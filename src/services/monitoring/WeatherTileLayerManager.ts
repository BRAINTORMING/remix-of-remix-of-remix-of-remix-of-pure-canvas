// src/services/monitoring/WeatherTileLayerManager.ts
//
// Dos fuentes por variable, con dos orígenes de datos distintos:
// - "base": pirámide global z=0..BASE_MAX_ZOOM leída directo del bucket
//   público de Storage (PNG estáticos, refrescados por el cron). No pasa
//   por la Edge Function ni por Postgres, así que se puede prefetchear
//   agresivo sin arriesgar la base de datos. Cubre todo el planeta gracias
//   al overzoom nativo de Mapbox más allá de su maxzoom.
// - "detail": minzoom=DETAIL_MIN_ZOOM, servida por la Edge Function
//   weather-tile (necesita generar al vuelo según la hora seleccionada).
//   Sin prefetch: Mapbox la pide sola, solo para lo que el usuario está
//   mirando, así el volumen de consultas a Postgres se mantiene bajo.
import type mapboxgl from "mapbox-gl";

const STORAGE_BASE_URL = `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/weather-tiles`;
const TILE_FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/weather-tile`;

const TILE_READY_VARIABLES = new Set(["temperature"]);

// Tope de la pirámide BASE: z=0..3 => 1+4+16+64 = 85 tiles. Cubre el
// planeta entero, es barato (Storage/CDN, sin DB), y es lo único que
// se prefetchea.
const BASE_MAX_ZOOM = 3;

// A partir de qué zoom empieza a pedirse la capa de DETALLE (Edge Function).
const DETAIL_MIN_ZOOM = 4;
const DETAIL_MAX_ZOOM = 12;

export class WeatherTileLayerManager {
  private map: mapboxgl.Map;
  private hourOffset = 0;
  private active = new Set<string>();

  // Evita repetir el prefetch de la base para la misma variable.
  private prefetched = new Set<string>();

  constructor(map: mapboxgl.Map) {
    this.map = map;
  }

  isTileReady(variable: string) {
    return TILE_READY_VARIABLES.has(variable);
  }

  setActive(variable: string, on: boolean) {
    if (!this.isTileReady(variable)) return;

    if (on) {
      this.active.add(variable);
      this.addLayer(variable);
      this.schedulePrefetch(variable);
    } else {
      this.active.delete(variable);
      this.removeLayer(variable);
    }
  }

  setHourOffset(h: number) {
    if (this.hourOffset === h) return;
    this.hourOffset = h;

    // Solo la capa de DETALLE depende de la hora (la genera la Edge
    // Function al vuelo). La capa BASE viene del cron y siempre muestra
    // el dato más reciente, sin importar la hora seleccionada.
    for (const v of this.active) {
      this.retile(this.detailSrcId(v), v);
    }
  }

  private retile(srcId: string, variable: string) {
    const src = this.map.getSource(srcId) as
      | (mapboxgl.RasterTileSource & { setTiles?: (t: string[]) => void })
      | undefined;
    if (src && typeof src.setTiles === "function") {
      src.setTiles([this.detailTilePattern(variable)]);
    }
  }

  private baseSrcId(v: string) {
    return `weather-tile-src-${v}-base`;
  }
  private baseLyrId(v: string) {
    return `weather-tile-lyr-${v}-base`;
  }
  private detailSrcId(v: string) {
    return `weather-tile-src-${v}-detail`;
  }
  private detailLyrId(v: string) {
    return `weather-tile-lyr-${v}-detail`;
  }

  private baseTilePattern(variable: string) {
    return `${STORAGE_BASE_URL}/${variable}/{z}/{x}/{y}/0.png`;
  }

  private baseTileUrl(variable: string, z: number, x: number, y: number) {
    return `${STORAGE_BASE_URL}/${variable}/${z}/${x}/${y}/0.png`;
  }

  private detailTilePattern(variable: string) {
    return `${TILE_FN_URL}/${variable}/{z}/{x}/{y}?hour=${this.hourOffset}`;
  }

  private schedulePrefetch(variable: string) {
    if (this.prefetched.has(variable)) return;
    this.prefetched.add(variable);

    // No bloqueamos el hilo principal; disparamos en idle para no competir
    // con el render inicial. Va directo a Storage (CDN estático), no toca
    // Postgres ni la Edge Function.
    const run = () => this.prefetchBaseTiles(variable).catch(() => {});
    if (typeof (window as any).requestIdleCallback === "function") {
      (window as any).requestIdleCallback(run, { timeout: 1500 });
    } else {
      setTimeout(run, 250);
    }
  }

  private async prefetchBaseTiles(variable: string) {
    // Prefetch por niveles, del más bajo al más alto: primero cubrimos
    // el globo, luego afinamos dentro del rango de la base. Cada nivel
    // espera al anterior para no saturar la red.
    for (let z = 0; z <= BASE_MAX_ZOOM; z++) {
      const max = 1 << z;
      const batch: Promise<unknown>[] = [];
      for (let x = 0; x < max; x++) {
        for (let y = 0; y < max; y++) {
          batch.push(
            fetch(this.baseTileUrl(variable, z, x, y), { cache: "force-cache" }).catch(() => {}),
          );
        }
      }
      await Promise.allSettled(batch);
    }
  }

  private addLayer(variable: string) {
    // Capa BASE: pirámide global de baja resolución servida por Storage.
    // Se limita su maxzoom a BASE_MAX_ZOOM — más allá de eso Mapbox la
    // overzoomea (estira el último nivel) automáticamente, así que
    // siempre hay algo dibujado en cualquier lugar del planeta.
    const baseSrcId = this.baseSrcId(variable);
    const baseLyrId = this.baseLyrId(variable);
    if (!this.map.getSource(baseSrcId)) {
      this.map.addSource(baseSrcId, {
        type: "raster",
        tiles: [this.baseTilePattern(variable)],
        tileSize: 256,
        minzoom: 0,
        maxzoom: BASE_MAX_ZOOM,
        volatile: false,
      } as mapboxgl.RasterSourceSpecification);

      this.map.addLayer({
        id: baseLyrId,
        type: "raster",
        source: baseSrcId,
        paint: {
          "raster-opacity": 0.72,
          "raster-fade-duration": 250,
          "raster-resampling": "linear",
        },
      });
    }

    // Capa DETALLE: sin prefetch, servida por la Edge Function. Mapbox
    // pide sola cada tile, solo cuando el usuario hace zoom/pan sobre esa
    // zona real, manteniendo bajo el volumen de consultas a Postgres.
    const detailSrcId = this.detailSrcId(variable);
    const detailLyrId = this.detailLyrId(variable);
    if (!this.map.getSource(detailSrcId)) {
      this.map.addSource(detailSrcId, {
        type: "raster",
        tiles: [this.detailTilePattern(variable)],
        tileSize: 256,
        minzoom: DETAIL_MIN_ZOOM,
        maxzoom: DETAIL_MAX_ZOOM,
        volatile: false,
      } as mapboxgl.RasterSourceSpecification);

      this.map.addLayer({
        id: detailLyrId,
        type: "raster",
        source: detailSrcId,
        paint: {
          "raster-opacity": 0.72,
          "raster-fade-duration": 250,
          "raster-resampling": "linear",
        },
      });
    }
  }

  private removeLayer(variable: string) {
    for (const [srcId, lyrId] of [
      [this.detailSrcId(variable), this.detailLyrId(variable)],
      [this.baseSrcId(variable), this.baseLyrId(variable)],
    ]) {
      if (this.map.getLayer(lyrId)) this.map.removeLayer(lyrId);
      if (this.map.getSource(srcId)) this.map.removeSource(srcId);
    }
  }

  destroy() {
    for (const v of Array.from(this.active)) this.removeLayer(v);
    this.active.clear();
    this.prefetched.clear();
  }
}
