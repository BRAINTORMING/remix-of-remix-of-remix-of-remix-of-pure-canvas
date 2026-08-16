// Campo global de viento (U/V) en formato compacto, con muestreo bilineal
// sobre typed arrays. Se descarga una sola vez y cubre todo el planeta,
// igual que los tiles base de temperatura.
import { supabase } from "@/integrations/supabase/client";

export interface WindFieldData {
  cols: number;
  rows: number;
  bbox: [number, number, number, number];
  hours: number;
  u: Float32Array;
  v: Float32Array;
}

let cache: WindFieldData | null = null;
let inflight: Promise<WindFieldData> | null = null;

const GLOBAL_BBOX: [number, number, number, number] = [-180, -78, 180, 78];

/** Construye el campo global a partir del modo "points" (siempre disponible),
 *  como respaldo si el modo "windfield" no está desplegado. */
async function loadViaPoints(cols = 25, rows = 13, hours = 24): Promise<WindFieldData> {
  const [w, s, e, n] = GLOBAL_BBOX;
  const points: { lat: number; lon: number }[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      points.push({
        lat: Number((s + ((n - s) * j) / (rows - 1)).toFixed(3)),
        lon: Number((w + ((e - w) * i) / (cols - 1)).toFixed(3)),
      });
    }
  }

  const { data, error } = await supabase.functions.invoke("weather-api", {
    body: { mode: "points", points },
  });
  if (error) throw error;

  const total = cols * rows;
  const u = new Float32Array(total * hours);
  const v = new Float32Array(total * hours);
  const list = (data as any)?.points ?? [];
  list.forEach((p: any, cell: number) => {
    const spd = p?.hourly?.wind_speed_10m ?? [];
    const dir = p?.hourly?.wind_direction_10m ?? [];
    for (let h = 0; h < hours; h++) {
      const S = spd[h], D = dir[h];
      if (S == null || D == null) continue;
      const rad = ((D + 180) % 360) * Math.PI / 180;
      u[h * total + cell] = Math.sin(rad) * S;
      v[h * total + cell] = Math.cos(rad) * S;
    }
  });

  return { cols, rows, bbox: GLOBAL_BBOX, hours, u, v };
}

export const WindFieldService = {
  get(): WindFieldData | null {
    return cache;
  },

  async load(): Promise<WindFieldData> {
    if (cache) return cache;
    if (inflight) return inflight;

    inflight = (async () => {
      try {
        const { data, error } = await supabase.functions.invoke("weather-api", {
          body: { mode: "windfield", cols: 37, rows: 19, hours: 24 },
        });
        if (error) throw error;
        const d = data as any;
        if (!d?.u?.length) throw new Error("windfield vacío");
        const field: WindFieldData = {
          cols: d.cols,
          rows: d.rows,
          bbox: d.bbox,
          hours: d.hours,
          u: Float32Array.from(d.u),
          v: Float32Array.from(d.v),
        };
        cache = field;
        return field;
      } catch (err) {
        console.warn("[wind] modo windfield no disponible, usando 'points'", err);
        const field = await loadViaPoints();
        cache = field;
        return field;
      }
    })().finally(() => {
      inflight = null;
    });

    return inflight;
  },
};


// Muestreo bilineal en (lng, lat) para una hora dada. Devuelve km/h en u/v.
export function sampleField(
  f: WindFieldData,
  lng: number,
  lat: number,
  hour: number,
  out: { u: number; v: number },
): boolean {
  const [w, s, e, n] = f.bbox;
  if (lat < s || lat > n) return false;
  // Envolvente en longitud para cobertura global continua.
  let x = lng;
  const span = e - w;
  while (x < w) x += span;
  while (x > e) x -= span;

  const fx = ((x - w) / span) * (f.cols - 1);
  const fy = ((lat - s) / (n - s)) * (f.rows - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(f.cols - 1, x0 + 1), y1 = Math.min(f.rows - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;

  const total = f.cols * f.rows;
  const h = Math.min(Math.max(0, hour), f.hours - 1) * total;

  const i00 = h + y0 * f.cols + x0;
  const i10 = h + y0 * f.cols + x1;
  const i01 = h + y1 * f.cols + x0;
  const i11 = h + y1 * f.cols + x1;

  const u = (f.u[i00] * (1 - tx) + f.u[i10] * tx) * (1 - ty)
    + (f.u[i01] * (1 - tx) + f.u[i11] * tx) * ty;
  const v = (f.v[i00] * (1 - tx) + f.v[i10] * tx) * (1 - ty)
    + (f.v[i01] * (1 - tx) + f.v[i11] * tx) * ty;

  out.u = u;
  out.v = v;
  return true;
}
