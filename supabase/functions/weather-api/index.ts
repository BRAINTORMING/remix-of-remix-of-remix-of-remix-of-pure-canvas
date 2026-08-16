// Monitoreo Territorial — Weather API proxy (Open-Meteo)
// Stateless proxy in front of Open-Meteo, backed by a two-tier cache:
//   1) in-memory (per isolate, instant, disappears on cold start)
//   2) Postgres `weather_cache` (persistent, shared across every user/isolate)
// Modes: 'point' | 'grid' | 'points' | 'windfield'.
import { createClient } from "npm:@supabase/supabase-js@2";
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

const OPEN_METEO_CHUNK_SIZE = 100;
const OPEN_METEO_MAX_PARALLEL = 4;

const POINT_TTL_MS = 15 * 60_000;
const GRID_TTL_MS = 30 * 60_000;
const POINTS_TTL_MS = 20 * 60_000;
const WINDFIELD_TTL_MS = 60 * 60_000;

interface LatLon { lat: number; lon: number }

interface Body {
  mode: "point" | "grid" | "points" | "windfield";
  lat?: number;
  lon?: number;
  bbox?: [number, number, number, number];
  cols?: number;
  rows?: number;
  hours?: number;
  points?: LatLon[];
  step?: number;
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Tier 1: in-memory cache (per isolate)
// ---------------------------------------------------------------------------
const memCache = new Map<string, { data: unknown; expiresAt: number }>();
const MAX_MEM_CACHE = 4000;

function memGet(key: string) {
  const hit = memCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) { memCache.delete(key); return null; }
  return hit.data;
}
function memSet(key: string, data: unknown, ttlMs: number) {
  if (memCache.size >= MAX_MEM_CACHE) {
    const first = memCache.keys().next().value;
    if (first) memCache.delete(first);
  }
  memCache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// ---------------------------------------------------------------------------
// Tier 2: Postgres persistent cache (shared across isolates and users)
// ---------------------------------------------------------------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const dbClient = SUPABASE_URL && SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

async function dbGetMany(keys: string[]): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  if (!dbClient || keys.length === 0) return out;
  try {
    const { data, error } = await dbClient
      .from("weather_cache")
      .select("key, payload, expires_at")
      .in("key", keys)
      .gt("expires_at", new Date().toISOString());
    if (error) throw error;
    for (const row of data ?? []) out.set(row.key as string, row.payload);
  } catch (err) {
    console.error("[weather-api] db cache read failed", err);
  }
  return out;
}

async function dbSetMany(rows: { key: string; payload: unknown; ttlMs: number }[]) {
  if (!dbClient || rows.length === 0) return;
  try {
    const expiresAt = (ttlMs: number) => new Date(Date.now() + ttlMs).toISOString();
    const payload = rows.map(r => ({
      key: r.key,
      payload: r.payload,
      expires_at: expiresAt(r.ttlMs),
    }));
    const { error } = await dbClient.from("weather_cache").upsert(payload, { onConflict: "key" });
    if (error) throw error;
  } catch (err) {
    console.error("[weather-api] db cache write failed", err);
  }
}

// ---------------------------------------------------------------------------
// Open-Meteo access
// ---------------------------------------------------------------------------
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

async function fetchMultiOpenMeteo(lats: number[], lons: number[]) {
  const url = new URL(OPEN_METEO);
  url.searchParams.set("latitude", lats.join(","));
  url.searchParams.set("longitude", lons.join(","));
  url.searchParams.set("hourly", HOURLY_VARS);
  url.searchParams.set("forecast_days", "2");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("wind_speed_unit", "kmh");
  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(`open-meteo multi ${r.status}: ${await r.text()}`);
  const json = await r.json();
  return Array.isArray(json) ? json : [json];
}

async function fetchManyPoints(pts: LatLon[]): Promise<any[]> {
  const chunks: LatLon[][] = [];
  for (let i = 0; i < pts.length; i += OPEN_METEO_CHUNK_SIZE) {
    chunks.push(pts.slice(i, i + OPEN_METEO_CHUNK_SIZE));
  }

  const results: any[] = new Array(pts.length);
  let cursor = 0;

  async function worker() {
    while (cursor < chunks.length) {
      const chunkIndex = cursor++;
      const chunk = chunks[chunkIndex];
      const offset = chunkIndex * OPEN_METEO_CHUNK_SIZE;
      try {
        const om = await fetchMultiOpenMeteo(chunk.map(p => p.lat), chunk.map(p => p.lon));
        for (let i = 0; i < chunk.length; i++) results[offset + i] = om[i] ?? null;
      } catch (err) {
        console.error("[weather-api] chunk failed", err);
        for (let i = 0; i < chunk.length; i++) results[offset + i] = null;
      }
    }
  }

  const workers = Array.from({ length: Math.min(OPEN_METEO_MAX_PARALLEL, chunks.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Wind field (global U/V grid) — used by the animated particles layer
// ---------------------------------------------------------------------------
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

  const CONCURRENCY = 4;
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const c = chunks[next++];
      let points: any[] = [];
      try {
        points = await fetchWindChunk(c.lats, c.lons, hours);
      } catch (err) {
        console.error("[weather-api] wind chunk failed", err);
        continue;
      }
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

function roundCoord(n: number, decimals = 4) {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
function pointKey(lat: number, lon: number) {
  return `pt:${lat.toFixed(4)}:${lon.toFixed(4)}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = (await req.json()) as Body;

    // -------------------------------------------------------------------
    // mode: point
    // -------------------------------------------------------------------
    if (body.mode === "point") {
      const lat = roundCoord(Number(body.lat), 2);
      const lon = roundCoord(Number(body.lon), 2);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return jsonResponse({ error: "invalid lat/lon" }, 400);
      }
      const key = `p:${lat}:${lon}`;
      const cached = memGet(key);
      if (cached) return jsonResponse({ cached: true, ...(cached as object) });

      const om = await fetchPoint(lat, lon);
      memSet(key, om, POINT_TTL_MS);
      return jsonResponse({ cached: false, ...om });
    }

    // -------------------------------------------------------------------
    // mode: grid (legacy)
    // -------------------------------------------------------------------
    if (body.mode === "grid") {
      const bbox = body.bbox;
      if (!bbox || bbox.length !== 4) return jsonResponse({ error: "bbox required" }, 400);

      const [w, s, e, n] = bbox;
      const cols = Math.max(3, Math.min(12, body.cols ?? 8));
      const rows = Math.max(3, Math.min(12, body.rows ?? 8));

      const lats: number[] = [];
      const lons: number[] = [];
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          lons.push(Number((w + ((e - w) * i) / (cols - 1)).toFixed(3)));
          lats.push(Number((s + ((n - s) * j) / (rows - 1)).toFixed(3)));
        }
      }
      const key = `g:${cols}x${rows}:${w.toFixed(2)},${s.toFixed(2)},${e.toFixed(2)},${n.toFixed(2)}`;
      const cached = memGet(key);
      if (cached) return jsonResponse({ cached: true, ...(cached as object) });

      const points = await fetchMultiOpenMeteo(lats, lons);
      const grid = points.map((p: any, idx: number) => ({
        lat: lats[idx], lon: lons[idx],
        hourly: p?.hourly ?? null,
        hourly_units: p?.hourly_units ?? null,
      }));
      const payload = { cols, rows, bbox, grid, generated_at: new Date().toISOString() };
      memSet(key, payload, GRID_TTL_MS);
      return jsonResponse({ cached: false, ...payload });
    }

    // -------------------------------------------------------------------
    // mode: points — arbitrary lattice nodes (WeatherGridCache)
    // -------------------------------------------------------------------
    if (body.mode === "points") {
      const raw = Array.isArray(body.points) ? body.points : [];
      if (raw.length === 0) return jsonResponse({ points: [] });

      const pts = raw.slice(0, 2500)
        .map(p => ({ lat: roundCoord(Number(p.lat)), lon: roundCoord(Number(p.lon)) }))
        .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));

      const keys = pts.map(p => pointKey(p.lat, p.lon));
      const results: any[] = new Array(pts.length).fill(null);

      const stillMissingAfterMem: number[] = [];
      keys.forEach((k, i) => {
        const hit = memGet(k);
        if (hit) results[i] = hit;
        else stillMissingAfterMem.push(i);
      });

      if (stillMissingAfterMem.length > 0) {
        const dbKeys = stillMissingAfterMem.map(i => keys[i]);
        const dbHits = await dbGetMany(dbKeys);
        const stillMissing: number[] = [];
        for (const i of stillMissingAfterMem) {
          const hit = dbHits.get(keys[i]);
          if (hit) {
            results[i] = hit;
            memSet(keys[i], hit, POINTS_TTL_MS);
          } else {
            stillMissing.push(i);
          }
        }

        if (stillMissing.length > 0) {
          const omResults = await fetchManyPoints(stillMissing.map(i => pts[i]));
          const dbRows: { key: string; payload: unknown; ttlMs: number }[] = [];
          stillMissing.forEach((i, j) => {
            const om = omResults[j];
            const payload = { lat: pts[i].lat, lon: pts[i].lon, hourly: om?.hourly ?? null };
            results[i] = payload;
            memSet(keys[i], payload, POINTS_TTL_MS);
            dbRows.push({ key: keys[i], payload, ttlMs: POINTS_TTL_MS });
          });
          await dbSetMany(dbRows);
        }
      }

      return jsonResponse({ points: results });
    }

    // -------------------------------------------------------------------
    // mode: windfield — global U/V grid for the animated wind particles
    // -------------------------------------------------------------------
    if (body.mode === "windfield") {
      const bbox = (body.bbox && body.bbox.length === 4
        ? body.bbox
        : [-180, -78, 180, 78]) as [number, number, number, number];
      const cols = Math.max(4, Math.min(48, body.cols ?? 37));
      const rows = Math.max(4, Math.min(32, body.rows ?? 19));
      const hours = Math.max(1, Math.min(48, body.hours ?? 24));

      const key = `wf:${cols}x${rows}:${hours}:${bbox.map(b => b.toFixed(1)).join(",")}`;

      const mem = memGet(key);
      if (mem) return jsonResponse({ cached: true, ...(mem as object) });

      const dbHit = (await dbGetMany([key])).get(key);
      if (dbHit) {
        memSet(key, dbHit, WINDFIELD_TTL_MS);
        return jsonResponse({ cached: true, ...(dbHit as object) });
      }

      const payload = await buildWindField(bbox, cols, rows, hours);
      memSet(key, payload, WINDFIELD_TTL_MS);
      await dbSetMany([{ key, payload, ttlMs: WINDFIELD_TTL_MS }]);
      return jsonResponse({ cached: false, ...payload });
    }

    return jsonResponse({ error: "invalid mode" }, 400);
  } catch (err) {
    console.error("weather-api error", err);
    return jsonResponse({ error: String(err) }, 500);
  }
});
