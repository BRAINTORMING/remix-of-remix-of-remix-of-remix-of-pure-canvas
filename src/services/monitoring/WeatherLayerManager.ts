// src/services/monitoring/WeatherTileLayerManager.ts
import mapboxgl from "mapbox-gl";

const TILE_FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/weather-tile`;

const TILE_READY_VARIABLES = new Set(["temperature", "precipitation"]);

// ---------------------------------------------------------------------------
// Post-proceso client-side EXCLUSIVO para precipitation.
//
// El PNG que devuelve la Edge Function viene con fondo blanco opaco. En vez
// de tocar el backend, interceptamos únicamente las tiles de "precipitation"
// con un protocolo custom de Mapbox: las bajamos, las pintamos en un canvas,
// volvemos transparente todo lo que es blanco/casi-blanco y aplicamos un
// blur para difuminar el contenido. El resultado (ya procesado) es lo que
// Mapbox termina renderizando. "temperature" nunca pasa por acá: sigue
// pidiendo su URL https normal, sin ningún cambio de comportamiento.
// ---------------------------------------------------------------------------
const PRECIP_PROTOCOL = "precip-fx";

// Umbral RGB desde el cual un pixel se considera "blanco" y se hace
// transparente. 0-255. Subilo (ej. 253) si querés ser más estricto y solo
// sacar el blanco puro; bajalo (ej. 235) si el fondo tiene blancos "sucios".
const WHITE_THRESHOLD = 240;

// Radio del blur en px aplicado sobre cada tile de 256x256 para difuminar
// el contenido. Ajustable.
const PRECIP_BLUR_PX = 3;

let precipProtocolRegistered = false;

function ensurePrecipProtocolRegistered() {
  if (precipProtocolRegistered) return;
  precipProtocolRegistered = true;

  mapboxgl.addProtocol(PRECIP_PROTOCOL, async (params, abortController) => {
    const realUrl = params.url.replace(`${PRECIP_PROTOCOL}://`, "");
    const res = await fetch(realUrl, { signal: abortController?.signal as AbortSignal | undefined });
    if (!res.ok) throw new Error(`precip tile fetch failed: ${res.status}`);
    const blob = await res.blob();
    const buffer = await processPrecipTileBlob(blob);
    return { data: buffer };
  });
}

async function processPrecipTileBlob(blob: Blob): Promise<ArrayBuffer> {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;

  // 1) Difuminar el contenido.
  ctx.filter = `blur(${PRECIP_BLUR_PX}px)`;
  ctx.drawImage(bitmap, 0, 0);
  ctx.filter = "none";

  // 2) Blanco → transparente (pixel a pixel).
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (r >= WHITE_THRESHOLD && g >= WHITE_THRESHOLD && b >= WHITE_THRESHOLD) {
      d[i + 3] = 0;
    }
  }
  ctx.putImageData(imgData, 0, 0);

  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  return await outBlob.arrayBuffer();
}

const BASE_MAX_ZOOM = 3;
const DETAIL_MIN_ZOOM = 4;
const DETAIL_MAX_ZOOM = 12;

// Máximo de requests en vuelo al mismo tiempo durante el prefetch de la
// base. Antes se disparaban hasta 64 en paralelo (z=3) y eso saturaba el
// pool de conexiones/requests de todo el proyecto Supabase, tirando abajo
// consultas de otras tablas (poligonos, plan_regulador, etc.). Con esto
// se procesan de a poco, sin perder el prefetch.
const MAX_CONCURRENT_PREFETCH = 4;

export class WeatherTileLayerManager {
  private map: mapboxgl.Map;
  private hourOffset = 0;
  private active = new Set<string>();
  private prefetched = new Set<string>();

  constructor(map: mapboxgl.Map) {
    this.map = map;
    ensurePrecipProtocolRegistered();
  }

  isTileReady(variable: string) {
    return TILE_READY_VARIABLES.has(variable);
  }

  async setActive(variable: string, on: boolean) {
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

    for (const v of this.active) {
      this.retile(this.baseSrcId(v), v);
      this.retile(this.detailSrcId(v), v);
      this.schedulePrefetch(v);
    }
  }

  private retile(srcId: string, variable: string) {
    const src = this.map.getSource(srcId) as
      | (mapboxgl.RasterTileSource & { setTiles?: (t: string[]) => void })
      | undefined;
    if (src && typeof src.setTiles === "function") {
      src.setTiles([this.tilePattern(variable)]);
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

  private tilePattern(variable: string) {
    const url = `${TILE_FN_URL}/${variable}/{z}/{x}/{y}?hour=${this.hourOffset}`;
    // Solo precipitation pasa por el protocolo de post-proceso (blanco
    // transparente + blur). El resto (temperature, etc.) mantiene el
    // comportamiento actual sin ningún cambio.
    if (variable === "precipitation") {
      return `${PRECIP_PROTOCOL}://${url}`;
    }
    return url;
  }

  private tileUrl(variable: string, z: number, x: number, y: number) {
    return `${TILE_FN_URL}/${variable}/${z}/${x}/${y}?hour=${this.hourOffset}`;
  }

  private schedulePrefetch(variable: string) {
    const key = `${variable}:${this.hourOffset}`;
    if (this.prefetched.has(key)) return;
    this.prefetched.add(key);

    const run = () => this.prefetchBaseTiles(variable).catch(() => {});
    if (typeof (window as any).requestIdleCallback === "function") {
      (window as any).requestIdleCallback(run, { timeout: 1500 });
    } else {
      setTimeout(run, 250);
    }
  }

  private async prefetchBaseTiles(variable: string) {
    const jobs: (() => Promise<unknown>)[] = [];
    for (let z = 0; z <= BASE_MAX_ZOOM; z++) {
      const max = 1 << z;
      for (let x = 0; x < max; x++) {
        for (let y = 0; y < max; y++) {
          jobs.push(() =>
            fetch(this.tileUrl(variable, z, x, y), { cache: "force-cache" }).catch(() => {}),
          );
        }
      }
    }

    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        await job();
      }
    };
    await Promise.all(
      Array.from({ length: MAX_CONCURRENT_PREFETCH }, () => worker()),
    );
  }

  private addLayer(variable: string) {
    const baseSrcId = this.baseSrcId(variable);
    const baseLyrId = this.baseLyrId(variable);
    if (!this.map.getSource(baseSrcId)) {
      this.map.addSource(baseSrcId, {
        type: "raster",
        tiles: [this.tilePattern(variable)],
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

    const detailSrcId = this.detailSrcId(variable);
    const detailLyrId = this.detailLyrId(variable);
    if (!this.map.getSource(detailSrcId)) {
      this.map.addSource(detailSrcId, {
        type: "raster",
        tiles: [this.tilePattern(variable)],
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
