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

export const WindFieldService = {
  get(): WindFieldData | null {
    return cache;
  },

  async load(): Promise<WindFieldData> {
    if (cache) return cache;
    if (inflight) return inflight;

    inflight = supabase.functions
      .invoke("weather-api", { body: { mode: "windfield", cols: 37, rows: 19, hours: 24 } })
      .then(({ data, error }) => {
        if (error) throw error;
        const d = data as any;
        const field: WindFieldData = {
          cols: d.cols,
          rows: d.rows,
          bbox: d.bbox,
          hours: d.hours,
          u: Float32Array.from(d.u ?? []),
          v: Float32Array.from(d.v ?? []),
        };
        cache = field;
        return field;
      })
      .finally(() => {
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
