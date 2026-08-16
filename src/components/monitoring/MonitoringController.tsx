// Controller: subscribes to monitoring events, drives WeatherLayerManager,
// WindAnimation, and FIRMS layer. Uses window.__gdudexMap set by MapView.
import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import { WeatherLayerManager } from "@/services/monitoring/WeatherLayerManager";
import { WeatherTileLayerManager } from "@/services/monitoring/WeatherTileLayerManager";
import { WindAnimation } from "@/services/monitoring/WindAnimation";
import { WeatherService, NASAFirmsService, FireRiskService } from "@/services/monitoring/WeatherService";
import type { MonitoringLayerId } from "@/lib/monitoring/palettes";
import Legend from "./Legend";
import Timeline from "./Timeline";

const FIRMS_SRC = "monitoring-firms-src";
const FIRMS_LYR = "monitoring-firms-lyr";

declare global {
  interface Window { __gdudexMap?: mapboxgl.Map }
}

export default function MonitoringController() {
  const [ready, setReady] = useState<mapboxgl.Map | null>(null);
  const [active, setActive] = useState<Set<MonitoringLayerId>>(new Set());
  const [hourOffset, setHourOffset] = useState(0);
  const mgrRef = useRef<WeatherLayerManager | null>(null);
  const tileMgrRef = useRef<WeatherTileLayerManager | null>(null);
  const windRef = useRef<WindAnimation | null>(null);
  const popupRef = useRef<mapboxgl.Popup | null>(null);

  // Wait for map instance
  useEffect(() => {
    const tryHook = () => {
      const m = window.__gdudexMap;
      if (m) {
        if (m.isStyleLoaded()) setReady(m);
        else m.once("load", () => setReady(m));
      }
    };
    tryHook();
    const onReady = () => tryHook();
    window.addEventListener("gdudex:mapReady", onReady);
    const interval = setInterval(tryHook, 500);
    return () => { window.removeEventListener("gdudex:mapReady", onReady); clearInterval(interval); };
  }, []);

  // Initialize manager when map is ready
  useEffect(() => {
    if (!ready) return;
    const mgr = new WeatherLayerManager(ready);
    mgrRef.current = mgr;
    const tileMgr = new WeatherTileLayerManager(ready);
    tileMgrRef.current = tileMgr;
    const wind = new WindAnimation(ready);
    windRef.current = wind;

    const debounce = (fn: () => void, ms: number) => {
      let t: number | undefined;
      return () => { window.clearTimeout(t); t = window.setTimeout(fn, ms); };
    };
    const onMoveEnd = debounce(() => {
      mgr.refreshForViewport();
      // Also refetch firms if active
      if (active.has("firms")) refreshFirms(ready);
      // El viento usa un campo global precargado; no depende del viewport.
    }, 600);
    ready.on("moveend", onMoveEnd);

    return () => {
      ready.off("moveend", onMoveEnd);
      mgr.destroy();
      tileMgr.destroy();
      wind.destroy();
      if (ready.getLayer(FIRMS_LYR)) ready.removeLayer(FIRMS_LYR);
      if (ready.getSource(FIRMS_SRC)) ready.removeSource(FIRMS_SRC);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  async function refreshFirms(map: mapboxgl.Map) {
    const b = map.getBounds();
    if (!b) return;
    try {
      const fc = await NASAFirmsService.fetchBBox(
        [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], 2,
      );
      if (map.getSource(FIRMS_SRC)) {
        (map.getSource(FIRMS_SRC) as mapboxgl.GeoJSONSource).setData(fc);
      } else {
        map.addSource(FIRMS_SRC, { type: "geojson", data: fc });
        map.addLayer({
          id: FIRMS_LYR,
          type: "circle",
          source: FIRMS_SRC,
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["coalesce", ["get", "frp"], 5], 0, 4, 50, 10, 200, 16],
            "circle-color": "#ef4444",
            "circle-opacity": 0.85,
            "circle-stroke-color": "#fff",
            "circle-stroke-width": 1.5,
          },
        });
        map.on("click", FIRMS_LYR, (e) => {
          const f = e.features?.[0];
          if (!f) return;
          const p = f.properties as any;
          const coords = (f.geometry as any).coordinates as [number, number];
          new mapboxgl.Popup({ closeButton: true, maxWidth: "260px" })
            .setLngLat(coords)
            .setHTML(`
              <div style="font-family:Inter,sans-serif;padding:6px 4px;min-width:200px">
                <div style="font-weight:700;color:#dc2626;margin-bottom:4px;display:flex;align-items:center;gap:6px">
                  🔥 Incendio activo
                </div>
                <div style="font-size:12px;line-height:1.5;color:#334155">
                  <div><b>Fecha:</b> ${p.acq_date ?? "—"} ${p.acq_time ?? ""}</div>
                  <div><b>Confianza:</b> ${p.confidence ?? "—"}</div>
                  <div><b>Potencia (FRP):</b> ${p.frp != null ? p.frp + " MW" : "—"}</div>
                  <div><b>Brillo:</b> ${p.brightness ?? "—"} K</div>
                  <div><b>Satélite:</b> ${p.satellite ?? "—"}</div>
                  <div style="margin-top:4px;color:#64748b;font-size:10.5px">Fuente: NASA FIRMS VIIRS</div>
                </div>
              </div>
            `)
            .addTo(map);
        });
        map.on("mouseenter", FIRMS_LYR, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", FIRMS_LYR, () => (map.getCanvas().style.cursor = ""));
      }
    } catch (err) {
      console.warn("[monitoring] FIRMS fetch failed", err);
    }
  }

  // Toggle handler
  useEffect(() => {
    const onToggle = (e: Event) => {
      const d = (e as CustomEvent).detail as { id: MonitoringLayerId; on: boolean };
      if (!d) return;
      setActive(prev => {
        const next = new Set(prev);
        if (d.on) next.add(d.id); else next.delete(d.id);
        return next;
      });

      const map = ready;
      const mgr = mgrRef.current;
      const wind = windRef.current;
      if (!map || !mgr || !wind) return;

      if (d.id === "wind") {
        if (d.on) {
          wind.setHourOffset(hourOffset);
          void wind.start();
        } else wind.stop();
      } else if (d.id === "firms") {
        if (d.on) refreshFirms(map);
        else {
          if (map.getLayer(FIRMS_LYR)) map.removeLayer(FIRMS_LYR);
          if (map.getSource(FIRMS_SRC)) map.removeSource(FIRMS_SRC);
        }
      } else if (d.id === "temperature") {
        // Migrada a tiles XYZ — ya no pasa por el WeatherLayerManager viejo.
        tileMgrRef.current?.setActive("temperature", d.on);
      } else {
        mgr.setActive(d.id, d.on);
      }
    };
    window.addEventListener("monitoring:toggle", onToggle);
    return () => window.removeEventListener("monitoring:toggle", onToggle);
  }, [ready]);

  // Hour offset handler
  useEffect(() => {
    const mgr = mgrRef.current, wind = windRef.current, tileMgr = tileMgrRef.current;
    if (!mgr) return;
    mgr.setHourOffset(hourOffset);
    wind?.setHourOffset(hourOffset);
    tileMgr?.setHourOffset(hourOffset);
  }, [hourOffset]);

  // Click popup with all variables
  useEffect(() => {
    if (!ready) return;
    const onClick = async (e: mapboxgl.MapMouseEvent) => {
      if (active.size === 0) return;
      // Ignore clicks on FIRMS features (they have their own popup)
      const f = ready.queryRenderedFeatures(e.point, { layers: [FIRMS_LYR] });
      if (f && f.length > 0) return;
      if (popupRef.current) popupRef.current.remove();

      const { lng, lat } = e.lngLat;
      const loading = new mapboxgl.Popup({ closeButton: true, maxWidth: "300px" })
        .setLngLat([lng, lat])
        .setHTML(`<div style="padding:10px;font-family:Inter,sans-serif;font-size:12px;color:#64748b">Consultando…</div>`)
        .addTo(ready);
      popupRef.current = loading;

      try {
        const point = await WeatherService.point(lat, lng);
        const idx = Math.min(hourOffset, (point.hourly?.time?.length ?? 1) - 1);
        const v = point.hourly ?? point.current ?? {};
        const get = (k: string) => (point.current?.[k] ?? v?.[k]?.[idx]);
        const T = get("temperature_2m"), RH = get("relative_humidity_2m"),
          W = get("wind_speed_10m"), Dir = get("wind_direction_10m"),
          Rn = get("rain"), Cl = get("cloud_cover"), P = get("pressure_msl"),
          UV = get("uv_index"), Rad = get("shortwave_radiation");
        const fire = FireRiskService.compute({
          temperature_2m: T ?? null, relative_humidity_2m: RH ?? null,
          wind_speed_10m: W ?? null, rain: Rn ?? null,
          shortwave_radiation: Rad ?? null, uv_index: UV ?? null,
        });
        const dirLetter = dirTo16((Dir ?? 0) as number);
        loading.setHTML(`
          <div style="font-family:Inter,sans-serif;padding:2px;min-width:230px">
            <div style="font-weight:700;font-size:13px;color:#0f172a;margin-bottom:6px">
              📍 ${lat.toFixed(3)}, ${lng.toFixed(3)}
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;font-size:12px;color:#334155">
              <div>🌡 <b>${fmt(T, 1)}°C</b></div>
              <div>💧 <b>${fmt(RH, 0)}%</b></div>
              <div>💨 <b>${fmt(W, 0)} km/h</b> ${dirLetter}</div>
              <div>🌧 <b>${fmt(Rn, 1)} mm</b></div>
              <div>☀ <b>${fmt(Rad, 0)} W/m²</b></div>
              <div>🟣 UV <b>${fmt(UV, 0)}</b></div>
              <div>☁ <b>${fmt(Cl, 0)}%</b></div>
              <div>🌡 <b>${fmt(P, 0)} hPa</b></div>
            </div>
            <div style="margin-top:6px;padding:5px 8px;border-radius:8px;background:${fire.color}22;color:${fire.color};font-size:11px;font-weight:600">
              🔥 Riesgo incendio: ${fire.label}
            </div>
          </div>
        `);
      } catch (err) {
        loading.setHTML(`<div style="padding:10px;color:#dc2626;font-size:12px">Error consultando datos.</div>`);
      }
    };
    ready.on("click", onClick);
    return () => { ready.off("click", onClick); };
  }, [ready, active, hourOffset]);

  const showTimeline = active.size > 0;

  return (
    <>
      {active.size > 0 && <Legend active={Array.from(active)} />}
      {showTimeline && <Timeline value={hourOffset} onChange={setHourOffset} />}
    </>
  );
}

function fmt(v: unknown, d: number) {
  if (v == null || Number.isNaN(v)) return "—";
  return Number(v).toFixed(d);
}
function dirTo16(deg: number) {
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(((deg % 360) / 22.5)) % 16];
}
