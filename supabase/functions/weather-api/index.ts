// Monitoreo Territorial — Weather API proxy (Open-Meteo)
// Stateless proxy with in-memory cache. Modes: 'point' | 'grid'.
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";

const HOURLY_VARS = [
  "temperature_2m",
  "relative_humidity_2m",
  "wind_speed_10m",
  "wind_direction_10m",
  "rain",
  "cloud_cover",
  "pressure_msl",
  "uv_index",
  "shortwave_radiation",
].join(",");

const CURRENT_VARS = HOURLY_VARS;

interface Body {
  mode: "point" | "grid" | "windfield";
  lat?: number;
  lon?: number;
  bbox?: [number, number, number, number];
  cols?: number;
  rows?: number;
  hours?: number;
}

// Simple in-memory LRU-ish cache per isolate. Not durable, but reduces upstream hits.
const memCache = new Map<string, { data: unknown; expiresAt: number }>();
const MAX_CACHE = 500;

function getCached(key: string) {
  const hit = memCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) { memCache.delete(key); return null; }
  return hit.data;
}
function setCached(key: string, data: unknown, ttlMs: number) {
  if (memCache.size >= MAX_CACHE) {
    const first = memCache.keys().next().value;
    if (first) memCache.delete(first);
  }
  memCache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

async function fetchPoint(lat: number, lon: number) {
  const url = new URL(OPEN_METEO);
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("current", CURRENT_VARS);
  url.searchParams.set("hourly", HOURLY_VARS);
  url.searchParams.set("forecast_days", "2");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("wind_speed_unit", "kmh");
  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(`open-meteo ${r.status}: ${await r.text()}`);
  return await r.json();
}

async function fetchGrid(lats: number[], lons: number[]) {
  const url = new URL(OPEN_METEO);
  url.searchParams.set("latitude", lats.join(","));
  url.searchParams.set("longitude", lons.join(","));
  url.searchParams.set("hourly", HOURLY_VARS);
  url.searchParams.set("forecast_days", "2");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("wind_speed_unit", "kmh");
  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(`open-meteo grid ${r.status}: ${await r.text()}`);
  return await r.json();
}

// --- Wind field (U/V) ------------------------------------------------------
// Devuelve una grilla regular (global por defecto) con componentes U/V del
// viento por hora, en formato compacto (arrays planos) para animar partículas.
async function fetchWindChunk(lats: number[], lons: number[], hours: number) {
  const url = new URL(OPEN_METEO);
  url.searchParams.set("latitude", lats.join(","));
  url.searchParams.set("longitude", lons.join(","));
  url.searchParams.set("hourly", "wind_speed_10m,wind_direction_10m");
  url.searchParams.set("forecast_hours", String(hours));
  url.searchParams.set("timezone", "GMT");
  url.searchParams.set("wind_speed_unit", "kmh");
  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(`open-meteo wind ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return Array.isArray(j) ? j : [j];
}

async function buildWindField(
  bbox: [number, number, number, number],
  cols: number,
  rows: number,
  hours: number,
) {
  const [w, s, e, n] = bbox;
  const lats: number[] = [];
  const lons: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      lons.push(Number((w + ((e - w) * i) / (cols - 1)).toFixed(3)));
      lats.push(Number((s + ((n - s) * j) / (rows - 1)).toFixed(3)));
    }
  }

  const CHUNK = 100;
  const chunks: Array<{ start: number; lats: number[]; lons: number[] }> = [];
  for (let i = 0; i < lats.length; i += CHUNK) {
    chunks.push({ start: i, lats: lats.slice(i, i + CHUNK), lons: lons.slice(i, i + CHUNK) });
  }

  const total = cols * rows;
  const u = new Array(total * hours).fill(0);
  const v = new Array(total * hours).fill(0);

  const CONCURRENCY = 3;
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const c = chunks[next++];
      const points = await fetchWindChunk(c.lats, c.lons, hours);
      points.forEach((p: any, k: number) => {
        const cell = c.start + k;
        const spd = p?.hourly?.wind_speed_10m ?? [];
        const dir = p?.hourly?.wind_direction_10m ?? [];
        for (let h = 0; h < hours; h++) {
          const S = spd[h], D = dir[h];
          if (S == null || D == null) continue;
          const rad = ((D + 180) % 360) * Math.PI / 180;
          u[h * total + cell] = Math.round(Math.sin(rad) * S * 10) / 10;
          v[h * total + cell] = Math.round(Math.cos(rad) * S * 10) / 10;
        }
      });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  return { cols, rows, bbox, hours, u, v, generated_at: new Date().toISOString() };
}



Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = (await req.json()) as Body;

    if (body.mode === "point") {
      const lat = Math.round(Number(body.lat) * 100) / 100;
      const lon = Math.round(Number(body.lon) * 100) / 100;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return new Response(JSON.stringify({ error: "invalid lat/lon" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const key = `p:${lat}:${lon}`;
      const cached = getCached(key);
      if (cached) {
        return new Response(JSON.stringify({ cached: true, ...(cached as object) }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const om = await fetchPoint(lat, lon);
      setCached(key, om, 15 * 60_000);
      return new Response(JSON.stringify({ cached: false, ...om }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (body.mode === "grid") {
      const bbox = body.bbox;
      if (!bbox || bbox.length !== 4) {
        return new Response(JSON.stringify({ error: "bbox required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const [w, s, e, n] = bbox;
      const cols = Math.max(3, Math.min(12, body.cols ?? 8));
      const rows = Math.max(3, Math.min(12, body.rows ?? 8));

      const lats: number[] = [];
      const lons: number[] = [];
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const lon = w + ((e - w) * i) / (cols - 1);
          const lat = s + ((n - s) * j) / (rows - 1);
          lats.push(Number(lat.toFixed(3)));
          lons.push(Number(lon.toFixed(3)));
        }
      }
      const key = `g:${cols}x${rows}:${w.toFixed(2)},${s.toFixed(2)},${e.toFixed(2)},${n.toFixed(2)}`;
      const cached = getCached(key);
      if (cached) {
        return new Response(JSON.stringify({ cached: true, ...(cached as object) }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const om = await fetchGrid(lats, lons);
      const points = Array.isArray(om) ? om : [om];
      const grid = points.map((p: any, idx: number) => ({
        lat: lats[idx], lon: lons[idx],
        hourly: p?.hourly ?? null,
        hourly_units: p?.hourly_units ?? null,
      }));
      const payload = { cols, rows, bbox, grid, generated_at: new Date().toISOString() };
      setCached(key, payload, 30 * 60_000);
      return new Response(JSON.stringify({ cached: false, ...payload }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (body.mode === "windfield") {
      const bbox = (body.bbox && body.bbox.length === 4
        ? body.bbox
        : [-180, -78, 180, 78]) as [number, number, number, number];
      const cols = Math.max(4, Math.min(48, body.cols ?? 37));
      const rows = Math.max(4, Math.min(32, body.rows ?? 19));
      const hours = Math.max(1, Math.min(48, body.hours ?? 24));

      const key = `wf:${cols}x${rows}:${hours}:${bbox.map(b => b.toFixed(1)).join(",")}`;
      const cached = getCached(key);
      if (cached) {
        return new Response(JSON.stringify({ cached: true, ...(cached as object) }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const payload = await buildWindField(bbox, cols, rows, hours);
      setCached(key, payload, 30 * 60_000);
      return new Response(JSON.stringify({ cached: false, ...payload }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }


    return new Response(JSON.stringify({ error: "invalid mode" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("weather-api error", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
