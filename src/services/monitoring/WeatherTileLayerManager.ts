// src/services/monitoring/WeatherTileLayerManager.ts
import type mapboxgl from "mapbox-gl";

const STORAGE_BASE_URL = `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/weather-tiles`;

const TILE_READY_VARIABLES = new Set(["temperature"]);

export class WeatherTileLayerManager {
  private map: mapboxgl.Map;
  private active = new Set<string>();

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
    } else {
      this.active.delete(variable);
      this.removeLayer(variable);
    }
  }

  setHourOffset(_h: number) {
    for (const v of this.active) {
      this.retile(v);
    }
  }

  private retile(variable: string) {
    const src = this.map.getSource(this.srcId(variable)) as
      | (mapboxgl.RasterTileSource & { setTiles?: (t: string[]) => void })
      | undefined;
    if (src && typeof src.setTiles === "function") {
      src.setTiles([this.tilePattern(variable)]);
    }
  }

  private srcId(v: string) {
    return `weather-tile-src-${v}`;
  }
  private lyrId(v: string) {
    return `weather-tile-lyr-${v}`;
  }

  private tilePattern(variable: string) {
    return `${STORAGE_BASE_URL}/${variable}/{z}/{x}/{y}/0.png`;
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
      maxzoom: 12,
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
    const srcId = this.srcId(variable);
    const lyrId = this.lyrId(variable);
    if (this.map.getLayer(lyrId)) this.map.removeLayer(lyrId);
    if (this.map.getSource(srcId)) this.map.removeSource(srcId);
  }

  destroy() {
    for (const v of Array.from(this.active)) this.removeLayer(v);
    this.active.clear();
  }
}
