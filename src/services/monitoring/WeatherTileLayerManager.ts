// src/services/monitoring/WeatherTileLayerManager.ts
//
// Implementación simplificada:
// - Una sola capa raster (BASE).
// - Los tiles se sirven directamente desde Supabase Storage (CDN).
// - Sin Edge Function.
// - Sin consultas a Postgres.
// - Sin prefetch.
// - El cron actualiza/sobrescribe automáticamente los PNG del bucket.
// - El frontend únicamente refresca la URL para que Mapbox vuelva a pedir
//   los tiles cuando sea necesario.

import type mapboxgl from "mapbox-gl";

const STORAGE_TILE_URL = `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/weather-tiles`;

const TILE_READY_VARIABLES = new Set(["temperature"]);
const MAX_ZOOM = 10;

export class WeatherTileLayerManager {
  private map: mapboxgl.Map;
  private active = new Set<string>();

  constructor(map: mapboxgl.Map) {
    this.map = map;
  }

  isTileReady(variable: string) {
    return TILE_READY_VARIABLES.has(variable);
  }

  async setActive(variable: string, on: boolean) {
    if (!this.isTileReady(variable)) return;

    if (on) {
      this.active.add(variable);
      this.addLayer(variable);
    } else {
      this.active.delete(variable);
      this.removeLayer(variable);
    }
  }

  setHourOffset(_: number) {
    for (const variable of this.active) {
      this.refresh(variable);
    }
  }

  private srcId(variable: string) {
    return `weather-tile-src-${variable}`;
  }

  private lyrId(variable: string) {
    return `weather-tile-lyr-${variable}`;
  }

  private tilePattern(variable: string) {
    return `${STORAGE_TILE_URL}/${variable}/{z}/{x}/{y}/0.png?v=${Date.now()}`;
  }

  private refresh(variable: string) {
    const source = this.map.getSource(this.srcId(variable)) as
      | (mapboxgl.RasterTileSource & { setTiles?: (tiles: string[]) => void })
      | undefined;

    if (source?.setTiles) {
      source.setTiles([this.tilePattern(variable)]);
    }
  }

  private addLayer(variable: string) {
    const srcId = this.srcId(variable);
    const lyrId = this.lyrId(variable);

    if (this.map.getSource(srcId)) return;

    this.map.addSource(srcId, {
      type: "raster",
      tiles: [this.tilePattern(variable)],
      tileSize: 256,
      minzoom: 0,
      maxzoom: MAX_ZOOM,
      volatile: false,
    } as mapboxgl.RasterSourceSpecification);

    this.map.addLayer({
      id: lyrId,
      type: "raster",
      source: srcId,
      paint: {
        "raster-opacity": 0.72,
        "raster-fade-duration": 250,
        "raster-resampling": "linear",
      },
    });
  }

  private removeLayer(variable: string) {
    const lyrId = this.lyrId(variable);
    const srcId = this.srcId(variable);

    if (this.map.getLayer(lyrId)) this.map.removeLayer(lyrId);
    if (this.map.getSource(srcId)) this.map.removeSource(srcId);
  }

  destroy() {
    for (const variable of Array.from(this.active)) {
      this.removeLayer(variable);
    }
    this.active.clear();
  }
}
