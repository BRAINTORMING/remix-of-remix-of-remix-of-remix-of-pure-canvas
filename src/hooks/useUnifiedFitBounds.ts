import { useRef, useCallback, useEffect } from 'react';
import mapboxgl from 'mapbox-gl';

interface FitBoundsOptions {
  /** Debounce delay in ms */
  debounceMs?: number;
  /** Default padding */
  padding?: number;
  /** Max zoom level */
  maxZoom?: number;
  /** Animation duration */
  duration?: number;
  /** Called when there are no coordinates left to fit (all filters cleared) */
  onEmpty?: () => void;
}

/**
 * Unified fitBounds hook that collects coordinates from all filter sources
 * and performs a single debounced fitBounds call.
 */
export function useUnifiedFitBounds(
  map: React.RefObject<mapboxgl.Map | null>,
  options: FitBoundsOptions = {}
) {
  const {
    debounceMs = 200,
    padding = 80,
    maxZoom = 14,
    duration = 1800,
    onEmpty,
  } = options;

  const onEmptyRef = useRef(onEmpty);
  onEmptyRef.current = onEmpty;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const coordsRef = useRef<Map<string, [number, number][]>>(new Map());
  const triggerRef = useRef(0);
  const hadCoordsRef = useRef(false);

  /**
   * Register coordinates for a source (e.g., 'comunas', 'poligonos', 'activos', 'proyectos')
   * Pass empty array to clear that source.
   */
  const setSourceCoords = useCallback((source: string, coords: [number, number][]) => {
    if (coords.length === 0) {
      coordsRef.current.delete(source);
    } else {
      coordsRef.current.set(source, coords);
    }
  }, []);

  /**
   * Trigger a debounced fitBounds with all registered coordinates.
   * Options allow focusing on a subset of sources (e.g. only 'planRegulador')
   * and overriding padding/zoom/duration for a snappier, tighter fit.
   */
  const triggerFitBounds = useCallback((opts?: {
    only?: string[];
    padding?: number;
    maxZoom?: number;
    duration?: number;
    debounceMs?: number;
    /** Skip the empty-fallback (do not zoom out when nothing is registered) */
    skipEmptyFallback?: boolean;
  }) => {
    if (timerRef.current) clearTimeout(timerRef.current);

    const wait = opts?.debounceMs ?? debounceMs;

    timerRef.current = setTimeout(() => {
      if (!map.current) return;

      // Collect coordinates (optionally restricted to specific sources)
      let allCoords: [number, number][] = [];
      let usedSources = 0;
      coordsRef.current.forEach((coords, source) => {
        if (opts?.only && !opts.only.includes(source)) return;
        usedSources++;
        allCoords.push(...coords);
      });

      // If the restricted subset is empty, fall back to everything registered
      if (allCoords.length === 0 && opts?.only) {
        allCoords = [];
        usedSources = 0;
        coordsRef.current.forEach((coords) => {
          usedSources++;
          allCoords.push(...coords);
        });
      }

      if (allCoords.length === 0) {
        // Nothing left on the map: zoom back out instead of silently doing nothing.
        if (!opts?.skipEmptyFallback && hadCoordsRef.current) {
          hadCoordsRef.current = false;
          try { map.current.stop(); } catch { /* noop */ }
          onEmptyRef.current?.();
        }
        return;
      }

      hadCoordsRef.current = true;

      // Cancel any in-flight camera animation so rapid toggles never get stuck.
      try { map.current.stop(); } catch { /* noop */ }

      const effPadding = opts?.padding ?? padding;
      const effMaxZoom = opts?.maxZoom ?? maxZoom;
      const effDuration = opts?.duration ?? duration;

      if (allCoords.length === 1) {
        map.current.flyTo({
          center: allCoords[0],
          zoom: Math.min(14, effMaxZoom),
          duration: effDuration,
          essential: true,
        });
        return;
      }

      const bounds = allCoords.reduce(
        (b, coord) => b.extend(coord),
        new mapboxgl.LngLatBounds(allCoords[0], allCoords[0])
      );

      // Smart padding: more padding when fewer sources, less when showing full country
      const sourceCount = usedSources;
      const dynamicPadding = sourceCount <= 1 ? effPadding : Math.max(40, effPadding - sourceCount * 10);

      // Smart maxZoom: if single polygon, allow closer zoom
      const totalPoints = allCoords.length;
      const dynamicMaxZoom = totalPoints <= 20 ? effMaxZoom + 2 : effMaxZoom;

      map.current.fitBounds(bounds, {
        padding: dynamicPadding,
        maxZoom: dynamicMaxZoom,
        duration: effDuration,
        essential: true,
      });
    }, wait);
  }, [map, debounceMs, padding, maxZoom, duration]);


  /**
   * Clear all sources and optionally trigger a reset.
   */
  const clearAll = useCallback(() => {
    coordsRef.current.clear();
    hadCoordsRef.current = false;
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  /**
   * Get total count of visible elements across all sources.
   */
  const getTotalCount = useCallback((): Map<string, number> => {
    const counts = new Map<string, number>();
    coordsRef.current.forEach((coords, source) => {
      counts.set(source, coords.length);
    });
    return counts;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return {
    setSourceCoords,
    triggerFitBounds,
    clearAll,
    getTotalCount,
  };
}
