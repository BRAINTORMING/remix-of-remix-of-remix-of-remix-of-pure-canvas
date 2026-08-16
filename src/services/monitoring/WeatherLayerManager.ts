// Monitoreo Territorial — Mapbox layer manager para variables meteorológicas.
//
// Punto clave de esta versión: el campo renderizado ya NO se recalcula en
// cada `moveend`. En su lugar mantenemos un "buffer" geográfico bastante más
// grande que el viewport actual; mientras el viewport siga cayendo dentro de
// ese buffer (con margen), no se pide nada a la red ni se vuelve a dibujar el
// canvas — Mapbox reproyecta el mismo canvas `raster` sobre el mapa durante
// pan/zoom de forma nativa en GPU, que es lo que da la sensación fluida tipo
// Windy. Solo cuando el usuario se sale del buffer (o cambia de nivel de
// zoom lo suficiente como para requerir otro espaciado) se pide cobertura
// nueva — sobre un buffer nuevo, otra vez más grande que el viewport, para
// que el próximo movimiento también tenga margen.
import type mapboxgl from "mapbox-gl";
import { LAYER_DEFS, FIRE_RISK_STOPS, type MonitoringLayerId } from "@/lib/monitoring/palettes";
import { FireRiskService, type GridResponse } from "@/services/monitoring/WeatherService";
import { ContinuousFieldLayer } from "@/services/monitoring/ContinuousFieldLayer";
import { WeatherGridCache } from "@/services/monitoring/WeatherGridCache";

type BBox = [number, number, number, number]; // [w, s, e, n]

// Cuánto más grande que el viewport es el buffer que se pide cada vez
// (0.6 = 60% extra a cada lado → área total ≈ 2.2x la del viewport en cada
// eje, ≈ 4.8x en superficie). Suficiente margen para paneos normales sin
// disparar demasiados nodos de golpe (el tope duro vive en WeatherGridCache).
const BUFFER_PAD_RATIO = 0.6;

// Qué tan cerca del borde del buffer puede llegar el viewport antes de
// forzar una recarga. Se resta como margen de seguridad al comparar
// contención, para no recargar justo al límite del buffer.
const SHRINK_MARGIN_RATIO = 0.12;

export class WeatherLayerManager {
  private map: mapboxgl.Map;
  private gridCache = new WeatherGridCache();

  private currentStep: number | null = null;
  private currentIxRange: [number, number] | null = null;
  private currentIyRange: [number, number] | null = null;

  // Buffer efectivamente cubierto en este momento (más grande que el viewport).
  private bufferBBox: BBox | null = null;
  private bufferStep: number | null = null;

  private hourOffset = 0;
  private active = new Set<MonitoringLayerId>();
  private fields = new Map<MonitoringLayerId, ContinuousFieldLayer>();
  private pendingCoverage: Promise<boolean> | null = null;

  constructor(map: mapboxgl.Map) {
    this.map = map;
  }

  setActive(layer: MonitoringLayerId, on: boolean) {
    if (on) {
      this.active.add(layer);
      // Se renderiza siempre al activar (aunque el buffer ya sea válido),
      // porque esta capa en particular todavía no tiene un ContinuousFieldLayer.
      this.ensureCoverageForViewport().then(() => this.renderLayer(layer));
    } else {
      this.active.delete(layer);
      this.removeLayer(layer);
    }
  }

  setHourOffset(h: number) {
    this.hourOffset = h;
    for (const l of this.active) this.renderLayer(l);
  }

  currentHourOffset() { return this.hourOffset; }
  activeLayers(): MonitoringLayerId[] { return [...this.active]; }

  /** Llamar en `moveend`. Es barato: si el buffer actual todavía cubre el
   *  viewport, no hace ninguna llamada de red ni redibuja nada — el canvas ya
   *  desplegado sigue siendo válido y Mapbox ya lo reproyectó solo. */
  refreshForViewport() {
    if (this.active.size === 0) return;
    this.ensureCoverageForViewport().then((fetchedNewBuffer) => {
      if (fetchedNewBuffer) {
        for (const l of this.active) this.renderLayer(l);
      }
    });
  }

  /** Devuelve true si se pidió (y llegó) cobertura nueva; false si el buffer
   *  vigente ya cubría el viewport y no hizo falta red. */
  private async ensureCoverageForViewport(): Promise<boolean> {
    const b = this.map.getBounds();
    if (!b) return false;

    const viewport: BBox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    const desiredStep = this.gridCache.chooseStep(viewport);

    if (
      this.bufferBBox &&
      this.bufferStep === desiredStep &&
      this.viewportWellInsideBuffer(viewport, this.bufferBBox)
    ) {
      return false; // el buffer actual ya alcanza — nada que pedir ni redibujar
    }

    if (this.pendingCoverage) return this.pendingCoverage;

    const dx = (viewport[2] - viewport[0]) * BUFFER_PAD_RATIO;
    const dy = (viewport[3] - viewport[1]) * BUFFER_PAD_RATIO;
    const targetBuffer: BBox = [
      viewport[0] - dx, viewport[1] - dy, viewport[2] + dx, viewport[3] + dy,
    ];

    this.pendingCoverage = this.gridCache
      .ensureCoverage(targetBuffer, desiredStep)
      .then(({ step, ixRange, iyRange }) => {
        this.currentStep = step;
        this.currentIxRange = ixRange;
        this.currentIyRange = iyRange;
        this.bufferBBox = targetBuffer;
        this.bufferStep = step;
        return true;
      })
      .catch(err => {
        console.error("[monitoring] coverage fetch failed", err);
        return false;
      })
      .finally(() => { this.pendingCoverage = null; });

    return this.pendingCoverage;
  }

  private viewportWellInsideBuffer(viewport: BBox, buffer: BBox): boolean {
    const [vw, vs, ve, vn] = viewport;
    const [bw, bs, be, bn] = buffer;
    const marginX = (ve - vw) * SHRINK_MARGIN_RATIO;
    const marginY = (vn - vs) * SHRINK_MARGIN_RATIO;
    return (
      vw - marginX >= bw &&
      ve + marginX <= be &&
      vs - marginY >= bs &&
      vn + marginY <= bn
    );
  }

  private renderLayer(layer: MonitoringLayerId) {
    if (layer === "wind" || layer === "firms") return;
    if (this.currentStep == null || !this.currentIxRange || !this.currentIyRange) return;

    const step = this.currentStep;
    const [ixMin, ixMax] = this.currentIxRange;
    const [iyMin, iyMax] = this.currentIyRange;
    const cols = ixMax - ixMin + 1;
    const rows = iyMax - iyMin + 1;
    const bbox: BBox = [ixMin * step, iyMin * step, ixMax * step, iyMax * step];

    const values = new Float32Array(rows * cols).fill(NaN);
    for (let iy = iyMin; iy <= iyMax; iy++) {
      for (let ix = ixMin; ix <= ixMax; ix++) {
        const idx = (iy - iyMin) * cols + (ix - ixMin);
        let v: number;
        if (layer === "fireRisk") {
          const h = this.gridCache.hourlyAt(step, ix, iy);
          if (!h) { v = NaN; }
          else {
            const hi = Math.min(this.hourOffset, (h.time?.length ?? 1) - 1);
            v = FireRiskService.compute({
              temperature_2m: h.temperature_2m?.[hi] ?? null,
              relative_humidity_2m: h.relative_humidity_2m?.[hi] ?? null,
              wind_speed_10m: h.wind_speed_10m?.[hi] ?? null,
              rain: h.rain?.[hi] ?? null,
              shortwave_radiation: h.shortwave_radiation?.[hi] ?? null,
              uv_index: h.uv_index?.[hi] ?? null,
            }).score;
          }
        } else {
          const def = LAYER_DEFS[layer as keyof typeof LAYER_DEFS];
          v = def ? this.gridCache.sample(step, ix, iy, def.variable, this.hourOffset) : NaN;
        }
        values[idx] = v;
      }
    }

    let field = this.fields.get(layer);
    if (!field) {
      const { min, max, stops } = this.spec(layer);
      field = new ContinuousFieldLayer(this.map, layer, stops, min, max);
      this.fields.set(layer, field);
    }
    field.render(values, cols, rows, bbox);
  }

  private spec(layer: MonitoringLayerId): { min: number; max: number; stops: any } {
    if (layer === "fireRisk") return { min: 0, max: 1, stops: FIRE_RISK_STOPS };
    const d = LAYER_DEFS[layer as keyof typeof LAYER_DEFS];
    return { min: d.min, max: d.max, stops: d.stops };
  }

  private removeLayer(layer: MonitoringLayerId) {
    const field = this.fields.get(layer);
    if (field) {
      field.remove();
      this.fields.delete(layer);
    }
  }

  /** Snapshot con la misma forma que antes (rows/cols/bbox/grid[]), construido
   *  al vuelo desde la grilla persistente — para no tocar WindAnimation.ts ni
   *  MonitoringController.tsx, que siguen esperando este formato. Como el
   *  buffer ahora es más grande que el viewport, el viento también gana:
   *  las partículas tienen datos más allá del borde de la pantalla. */
  getGrid(): GridResponse | null {
    if (this.currentStep == null || !this.currentIxRange || !this.currentIyRange) return null;
    const step = this.currentStep;
    const [ixMin, ixMax] = this.currentIxRange;
    const [iyMin, iyMax] = this.currentIyRange;
    const grid: GridResponse["grid"] = [];
    for (let iy = iyMin; iy <= iyMax; iy++) {
      for (let ix = ixMin; ix <= ixMax; ix++) {
        const hourly = this.gridCache.hourlyAt(step, ix, iy);
        grid.push({ lat: iy * step, lon: ix * step, hourly: hourly as any });
      }
    }
    return {
      cols: ixMax - ixMin + 1,
      rows: iyMax - iyMin + 1,
      bbox: [ixMin * step, iyMin * step, ixMax * step, iyMax * step],
      grid,
      generated_at: new Date().toISOString(),
    };
  }

  /** Compatibilidad con MonitoringController, que llama `ensureGrid?.()`
   *  (con `?.` opcional) antes de arrancar el viento. */
  async ensureGrid() {
    await this.ensureCoverageForViewport();
  }

  destroy() {
    for (const l of Array.from(this.active)) this.removeLayer(l);
    this.active.clear();
  }
}
