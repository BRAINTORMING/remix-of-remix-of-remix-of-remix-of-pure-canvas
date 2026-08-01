import { useEffect, useRef, useState, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import 'mapbox-gl/dist/mapbox-gl.css';
import { externalSupabase as supabase } from '@/integrations/supabase/externalClient';
import { useAuth } from '@/contexts/AuthContext';
import { isRegionAllowed } from '@/lib/regionUtils';
import { Button } from './ui/button';
import { X } from 'lucide-react';
import SearchBar from './SearchBar';
import { COMUNAS_TARAPACA, type PoligonoData, type PlanReguladorData } from './ActivosLayerControl';
import { type Proyecto } from '@/hooks/useProyectos';
import { usePointInPolygon } from '@/hooks/usePointInPolygon';
import { useUnifiedFitBounds } from '@/hooks/useUnifiedFitBounds';
import MapResultsCounter from './MapResultsCounter';
import MapDetailPanel from './MapDetailPanel';
import { summaryHTML, openDetailPanel } from '@/lib/mapPopups';
import MapStyleSelector, { getStoredMapStyle } from './MapStyleSelector';
import MonitoringController from './monitoring/MonitoringController';
import {
  CORREDOR_ROUTES,
  CORREDOR_EVENT,
  CORREDOR_BASE_COLOR,
  CORREDOR_BASE_WIDTH,
  CORREDOR_HIGHLIGHT_WIDTH,
  corredorSourceId,
  corredorLayerId,
  corredorCasingId,
  type CorredorSelectionDetail,
} from '@/lib/corredorBioceanico';

interface ActivoMapa {
  id: string;
  capa: string;
  categoria: string;
  region: string;
  comuna: string | null;
  latitud: number;
  longitud: number;
  icono: string | null;
  tipo: string;
  potencial: number | null;
  etiqueta: string;
  descripcion: string | null;
  fuente_datos: string | null;
  image: string | null;
  faena_explotacion: string | null;
  minerales: string | null;
  direccion_oficina: string | null;
  datos_contacto: string | null;
  website: string | null;
}

interface MapViewProps {
  filters?: { capas: string[]; categorias: string[]; comunas: string[]; poligonos: PoligonoData[]; planRegulador: PlanReguladorData[] };
  onMapReady?: (zoomToCoords: (coords: Array<[number, number]>) => void) => void;
  onResetView?: boolean;
  isMobile?: boolean;
  onFiltersApply?: (filters: { capas: string[]; categorias: string[]; comunas: string[]; medioambienteKeys: string[]; activateAllPlanRegulador?: boolean; pricQueryPoint?: { lat: number; lng: number } }) => void;
  availableCapas?: { capa: string; categorias: string[] }[];
  availableMedioambiente?: { capa: string; categorias: { categoria: string; etiquetas: string[] }[] }[];
  proyectosFiltrados?: Proyecto[];
  allProyectos?: Proyecto[];
  sidebarCollapsed?: boolean;
  pricQueryPoint?: { lat: number; lng: number } | null;
  onPricFormOpenChange?: (open: boolean) => void;
  allPoligonos?: PoligonoData[];
  allPlanRegulador?: PlanReguladorData[];
}

export default function MapView({ 
  filters = { capas: [], categorias: [], comunas: [], poligonos: [], planRegulador: [] },
  onMapReady, 
  onResetView, 
  isMobile = false,
  onFiltersApply,
  availableCapas = [],
  availableMedioambiente = [],
  proyectosFiltrados = [],
  allProyectos = [],
  sidebarCollapsed = false,
  pricQueryPoint = null,
  onPricFormOpenChange,
  allPoligonos = [],
  allPlanRegulador = []
}: MapViewProps) {
  const INITIAL_CENTER: [number, number] = [-70, -20];
  const INITIAL_ZOOM = 1.5;
  
  // Result counts for the counter overlay
  const [resultCounts, setResultCounts] = useState<{
    comunas?: number; activos?: number; poligonos?: number; planRegulador?: number; proyectos?: number;
  }>({});
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const draw = useRef<MapboxDraw | null>(null);
  const lastResetFlag = useRef<boolean>(false);
  const activePopup = useRef<mapboxgl.Popup | null>(null);
  const userInteracting = useRef(false);
  const spinEnabled = useRef(true);
  const prevProyectosRef = useRef<Proyecto[]>([]);
  const [loading, setLoading] = useState(true);
  const [activos, setActivos] = useState<ActivoMapa[]>([]);
  const [activoMarkers, setActivoMarkers] = useState<mapboxgl.Marker[]>([]);
  
  // Geographic filtering by selected comunas
  const { isPointInSelectedComunas, isPolygonInSelectedComunas, hasSelectedComunas } = usePointInPolygon(filters.comunas || []);
  
  // Globe rotation configuration
  const SECONDS_PER_REVOLUTION = 120;
  const MAX_SPIN_ZOOM = 5;
  const SLOW_SPIN_ZOOM = 3;

  // Function to spin the globe
  const spinGlobe = () => {
    if (!map.current) return;
    
    const zoom = map.current.getZoom();
    if (spinEnabled.current && !userInteracting.current && zoom < MAX_SPIN_ZOOM) {
      let distancePerSecond = 360 / SECONDS_PER_REVOLUTION;
      if (zoom > SLOW_SPIN_ZOOM) {
        const zoomDif = (MAX_SPIN_ZOOM - zoom) / (MAX_SPIN_ZOOM - SLOW_SPIN_ZOOM);
        distancePerSecond *= zoomDif;
      }
      const center = map.current.getCenter();
      center.lng -= distancePerSecond;
      map.current.easeTo({ center, duration: 1000, easing: (n) => n });
    }
  };
  const [proyectoMarkers, setProyectoMarkers] = useState<mapboxgl.Marker[]>([]);
  const [selectedCoords, setSelectedCoords] = useState<{ lat: number; lng: number } | null>(null);
  const tarapacaMarker = useRef<mapboxgl.Marker | null>(null);
  
  // Unified fitBounds system
  const { setSourceCoords, triggerFitBounds, clearAll: clearAllBounds } = useUnifiedFitBounds(map, {
    debounceMs: 200,
    padding: 80,
    maxZoom: 14,
    duration: 1800,
  });
  const loadedComunasRef = useRef<Set<string>>(new Set());
  const loadedPoligonosRef = useRef<Set<string>>(new Set());
  const loadedPlanReguladorRef = useRef<Set<string>>(new Set());
  const pricMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const radialPickModeRef = useRef<boolean>(false);
  const pricPickModeRef = useRef<boolean>(false);
  const radialMarkerRef = useRef<mapboxgl.Marker | null>(null);

  // Radial analysis state — drives spatial filtering across all renders.
  const [radialState, setRadialState] = useState<{ active: boolean; center: { lat: number; lng: number } | null; radiusKm: number }>(
    { active: false, center: null, radiusKm: 10 }
  );
  const radialActive = radialState.active && !!radialState.center;

  // PRIC evaluation zone-focus mode. When set, plan regulador and
  // medioambiente rendering are filtered to only the zones involved.
  const [pricEvalZones, setPricEvalZones] = useState<string[] | null>(null);

  // Bumped after a basemap style swap so every layer effect re-applies
  // the current filters onto the fresh style (no filters are lost).
  const [styleEpoch, setStyleEpoch] = useState(0);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      setRadialState({
        active: !!detail.active,
        center: detail.center || null,
        radiusKm: typeof detail.radiusKm === 'number' ? detail.radiusKm : 10,
      });
    };
    window.addEventListener('radial:set', handler);
    return () => window.removeEventListener('radial:set', handler);
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { zones?: string[] | null } | undefined;
      const zones = detail?.zones;
      setPricEvalZones(Array.isArray(zones) && zones.length > 0 ? zones : null);
    };
    window.addEventListener('pric:evalResult', handler);
    return () => window.removeEventListener('pric:evalResult', handler);
  }, []);

  // ===== Oportunidades: coherent zoom + restore =====
  // Save the current camera when the Oportunidades panel opens, allow the
  // panel to request a fit/flyTo when a result arrives, and restore the
  // original camera when the panel closes or the user switches away.
  useEffect(() => {
    const saved: { current: null | { center: [number, number]; zoom: number; bearing: number; pitch: number } } = { current: null };

    const saveCamera = () => {
      if (!map.current || saved.current) return;
      const c = map.current.getCenter();
      saved.current = {
        center: [c.lng, c.lat],
        zoom: map.current.getZoom(),
        bearing: map.current.getBearing(),
        pitch: map.current.getPitch(),
      };
    };

    const onOpen = () => saveCamera();

    const onFit = (e: Event) => {
      if (!map.current) return;
      saveCamera();
      const detail = (e as CustomEvent).detail as
        | { points?: [number, number][]; center?: { lat: number; lng: number }; zoom?: number; padding?: number }
        | undefined;
      if (!detail) return;
      const pts = (detail.points || []).filter(
        (p): p is [number, number] => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
      );
      const padding = detail.padding ?? 120;
      const maxZoom = detail.zoom ?? 14;
      if (pts.length >= 2) {
        const bounds = pts.reduce((b, c) => b.extend(c), new mapboxgl.LngLatBounds(pts[0], pts[0]));
        map.current.fitBounds(bounds, { padding, maxZoom, duration: 1000, essential: true });
      } else {
        const c = detail.center
          ? ([detail.center.lng, detail.center.lat] as [number, number])
          : pts[0];
        if (!c) return;
        map.current.flyTo({ center: c, zoom: maxZoom, duration: 1000, essential: true });
      }
    };

    const onClose = () => {
      if (!map.current || !saved.current) return;
      map.current.flyTo({ ...saved.current, duration: 900, essential: true });
      saved.current = null;
    };

    window.addEventListener('oportunidades:panelOpen', onOpen);
    window.addEventListener('oportunidades:fit', onFit as EventListener);
    window.addEventListener('oportunidades:panelClose', onClose);
    return () => {
      window.removeEventListener('oportunidades:panelOpen', onOpen);
      window.removeEventListener('oportunidades:fit', onFit as EventListener);
      window.removeEventListener('oportunidades:panelClose', onClose);
    };
  }, []);

  // Match a value against active PRIC eval zone codes (case-insensitive substring).
  const matchesPricEvalZone = useCallback((...vals: (string | null | undefined)[]) => {
    if (!pricEvalZones || pricEvalZones.length === 0) return true;
    const zonesLower = pricEvalZones.map(z => z.toLowerCase());
    return vals.some(v => {
      if (!v) return false;
      const vl = v.toLowerCase();
      return zonesLower.some(z => vl.includes(z) || z.includes(vl));
    });
  }, [pricEvalZones]);

  // Auto-close detail card whenever the user shifts focus to a different
  // dataset (filter change, radial toggle, search-driven results, etc.).
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('map:close-detail'));
    // Also collapse the radial summary panel — it should only show when the
    // user explicitly clicks the radial center marker.
    window.dispatchEvent(new CustomEvent('radial:closeSummary'));
  }, [
    filters.capas.join('|'),
    filters.categorias.join('|'),
    filters.comunas.join('|'),
    filters.poligonos.length,
    filters.planRegulador.length,
    radialState.active,
    radialState.center?.lat,
    radialState.center?.lng,
    proyectosFiltrados.length,
  ]);


  // When radial is active, boost the visual weight of all loaded polygon layers
  // (medioambiente + plan regulador) so the ones falling inside the circle pop.
  // When radial turns off, restore the default styling.
  useEffect(() => {
    const m = map.current;
    if (!m || !m.isStyleLoaded()) return;

    const apply = (fillId: string, outlineId: string, glowId: string) => {
      if (!m.getLayer(fillId)) return;
      if (radialActive) {
        m.setPaintProperty(fillId, 'fill-opacity', 0.85);
        if (m.getLayer(outlineId)) {
          m.setPaintProperty(outlineId, 'line-width', 5);
          m.setPaintProperty(outlineId, 'line-color', '#FFD400');
        }
        if (m.getLayer(glowId)) {
          m.setPaintProperty(glowId, 'line-width', 22);
          m.setPaintProperty(glowId, 'line-opacity', 1);
          m.setPaintProperty(glowId, 'line-color', '#FFB300');
        }
      } else {
        m.setPaintProperty(fillId, 'fill-opacity', 0.5);
        if (m.getLayer(outlineId)) m.setPaintProperty(outlineId, 'line-width', 2.5);
        if (m.getLayer(glowId)) {
          m.setPaintProperty(glowId, 'line-width', 10);
          m.setPaintProperty(glowId, 'line-opacity', 0.55);
        }
      }
    };

    loadedPoligonosRef.current.forEach(key => {
      const safe = key.replace(/[^a-zA-Z0-9]/g, '-');
      apply(`poligono-${safe}-fill`, `poligono-${safe}-outline`, `poligono-${safe}-glow`);
    });
    loadedPlanReguladorRef.current.forEach(key => {
      const safe = key.replace(/[^a-zA-Z0-9]/g, '-');
      apply(`planregulador-${safe}-fill`, `planregulador-${safe}-outline`, `planregulador-${safe}-glow`);
    });
  }, [radialActive, radialState.radiusKm, radialState.center, filters.poligonos, filters.planRegulador]);

  // Haversine distance in km
  const haversineKm = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
    const R = 6371;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  };

  const isPointInRadius = useCallback((lat: number, lng: number): boolean => {
    if (!radialActive || !radialState.center) return true;
    return haversineKm(radialState.center.lat, radialState.center.lng, lat, lng) <= radialState.radiusKm;
  }, [radialActive, radialState.center, radialState.radiusKm]);

  // True if a polygon (GeoJSON string) intersects the radial circle.
  // Approximation: centroid inside OR any vertex inside the radius.
  const polygonIntersectsRadius = useCallback((geoJsonString: string): boolean => {
    if (!radialActive || !radialState.center) return true;
    try {
      const verts: [number, number][] = [];
      const parsed = JSON.parse(geoJsonString);
      const walk = (g: any) => {
        if (!g) return;
        if (g.type === 'FeatureCollection') g.features?.forEach((f: any) => walk(f.geometry));
        else if (g.type === 'Feature') walk(g.geometry);
        else if (g.type === 'GeometryCollection') g.geometries?.forEach(walk);
        else if (g.type === 'Polygon') g.coordinates?.[0]?.forEach((c: number[]) => verts.push([c[0], c[1]]));
        else if (g.type === 'MultiPolygon') g.coordinates?.forEach((p: number[][][]) => p[0]?.forEach((c: number[]) => verts.push([c[0], c[1]])));
        else if (g.type === 'Point') verts.push([g.coordinates[0], g.coordinates[1]]);
      };
      walk(parsed);
      for (const [lng, lat] of verts) {
        if (isPointInRadius(lat, lng)) return true;
      }
      let sx = 0, sy = 0, n = 0;
      for (const [lng, lat] of verts) { sx += lng; sy += lat; n++; }
      if (n > 0 && isPointInRadius(sy / n, sx / n)) return true;
    } catch {}
    return false;
  }, [radialActive, radialState.center, radialState.radiusKm, isPointInRadius]);

  // Calculate centroid of a polygon for label placement
  const calculatePolygonCentroid = (geojson: GeoJSON.FeatureCollection): [number, number] | null => {
    const coords: [number, number][] = [];
    
    const extractCoords = (geometry: GeoJSON.Geometry) => {
      switch (geometry.type) {
        case 'Polygon':
          geometry.coordinates[0].forEach((coord: number[]) => {
            coords.push([coord[0], coord[1]]);
          });
          break;
        case 'MultiPolygon':
          geometry.coordinates.forEach((polygon: number[][][]) => {
            polygon[0].forEach((coord: number[]) => {
              coords.push([coord[0], coord[1]]);
            });
          });
          break;
        case 'GeometryCollection':
          geometry.geometries.forEach((geom: GeoJSON.Geometry) => {
            extractCoords(geom);
          });
          break;
      }
    };
    
    geojson.features.forEach(feature => {
      if (feature.geometry) {
        extractCoords(feature.geometry);
      }
    });
    
    if (coords.length === 0) return null;
    
    const sumLng = coords.reduce((sum, c) => sum + c[0], 0);
    const sumLat = coords.reduce((sum, c) => sum + c[1], 0);
    
    return [sumLng / coords.length, sumLat / coords.length];
  };

  // Calculate centroid from GeoJSON string
  const calculateCentroidFromGeoJSON = (geoJsonString: string): [number, number] | null => {
    try {
      const geojson = JSON.parse(geoJsonString);
      const coords: [number, number][] = [];
      
      const extractCoords = (geometry: GeoJSON.Geometry) => {
        switch (geometry.type) {
          case 'Polygon':
            geometry.coordinates[0].forEach((coord: number[]) => {
              coords.push([coord[0], coord[1]]);
            });
            break;
          case 'MultiPolygon':
            geometry.coordinates.forEach((polygon: number[][][]) => {
              polygon[0].forEach((coord: number[]) => {
                coords.push([coord[0], coord[1]]);
              });
            });
            break;
          case 'GeometryCollection':
            geometry.geometries.forEach((geom: GeoJSON.Geometry) => {
              extractCoords(geom);
            });
            break;
        }
      };
      
      if (geojson.type === 'FeatureCollection') {
        geojson.features.forEach((feature: GeoJSON.Feature) => {
          if (feature.geometry) {
            extractCoords(feature.geometry);
          }
        });
      } else if (geojson.type === 'Feature') {
        if (geojson.geometry) {
          extractCoords(geojson.geometry);
        }
      } else {
        extractCoords(geojson);
      }
      
      if (coords.length === 0) return null;
      
      const sumLng = coords.reduce((sum, c) => sum + c[0], 0);
      const sumLat = coords.reduce((sum, c) => sum + c[1], 0);
      
      return [sumLng / coords.length, sumLat / coords.length];
    } catch (e) {
      console.error('Error calculating centroid:', e);
      return null;
    }
  };

  // Reactive lighting: cycles automatically through dawn/day/dusk/night based on local time.
  // Windows tuned to preserve layer/polygon legibility (avoid harsh midday wash + deep night blackout).
  const getLightPreset = (): 'dawn' | 'day' | 'dusk' | 'night' => {
    const h = new Date().getHours();
    if (h >= 5 && h < 8) return 'dawn';   // 05:00–07:59
    if (h >= 8 && h < 18) return 'day';   // 08:00–17:59
    if (h >= 18 && h < 21) return 'dusk'; // 18:00–20:59
    return 'night';                        // 21:00–04:59
  };

  // Load a comuna from GeoJSON coordinates and add to map
  const loadComunaGeoJSON = (comunaId: string, coordenadas: string, comunaNombre: string, regionName?: string): GeoJSON.FeatureCollection | null => {
    if (!map.current) return null;

    try {
      const geojsonData = JSON.parse(coordenadas) as GeoJSON.FeatureCollection | GeoJSON.Feature | GeoJSON.Geometry;
      
      // Normalize to FeatureCollection
      let normalizedData: GeoJSON.FeatureCollection;
      if (geojsonData.type === 'FeatureCollection') {
        normalizedData = geojsonData;
      } else if (geojsonData.type === 'Feature') {
        normalizedData = { type: 'FeatureCollection', features: [geojsonData] };
      } else {
        normalizedData = { 
          type: 'FeatureCollection', 
          features: [{ type: 'Feature', geometry: geojsonData, properties: {} }] 
        };
      }
      
      const sourceId = `comuna-${comunaId}-source`;
      const fillLayerId = `comuna-${comunaId}-fill`;
      const outlineLayerId = `comuna-${comunaId}-outline`;
      
      // Remove existing layers if present
      if (map.current.getSource(sourceId)) {
        if (map.current.getLayer(fillLayerId)) map.current.removeLayer(fillLayerId);
        if (map.current.getLayer(outlineLayerId)) map.current.removeLayer(outlineLayerId);
        map.current.removeSource(sourceId);
      }
      
      // Neon geospatial-intelligence palette
      const generateColor = (name: string): string => {
        const colors = [
          '#3B82F6', // azul eléctrico
          '#06B6D4', // cyan brillante
          '#EC4899', // magenta geoespacial
          '#F97316', // naranja territorial
          '#22C55E', // verde IA
          '#8B5CF6', // violeta neon
          '#14B8A6', // teal neon
          '#EAB308', // amarillo neon (limitado)
        ];
        let hash = 0;
        for (let i = 0; i < name.length; i++) {
          hash = name.charCodeAt(i) + ((hash << 5) - hash);
        }
        return colors[Math.abs(hash) % colors.length];
      };
      const color = generateColor(comunaId);
      const glowLayerId = `comuna-${comunaId}-glow`;
      
      // Calculate centroid for label placement
      const centroid = calculatePolygonCentroid(normalizedData);
      const labelSourceId = `comuna-${comunaId}-label-source`;
      const labelLayerId = `comuna-${comunaId}-label`;
      
      map.current.addSource(sourceId, {
        type: 'geojson',
        data: normalizedData,
        promoteId: 'id' as any
      } as any);

      // Fill — interno con opacidad balanceada y boost en hover
      map.current.addLayer({
        id: fillLayerId,
        type: 'fill',
        source: sourceId,
        paint: {
          'fill-color': color,
          'fill-opacity': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            0.42,
            0.24
          ],
          'fill-opacity-transition': { duration: 220 }
        },
        filter: ['==', '$type', 'Polygon']
      });

      // Borde principal — sólido, alto contraste, completamente plano (sin glow)
      map.current.addLayer({
        id: outlineLayerId,
        type: 'line',
        source: sourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            '#FFFFFF',
            color
          ],
          'line-width': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            4,
            3
          ],
          'line-opacity': 1,
          'line-width-transition': { duration: 220 }
        },
        filter: ['==', '$type', 'Polygon']
      });

      // Add label at centroid — estilo pill premium
      if (centroid) {
        if (map.current.getLayer(labelLayerId)) map.current.removeLayer(labelLayerId);
        if (map.current.getSource(labelSourceId)) map.current.removeSource(labelSourceId);
        
        map.current.addSource(labelSourceId, {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: [{
              type: 'Feature',
              geometry: { type: 'Point', coordinates: centroid },
              properties: { label: comunaNombre }
            }]
          }
        });

        map.current.addLayer({
          id: labelLayerId,
          type: 'symbol',
          source: labelSourceId,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 13,
            'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
            'text-max-width': 10,
            'text-letter-spacing': 0.04,
            'text-padding': 6,
            'text-allow-overlap': true,
            'text-ignore-placement': true
          },
          paint: {
            'text-color': '#FFFFFF',
            'text-halo-color': 'rgba(8, 15, 30, 0.92)',
            'text-halo-width': 2.2,
            'text-halo-blur': 1.2
          }
        });
      }

      // Click on comuna opens detail panel
      map.current.on('click', fillLayerId, (e) => {
        if (radialPickModeRef.current || pricPickModeRef.current) return;
        if (!e.features || e.features.length === 0) return;
        openDetailPanel({
          type: 'comuna',
          data: { comuna: comunaNombre, region: regionName },
          color,
        });
      });

      // Hover focus inteligente con feature-state
      let hoveredFeatureId: string | number | null = null;
      map.current.on('mousemove', fillLayerId, (e) => {
        if (!map.current || !e.features || e.features.length === 0) return;
        map.current.getCanvas().style.cursor = 'pointer';
        const fid = e.features[0].id;
        if (fid === undefined) return;
        if (hoveredFeatureId !== null && hoveredFeatureId !== fid) {
          map.current.setFeatureState({ source: sourceId, id: hoveredFeatureId }, { hover: false });
        }
        hoveredFeatureId = fid;
        map.current.setFeatureState({ source: sourceId, id: fid }, { hover: true });
      });

      map.current.on('mouseleave', fillLayerId, () => {
        if (!map.current) return;
        map.current.getCanvas().style.cursor = '';
        if (hoveredFeatureId !== null) {
          map.current.setFeatureState({ source: sourceId, id: hoveredFeatureId }, { hover: false });
        }
        hoveredFeatureId = null;
      });

      loadedComunasRef.current.add(comunaId);
      console.log(`Comuna ${comunaNombre} loaded successfully from GeoJSON`);
      
      return normalizedData;
    } catch (error) {
      console.error(`Error loading comuna ${comunaId}:`, error);
      return null;
    }
  };

  // Remove comuna layer from map
  const removeComunaLayer = (comunaId: string) => {
    if (!map.current) return;
    
    const sourceId = `comuna-${comunaId}-source`;
    const fillLayerId = `comuna-${comunaId}-fill`;
    const outlineLayerId = `comuna-${comunaId}-outline`;
    const glowLayerId = `comuna-${comunaId}-glow`;
    const labelSourceId = `comuna-${comunaId}-label-source`;
    const labelLayerId = `comuna-${comunaId}-label`;
    
    if (map.current.getLayer(labelLayerId)) map.current.removeLayer(labelLayerId);
    if (map.current.getLayer(fillLayerId)) map.current.removeLayer(fillLayerId);
    if (map.current.getLayer(outlineLayerId)) map.current.removeLayer(outlineLayerId);
    if (map.current.getLayer(glowLayerId)) map.current.removeLayer(glowLayerId);
    if (map.current.getSource(labelSourceId)) map.current.removeSource(labelSourceId);
    if (map.current.getSource(sourceId)) map.current.removeSource(sourceId);
    
    loadedComunasRef.current.delete(comunaId);
  };

  // Handle comunas filter changes
  useEffect(() => {
    if (!map.current || !map.current.isStyleLoaded()) return;
    
    const selectedComunas = filters.comunas || [];
    
    // Remove comunas that are no longer selected
    const comunasToRemove: string[] = [];
    loadedComunasRef.current.forEach(comunaId => {
      if (!selectedComunas.includes(comunaId)) {
        comunasToRemove.push(comunaId);
      }
    });
    comunasToRemove.forEach(comunaId => removeComunaLayer(comunaId));
    
    // If no comunas selected, clear comuna bounds source
    if (selectedComunas.length === 0) {
      setSourceCoords('comunas', []);
      setResultCounts(prev => ({ ...prev, comunas: 0 }));
      // Only reset if NO other filters are active
      const hasOtherFilters = (filters.capas?.length > 0) || (filters.categorias?.length > 0) || 
        (filters.poligonos?.length > 0) || (filters.planRegulador?.length > 0);
      if (!hasOtherFilters) {
        resetToInitialView();
      } else {
        triggerFitBounds();
      }
      return;
    }
    
    // Load all selected comunas and calculate bounds for ALL of them
    const loadComunas = () => {
      const allCoords: [number, number][] = [];
      
      // Helper function to extract all coordinates from any geometry type
      const extractCoordsFromGeometry = (geometry: GeoJSON.Geometry): [number, number][] => {
        const coords: [number, number][] = [];
        
        switch (geometry.type) {
          case 'Point':
            coords.push([geometry.coordinates[0], geometry.coordinates[1]]);
            break;
          case 'MultiPoint':
          case 'LineString':
            geometry.coordinates.forEach(coord => {
              coords.push([coord[0], coord[1]]);
            });
            break;
          case 'MultiLineString':
          case 'Polygon':
            geometry.coordinates.forEach(ring => {
              ring.forEach(coord => {
                coords.push([coord[0], coord[1]]);
              });
            });
            break;
          case 'MultiPolygon':
            geometry.coordinates.forEach(polygon => {
              polygon.forEach(ring => {
                ring.forEach(coord => {
                  coords.push([coord[0], coord[1]]);
                });
              });
            });
            break;
          case 'GeometryCollection':
            geometry.geometries.forEach(geom => {
              coords.push(...extractCoordsFromGeometry(geom));
            });
            break;
        }
        
        return coords;
      };
      
      // Load each comuna from its GeoJSON coordinates
      selectedComunas.forEach((comunaId) => {
        const comunaInfo = COMUNAS_TARAPACA.find(c => c.id === comunaId);
        if (!comunaInfo) return;
        
        // Load comuna if not already loaded
        if (!loadedComunasRef.current.has(comunaId) && comunaInfo.coordenadas) {
          const geojsonData = loadComunaGeoJSON(comunaId, comunaInfo.coordenadas, comunaInfo.nombre);
          
          // Extract coords for bounds calculation
          if (geojsonData) {
            geojsonData.features.forEach(feature => {
              if (feature.geometry) {
                allCoords.push(...extractCoordsFromGeometry(feature.geometry));
              }
            });
          }
        } else if (comunaInfo.coordenadas) {
          // Already loaded, still need coords for bounds
          try {
            const parsed = JSON.parse(comunaInfo.coordenadas);
            let normalizedData: GeoJSON.FeatureCollection;
            if (parsed.type === 'FeatureCollection') {
              normalizedData = parsed;
            } else if (parsed.type === 'Feature') {
              normalizedData = { type: 'FeatureCollection', features: [parsed] };
            } else {
              normalizedData = { 
                type: 'FeatureCollection', 
                features: [{ type: 'Feature', geometry: parsed, properties: {} }] 
              };
            }
            normalizedData.features.forEach(feature => {
              if (feature.geometry) {
                allCoords.push(...extractCoordsFromGeometry(feature.geometry));
              }
            });
          } catch (e) {
            console.error('Error parsing comuna coordinates:', e);
          }
        }
      });
      
      // Register coordinates with unified fitBounds (instead of fitting individually)
      if (allCoords.length > 0) {
        setSourceCoords('comunas', allCoords);
        setResultCounts(prev => ({ ...prev, comunas: selectedComunas.length }));
        triggerFitBounds();
      } else {
        setSourceCoords('comunas', []);
        setResultCounts(prev => ({ ...prev, comunas: 0 }));
      }
    };
    
    loadComunas();
  }, [filters.comunas]);

  // Handle poligonos (medioambiente) filter changes - with comuna filtering
  useEffect(() => {
    if (!map.current || !map.current.isStyleLoaded()) return;

    // Base set = whatever the user explicitly picked in the sidebar.
    // Note: radial analysis intentionally does NOT auto-add polygons — it acts
    // as a spatial filter on the user's own selection, so toggling filters off
    // reliably removes them from the map even while radial is active.
    const selectedPoligonos = filters.poligonos || [];

    // Filter poligonos
    const filteredPoligonos = selectedPoligonos.filter(poligono => {
      // PRIC eval mode: keep only polygons whose capa/etiqueta match the evaluated zones.
      if (!matchesPricEvalZone(poligono.capa, poligono.etiqueta, poligono.categoria)) {
        return false;
      }
      // If no comunas selected, show all
      if (!filters.comunas || filters.comunas.length === 0) {
        return true;
      }
      // Check if polygon's centroid is within selected comunas
      return isPolygonInSelectedComunas(poligono.coordenadas);
    });
    
    const selectedKeys = new Set(filteredPoligonos.map(p => `${p.capa}::${p.categoria}::${p.etiqueta || ''}`));
    
    // Remove poligonos that are no longer selected or not in comuna
    const keysToRemove: string[] = [];
    loadedPoligonosRef.current.forEach(key => {
      if (!selectedKeys.has(key)) {
        keysToRemove.push(key);
      }
    });
    keysToRemove.forEach(key => removePoligonoLayer(key));
    
    // If no poligonos selected, just return (don't reset view - let comunas handle that)
    if (filteredPoligonos.length === 0) {
      setSourceCoords('poligonos', []);
      setResultCounts(prev => ({ ...prev, poligonos: 0 }));
      return;
    }
    
    // Load all selected poligonos and calculate bounds
    const loadAndZoomPoligonos = async () => {
      const allCoords: [number, number][] = [];
      
      filteredPoligonos.forEach(poligono => {
        const key = `${poligono.capa}::${poligono.categoria}::${poligono.etiqueta || ''}`;
        
        // Load poligono if not already loaded
        if (!loadedPoligonosRef.current.has(key)) {
          const coords = loadPoligonoGeoJSON(poligono);
          allCoords.push(...coords);
        } else {
          // Extract coords from already loaded poligono
          const coords = extractCoordsFromGeoJSON(poligono.coordenadas);
          allCoords.push(...coords);
        }
      });
      
      // Register with unified fitBounds
      if (allCoords.length > 0) {
        setSourceCoords('poligonos', allCoords);
        setResultCounts(prev => ({ ...prev, poligonos: filteredPoligonos.length }));
        triggerFitBounds();
      }
    };
    
    loadAndZoomPoligonos();
  }, [filters.poligonos, filters.comunas, isPolygonInSelectedComunas, matchesPricEvalZone]);

  // Load Plan Regulador GeoJSON and add to map
  const loadPlanReguladorGeoJSON = (planRegulador: PlanReguladorData, keyOverride?: string): [number, number][] => {
    if (!map.current) return [];

    const key = keyOverride || `planregulador::${planRegulador.capa}`;
    
    if (loadedPlanReguladorRef.current.has(key)) {
      return extractCoordsFromGeoJSON(planRegulador.coordenadas);
    }


    try {
      const geojsonData = JSON.parse(planRegulador.coordenadas);
      const safeKey = key.replace(/[^a-zA-Z0-9]/g, '-');
      const sourceId = `planregulador-${safeKey}-source`;
      const fillLayerId = `planregulador-${safeKey}-fill`;
      const outlineLayerId = `planregulador-${safeKey}-outline`;
      const glowLayerId = `planregulador-${safeKey}-glow`;
      const labelSourceId = `planregulador-${safeKey}-label-source`;
      const labelLayerId = `planregulador-${safeKey}-label`;

      // Remove existing layers
      if (map.current.getLayer(labelLayerId)) map.current.removeLayer(labelLayerId);
      if (map.current.getLayer(fillLayerId)) map.current.removeLayer(fillLayerId);
      if (map.current.getLayer(outlineLayerId)) map.current.removeLayer(outlineLayerId);
      if (map.current.getLayer(glowLayerId)) map.current.removeLayer(glowLayerId);
      if (map.current.getSource(labelSourceId)) map.current.removeSource(labelSourceId);
      if (map.current.getSource(sourceId)) map.current.removeSource(sourceId);

      // Vivid orange — instantly distinguishable from terrain & medioambiente layers.
      const color = '#FF8C1A';

      const centroid = calculateCentroidFromGeoJSON(planRegulador.coordenadas);
      const truncatedLabel = planRegulador.capa.length > 25 ? planRegulador.capa.substring(0, 22) + '...' : planRegulador.capa;

      map.current.addSource(sourceId, {
        type: 'geojson',
        data: geojsonData.type === 'FeatureCollection' ? geojsonData : 
              geojsonData.type === 'Feature' ? geojsonData :
              { type: 'Feature', geometry: geojsonData, properties: {} }
      });

      map.current.addLayer({
        id: fillLayerId,
        type: 'fill',
        source: sourceId,
        paint: {
          'fill-color': color,
          'fill-opacity': 0.5,
          'fill-antialias': true,
        }
      });

      map.current.addLayer({
        id: outlineLayerId,
        type: 'line',
        source: sourceId,
        paint: {
          'line-color': color,
          'line-width': 2.5,
          'line-opacity': 1,
        }
      });

      // Add label
      if (centroid) {
        map.current.addSource(labelSourceId, {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: [{
              type: 'Feature',
              geometry: { type: 'Point', coordinates: centroid },
              properties: { label: truncatedLabel }
            }]
          }
        });

        map.current.addLayer({
          id: labelLayerId,
          type: 'symbol',
          source: labelSourceId,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 11,
            'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
            'text-max-width': 12,
            'text-allow-overlap': true,
            'text-ignore-placement': true
          },
          paint: {
            'text-color': '#ffffff',
            'text-halo-color': '#000000',
            'text-halo-width': 2,
            'text-halo-blur': 0
          }
        });
      }

      // Compact hover summary
      const popupContent = summaryHTML({
        title: planRegulador.capa,
        badge: 'Plan Regulador',
        color,
      });

      let layerPopup: mapboxgl.Popup | null = null;

      map.current.on('mouseenter', fillLayerId, (e) => {
        if (map.current) map.current.getCanvas().style.cursor = 'pointer';
        if (!e.lngLat) return;
        if (activePopup.current) activePopup.current.remove();
        layerPopup = new mapboxgl.Popup({
          offset: [0, -10],
          maxWidth: '280px',
          closeOnMove: false,
          closeButton: false,
          closeOnClick: false,
        })
          .setLngLat(e.lngLat)
          .setHTML(popupContent)
          .addTo(map.current!);
        activePopup.current = layerPopup;
      });

      map.current.on('mouseleave', fillLayerId, () => {
        if (map.current) map.current.getCanvas().style.cursor = '';
        if (layerPopup) { layerPopup.remove(); layerPopup = null; }
        if (activePopup.current) activePopup.current = null;
      });

      // Click → open detail panel
      map.current.on('click', fillLayerId, () => {
        openDetailPanel({
          type: 'planRegulador',
          data: { capa: planRegulador.capa },
          color,
        });
      });


      loadedPlanReguladorRef.current.add(key);
      console.log(`Plan Regulador ${planRegulador.capa} loaded successfully`);
      
      return extractCoordsFromGeoJSON(planRegulador.coordenadas);
    } catch (error) {
      console.error(`Error loading plan regulador:`, error);
      return [];
    }
  };

  // Remove Plan Regulador layer from map
  const removePlanReguladorLayer = (key: string) => {
    if (!map.current) return;
    
    const safeKey = key.replace(/[^a-zA-Z0-9]/g, '-');
    const sourceId = `planregulador-${safeKey}-source`;
    const fillLayerId = `planregulador-${safeKey}-fill`;
    const outlineLayerId = `planregulador-${safeKey}-outline`;
    const labelSourceId = `planregulador-${safeKey}-label-source`;
    const labelLayerId = `planregulador-${safeKey}-label`;
    
    const glowLayerId = `planregulador-${safeKey}-glow`;
    if (map.current.getLayer(labelLayerId)) map.current.removeLayer(labelLayerId);
    if (map.current.getLayer(fillLayerId)) map.current.removeLayer(fillLayerId);
    if (map.current.getLayer(outlineLayerId)) map.current.removeLayer(outlineLayerId);
    if (map.current.getLayer(glowLayerId)) map.current.removeLayer(glowLayerId);
    if (map.current.getSource(labelSourceId)) map.current.removeSource(labelSourceId);
    if (map.current.getSource(sourceId)) map.current.removeSource(sourceId);
    
    loadedPlanReguladorRef.current.delete(key);
  };

  // Handle Plan Regulador filter changes
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    let cancelled = false;

    const applyPric = () => {
    if (cancelled || !map.current) return;


    // In PRIC eval mode: force-load only the polygons matching the evaluated
    // zones (from allPlanRegulador), regardless of the user's filter selection.
    // Otherwise: use the user's explicit selection (radial no longer auto-adds).
    const baseSelected: PlanReguladorData[] = (pricEvalZones && pricEvalZones.length > 0)
      ? (allPlanRegulador || []).filter(pr => matchesPricEvalZone(pr.capa))
      : (filters.planRegulador || []);

    // Each row of poligonos_pric is its own polygon; several rows share the
    // same `capa` (nombre — categoría), so the key must include the geometry
    // to avoid collapsing an entire área into a single polygon.
    const hashCoords = (s: string) => {
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      return Math.abs(h).toString(36);
    };
    const keyFor = (p: PlanReguladorData) =>
      `planregulador::${p.capa}::${hashCoords(p.coordenadas || '')}`;

    const mergedMap = new Map<string, PlanReguladorData>();
    baseSelected.forEach(p => {
      const k = keyFor(p);
      if (!mergedMap.has(k)) mergedMap.set(k, p);
    });
    const selectedPlanRegulador = Array.from(mergedMap.values());

    const byComuna = selectedPlanRegulador.filter(pr => {
      // Do NOT apply comuna filter in PRIC eval mode — we want the exact zones.
      if (pricEvalZones && pricEvalZones.length > 0) return true;
      if (!filters.comunas || filters.comunas.length === 0) {
        return true;
      }
      return isPolygonInSelectedComunas(pr.coordenadas);
    });
    // Si el filtro por comuna descarta todo (datos sin match geométrico),
    // mostramos igualmente la selección del usuario en vez de dejar el mapa vacío.
    const filteredPlanRegulador = byComuna.length > 0 ? byComuna : selectedPlanRegulador;

    
    const selectedKeys = new Set(filteredPlanRegulador.map(p => keyFor(p)));
    
    // Remove layers that are no longer selected
    const keysToRemove: string[] = [];
    loadedPlanReguladorRef.current.forEach(key => {
      if (!selectedKeys.has(key)) {
        keysToRemove.push(key);
      }
    });
    keysToRemove.forEach(key => removePlanReguladorLayer(key));
    
    if (filteredPlanRegulador.length === 0) {
      setSourceCoords('planRegulador', []);
      setResultCounts(prev => ({ ...prev, planRegulador: 0 }));
      // Re-encuadrar a lo que quede visible (comunas, activos, etc.)
      triggerFitBounds({ padding: 60, duration: 700, debounceMs: 120 });
      return;
    }
    
    // Load all selected plan regulador layers
    const loadAndZoomPlanRegulador = () => {
      const allCoords: [number, number][] = [];
      
      filteredPlanRegulador.forEach(pr => {
        const key = keyFor(pr);
        
        if (!loadedPlanReguladorRef.current.has(key)) {
          const coords = loadPlanReguladorGeoJSON(pr, key);
          allCoords.push(...coords);
        } else {
          const coords = extractCoordsFromGeoJSON(pr.coordenadas);
          allCoords.push(...coords);
        }
      });
      
      // Register with unified fitBounds and zoom ONLY to the PRIC selection so
      // los polígonos se vean grandes y centrados (no diluidos por la comuna).
      if (allCoords.length > 0) {
        setSourceCoords('planRegulador', allCoords);
        setResultCounts(prev => ({ ...prev, planRegulador: filteredPlanRegulador.length }));
        triggerFitBounds({
          only: ['planRegulador'],
          padding: 50,
          maxZoom: 16,
          duration: 700,
          debounceMs: 120,
        });
      }
    };
    
    loadAndZoomPlanRegulador();
    };

    if (m.isStyleLoaded()) applyPric();
    else m.once('idle', applyPric);

    return () => {
      cancelled = true;
      m.off('idle', applyPric);
    };
  }, [filters.planRegulador, filters.comunas, isPolygonInSelectedComunas, allPlanRegulador, pricEvalZones, matchesPricEvalZone, setSourceCoords, triggerFitBounds]);



  // Extract coordinates from GeoJSON string
  const extractCoordsFromGeoJSON = (geoJsonString: string): [number, number][] => {
    try {
      const geojson = JSON.parse(geoJsonString);
      const coords: [number, number][] = [];
      
      const extractFromGeometry = (geometry: GeoJSON.Geometry) => {
        switch (geometry.type) {
          case 'Point':
            coords.push([geometry.coordinates[0], geometry.coordinates[1]]);
            break;
          case 'MultiPoint':
          case 'LineString':
            geometry.coordinates.forEach((coord: number[]) => {
              coords.push([coord[0], coord[1]]);
            });
            break;
          case 'MultiLineString':
          case 'Polygon':
            geometry.coordinates.forEach((ring: number[][]) => {
              ring.forEach((coord: number[]) => {
                coords.push([coord[0], coord[1]]);
              });
            });
            break;
          case 'MultiPolygon':
            geometry.coordinates.forEach((polygon: number[][][]) => {
              polygon.forEach((ring: number[][]) => {
                ring.forEach((coord: number[]) => {
                  coords.push([coord[0], coord[1]]);
                });
              });
            });
            break;
          case 'GeometryCollection':
            geometry.geometries.forEach((geom: GeoJSON.Geometry) => {
              extractFromGeometry(geom);
            });
            break;
        }
      };
      
      if (geojson.type === 'FeatureCollection') {
        geojson.features.forEach((feature: GeoJSON.Feature) => {
          if (feature.geometry) {
            extractFromGeometry(feature.geometry);
          }
        });
      } else if (geojson.type === 'Feature') {
        if (geojson.geometry) {
          extractFromGeometry(geojson.geometry);
        }
      } else {
        extractFromGeometry(geojson);
      }
      
      return coords;
    } catch (e) {
      console.error('Error parsing GeoJSON:', e);
      return [];
    }
  };

  // Load poligono GeoJSON and add to map
  const loadPoligonoGeoJSON = (poligono: PoligonoData): [number, number][] => {
    if (!map.current) return [];

    try {
      const geojson = JSON.parse(poligono.coordenadas);
      const key = `${poligono.capa}::${poligono.categoria}::${poligono.etiqueta || ''}`;
      const sourceId = `poligono-${key.replace(/[^a-zA-Z0-9]/g, '-')}-source`;
      const fillLayerId = `poligono-${key.replace(/[^a-zA-Z0-9]/g, '-')}-fill`;
      const outlineLayerId = `poligono-${key.replace(/[^a-zA-Z0-9]/g, '-')}-outline`;
      
      // Remove existing layers if present
      if (map.current.getSource(sourceId)) {
        if (map.current.getLayer(fillLayerId)) map.current.removeLayer(fillLayerId);
        if (map.current.getLayer(outlineLayerId)) map.current.removeLayer(outlineLayerId);
        map.current.removeSource(sourceId);
      }
      
      // Bright high-contrast palette for medioambiente — stands out day & night.
      // Color is chosen by categoria hash for consistency across loads.
      const HIGHLIGHT_PALETTE = [
        '#22FF88', // verde neón
        '#FF3DA5', // magenta vibrante
        '#FFB300', // ámbar saturado
        '#00E0FF', // cian eléctrico
        '#A855F7', // violeta brillante
        '#FF5E3A', // naranja intenso
        '#34D399', // esmeralda
        '#F472B6', // rosa neón
      ];
      let hash = 0;
      for (let i = 0; i < poligono.categoria.length; i++) {
        hash = poligono.categoria.charCodeAt(i) + ((hash << 5) - hash);
      }
      const color = HIGHLIGHT_PALETTE[Math.abs(hash) % HIGHLIGHT_PALETTE.length];
      const glowLayerId = `poligono-${key.replace(/[^a-zA-Z0-9]/g, '-')}-glow`;
      
      // Calculate centroid for label
      const centroid = calculateCentroidFromGeoJSON(poligono.coordenadas);
      const labelSourceId = `poligono-${key.replace(/[^a-zA-Z0-9]/g, '-')}-label-source`;
      const labelLayerId = `poligono-${key.replace(/[^a-zA-Z0-9]/g, '-')}-label`;
      
      // Truncate etiqueta for label display
      const labelText = (poligono.etiqueta || poligono.categoria);
      const truncatedLabel = labelText.length > 20 ? labelText.substring(0, 18) + '...' : labelText;
      
      map.current.addSource(sourceId, {
        type: 'geojson',
        data: geojson
      });

      map.current.addLayer({
        id: fillLayerId,
        type: 'fill',
        source: sourceId,
        paint: {
          'fill-color': color,
          'fill-opacity': 0.5,
          'fill-antialias': true,
        }
      });

      map.current.addLayer({
        id: outlineLayerId,
        type: 'line',
        source: sourceId,
        paint: {
          'line-color': color,
          'line-width': 2.5,
          'line-opacity': 1,
        }
      });

      // Add label at centroid
      if (centroid) {
        map.current.addSource(labelSourceId, {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: [{
              type: 'Feature',
              geometry: {
                type: 'Point',
                coordinates: centroid
              },
              properties: {
                label: truncatedLabel
              }
            }]
          }
        });

        map.current.addLayer({
          id: labelLayerId,
          type: 'symbol',
          source: labelSourceId,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 11,
            'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
            'text-max-width': 12,
            'text-allow-overlap': true,
            'text-ignore-placement': true
          },
          paint: {
            'text-color': '#ffffff',
            'text-halo-color': '#000000',
            'text-halo-width': 2,
            'text-halo-blur': 0
          }
        });
      }

      // Compact hover summary
      const popupContent = summaryHTML({
        title: poligono.etiqueta || poligono.categoria,
        subtitle: [poligono.region, poligono.comuna].filter(Boolean).join(', ') || undefined,
        badge: poligono.capa,
        color,
      });

      let layerPopup: mapboxgl.Popup | null = null;

      map.current.on('mouseenter', fillLayerId, (e) => {
        if (map.current) map.current.getCanvas().style.cursor = 'pointer';
        if (!e.lngLat) return;
        if (activePopup.current) activePopup.current.remove();
        layerPopup = new mapboxgl.Popup({
          offset: [0, -10],
          maxWidth: '280px',
          closeOnMove: false,
          closeButton: false,
          closeOnClick: false,
        })
          .setLngLat(e.lngLat)
          .setHTML(popupContent)
          .addTo(map.current!);
        activePopup.current = layerPopup;
      });

      map.current.on('mouseleave', fillLayerId, () => {
        if (map.current) map.current.getCanvas().style.cursor = '';
        if (layerPopup) { layerPopup.remove(); layerPopup = null; }
        if (activePopup.current) activePopup.current = null;
      });

      // Click → open detail panel
      map.current.on('click', fillLayerId, () => {
        openDetailPanel({ type: 'poligono', data: poligono, color });
      });


      loadedPoligonosRef.current.add(key);
      console.log(`Poligono ${poligono.categoria} loaded successfully`);
      
      return extractCoordsFromGeoJSON(poligono.coordenadas);
    } catch (error) {
      console.error(`Error loading poligono:`, error);
      return [];
    }
  };

  // Remove poligono layer from map
  const removePoligonoLayer = (key: string) => {
    if (!map.current) return;
    
    const sourceId = `poligono-${key.replace(/[^a-zA-Z0-9]/g, '-')}-source`;
    const fillLayerId = `poligono-${key.replace(/[^a-zA-Z0-9]/g, '-')}-fill`;
    const outlineLayerId = `poligono-${key.replace(/[^a-zA-Z0-9]/g, '-')}-outline`;
    const labelSourceId = `poligono-${key.replace(/[^a-zA-Z0-9]/g, '-')}-label-source`;
    const labelLayerId = `poligono-${key.replace(/[^a-zA-Z0-9]/g, '-')}-label`;
    
    const glowLayerId = `poligono-${key.replace(/[^a-zA-Z0-9]/g, '-')}-glow`;
    if (map.current.getLayer(labelLayerId)) map.current.removeLayer(labelLayerId);
    if (map.current.getLayer(fillLayerId)) map.current.removeLayer(fillLayerId);
    if (map.current.getLayer(outlineLayerId)) map.current.removeLayer(outlineLayerId);
    if (map.current.getLayer(glowLayerId)) map.current.removeLayer(glowLayerId);
    if (map.current.getSource(labelSourceId)) map.current.removeSource(labelSourceId);
    if (map.current.getSource(sourceId)) map.current.removeSource(sourceId);
    
    loadedPoligonosRef.current.delete(key);
  };

  useEffect(() => {
    loadActivos();
  }, []);

  // Handle PRIC query point marker
  useEffect(() => {
    if (!map.current) return;

    // Remove existing PRIC marker
    if (pricMarkerRef.current) {
      pricMarkerRef.current.remove();
      pricMarkerRef.current = null;
    }

    // If no PRIC point, nothing more to do
    if (!pricQueryPoint) return;

    // Create a distinctive marker for the PRIC query point
    const el = document.createElement('div');
    el.className = 'pric-query-marker';
    el.innerHTML = `
      <div style="
        width: 40px;
        height: 40px;
        background: linear-gradient(135deg, #FF6B6B, #EE5A5A);
        border: 3px solid white;
        border-radius: 50%;
        box-shadow: 0 4px 12px rgba(238, 90, 90, 0.5), 0 0 0 4px rgba(238, 90, 90, 0.2);
        display: flex;
        align-items: center;
        justify-content: center;
        animation: pulse-ring 2s ease-out infinite;
      ">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>
          <circle cx="12" cy="10" r="3"/>
        </svg>
      </div>
    `;

    // Add CSS animation if not already added
    if (!document.getElementById('pric-marker-styles')) {
      const style = document.createElement('style');
      style.id = 'pric-marker-styles';
      style.textContent = `
        @keyframes pulse-ring {
          0% {
            box-shadow: 0 4px 12px rgba(238, 90, 90, 0.5), 0 0 0 0 rgba(238, 90, 90, 0.4);
          }
          70% {
            box-shadow: 0 4px 12px rgba(238, 90, 90, 0.5), 0 0 0 15px rgba(238, 90, 90, 0);
          }
          100% {
            box-shadow: 0 4px 12px rgba(238, 90, 90, 0.5), 0 0 0 0 rgba(238, 90, 90, 0);
          }
        }
      `;
      document.head.appendChild(style);
    }

    // Compact hover summary; click opens detail panel
    const popup = new mapboxgl.Popup({
      offset: 18,
      maxWidth: '280px',
      closeButton: false,
      closeOnClick: false,
    }).setHTML(summaryHTML({
      title: 'Consulta PRIC',
      subtitle: `${pricQueryPoint.lat.toFixed(4)}°, ${pricQueryPoint.lng.toFixed(4)}°`,
      badge: 'PRIC',
      color: '#EE5A5A',
    }));

    pricMarkerRef.current = new mapboxgl.Marker({
      element: el,
      anchor: 'center'
    })
      .setLngLat([pricQueryPoint.lng, pricQueryPoint.lat])
      .addTo(map.current);

    el.addEventListener('mouseenter', () => {
      if (!map.current) return;
      if (activePopup.current && activePopup.current !== popup) activePopup.current.remove();
      popup.setLngLat([pricQueryPoint.lng, pricQueryPoint.lat]).addTo(map.current);
      activePopup.current = popup;
    });
    el.addEventListener('mouseleave', () => {
      if (popup.isOpen()) popup.remove();
      if (activePopup.current === popup) activePopup.current = null;
    });
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      openDetailPanel({
        type: 'pric',
        data: { lat: pricQueryPoint.lat, lng: pricQueryPoint.lng },
        color: '#EE5A5A',
      });
    });



    // Zoom to the point
    map.current.flyTo({
      center: [pricQueryPoint.lng, pricQueryPoint.lat],
      zoom: 14,
      duration: 1500,
      essential: true
    });

  }, [pricQueryPoint]);

  // Radial analysis: listen to sidebar events and render a dashed circle
  useEffect(() => {
    const SOURCE_ID = 'radial-analysis-source';
    const MASK_SOURCE_ID = 'radial-analysis-mask-source';
    const MASK_LAYER = 'radial-analysis-mask';
    const GLOW_LAYER = 'radial-analysis-glow';
    const LINE_LAYER = 'radial-analysis-line';
    const FILL_LAYER = 'radial-analysis-fill'; // legacy id (kept for cleanup)

    const buildCircle = (
      center: { lat: number; lng: number },
      radiusKm: number,
      points = 128
    ): GeoJSON.Feature<GeoJSON.Polygon> => {
      const coords: [number, number][] = [];
      const distanceX = radiusKm / (111.32 * Math.cos((center.lat * Math.PI) / 180));
      const distanceY = radiusKm / 110.574;
      for (let i = 0; i < points; i++) {
        const theta = (i / points) * (2 * Math.PI);
        coords.push([
          center.lng + distanceX * Math.cos(theta),
          center.lat + distanceY * Math.sin(theta),
        ]);
      }
      coords.push(coords[0]);
      return {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [coords] },
      };
    };

    // World polygon with the circle punched out as a hole — the inner
    // ring stays fully transparent so points/polygons inside remain visible,
    // while everything outside is dimmed to make the radius unmistakable.
    const buildMask = (circle: GeoJSON.Feature<GeoJSON.Polygon>): GeoJSON.Feature<GeoJSON.Polygon> => {
      const outer: [number, number][] = [
        [-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85],
      ];
      // Mapbox requires opposite winding for holes; reverse the circle ring.
      const hole = [...(circle.geometry.coordinates[0] as [number, number][])].reverse();
      return {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [outer, hole] },
      };
    };

    const removeRadial = () => {
      if (!map.current) return;
      [LINE_LAYER, GLOW_LAYER, MASK_LAYER, FILL_LAYER].forEach(id => {
        if (map.current!.getLayer(id)) map.current!.removeLayer(id);
      });
      if (map.current.getSource(SOURCE_ID)) map.current.removeSource(SOURCE_ID);
      if (map.current.getSource(MASK_SOURCE_ID)) map.current.removeSource(MASK_SOURCE_ID);
      if (radialMarkerRef.current) {
        radialMarkerRef.current.remove();
        radialMarkerRef.current = null;
      }
    };

    const drawRadial = (center: { lat: number; lng: number }, radiusKm: number) => {
      if (!map.current) return;
      const apply = () => {
        if (!map.current) return;
        const feature = buildCircle(center, radiusKm);
        const mask = buildMask(feature);

        const existingCircle = map.current.getSource(SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
        const existingMask = map.current.getSource(MASK_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;

        if (existingCircle && existingMask) {
          existingCircle.setData(feature as any);
          existingMask.setData(mask as any);
        } else {
          // Mask source — dims everything OUTSIDE the radius so the circle
          // reads even on top of saturated comuna polygons. Interior has
          // zero fill so layers/points/polygons inside stay untouched.
          map.current.addSource(MASK_SOURCE_ID, { type: 'geojson', data: mask as any });
          map.current.addLayer({
            id: MASK_LAYER,
            type: 'fill',
            source: MASK_SOURCE_ID,
            paint: {
              'fill-color': '#000814',
              'fill-opacity': 0.55,
              'fill-antialias': true,
            },
          });

          // Circle source — only used for the boundary glow + dashed ring.
          map.current.addSource(SOURCE_ID, { type: 'geojson', data: feature as any });
          map.current.addLayer({
            id: GLOW_LAYER,
            type: 'line',
            source: SOURCE_ID,
            paint: {
              'line-color': '#00E0FF',
              'line-width': 10,
              'line-blur': 8,
              'line-opacity': 0.55,
            },
          });
          map.current.addLayer({
            id: LINE_LAYER,
            type: 'line',
            source: SOURCE_ID,
            paint: {
              'line-color': '#00E0FF',
              'line-width': 2.5,
              'line-opacity': 1,
              'line-dasharray': [2, 2],
            },
          });
        }

        // Center marker
        if (!radialMarkerRef.current) {
          const el = document.createElement('div');
          el.style.width = '16px';
          el.style.height = '16px';
          el.style.borderRadius = '50%';
          el.style.background = '#FFB300';
          el.style.border = '2px solid #ffffff';
          el.style.boxShadow = '0 0 0 3px rgba(255,179,0,0.25), 0 2px 6px rgba(0,0,0,0.4)';
          el.style.cursor = 'pointer';
          el.title = 'Ver resumen territorial';
          el.addEventListener('click', (ev) => {
            ev.stopPropagation();
            window.dispatchEvent(new CustomEvent('radial:openSummary'));
          });
          radialMarkerRef.current = new mapboxgl.Marker({ element: el, anchor: 'center' })
            .setLngLat([center.lng, center.lat])
            .addTo(map.current);
        } else {
          radialMarkerRef.current.setLngLat([center.lng, center.lat]);
        }

        // Fit bounds tightly to the circle — uses maxZoom so small radii (1-5 km)
        // zoom in instead of leaving the user with a tiny circle on a wide view.
        // Re-fired with a small delay so it wins over unifiedFitBounds (debounce 200ms).
        const bounds = new mapboxgl.LngLatBounds();
        (feature.geometry.coordinates[0] as [number, number][]).forEach((c) => bounds.extend(c));
        const fitOpts: mapboxgl.FitBoundsOptions = {
          padding: 60,
          maxZoom: 16,
          duration: 1200,
          essential: true,
        };
        map.current.fitBounds(bounds, fitOpts);
        setTimeout(() => {
          if (map.current) map.current.fitBounds(bounds, { ...fitOpts, duration: 600 });
        }, 260);
      };
      if (map.current.isStyleLoaded()) apply();
      else map.current.once('load', apply);
    };

    const handleSet = (e: Event) => {
      const { active, center, radiusKm } = (e as CustomEvent).detail || {};
      if (!active || !center) {
        removeRadial();
        return;
      }
      drawRadial(center, radiusKm);
    };

    const handlePickMode = (e: Event) => {
      const { enabled } = (e as CustomEvent).detail || {};
      radialPickModeRef.current = Boolean(enabled);
      if (map.current) {
        map.current.getCanvas().style.cursor = (enabled || pricPickModeRef.current) ? 'crosshair' : '';
      }
    };

    const handlePricPickMode = (e: Event) => {
      const { enabled } = (e as CustomEvent).detail || {};
      pricPickModeRef.current = Boolean(enabled);
      if (map.current) {
        map.current.getCanvas().style.cursor = (enabled || radialPickModeRef.current) ? 'crosshair' : '';
      }
    };

    window.addEventListener('radial:set', handleSet);
    window.addEventListener('radial:pickMode', handlePickMode);
    window.addEventListener('pric:pickMode', handlePricPickMode);
    return () => {
      window.removeEventListener('radial:set', handleSet);
      window.removeEventListener('radial:pickMode', handlePickMode);
      window.removeEventListener('pric:pickMode', handlePricPickMode);
      removeRadial();
    };
  }, []);

  // ===== Límite oficial PRIC =====
  // Loads the PRIC boundary polygon from `pric_limite_oficial_geom` and
  // renders it as a subtle fill + dark outline BELOW the individual zone
  // layers, so it never obscures the ZEU/ZPM/ZPC polygons rendered from
  // `poligonos_pric`. Toggled from the sidebar via `pric:limiteToggle`.
  const pricLimiteGeomRef = useRef<any | null>(null);
  const pricLimiteEnabledRef = useRef<boolean>(false);

  const removePricLimiteLayer = useCallback(() => {
    if (!map.current) return;
    const src = 'pric-limite-source';
    const fill = 'pric-limite-fill';
    const line = 'pric-limite-outline';
    if (map.current.getLayer(line)) map.current.removeLayer(line);
    if (map.current.getLayer(fill)) map.current.removeLayer(fill);
    if (map.current.getSource(src)) map.current.removeSource(src);
    setSourceCoords('pricLimite', []);
  }, [setSourceCoords]);

  const addPricLimiteLayer = useCallback((geojson: any) => {
    if (!map.current || !geojson) return;
    const src = 'pric-limite-source';
    const fill = 'pric-limite-fill';
    const line = 'pric-limite-outline';
    // Clean prior instance
    if (map.current.getLayer(line)) map.current.removeLayer(line);
    if (map.current.getLayer(fill)) map.current.removeLayer(fill);
    if (map.current.getSource(src)) map.current.removeSource(src);

    const data =
      geojson.type === 'FeatureCollection' ? geojson :
      geojson.type === 'Feature' ? geojson :
      { type: 'Feature', geometry: geojson, properties: {} };

    // Insert BELOW any existing plan regulador zone layers so it never
    // covers the individual ZEU/ZPM/ZPC polygons.
    let beforeId: string | undefined;
    try {
      const style = map.current.getStyle();
      const found = style?.layers?.find((l: any) => typeof l.id === 'string' && l.id.startsWith('planregulador-'));
      if (found) beforeId = found.id;
    } catch { /* noop */ }

    map.current.addSource(src, { type: 'geojson', data });
    map.current.addLayer({
      id: fill,
      type: 'fill',
      source: src,
      paint: {
        'fill-color': '#4338CA',
        'fill-opacity': 0.12,
      },
    }, beforeId);
    map.current.addLayer({
      id: line,
      type: 'line',
      source: src,
      paint: {
        'line-color': '#312E81',
        'line-width': 2,
        'line-opacity': 0.95,
      },
    }, beforeId);

    // Register coords with unified fitBounds so the boundary participates
    // in the auto-zoom alongside any selected zones.
    try {
      const coords = extractCoordsFromGeoJSON(
        typeof geojson === 'string' ? geojson : JSON.stringify(geojson)
      );
      setSourceCoords('pricLimite', coords);
      triggerFitBounds();
    } catch { /* noop */ }
  }, [setSourceCoords, triggerFitBounds]);

  useEffect(() => {
    const handler = async (e: Event) => {
      const enabled = Boolean((e as CustomEvent).detail?.enabled);
      pricLimiteEnabledRef.current = enabled;
      if (!enabled) {
        removePricLimiteLayer();
        return;
      }
      // Fetch once, then reuse
      if (!pricLimiteGeomRef.current) {
        if (!supabase) return;
        const { data, error } = await supabase
          .from('pric_limite_oficial_geom')
          .select('geom')
          .single();
        if (error || !data) {
          console.error('[pric limite] fetch error', error);
          return;
        }
        const raw = (data as any).geom;
        let parsed: any = null;
        if (raw && typeof raw === 'object') parsed = raw;
        else if (typeof raw === 'string') {
          try { parsed = JSON.parse(raw); } catch {
            console.error('[pric limite] geom is not GeoJSON-parseable', raw?.slice?.(0, 40));
            return;
          }
        }
        pricLimiteGeomRef.current = parsed;
      }
      // Ensure map style is ready
      const applyWhenReady = () => {
        if (!map.current) return;
        if (map.current.isStyleLoaded()) {
          addPricLimiteLayer(pricLimiteGeomRef.current);
        } else {
          map.current.once('style.load', () => addPricLimiteLayer(pricLimiteGeomRef.current));
        }
      };
      applyWhenReady();
    };
    window.addEventListener('pric:limiteToggle', handler);
    return () => window.removeEventListener('pric:limiteToggle', handler);
  }, [addPricLimiteLayer, removePricLimiteLayer]);

  // Re-apply on style reload if user had it enabled
  useEffect(() => {
    if (!map.current) return;
    const onStyleLoad = () => {
      if (pricLimiteEnabledRef.current && pricLimiteGeomRef.current) {
        addPricLimiteLayer(pricLimiteGeomRef.current);
      }
    };
    map.current.on('style.load', onStyleLoad);
    return () => { map.current?.off('style.load', onStyleLoad); };
  }, [addPricLimiteLayer]);


  // Function to zoom to specific coordinates
  const zoomToCoordinates = (coords: Array<[number, number]>) => {
    if (!map.current || coords.length === 0) return;

    if (coords.length === 1) {
      // Single point - zoom to it
      map.current.flyTo({
        center: coords[0],
        zoom: 12,
        duration: 300,
        essential: true
      });
    } else {
      // Multiple points - fit bounds
      const bounds = coords.reduce(
        (bounds, coord) => bounds.extend(coord),
        new mapboxgl.LngLatBounds(coords[0], coords[0])
      );

      map.current.fitBounds(bounds, {
        padding: 100,
        maxZoom: 14,
        duration: 300
      });
    }
  };

  // Function to reset to initial globe view - clears all bounds and resets
  const resetToInitialView = useCallback(() => {
    if (!map.current) return;
    
    // Clear all unified bounds sources
    clearAllBounds();
    setResultCounts({});
    
    // Force-remove all polygon layers currently on the map so the reset
    // visually clears the map even if the parent filter state is slow to update.
    try {
      const ids = Array.from(loadedComunasRef.current);
      ids.forEach(comunaId => removeComunaLayer(comunaId));
      loadedComunasRef.current.clear();
    } catch (err) {
      console.warn('[reset] error removing comuna layers', err);
    }
    
    map.current.flyTo({
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      duration: 800,
      essential: true,
    });
  }, [clearAllBounds]);


  // SVG path mapping for icons (Lucide icons SVG paths)
  const getIconSvgPath = (iconName: string): string => {
    const iconPaths: { [key: string]: string } = {
      'sun': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
      'graduation-cap': '<path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/>',
      'anchor': '<circle cx="12" cy="5" r="3"/><line x1="12" y1="22" x2="12" y2="8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/>',
      'mountain': '<path d="m8 3 4 8 5-5 5 15H2L8 3z"/>',
      'palmtree': '<path d="M13 8c0-2.76-2.46-5-5.5-5S2 5.24 2 8h2l1-1 1 1h4"/><path d="M13 7.14A5.82 5.82 0 0 1 16.5 6c3.04 0 5.5 2.24 5.5 5h-3l-1-1-1 1h-3"/><path d="M5.89 9.71c-2.15 2.15-2.3 5.47-.35 7.43l4.24-4.25.7-.7.71-.71 2.12-2.12c-1.95-1.96-5.27-1.8-7.42.35z"/><path d="M11 15.5c.5 2.5-.17 4.5-1 6.5h4c2-5.5-.5-12-1-14"/>',
      'map-pin': '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
      'building': '<rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><path d="M9 22v-4h6v4M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01"/>',
      'factory': '<path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M17 18h1M12 18h1M7 18h1"/>',
      'leaf': '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
      'droplet': '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>',
      'zap': '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
      'wind': '<path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/>',
      'home': '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
      'school': '<path d="m4 6 8-4 8 4"/><path d="m18 10 4 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8l4-2"/><path d="M14 22v-4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v4"/><path d="M18 5v17"/><path d="M6 5v17"/><circle cx="12" cy="9" r="2"/>',
      'hospital': '<path d="M12 6v4"/><path d="M14 14h-4"/><path d="M14 18h-4"/><path d="M14 8h-4"/><path d="M18 12h2a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h2"/><path d="M18 22V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v18"/>',
      'store': '<path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/><path d="M22 7v3a2 2 0 0 1-2 2v0a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12v0a2 2 0 0 1-2-2V7"/>',
      'coffee': '<path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><line x1="6" y1="2" x2="6" y2="4"/><line x1="10" y1="2" x2="10" y2="4"/><line x1="14" y1="2" x2="14" y2="4"/>',
      'music': '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
      'camera': '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
      'book': '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
      'briefcase': '<rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
      'package': '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
      'truck': '<path d="M5 18H3c-.6 0-1-.4-1-1V7c0-.6.4-1 1-1h10c.6 0 1 .4 1 1v11"/><path d="M14 9h4l4 4v4c0 .6-.4 1-1 1h-2"/><circle cx="7" cy="18" r="2"/><path d="M15 18H9"/><circle cx="17" cy="18" r="2"/>',
      'plane': '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
      'ship': '<path d="M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1 .6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M19.38 20A11.6 11.6 0 0 0 21 14l-9-4-9 4c0 2.9.94 5.34 2.81 7.76"/><path d="M19 13V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6"/><path d="M12 10v4"/><path d="M12 2v3"/>',
      'train': '<rect x="4" y="3" width="16" height="16" rx="2"/><path d="M4 11h16"/><path d="M12 3v8"/><path d="m8 19-2 3"/><path d="m18 22-2-3"/><path d="M8 15h0"/><path d="M16 15h0"/>',
      'circle-dot': '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/>',
    };
    
    return iconPaths[iconName] || iconPaths['circle-dot'];
  };

  useEffect(() => {
    if (!mapContainer.current) return;

    // Mapbox public token
    const mapboxToken = 'pk.eyJ1Ijoic2FtdWVsMjQxNSIsImEiOiJjbWdjOXdoeGMwMXB5Mm1xM3drbHhpNjN1In0.AiiVhpYl0w2IwYzA_7UAiw';

    // Initialize map
    mapboxgl.accessToken = mapboxToken;
    
    const storedStyle = getStoredMapStyle();

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: storedStyle.url,
      projection: { name: 'globe' },
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      pitch: 0,
      bearing: 0,
      minZoom: 1,
      maxZoom: 18,
      maxBounds: undefined,
      maxTileCacheSize: 2048,
      fadeDuration: 150,
    });

    // Monitoreo Territorial — expose map instance globally for the monitoring controller.
    (window as unknown as { __gdudexMap?: mapboxgl.Map }).__gdudexMap = map.current;
    window.dispatchEvent(new CustomEvent('gdudex:mapReady'));

    // Set initial light preset (only for "auto" Mapbox Standard styles).
    map.current.on('style.load', () => {
      if (!map.current) return;
      if (storedStyle.auto) {
        try { map.current.setConfigProperty('basemap', 'lightPreset', getLightPreset()); } catch {}
      }
    });

    // Update light preset every hour (no-op for non-auto styles)
    const updateLightPreset = () => {
      if (map.current && storedStyle.auto) {
        try { map.current.setConfigProperty('basemap', 'lightPreset', getLightPreset()); } catch {}
      }
    };


    const lightInterval = setInterval(updateLightPreset, 10 * 60 * 1000); // Re-check every 10 min for smooth transitions

    // Add navigation controls
    map.current.addControl(
      new mapboxgl.NavigationControl({
        visualizePitch: true,
      }),
      'top-right'
    );

    // Add fullscreen control
    map.current.addControl(new mapboxgl.FullscreenControl(), 'top-right');

    // Add scale control
    map.current.addControl(
      new mapboxgl.ScaleControl({
        maxWidth: 100,
        unit: 'metric'
      }),
      'bottom-left'
    );

    // Globe rotation event handlers
    map.current.on('mousedown', () => {
      userInteracting.current = true;
    });

    map.current.on('mouseup', () => {
      userInteracting.current = false;
      spinGlobe();
    });

    map.current.on('dragend', () => {
      userInteracting.current = false;
      spinGlobe();
    });

    map.current.on('pitchend', () => {
      userInteracting.current = false;
      spinGlobe();
    });

    map.current.on('rotateend', () => {
      userInteracting.current = false;
      spinGlobe();
    });

    map.current.on('moveend', () => {
      spinGlobe();
    });

    // Click to show coordinates (only when not clicking on a marker)
    map.current.on('click', (e) => {
      // Radial pick mode: capture this click as the radial center
      if (radialPickModeRef.current) {
        window.dispatchEvent(
          new CustomEvent('radial:pointPicked', {
            detail: { lat: e.lngLat.lat, lng: e.lngLat.lng },
          })
        );
        return;
      }

      // PRIC pick mode: capture this click as the evaluation point
      if (pricPickModeRef.current) {
        window.dispatchEvent(
          new CustomEvent('pric:pointPicked', {
            detail: { lat: e.lngLat.lat, lng: e.lngLat.lng },
          })
        );
        return;
      }


      // Check if click was on a marker element or popup
      const target = e.originalEvent.target as HTMLElement;
      if (target.closest('.activo-marker') || target.closest('.activo-label') || target.closest('.mapboxgl-popup')) {
        return;
      }
      
      // Close any open popup when clicking on the map
      if (activePopup.current) {
        activePopup.current.remove();
        activePopup.current = null;
      }
      
      setSelectedCoords({
        lat: e.lngLat.lat,
        lng: e.lngLat.lng
      });
    });

    // Enable 3D terrain and add comunas layer
    map.current.on('load', () => {
      // Add atmosphere for globe
      map.current?.setFog({
        color: 'rgb(186, 210, 235)',
        'high-color': 'rgb(36, 92, 223)',
        'horizon-blend': 0.02,
        'space-color': 'rgb(11, 11, 25)',
        'star-intensity': 0.6
      });

      map.current?.addSource('mapbox-dem', {
        type: 'raster-dem',
        url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
        tileSize: 512,
        maxzoom: 14,
      });

      map.current?.setTerrain({ source: 'mapbox-dem', exaggeration: 1.5 });

      // Add Tarapacá marker on globe
      const tarapacaEl = document.createElement('div');
      tarapacaEl.className = 'tarapaca-globe-marker';
      tarapacaEl.style.width = '20px';
      tarapacaEl.style.height = '20px';
      tarapacaEl.style.borderRadius = '50%';
      tarapacaEl.style.background = 'radial-gradient(circle, #FBBF24 0%, #F59E0B 100%)';
      tarapacaEl.style.border = '3px solid white';
      tarapacaEl.style.boxShadow = '0 0 20px rgba(251, 191, 36, 0.8), 0 0 40px rgba(251, 191, 36, 0.4)';
      
      tarapacaMarker.current = new mapboxgl.Marker(tarapacaEl)
        .setLngLat([-70.15, -20.21]) // Tarapacá center
        .addTo(map.current!);

      // Add sky layer for atmosphere
      map.current?.addLayer({
        id: 'sky',
        type: 'sky',
        paint: {
          'sky-type': 'atmosphere',
          'sky-atmosphere-sun': [0.0, 90.0],
          'sky-atmosphere-sun-intensity': 15,
        },
      });

      setLoading(false);
      
      // Start spinning the globe
      spinGlobe();
      
      // Expose zoom function to parent
      if (onMapReady) {
        onMapReady(zoomToCoordinates);
      }
    });

    // ===== Corredor Bioceánico Capricornio =====
    // Load every configured route as its own source+layers (casing for glow,
    // main line on top). Default state: ALL routes visible in the same base
    // color. Selecting a subset paints each route with its unique color.
    const corredorHoverPopup = new mapboxgl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 12,
      className: 'corredor-hover-popup',
    });

    // Cache of bounds per route, computed from its GeoJSON on first load.
    const corredorBoundsCache = new Map<string, mapboxgl.LngLatBounds>();

    const computeBoundsFromGeoJSON = (geojson: any): mapboxgl.LngLatBounds | null => {
      const b = new mapboxgl.LngLatBounds();
      let has = false;
      const visit = (coords: any) => {
        if (typeof coords?.[0] === 'number') {
          b.extend(coords as [number, number]);
          has = true;
        } else if (Array.isArray(coords)) {
          coords.forEach(visit);
        }
      };
      (geojson?.features || []).forEach((f: any) => visit(f?.geometry?.coordinates));
      return has ? b : null;
    };

    const fitCorredorSelection = (selected: string[]) => {
      if (!map.current || selected.length === 0) return;
      const combined = new mapboxgl.LngLatBounds();
      let has = false;
      selected.forEach(id => {
        const b = corredorBoundsCache.get(id);
        if (b) {
          combined.extend(b.getSouthWest());
          combined.extend(b.getNorthEast());
          has = true;
        }
      });
      if (!has) return;
      map.current.fitBounds(combined, { padding: 80, duration: 900, maxZoom: 11 });
    };

    const applyCorredorSelection = (selected: string[], fit = true) => {
      if (!map.current) return;
      const allOn = selected.length === CORREDOR_ROUTES.length;
      CORREDOR_ROUTES.forEach(route => {
        const lyr = corredorLayerId(route.id);
        const cas = corredorCasingId(route.id);
        if (!map.current!.getLayer(lyr)) return;
        const visible = selected.includes(route.id);
        const color = allOn ? CORREDOR_BASE_COLOR : route.color;
        const width = allOn ? CORREDOR_BASE_WIDTH : CORREDOR_HIGHLIGHT_WIDTH;
        map.current!.setLayoutProperty(lyr, 'visibility', visible ? 'visible' : 'none');
        map.current!.setLayoutProperty(cas, 'visibility', visible ? 'visible' : 'none');
        map.current!.setPaintProperty(lyr, 'line-color', color);
        map.current!.setPaintProperty(lyr, 'line-width', width);
      });
      if (!fit) return;
      if (selected.length === 0) {
        // No routes visible → return to the initial globe view.
        map.current.flyTo({
          center: INITIAL_CENTER,
          zoom: INITIAL_ZOOM,
          duration: 900,
          essential: true,
        });
      } else {
        fitCorredorSelection(selected);
      }
    };

    const initCorredor = async () => {
      if (!map.current) return;
      for (const route of CORREDOR_ROUTES) {
        try {
          const res = await fetch(route.url);
          if (!res.ok) continue;
          const geojson = await res.json();
          const b = computeBoundsFromGeoJSON(geojson);
          if (b) corredorBoundsCache.set(route.id, b);
          const srcId = corredorSourceId(route.id);
          const lyrId = corredorLayerId(route.id);
          const casId = corredorCasingId(route.id);
          if (!map.current.getSource(srcId)) {
            map.current.addSource(srcId, { type: 'geojson', data: geojson });
          }
          if (!map.current.getLayer(casId)) {
            map.current.addLayer({
              id: casId,
              type: 'line',
              source: srcId,
              layout: { 'line-join': 'round', 'line-cap': 'round' },
              paint: {
                'line-color': '#ffffff',
                'line-width': CORREDOR_BASE_WIDTH + 3,
                'line-opacity': 0.55,
                'line-blur': 1.5,
              },
            });
          }
          if (!map.current.getLayer(lyrId)) {
            map.current.addLayer({
              id: lyrId,
              type: 'line',
              source: srcId,
              layout: { 'line-join': 'round', 'line-cap': 'round' },
              paint: {
                'line-color': CORREDOR_BASE_COLOR,
                'line-width': CORREDOR_BASE_WIDTH,
              },
            });

            map.current.on('mouseenter', lyrId, (e) => {
              if (!map.current) return;
              map.current.getCanvas().style.cursor = 'pointer';
              const lngLat = (e as any).lngLat;
              corredorHoverPopup
                .setLngLat(lngLat)
                .setHTML(
                  `<div style="font-family: inherit; font-size: 12px; font-weight: 600; color: #0f172a; padding: 2px 4px;">${route.name}</div>`
                )
                .addTo(map.current);
            });
            map.current.on('mousemove', lyrId, (e) => {
              const lngLat = (e as any).lngLat;
              corredorHoverPopup.setLngLat(lngLat);
            });
            map.current.on('mouseleave', lyrId, () => {
              if (!map.current) return;
              map.current.getCanvas().style.cursor = '';
              corredorHoverPopup.remove();
            });
          }
        } catch (err) {
          console.warn('[Corredor] failed to load', route.id, err);
        }
      }
      // Initial state: nothing selected. The sidebar's "Chile" toggle drives it.
      applyCorredorSelection([], false);
    };

    let prevCorredorSelected: string[] = [];
    const onCorredorSelection = (e: Event) => {
      const detail = (e as CustomEvent<CorredorSelectionDetail>).detail;
      if (!detail) return;
      // Avoid the empty→empty no-op flyTo on initial mount.
      const isInitialEmpty = prevCorredorSelected.length === 0 && detail.selected.length === 0;
      applyCorredorSelection(detail.selected, !isInitialEmpty);
      prevCorredorSelected = detail.selected;
    };

    if (map.current.isStyleLoaded()) {
      initCorredor();
    } else {
      map.current.once('load', initCorredor);
    }
    window.addEventListener(CORREDOR_EVENT, onCorredorSelection as EventListener);

    // Swap map style in place — no full page reload.
    const onStyleChange = (e: Event) => {
      const style = (e as CustomEvent).detail as { url: string; auto?: boolean } | undefined;
      if (!map.current || !style?.url) return;
      map.current.setStyle(style.url);
      map.current.once('style.load', () => {
        if (!map.current) return;
        if (style.auto) {
          try { map.current.setConfigProperty('basemap', 'lightPreset', getLightPreset()); } catch {}
        }
      });
    };
    window.addEventListener('gdudex:mapStyleChange', onStyleChange as EventListener);

    // Cleanup
    return () => {
      window.removeEventListener(CORREDOR_EVENT, onCorredorSelection as EventListener);
      window.removeEventListener('gdudex:mapStyleChange', onStyleChange as EventListener);
      clearInterval(lightInterval);
      map.current?.remove();
    };
  }, []);

  // Reset view only on rising edge of onResetView flag
  useEffect(() => {
    if (onResetView && !lastResetFlag.current) {
      resetToInitialView();
    }
    lastResetFlag.current = !!onResetView;
  }, [onResetView]);

  // Helper function to generate color from capa name
  const getColorFromCapa = (capa: string): string => {
    // Generate a hash from the capa string
    let hash = 0;
    for (let i = 0; i < capa.length; i++) {
      hash = capa.charCodeAt(i) + ((hash << 5) - hash);
    }
    
    // Convert to HSL with good saturation and lightness
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 50%)`;
  };

  // Function to search and zoom to marker by label
  const zoomToMarkerByLabel = (label: string) => {
    const activo = activos.find(a => 
      a.etiqueta.toLowerCase().includes(label.toLowerCase())
    );
    
    if (activo && map.current) {
      map.current.flyTo({
        center: [activo.longitud, activo.latitud],
        zoom: 14,
        duration: 2000,
        essential: true
      });
    }
  };

  // Add activo markers with filtering
  useEffect(() => {
    if (!map.current || !activos.length) return;

    // Clear existing activo markers
    activoMarkers.forEach(marker => marker.remove());
    const newMarkers: mapboxgl.Marker[] = [];

    // Filter activos based on selected filters AND selected comunas
    const filteredActivos = activos.filter(activo => {
      // Radial mode: enable everything, restrict to circle only.
      if (radialActive && radialState.center) {
        return isPointInRadius(activo.latitud, activo.longitud);
      }
      const { capas, categorias, comunas } = filters;
      
      // First check if point is within selected comunas (if any selected)
      if (comunas && comunas.length > 0) {
        if (!isPointInSelectedComunas(activo.longitud, activo.latitud)) {
          return false;
        }
      }
      
      // If no layer/category filters selected, show NOTHING (empty map by default)
      if (capas.length === 0 && categorias.length === 0) {
        return false;
      }

      // Check if activo matches selected capa
      const matchesCapa = capas.length === 0 || capas.includes(activo.capa);
      
      // Check if activo matches selected categoria (only if categorias are selected)
      const matchesCategoria = categorias.length === 0 || categorias.includes(activo.categoria);

      // Must match capa AND categoria (if both filters are active)
      return matchesCapa && matchesCategoria;
    });

    // Labels are no longer rendered next to the marker — info appears only on hover (popup) / click (panel).
    // This keeps the map clean, mirroring the projects-filter UX.

    // Define dark gray color for borders and hover
    const MARKER_BORDER_COLOR = '#FFFFFF'; // gray-700
    const MARKER_SIZE = 12; // Base size for activo markers

    filteredActivos.forEach((activo) => {
      // Create marker container (kept for consistency, label removed)
      const container = document.createElement('div');
      container.style.display = 'flex';
      container.style.flexDirection = 'column';
      container.style.alignItems = 'center';
      container.style.gap = '4px';

      // Create marker element with larger hover area
      const el = document.createElement('div');
      el.className = 'activo-marker';
      el.style.width = '24px';
      el.style.height = '24px';
      el.style.display = 'flex';
      el.style.alignItems = 'center';
      el.style.justifyContent = 'center';
      el.style.cursor = 'pointer';
      el.style.position = 'relative';
      
      // Inner visible circle - clean flat design, no icons
      const innerCircle = document.createElement('div');
      innerCircle.style.width = `${MARKER_SIZE}px`;
      innerCircle.style.height = `${MARKER_SIZE}px`;
      innerCircle.style.backgroundColor = getColorFromCapa(activo.capa);
      innerCircle.style.borderRadius = '50%';
      innerCircle.style.border = `1.8px solid ${MARKER_BORDER_COLOR}`;
      innerCircle.style.transition = 'background-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease';
      
      el.appendChild(innerCircle);
      container.appendChild(el);

      // Hover effect - subtle scale + glow, no permanent label
      el.addEventListener('mouseenter', () => {
        innerCircle.style.backgroundColor = MARKER_BORDER_COLOR;
        innerCircle.style.transform = 'scale(1.25)';
        innerCircle.style.boxShadow = `0 0 0 4px ${getColorFromCapa(activo.capa)}33, 0 2px 8px rgba(0,0,0,0.35)`;
      });
      el.addEventListener('mouseleave', () => {
        innerCircle.style.backgroundColor = getColorFromCapa(activo.capa);
        innerCircle.style.transform = 'scale(1)';
        innerCircle.style.boxShadow = 'none';
      });

      
      const capaColor = getColorFromCapa(activo.capa);

      // Compact hover summary; click opens full detail panel
      const popupContent = summaryHTML({
        title: activo.etiqueta,
        subtitle: [activo.region, activo.comuna].filter(Boolean).join(', ') || undefined,
        badge: activo.capa,
        color: capaColor,
      });

      const popup = new mapboxgl.Popup({
        offset: 18,
        maxWidth: '280px',
        closeOnMove: false,
        closeButton: false,
        closeOnClick: false,
      }).setHTML(popupContent);

      const marker = new mapboxgl.Marker({
        element: container,
        anchor: 'center'
      })
        .setLngLat([activo.longitud, activo.latitud])
        .addTo(map.current!);

      // Hover with smart close timing
      let hoverTimeout: ReturnType<typeof setTimeout> | null = null;
      const clearHoverTimeout = () => {
        if (hoverTimeout) { clearTimeout(hoverTimeout); hoverTimeout = null; }
      };
      const scheduleClose = () => {
        clearHoverTimeout();
        hoverTimeout = setTimeout(() => {
          if (popup.isOpen()) popup.remove();
          if (activePopup.current === popup) activePopup.current = null;
        }, 200);
      };

      container.addEventListener('mouseenter', () => {
        clearHoverTimeout();
        if (activePopup.current && activePopup.current !== popup) activePopup.current.remove();
        if (!popup.isOpen()) {
          popup.setLngLat([activo.longitud, activo.latitud]).addTo(map.current!);
        }
        activePopup.current = popup;
      });
      container.addEventListener('mouseleave', scheduleClose);

      // Click opens the draggable detail panel
      container.addEventListener('click', (e) => {
        e.stopPropagation();
        if (popup.isOpen()) popup.remove();
        if (activePopup.current === popup) activePopup.current = null;
        openDetailPanel({ type: 'activo', data: activo, color: capaColor });
      });

      // Touch — tap toggles the detail panel
      container.addEventListener('touchstart', (e: TouchEvent) => {
        e.preventDefault();
        openDetailPanel({ type: 'activo', data: activo, color: capaColor });
      }, { passive: false });

      newMarkers.push(marker);
    });


    setActivoMarkers(newMarkers);
    // Register activos with unified fitBounds
    if (filteredActivos.length > 0) {
      const activoCoords = filteredActivos.map(activo => [activo.longitud, activo.latitud] as [number, number]);
      setSourceCoords('activos', activoCoords);
      setResultCounts(prev => ({ ...prev, activos: filteredActivos.length }));
      triggerFitBounds();
    } else {
      setSourceCoords('activos', []);
      setResultCounts(prev => ({ ...prev, activos: 0 }));
    }
  }, [activos, filters, isPointInSelectedComunas, hasSelectedComunas, radialActive, radialState.center, radialState.radiusKm, isPointInRadius]);

  // Add proyecto markers with comuna filtering
  useEffect(() => {
    if (!map.current) return;

    // Source list: radial mode shows ALL projects within radius, ignoring other filters.
    const sourceProyectos = radialActive ? allProyectos : proyectosFiltrados;

    // Filter proyectos with valid coordinates AND within selected comunas / radial
    const validProyectos = sourceProyectos.filter(p => {
      if (p.latitud === null || p.longitud === null || isNaN(p.latitud) || isNaN(p.longitud)) {
        return false;
      }
      if (radialActive && radialState.center) {
        return isPointInRadius(p.latitud, p.longitud);
      }
      // Check if within selected comunas (if any selected)
      if (filters.comunas && filters.comunas.length > 0) {
        if (!isPointInSelectedComunas(p.longitud, p.latitud)) {
          return false;
        }
      }
      return true;
    });

    // Skip marker recreation if the set of projects hasn't changed
    const prevIds = new Set(prevProyectosRef.current.map(p => p.nombre));
    const currIds = new Set(validProyectos.map(p => p.nombre));
    const changed = prevIds.size !== currIds.size || [...currIds].some(id => !prevIds.has(id));
    
    if (!changed && proyectoMarkers.length > 0) {
      return; // Same projects, keep existing markers
    }

    // Clear existing proyecto markers
    proyectoMarkers.forEach(marker => marker.remove());
    const newMarkers: mapboxgl.Marker[] = [];

    // Calculate investment range for sizing
    const investments = validProyectos.map(p => p.inversion || 0).filter(i => i > 0);
    const minInv = investments.length > 0 ? Math.min(...investments) : 0;
    const maxInv = investments.length > 0 ? Math.max(...investments) : 1;
    const invRange = maxInv - minInv || 1;
    
    // Function to calculate size multiplier based on investment (0.5 to 2)
    const getSizeMultiplier = (inversion: number | null): number => {
      if (inversion === null || inversion <= 0) return 1;
      const normalized = (inversion - minInv) / invRange; // 0 to 1
      return 0.5 + (normalized * 1.5); // 0.5 to 2
    };

    const PROYECTO_BASE_SIZE = 12;
    const PROYECTO_COLOR = '#9333EA'; // Purple
    const PROYECTO_BORDER_COLOR = '#ffffff'; // gray-700

    validProyectos.forEach((proyecto) => {
      // Calculate size based on investment
      const sizeMultiplier = getSizeMultiplier(proyecto.inversion);
      const markerSize = Math.round(PROYECTO_BASE_SIZE * sizeMultiplier);
      const containerSize = markerSize + 16;
      
      // Create marker container
      const container = document.createElement('div');
      container.style.display = 'flex';
      container.style.flexDirection = 'column';
      container.style.alignItems = 'center';
      container.style.gap = '4px';

      // Create marker element with dynamic size
      const el = document.createElement('div');
      el.className = 'proyecto-marker';
      el.style.width = `${containerSize}px`;
      el.style.height = `${containerSize}px`;
      el.style.display = 'flex';
      el.style.alignItems = 'center';
      el.style.justifyContent = 'center';
      el.style.cursor = 'pointer';
      el.style.position = 'relative';
      
      // Inner visible circle - clean flat design, size based on investment
      const innerCircle = document.createElement('div');
      innerCircle.style.width = `${markerSize}px`;
      innerCircle.style.height = `${markerSize}px`;
      innerCircle.style.backgroundColor = PROYECTO_COLOR;
      innerCircle.style.borderRadius = '50%';
      innerCircle.style.border = `1.8px solid ${PROYECTO_BORDER_COLOR}`;
      innerCircle.style.transition = 'background-color 0.15s ease';
      
      el.appendChild(innerCircle);
      container.appendChild(el);

      // Hover effect - fill with dark gray
      el.addEventListener('mouseenter', () => {
        innerCircle.style.backgroundColor = PROYECTO_BORDER_COLOR;
      });
      el.addEventListener('mouseleave', () => {
        innerCircle.style.backgroundColor = PROYECTO_COLOR;
      });

      // Format investment for display
      const formatInversion = (value: number | null): string => {
        if (value === null) return 'N/A';
        if (value >= 1000) return `$${(value / 1000).toFixed(1)}B USD`;
        if (value >= 1) return `$${value.toFixed(0)}M USD`;
        return `$${(value * 1000).toFixed(0)}K USD`;
      };

      // Compact hover summary; click opens full detail panel
      const popupContent = summaryHTML({
        title: proyecto.nombre,
        subtitle: [proyecto.region, proyecto.comuna].filter(Boolean).join(', ') || formatInversion(proyecto.inversion),
        badge: proyecto.estadoProyecto || 'Proyecto',
        color: PROYECTO_COLOR,
      });

      const popup = new mapboxgl.Popup({
        offset: 18,
        maxWidth: '280px',
        closeOnMove: false,
        closeButton: false,
        closeOnClick: false,
      }).setHTML(popupContent);

      const marker = new mapboxgl.Marker({
        element: container,
        anchor: 'bottom'
      })
        .setLngLat([proyecto.longitud!, proyecto.latitud!])
        .addTo(map.current!);

      let hoverTimeout: ReturnType<typeof setTimeout> | null = null;
      container.addEventListener('mouseenter', () => {
        if (hoverTimeout) clearTimeout(hoverTimeout);
        if (activePopup.current && activePopup.current !== popup) activePopup.current.remove();
        if (!popup.isOpen()) {
          popup.setLngLat([proyecto.longitud!, proyecto.latitud!]).addTo(map.current!);
        }
        activePopup.current = popup;
      });
      container.addEventListener('mouseleave', () => {
        hoverTimeout = setTimeout(() => {
          if (popup.isOpen()) popup.remove();
          if (activePopup.current === popup) activePopup.current = null;
        }, 150);
      });

      container.addEventListener('click', (e) => {
        e.stopPropagation();
        if (popup.isOpen()) popup.remove();
        if (activePopup.current === popup) activePopup.current = null;
        openDetailPanel({ type: 'proyecto', data: proyecto, color: PROYECTO_COLOR });
      });

      container.addEventListener('touchstart', (e: TouchEvent) => {
        e.preventDefault();
        openDetailPanel({ type: 'proyecto', data: proyecto, color: PROYECTO_COLOR });
      }, { passive: false });

      newMarkers.push(marker);
    });


    setProyectoMarkers(newMarkers);
    
    // Register proyectos with unified fitBounds
    if (validProyectos.length > 0) {
      const proyCoords = validProyectos.map(p => [p.longitud!, p.latitud!] as [number, number]);
      setSourceCoords('proyectos', proyCoords);
      setResultCounts(prev => ({ ...prev, proyectos: validProyectos.length }));
      triggerFitBounds();
    } else {
      setSourceCoords('proyectos', []);
      setResultCounts(prev => ({ ...prev, proyectos: 0 }));
    }
    prevProyectosRef.current = validProyectos;
  }, [proyectosFiltrados, allProyectos, filters.comunas, isPointInSelectedComunas, radialActive, radialState.center, radialState.radiusKm, isPointInRadius]);

  const { regionesPermitidas } = useAuth();

  async function loadActivos() {
    try {
      const { fetchAllRows } = await import('@/lib/supabasePagination');
      const data = await fetchAllRows((from, to) =>
        supabase.from('activos_mapa').select('*').eq('visible', true).range(from, to)
      );
      
      // Filter by user's allowed regions
      const filtered = regionesPermitidas.length > 0
        ? (data || []).filter((item: any) => item.region && isRegionAllowed(item.region, regionesPermitidas))
        : (data || []);
      
      setActivos(filtered);
    } catch (error) {
      console.error('Error loading activos:', error);
    }
  }

  // ── Inteligencia Logística: infrastructure markers ──
  // Listens for `logistics:set` events dispatched by LogisticsIntelligence
  // and renders category-colored markers on the map. Fully self-contained
  // so it doesn't interfere with existing filter/marker logic.
  useEffect(() => {
    if (!map.current) return;
    let markers: mapboxgl.Marker[] = [];
    const CATEGORY_COLORS: Record<string, string> = {
      puertos: '#1E3A8A',
      parques_industriales: '#7C3AED',
      centros_logisticos: '#16A34A',
      zonas_pric: '#F97316',
    };
    const CATEGORY_LABELS: Record<string, string> = {
      puertos: 'Puerto',
      parques_industriales: 'Parque Industrial',
      centros_logisticos: 'Centro Logístico',
      zonas_pric: 'Zona PRIC',
    };

    const clear = () => {
      markers.forEach(m => m.remove());
      markers = [];
    };

    const handler = async (e: Event) => {
      const detail = (e as CustomEvent).detail as { active: string[] } | undefined;
      const active = detail?.active || [];
      clear();
      if (!map.current || active.length === 0) return;

      const {
        LOGISTICS_PORTS,
        LOGISTICS_PARQUES,
        LOGISTICS_CENTROS,
        LOGISTICS_PRIC,
      } = await import('@/lib/logisticsData');

      const groups: Record<string, { points: typeof LOGISTICS_PORTS }> = {
        puertos: { points: LOGISTICS_PORTS },
        parques_industriales: { points: LOGISTICS_PARQUES },
        centros_logisticos: { points: LOGISTICS_CENTROS },
        zonas_pric: { points: LOGISTICS_PRIC },
      };

      const bounds = new mapboxgl.LngLatBounds();
      active.forEach(catId => {
        const group = groups[catId];
        if (!group) return;
        const color = CATEGORY_COLORS[catId];
        const label = CATEGORY_LABELS[catId];
        group.points.forEach(pt => {
          const el = document.createElement('div');
          el.style.cssText = `
            width:22px;height:22px;border-radius:50%;
            background:${color};border:2px solid #fff;
            box-shadow:0 0 0 3px ${color}33, 0 2px 6px rgba(0,0,0,0.35);
            display:flex;align-items:center;justify-content:center;
            color:#fff;font-size:11px;font-weight:700;cursor:pointer;
            transition:transform .15s ease;
          `;
          el.title = `${label}: ${pt.name}`;
          el.textContent = label.charAt(0);
          el.addEventListener('mouseenter', () => { el.style.transform = 'scale(1.15)'; });
          el.addEventListener('mouseleave', () => { el.style.transform = 'scale(1)'; });

          const popupHtml = `
            <div style="font-family:inherit;min-width:180px;padding:2px 4px;">
              <div style="font-size:10px;font-weight:600;color:${color};text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px;">${label}</div>
              <div style="font-size:13px;font-weight:600;color:#111827;line-height:1.2;">${pt.name}</div>
              ${pt.description ? `<div style="font-size:11px;color:#6B7280;margin-top:4px;line-height:1.35;">${pt.description}</div>` : ''}
              <div style="font-size:10px;color:#9CA3AF;margin-top:6px;font-family:monospace;">${pt.lat.toFixed(4)}°, ${pt.lng.toFixed(4)}°</div>
            </div>
          `;
          const popup = new mapboxgl.Popup({ offset: 16, closeButton: true }).setHTML(popupHtml);
          const marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
            .setLngLat([pt.lng, pt.lat])
            .setPopup(popup)
            .addTo(map.current!);
          markers.push(marker);
          bounds.extend([pt.lng, pt.lat]);
        });
      });

      if (!bounds.isEmpty() && map.current) {
        map.current.fitBounds(bounds, { padding: 80, maxZoom: 10, duration: 900 });
      }
    };

    window.addEventListener('logistics:set', handler);
    return () => {
      window.removeEventListener('logistics:set', handler);
      clear();
    };
  }, []);

  return (
    <div className="w-full h-full relative">
      <div ref={mapContainer} className="absolute inset-0" />
      
      {/* Results Counter Overlay */}
      <MapResultsCounter
        counts={resultCounts}
        hasActiveFilters={
          (filters.capas?.length > 0) || (filters.categorias?.length > 0) ||
          (filters.comunas?.length > 0) || (filters.poligonos?.length > 0) ||
          (filters.planRegulador?.length > 0) || (proyectosFiltrados?.length > 0)
        }
        onClearAll={resetToInitialView}
      />
      
      {/* AI Search Component */}
      <SearchBar 
        onSearch={() => {}} 
        onCoordinatesExtracted={zoomToCoordinates}
        onLabelSearch={zoomToMarkerByLabel}
        onResponseClose={resetToInitialView}
        onFiltersApply={onFiltersApply}
        activos={activos}
        availableCapas={availableCapas}
        availableMedioambiente={availableMedioambiente}
        proyectos={allProyectos}
        isMobile={isMobile}
        selectedComunas={filters.comunas}
        isPointInSelectedComunas={isPointInSelectedComunas}
        sidebarCollapsed={sidebarCollapsed}
        onPricFormOpenChange={onPricFormOpenChange}
      />

      {/* Map style selector next to the SearchBar */}
      <MapStyleSelector sidebarCollapsed={sidebarCollapsed} sidebarWidth={360} isMobile={isMobile} />


      {/* Coordinates Display */}
      {selectedCoords && (
        <div className="absolute bottom-20 left-4 z-[900] glass-panel p-4 shadow-lg animate-fade-in">
          <div className="flex items-start justify-between gap-8">
            <div>
              <p className="text-xs font-semibold mb-2">Coordenadas seleccionadas:</p>
              <div className="space-y-1 font-mono text-xs">
                <p><span className="text-muted-foreground">Latitud:</span> {selectedCoords.lat.toFixed(6)}°</p>
                <p><span className="text-muted-foreground">Longitud:</span> {selectedCoords.lng.toFixed(6)}°</p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedCoords(null)}
              className="h-6 w-6 p-0"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <MapDetailPanel />
      <MonitoringController />
    </div>
  );
}
