// Monitoreo Territorial — gradientes, leyendas, tipos.
export type MonitoringLayerId =
  | "temperature" | "wind" | "solar" | "uv" | "humidity"
  | "rain" | "cloud" | "pressure" | "fireRisk" | "firms";

export interface Stop { v: number; c: string; label?: string }

export interface LayerDef {
  id: MonitoringLayerId;
  label: string;
  unit: string;
  variable: string;      // key in Open-Meteo hourly response
  stops: Stop[];         // ascending
  min: number;
  max: number;
}

// Windy-like temperature palette
export const LAYER_DEFS: Record<Exclude<MonitoringLayerId, "wind" | "firms" | "fireRisk">, LayerDef> = {
  temperature: {
    id: "temperature", label: "Temperatura", unit: "°C", variable: "temperature_2m",
    min: -10, max: 45,
    stops: [
      { v: -10, c: "#0b1e5b", label: "-10°" },
      { v: 0,   c: "#2b6cb0", label: "0°" },
      { v: 10,  c: "#4dc4ff", label: "10°" },
      { v: 18,  c: "#7ee787", label: "18°" },
      { v: 25,  c: "#facc15", label: "25°" },
      { v: 32,  c: "#f97316", label: "32°" },
      { v: 42,  c: "#dc2626", label: "42°+" },
    ],
  },
  solar: {
    id: "solar", label: "Radiación Solar", unit: "W/m²", variable: "shortwave_radiation",
    min: 0, max: 1000,
    // Debe coincidir 1:1 con LAYER_DEFS.solar en supabase/functions/_shared/weatherTile.ts
    // (misma paleta = el tile PNG y la leyenda del cliente siempre calzan).
    stops: [
      { v: 0,    c: "#6F6F6F" },
      { v: 250,  c: "#BD6759" },
      { v: 500,  c: "#DA9669" },
      { v: 750,  c: "#EBC28C" },
      { v: 1000, c: "#FCF7BF" },
    ],
  },
  uv: {
    id: "uv", label: "Índice UV", unit: "", variable: "uv_index",
    min: 0, max: 12,
    stops: [
      { v: 0,  c: "#22c55e", label: "Bajo" },
      { v: 3,  c: "#facc15", label: "Moderado" },
      { v: 6,  c: "#f97316", label: "Alto" },
      { v: 8,  c: "#dc2626", label: "Muy Alto" },
      { v: 11, c: "#7e22ce", label: "Extremo" },
    ],
  },
  humidity: {
    id: "humidity", label: "Humedad", unit: "%", variable: "relative_humidity_2m",
    min: 0, max: 100,
    stops: [
      { v: 0,   c: "#fef3c7" },
      { v: 30,  c: "#fde68a" },
      { v: 55,  c: "#67e8f9" },
      { v: 75,  c: "#3b82f6" },
      { v: 100, c: "#1e3a8a" },
    ],
  },
  rain: {
    id: "rain", label: "Precipitación", unit: "mm", variable: "rain",
    min: 0, max: 20,
    stops: [
      { v: 0,  c: "#eef2ff" },
      { v: 1,  c: "#93c5fd" },
      { v: 4,  c: "#3b82f6" },
      { v: 10, c: "#4338ca" },
      { v: 20, c: "#312e81" },
    ],
  },
  cloud: {
    id: "cloud", label: "Nubosidad", unit: "%", variable: "cloud_cover",
    min: 0, max: 100,
    stops: [
      { v: 0,   c: "#f8fafc" },
      { v: 40,  c: "#cbd5e1" },
      { v: 70,  c: "#64748b" },
      { v: 100, c: "#1e293b" },
    ],
  },
  pressure: {
    id: "pressure", label: "Presión Atmosférica", unit: "hPa", variable: "pressure_msl",
    min: 990, max: 1030,
    stops: [
      { v: 990,  c: "#7c3aed" },
      { v: 1005, c: "#3b82f6" },
      { v: 1013, c: "#22c55e" },
      { v: 1020, c: "#f97316" },
      { v: 1030, c: "#dc2626" },
    ],
  },
};

// Fire risk levels
export const FIRE_RISK_STOPS: Stop[] = [
  { v: 0,   c: "#22c55e", label: "Muy Bajo" },
  { v: 0.3, c: "#facc15", label: "Bajo" },
  { v: 0.5, c: "#f97316", label: "Moderado" },
  { v: 0.7, c: "#dc2626", label: "Alto" },
  { v: 0.9, c: "#7e22ce", label: "Extremo" },
];

export function colorAt(stops: Stop[], v: number): string {
  if (v <= stops[0].v) return stops[0].c;
  if (v >= stops[stops.length - 1].v) return stops[stops.length - 1].c;
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i].v) {
      const a = stops[i - 1], b = stops[i];
      const t = (v - a.v) / (b.v - a.v);
      return mix(a.c, b.c, t);
    }
  }
  return stops[stops.length - 1].c;
}

function mix(a: string, b: string, t: number): string {
  const pa = hex(a), pb = hex(b);
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `rgb(${r},${g},${bl})`;
}
function hex(c: string): [number, number, number] {
  const h = c.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// Mapbox heatmap-color expression from stops normalized 0..1 by (min,max).
export function mapboxHeatmapColor(stops: Stop[], min: number, max: number): any {
  const expr: any[] = ["interpolate", ["linear"], ["heatmap-density"]];
  // heatmap-color uses density 0..1; map each stop into density space by (v-min)/(max-min).
  expr.push(0, "rgba(0,0,0,0)");
  for (const s of stops) {
    const t = Math.max(0.01, Math.min(1, (s.v - min) / (max - min)));
    expr.push(t, s.c);
  }
  return expr;
}
