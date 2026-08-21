// Monitoreo Territorial · Tiempo — contexto climático complementario de una zona.
// Aditivo: no participa en el dictamen normativo, solo entrega contexto.
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";

interface Body {
  lat?: number;
  lon?: number;
  radio_km?: number | null;
  categoria_proyecto?: string | null;
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const r1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = (await req.json()) as Body;
    const lat = Number(body.lat);
    const lon = Number(body.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return json({ error: "lat/lon inválidos" }, 400);
    }
    const categoria = body.categoria_proyecto ?? null;
    const radioKm = Number.isFinite(Number(body.radio_km)) ? Number(body.radio_km) : null;

    const url = new URL(OPEN_METEO);
    url.searchParams.set("latitude", lat.toFixed(4));
    url.searchParams.set("longitude", lon.toFixed(4));
    url.searchParams.set(
      "hourly",
      "temperature_2m,wind_speed_10m,rain,shortwave_radiation,uv_index",
    );
    url.searchParams.set("forecast_days", "2");
    url.searchParams.set("timezone", "auto");
    url.searchParams.set("wind_speed_unit", "kmh");

    const r = await fetch(url.toString());
    if (!r.ok) return json({ error: `open-meteo ${r.status}` }, 502);
    const om = await r.json();

    const h = om?.hourly ?? {};
    const temps: number[] = (h.temperature_2m ?? []).slice(0, 48).filter((v: number) => v != null);
    const winds: number[] = (h.wind_speed_10m ?? []).slice(0, 48).filter((v: number) => v != null);
    const rains: number[] = (h.rain ?? []).slice(0, 48).filter((v: number) => v != null);
    const rad: number[] = (h.shortwave_radiation ?? []).slice(0, 48).filter((v: number) => v != null);
    const uv: number[] = (h.uv_index ?? []).slice(0, 48).filter((v: number) => v != null);

    if (temps.length === 0) return json({ error: "sin datos" }, 502);

    const resumen = {
      temperatura_prom: r1(avg(temps)),
      temperatura_min: r1(Math.min(...temps)),
      temperatura_max: r1(Math.max(...temps)),
      viento_prom_kmh: r1(avg(winds)),
      viento_max_kmh: winds.length ? r1(Math.max(...winds)) : 0,
      lluvia_acumulada_mm: r1(rains.reduce((s, v) => s + v, 0)),
      irradiancia_prom_wm2: Math.round(avg(rad.filter((v) => v > 0))),
      uv_max: uv.length ? r1(Math.max(...uv)) : 0,
    };

    // Índice de contexto climático 0..100 (100 = condiciones favorables)
    const tPen = clamp(Math.abs(resumen.temperatura_prom - 20) * 2.2, 0, 30);
    const wPen = clamp((resumen.viento_prom_kmh - 15) * 1.4, 0, 25);
    const rPen = clamp(resumen.lluvia_acumulada_mm * 2, 0, 25);
    const uvPen = clamp((resumen.uv_max - 8) * 4, 0, 15);
    const indice = Math.round(clamp(100 - tPen - wPen - rPen - uvPen, 0, 100));

    const aptitud_solar = Math.round(
      clamp((resumen.irradiancia_prom_wm2 / 800) * 100 - resumen.lluvia_acumulada_mm * 1.5, 0, 100),
    );
    const aptitud_eolica = Math.round(clamp((resumen.viento_prom_kmh / 35) * 100, 0, 100));

    return json({
      lat,
      lon,
      radio_km: radioKm,
      categoria_proyecto: categoria,
      indice_contexto_climatico: indice,
      resumen,
      aptitud_solar,
      aptitud_eolica,
      fuente: "Open-Meteo",
      generado_en: new Date().toISOString(),
    });
  } catch (err) {
    console.error("zone-weather-context error", err);
    return json({ error: String(err) }, 500);
  }
});
