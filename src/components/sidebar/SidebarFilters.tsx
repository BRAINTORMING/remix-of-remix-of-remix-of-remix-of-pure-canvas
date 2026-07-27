/**
 * Shared filters state + section components used by the new AppSidebar layout.
 * Mirrors the original ActivosLayerControl behavior (state, data loading,
 * onFiltersChange/onResetView callbacks) but exposes the four logical
 * sub-sections (Regiones y Comunas, Capas Base, Medioambiente, Planes
 * Reguladores) as independent components that share a single state instance
 * through React Context.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  Layers,
  Leaf,
  FileText,
  MapPin,
  Star,
  X,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { externalSupabase as supabase } from "@/integrations/supabase/externalClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { useRegionComunas } from "@/hooks/useRegionComunas";
import { useAuth } from "@/contexts/AuthContext";
import { useSessionTracking } from "@/contexts/SessionTrackingContext";
import { fetchAllRows } from "@/lib/supabasePagination";
import {
  COMUNAS_TARAPACA,
  type PoligonoData,
  type PlanReguladorData,
} from "@/components/ActivosLayerControl";

// ===== Types =====
interface CapaWithCategorias {
  capa: string;
  categorias: string[];
}

interface PoligonoItem {
  categoria: string;
  coordenadas: string;
  image?: string | null;
  descripcion?: string | null;
  etiqueta?: string | null;
  comuna?: string | null;
  region?: string | null;
}

interface CategoriaGroup {
  categoria: string;
  poligonos: PoligonoItem[];
  isGroup: boolean;
}

interface MedioambienteCapaWithCategorias {
  capa: string;
  categorias: CategoriaGroup[];
}

interface SidebarFiltersContextValue {
  // Region / Comuna
  regionsWithComunas: { region: string; comunas: { comuna: string; coordenadas: string }[] }[];
  loadingComunas: boolean;
  coordsReady: boolean;
  selectedRegion: string;
  selectedComunas: string[];
  filteredComunas: { comuna: string; coordenadas: string }[];
  setRegion: (region: string) => void;
  setComunaSingle: (comunaId: string | null) => void;
  toggleComuna: (comunaId: string) => void;
  selectAllComunas: () => void;
  deselectAllComunas: () => void;

  // Capas Base
  capasWithCategorias: CapaWithCategorias[];
  selectedCapas: string[];
  // NOTE: internally stored as composite "capa::categoria" keys so that two
  // different capas sharing a categoria name don't collide. Use the helper
  // methods below (toggleCategoria / getSelectedCategoriasCount / etc.)
  // rather than comparing raw categoria strings against this array.
  selectedCategorias: string[];
  expandedCapas: string[];
  toggleCapa: (capa: string) => void;
  toggleCategoria: (categoria: string, parentCapa: string) => void;
  toggleExpandCapa: (capa: string) => void;
  selectAllCategoriasForCapa: (capa: CapaWithCategorias) => void;
  deselectAllCategoriasForCapa: (capa: CapaWithCategorias) => void;
  areAllCategoriasSelected: (capa: CapaWithCategorias) => boolean;
  getSelectedCategoriasCount: (capa: string) => number;
  isCategoriaSelected: (categoria: string, parentCapa: string) => boolean;

  // Medioambiente
  medioambienteCapas: MedioambienteCapaWithCategorias[];
  selectedMedioambienteCategorias: string[];
  expandedMedioambienteCapas: string[];
  expandedMedioambienteCategorias: string[];
  toggleMedioambientePoligono: (capa: string, categoria: string, etiqueta: string) => void;
  toggleExpandMedioambienteCapa: (capa: string) => void;
  toggleExpandMedioambienteCategoria: (capa: string, categoria: string) => void;
  selectAllMedioambienteCapa: (capa: string) => void;
  deselectAllMedioambienteCapa: (capa: string) => void;
  areAllMedioambienteCapaSelected: (capa: string) => boolean;
  getSelectedMedioambienteCategoriasCount: (capa: string) => number;
  selectAllMedioambienteCategoriaGroup: (capa: string, categoria: string) => void;
  deselectAllMedioambienteCategoriaGroup: (capa: string, categoria: string) => void;
  areAllMedioambienteCategoriaGroupSelected: (capa: string, categoria: string) => boolean;

  // Planes Reguladores (PRIC — table poligonos_pric)
  pricNombres: string[];
  pricCategoriasByNombre: Record<string, string[]>;
  // Polygon counts: per nombre_zona_pric and per `${nombre}::${categoria}` key.
  pricCountByNombre: Record<string, number>;
  pricCountByCategoria: Record<string, number>;
  pricTotalPoligonos: number;
  // Composite keys `${nombre_zona_pric}::${categoria_zona_pric}` — each key
  // corresponds to the set of polygons sharing that (nombre, categoria) pair.
  selectedPricKeys: string[];
  togglePricNombre: (nombre: string) => void;
  togglePricCategoria: (nombre: string, categoria: string) => void;
  isPricNombreFullySelected: (nombre: string) => boolean;
  isPricNombrePartiallySelected: (nombre: string) => boolean;
  isPricCategoriaSelected: (nombre: string, categoria: string) => boolean;
  selectAllPric: () => void;
  deselectAllPric: () => void;

  // Límite oficial PRIC (contorno del ámbito de aplicación).
  pricLimiteEnabled: boolean;
  togglePricLimite: () => void;
}

const SidebarFiltersContext = createContext<SidebarFiltersContextValue | null>(null);

export function useSidebarFilters() {
  const ctx = useContext(SidebarFiltersContext);
  if (!ctx) throw new Error("useSidebarFilters must be used inside <SidebarFiltersProvider>");
  return ctx;
}

interface ProviderProps {
  children: ReactNode;
  onFiltersChange?: (filters: {
    capas: string[];
    categorias: string[];
    comunas: string[];
    poligonos: PoligonoData[];
    planRegulador: PlanReguladorData[];
  }) => void;
  onResetView?: () => void;
  onRegionChange?: (region: string) => void;
  onComunasChange?: (comunas: string[]) => void;
  onHasFiltersChange?: (hasFilters: boolean) => void;
  resetKey?: number;
}

// Builds the composite key used to store a categoria selection scoped to its
// parent capa, avoiding collisions when two capas share a categoria name.
function categoriaKey(capa: string, categoria: string) {
  return `${capa}::${categoria}`;
}

export function SidebarFiltersProvider({
  children,
  onFiltersChange,
  onResetView,
  onRegionChange,
  onComunasChange,
  onHasFiltersChange,
  resetKey,
}: ProviderProps) {
  const { toast } = useToast();
  const { trackCapas, trackModule } = useSessionTracking();
  const { regionsWithComunas: allRegionsWithComunas, data: regionComunasData, loading: loadingComunas, coordsReady } = useRegionComunas();
  const { regionesPermitidas } = useAuth();

  const normalize = useCallback(
    (s: string) =>
      s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/^regi[oó]n\s+(de(l)?\s+)?/i, "")
        .replace(/[_\s]+/g, " ")
        .trim(),
    []
  );

  const regionsWithComunas = useMemo(() => {
    if (!regionesPermitidas || regionesPermitidas.length === 0) return allRegionsWithComunas;
    return allRegionsWithComunas.filter(r =>
      regionesPermitidas.some(allowed => {
        const na = normalize(r.region);
        const nb = normalize(allowed);
        return na === nb || na.includes(nb) || nb.includes(na);
      })
    );
  }, [allRegionsWithComunas, regionesPermitidas, normalize]);

  const [capasWithCategorias, setCapasWithCategorias] = useState<CapaWithCategorias[]>([]);
  const [selectedCapas, setSelectedCapas] = useState<string[]>([]);
  // Composite "capa::categoria" keys — see categoriaKey().
  const [selectedCategorias, setSelectedCategorias] = useState<string[]>([]);
  const [selectedComunas, setSelectedComunas] = useState<string[]>([]);
  const [selectedRegion, setSelectedRegion] = useState<string>("");
  const [expandedCapas, setExpandedCapas] = useState<string[]>([]);
  const hadFiltersRef = useRef(false);
  const onFiltersChangeRef = useRef(onFiltersChange);
  const onResetViewRef = useRef(onResetView);
  const onRegionChangeRef = useRef(onRegionChange);

  const [medioambienteCapas, setMedioambienteCapas] = useState<MedioambienteCapaWithCategorias[]>([]);
  const [selectedMedioambienteCategorias, setSelectedMedioambienteCategorias] = useState<string[]>([]);
  const [expandedMedioambienteCapas, setExpandedMedioambienteCapas] = useState<string[]>([]);
  const [expandedMedioambienteCategorias, setExpandedMedioambienteCategorias] = useState<string[]>([]);
  const [allPoligonos, setAllPoligonos] = useState<PoligonoData[]>([]);

  // PRIC (poligonos_pric) — nombre_zona_pric + categoria_zona_pric
  const [pricNombres, setPricNombres] = useState<string[]>([]);
  const [pricCategoriasByNombre, setPricCategoriasByNombre] = useState<Record<string, string[]>>({});
  const [pricCountByNombre, setPricCountByNombre] = useState<Record<string, number>>({});
  const [pricCountByCategoria, setPricCountByCategoria] = useState<Record<string, number>>({});
  const [pricTotalPoligonos, setPricTotalPoligonos] = useState(0);
  const [selectedPricKeys, setSelectedPricKeys] = useState<string[]>([]);
  const [pricLimiteEnabled, setPricLimiteEnabled] = useState(false);
  const [allPlanReguladorData, setAllPlanReguladorData] = useState<(PlanReguladorData & { nombre?: string; categoria?: string })[]>([]);

  // Plain categoria names (deduped) derived from the composite keys, for
  // consumers of onFiltersChange that expect a flat list of categoria names.
  const plainCategorias = useMemo(() => {
    const set = new Set<string>();
    selectedCategorias.forEach(key => {
      const idx = key.indexOf("::");
      set.add(idx >= 0 ? key.slice(idx + 2) : key);
    });
    return Array.from(set);
  }, [selectedCategorias]);

  // Keep COMUNAS_TARAPACA in sync (backward compat with other components).
  useEffect(() => {
    if (regionComunasData.length > 0) {
      // Mutates exported reference used by SearchBar, MapView, etc.
      (COMUNAS_TARAPACA as any).length = 0;
      regionComunasData.forEach(item => {
        (COMUNAS_TARAPACA as any).push({
          id: item.comuna.toLowerCase().replace(/\s+/g, "-"),
          nombre: item.comuna,
          coordenadas: item.coordenadas,
        });
      });
    }
  }, [regionComunasData]);

  const filteredComunas = selectedRegion
    ? regionsWithComunas.find(r => r.region === selectedRegion)?.comunas || []
    : [];

  useEffect(() => {
    onFiltersChangeRef.current = onFiltersChange;
    onResetViewRef.current = onResetView;
    onRegionChangeRef.current = onRegionChange;
  });

  useEffect(() => {
    if (!supabase) {
      console.error("External Supabase client not configured.");
      return;
    }
    loadFilterOptions();
    loadMedioambienteOptions();
    loadPlanReguladorOptions();

    const channel = supabase
      .channel("activos-mapa-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "activos_mapa" }, () => {
        loadFilterOptions();
        toast({ title: "Datos actualizados", description: "Los filtros se han actualizado" });
      })
      .subscribe();

    const poligonosChannel = supabase
      .channel("poligonos-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "poligonos" }, () => {
        loadMedioambienteOptions();
        toast({ title: "Datos actualizados", description: "Los filtros de medioambiente se han actualizado" });
      })
      .subscribe();

    const planReguladorChannel = supabase
      .channel("plan-regulador-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "plan_regulador" }, () => {
        loadPlanReguladorOptions();
        toast({ title: "Datos actualizados", description: "Los filtros de Plan Regulador se han actualizado" });
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      supabase.removeChannel(poligonosChannel);
      supabase.removeChannel(planReguladorChannel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Emit filters upstream
  useEffect(() => {
    const selectedPoligonos = allPoligonos.filter(p => {
      const uniqueKey = `${p.capa}::${p.categoria}::${p.etiqueta || ""}`;
      return selectedMedioambienteCategorias.includes(uniqueKey);
    });

    const selectedPlanReguladorData = allPlanReguladorData.filter(p =>
      selectedPricKeys.includes(`${p.nombre || ""}::${p.categoria || ""}`)
    );

    onFiltersChangeRef.current?.({
      capas: selectedCapas,
      categorias: plainCategorias,
      comunas: selectedComunas,
      poligonos: selectedPoligonos,
      planRegulador: selectedPlanReguladorData,
    });

    // NOTE: selectedRegion is intentionally excluded. Having a region picked
    // (e.g. the default "Tarapacá") is not itself a "filter" — the map only
    // draws things once the user actually selects comunas/capas/proyectos.
    // Clearing every filter manually should return to the globe view while
    // keeping the region selected.
    const hasFilters =
      selectedCapas.length > 0 ||
      selectedCategorias.length > 0 ||
      selectedComunas.length > 0 ||
      selectedMedioambienteCategorias.length > 0 ||
      selectedPricKeys.length > 0;

    onHasFiltersChange?.(hasFilters);

    if (!hasFilters && hadFiltersRef.current) {
      onResetViewRef.current?.();
    }
    hadFiltersRef.current = hasFilters;
  }, [
    selectedCapas,
    selectedCategorias,
    plainCategorias,
    selectedComunas,
    selectedMedioambienteCategorias,
    allPoligonos,
    selectedPricKeys,
    allPlanReguladorData,
    selectedRegion,
    onHasFiltersChange,
  ]);

  useEffect(() => {
    onComunasChange?.(selectedComunas);
  }, [selectedComunas, onComunasChange]);

  // External reset
  useEffect(() => {
    if (resetKey !== undefined && resetKey > 0) {
      setSelectedCapas([]);
      setSelectedCategorias([]);
      setSelectedComunas([]);
      setSelectedMedioambienteCategorias([]);
      setSelectedPricKeys([]);
      setExpandedCapas([]);
      setExpandedMedioambienteCapas([]);
      setExpandedMedioambienteCategorias([]);
      // Re-default region to Tarapacá (or the first allowed region) so the
      // "position zero" of Gdudex always has a region pre-picked.
      const preferred =
        regionsWithComunas.find(r => normalize(r.region).includes("tarapaca"))?.region ||
        regionsWithComunas[0]?.region ||
        "";
      setSelectedRegion(preferred);
      onRegionChangeRef.current?.(preferred);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // Auto-select Tarapacá as the default region on first load so the user
  // doesn't have to open the dropdown to start filtering. The map still
  // stays on the globe until an actual filter is applied.
  const didAutoPickRegion = useRef(false);
  useEffect(() => {
    if (didAutoPickRegion.current) return;
    if (loadingComunas) return;
    if (selectedRegion) { didAutoPickRegion.current = true; return; }
    if (regionsWithComunas.length === 0) return;
    const preferred =
      regionsWithComunas.find(r => normalize(r.region).includes("tarapaca"))?.region ||
      regionsWithComunas[0]?.region;
    if (preferred) {
      didAutoPickRegion.current = true;
      setSelectedRegion(preferred);
      onRegionChangeRef.current?.(preferred);
    }
  }, [loadingComunas, regionsWithComunas, selectedRegion, normalize]);

  useEffect(() => { trackCapas(selectedCapas); }, [selectedCapas, trackCapas]);
  useEffect(() => { trackModule("medioambiente", selectedMedioambienteCategorias.length > 0); }, [selectedMedioambienteCategorias, trackModule]);
  useEffect(() => { trackModule("plan_regulador", selectedPricKeys.length > 0); }, [selectedPricKeys, trackModule]);

  async function loadFilterOptions() {
    try {
      if (!supabase) return;
      const data = await fetchAllRows((from, to) =>
        supabase.from("activos_mapa")
          .select("capa, categoria, region")
          .eq("visible", true)
          .range(from, to)
      );
      const filtered = regionesPermitidas.length > 0
        ? (data || []).filter((item: any) => item.region && regionesPermitidas.some(allowed =>
            normalize(item.region).includes(normalize(allowed)) || normalize(allowed).includes(normalize(item.region))
          ))
        : (data || []);

      const capaMap = new Map<string, Set<string>>();
      filtered.forEach((item: any) => {
        if (item.capa) {
          if (!capaMap.has(item.capa)) capaMap.set(item.capa, new Set());
          if (item.categoria) capaMap.get(item.capa)!.add(item.categoria);
        }
      });
      const result: CapaWithCategorias[] = [];
      capaMap.forEach((categorias, capa) => {
        result.push({ capa, categorias: Array.from(categorias).sort() });
      });
      setCapasWithCategorias(result.sort((a, b) => a.capa.localeCompare(b.capa)));
    } catch (e) { console.error(e); }
  }

  async function loadMedioambienteOptions() {
    try {
      if (!supabase) return;
      const data = await fetchAllRows((from, to) =>
        supabase.from("poligonos")
          .select("capa, categoria, coordenadas, image, descripcion, etiqueta, comuna, region")
          .range(from, to)
      );
      const filtered = regionesPermitidas.length > 0
        ? (data || []).filter((item: any) => item.region && regionesPermitidas.some(allowed =>
            normalize(item.region).includes(normalize(allowed)) || normalize(allowed).includes(normalize(item.region))
          ))
        : (data || []);
      setAllPoligonos(filtered);

      const capaMap = new Map<string, Map<string, PoligonoItem[]>>();
      (data || []).forEach((item: any) => {
        if (item.capa && item.categoria && item.coordenadas) {
          if (!capaMap.has(item.capa)) capaMap.set(item.capa, new Map());
          const categoriaMap = capaMap.get(item.capa)!;
          if (!categoriaMap.has(item.categoria)) categoriaMap.set(item.categoria, []);
          categoriaMap.get(item.categoria)!.push({
            categoria: item.categoria,
            coordenadas: item.coordenadas,
            image: item.image,
            descripcion: item.descripcion,
            etiqueta: item.etiqueta,
            comuna: item.comuna,
            region: item.region,
          });
        }
      });

      const result: MedioambienteCapaWithCategorias[] = [];
      capaMap.forEach((categoriaMap, capa) => {
        const cgs: CategoriaGroup[] = [];
        categoriaMap.forEach((poligonos, categoria) => {
          cgs.push({
            categoria,
            poligonos: poligonos.sort((a, b) => (a.etiqueta || "").localeCompare(b.etiqueta || "")),
            isGroup: poligonos.length > 1,
          });
        });
        result.push({ capa, categorias: cgs.sort((a, b) => a.categoria.localeCompare(b.categoria)) });
      });
      setMedioambienteCapas(result.sort((a, b) => a.capa.localeCompare(b.capa)));
    } catch (e) { console.error(e); }
  }

  async function loadPlanReguladorOptions() {
    try {
      if (!supabase) return;
      // New data source: poligonos_pric (nombre_zona_pric / categoria_zona_pric).
      // Legacy `plan_regulador` table is no longer read here.
      const rows = await fetchAllRows((from, to) =>
        (supabase as any)
          .from("poligonos_pric")
          .select("nombre_zona_pric, categoria_zona_pric, coordenadas, region, comuna")
          .range(from, to)
      );
      const filtered = regionesPermitidas.length > 0
        ? (rows || []).filter((r: any) => r.region && regionesPermitidas.some(allowed =>
            normalize(r.region).includes(normalize(allowed)) || normalize(allowed).includes(normalize(r.region))
          ))
        : (rows || []);

      const mapped = filtered
        .filter((r: any) => r.coordenadas && (r.nombre_zona_pric || r.categoria_zona_pric))
        .map((r: any) => ({
          capa: `${r.nombre_zona_pric || "Sin nombre"} — ${r.categoria_zona_pric || "Sin categoría"}`,
          coordenadas: r.coordenadas as string,
          nombre: (r.nombre_zona_pric || "Sin nombre") as string,
          categoria: (r.categoria_zona_pric || "Sin categoría") as string,
        }));

      setAllPlanReguladorData(mapped);

      // Group categorias by nombre for the UI + count polygons per level.
      const byNombre: Record<string, Set<string>> = {};
      const countNombre: Record<string, number> = {};
      const countCategoria: Record<string, number> = {};
      mapped.forEach((m) => {
        if (!byNombre[m.nombre]) byNombre[m.nombre] = new Set();
        byNombre[m.nombre].add(m.categoria);
        countNombre[m.nombre] = (countNombre[m.nombre] || 0) + 1;
        const k = `${m.nombre}::${m.categoria}`;
        countCategoria[k] = (countCategoria[k] || 0) + 1;
      });
      const nombres = Object.keys(byNombre).sort((a, b) => a.localeCompare(b));
      const byNombreArr: Record<string, string[]> = {};
      nombres.forEach((n) => {
        byNombreArr[n] = Array.from(byNombre[n]).sort((a, b) => a.localeCompare(b));
      });
      setPricNombres(nombres);
      setPricCategoriasByNombre(byNombreArr);
      setPricCountByNombre(countNombre);
      setPricCountByCategoria(countCategoria);
      setPricTotalPoligonos(mapped.length);
    } catch (e) { console.error(e); }
  }

  // ===== Actions =====
  const setRegion = (region: string) => {
    setSelectedRegion(region);
    // Do NOT auto-select all comunas: at initial load nothing should be
    // marked on the map. Comunas remain empty until the user picks them.
    setSelectedComunas([]);
    onRegionChange?.(region);
  };

  const setComunaSingle = (comunaId: string | null) => {
    if (!comunaId) {
      // "Todas" — select all comunas of the current region
      const regionComunas = regionsWithComunas.find(r => r.region === selectedRegion)?.comunas || [];
      setSelectedComunas(regionComunas.map(c => c.comuna.toLowerCase().replace(/\s+/g, "-")));
    } else {
      setSelectedComunas([comunaId]);
    }
  };

  const toggleComuna = (comunaId: string) => {
    setSelectedComunas(prev =>
      prev.includes(comunaId) ? prev.filter(c => c !== comunaId) : [...prev, comunaId]
    );
  };
  const selectAllComunas = () => {
    const regionComunas = regionsWithComunas.find(r => r.region === selectedRegion)?.comunas || [];
    setSelectedComunas(regionComunas.map(c => c.comuna.toLowerCase().replace(/\s+/g, "-")));
  };
  const deselectAllComunas = () => setSelectedComunas([]);


  const toggleCapa = (capa: string) => {
    setSelectedCapas(prev => {
      const isSelected = prev.includes(capa);
      if (isSelected) {
        // Drop every categoria selection that belongs to this capa, scoped
        // by the composite key prefix so categorias of other capas (even if
        // they share the same name) are left untouched.
        setSelectedCategorias(p => p.filter(key => !key.startsWith(`${capa}::`)));
        return prev.filter(c => c !== capa);
      }
      return [...prev, capa];
    });
  };

  const toggleCategoria = (categoria: string, parentCapa: string) => {
    const key = categoriaKey(parentCapa, categoria);
    const isCurrentlySelected = selectedCategorias.includes(key);

    if (isCurrentlySelected) {
      // Deselecting: drop the categoria, and if that was the last selected
      // categoria for this capa, drop the capa from selectedCapas too —
      // otherwise it's reported upstream as "selected" with no categoria
      // filter, which makes the map fall back to showing every point of
      // the capa.
      setSelectedCategorias(prev => {
        const next = prev.filter(c => c !== key);
        const stillHasOtherCategoria = next.some(k => k.startsWith(`${parentCapa}::`));
        if (!stillHasOtherCategoria) {
          setSelectedCapas(p => p.filter(c => c !== parentCapa));
        }
        return next;
      });
    } else {
      if (!selectedCapas.includes(parentCapa)) setSelectedCapas(prev => [...prev, parentCapa]);
      setSelectedCategorias(prev => [...prev, key]);
    }
  };

  const toggleExpandCapa = (capa: string) =>
    setExpandedCapas(prev => prev.includes(capa) ? prev.filter(c => c !== capa) : [...prev, capa]);

  const selectAllCategoriasForCapa = (capaData: CapaWithCategorias) => {
    if (!selectedCapas.includes(capaData.capa)) setSelectedCapas(prev => [...prev, capaData.capa]);
    setSelectedCategorias(prev => {
      const newKeys = capaData.categorias
        .map(cat => categoriaKey(capaData.capa, cat))
        .filter(key => !prev.includes(key));
      return [...prev, ...newKeys];
    });
  };
  const deselectAllCategoriasForCapa = (capaData: CapaWithCategorias) => {
    setSelectedCategorias(prev => prev.filter(key => !key.startsWith(`${capaData.capa}::`)));
    setSelectedCapas(prev => prev.filter(c => c !== capaData.capa));
  };
  const areAllCategoriasSelected = (capaData: CapaWithCategorias) =>
    capaData.categorias.length > 0
      ? capaData.categorias.every(cat => selectedCategorias.includes(categoriaKey(capaData.capa, cat)))
      : selectedCapas.includes(capaData.capa);
  // Capas without categorias (e.g. "Corredor Bioceánico") have nothing to
  // add to selectedCategorias, so their selection state lives only in
  // selectedCapas. Count them as 1 when selected so they still show a badge.
  const getSelectedCategoriasCount = (capa: string) => {
    const capaData = capasWithCategorias.find(c => c.capa === capa);
    if (capaData && capaData.categorias.length === 0) {
      return selectedCapas.includes(capa) ? 1 : 0;
    }
    return selectedCategorias.filter(key => key.startsWith(`${capa}::`)).length;
  };
  const isCategoriaSelected = (categoria: string, parentCapa: string) =>
    selectedCategorias.includes(categoriaKey(parentCapa, categoria));

  // Medioambiente helpers
  const toggleMedioambientePoligono = (capa: string, categoria: string, etiqueta: string) => {
    const key = `${capa}::${categoria}::${etiqueta}`;
    setSelectedMedioambienteCategorias(prev => prev.includes(key) ? prev.filter(c => c !== key) : [...prev, key]);
  };
  const toggleExpandMedioambienteCapa = (capa: string) =>
    setExpandedMedioambienteCapas(prev => prev.includes(capa) ? prev.filter(c => c !== capa) : [...prev, capa]);
  const toggleExpandMedioambienteCategoria = (capa: string, categoria: string) => {
    const key = `${capa}::${categoria}`;
    setExpandedMedioambienteCategorias(prev => prev.includes(key) ? prev.filter(c => c !== key) : [...prev, key]);
  };
  const getAllMedioambienteKeysForCapa = (capa: string): string[] => {
    const cd = medioambienteCapas.find(c => c.capa === capa);
    if (!cd) return [];
    const keys: string[] = [];
    cd.categorias.forEach(cg => cg.poligonos.forEach(pol => keys.push(`${capa}::${cg.categoria}::${pol.etiqueta || ""}`)));
    return keys;
  };
  const selectAllMedioambienteCapa = (capa: string) => {
    const allKeys = getAllMedioambienteKeysForCapa(capa);
    setSelectedMedioambienteCategorias(prev => [...prev, ...allKeys.filter(k => !prev.includes(k))]);
  };
  const deselectAllMedioambienteCapa = (capa: string) => {
    const allKeys = getAllMedioambienteKeysForCapa(capa);
    setSelectedMedioambienteCategorias(prev => prev.filter(k => !allKeys.includes(k)));
  };
  const areAllMedioambienteCapaSelected = (capa: string) => {
    const allKeys = getAllMedioambienteKeysForCapa(capa);
    return allKeys.length > 0 && allKeys.every(k => selectedMedioambienteCategorias.includes(k));
  };
  const getSelectedMedioambienteCategoriasCount = (capa: string) =>
    selectedMedioambienteCategorias.filter(k => k.startsWith(`${capa}::`)).length;

  const getAllMedioambienteKeysForCategoriaGroup = (capa: string, categoria: string): string[] => {
    const cd = medioambienteCapas.find(c => c.capa === capa);
    if (!cd) return [];
    const cg = cd.categorias.find(x => x.categoria === categoria);
    if (!cg) return [];
    return cg.poligonos.map(pol => `${capa}::${categoria}::${pol.etiqueta || ""}`);
  };
  const selectAllMedioambienteCategoriaGroup = (capa: string, categoria: string) => {
    const keys = getAllMedioambienteKeysForCategoriaGroup(capa, categoria);
    setSelectedMedioambienteCategorias(prev => [...prev, ...keys.filter(k => !prev.includes(k))]);
  };
  const deselectAllMedioambienteCategoriaGroup = (capa: string, categoria: string) => {
    const keys = getAllMedioambienteKeysForCategoriaGroup(capa, categoria);
    setSelectedMedioambienteCategorias(prev => prev.filter(k => !keys.includes(k)));
  };
  const areAllMedioambienteCategoriaGroupSelected = (capa: string, categoria: string) => {
    const keys = getAllMedioambienteKeysForCategoriaGroup(capa, categoria);
    return keys.length > 0 && keys.every(k => selectedMedioambienteCategorias.includes(k));
  };

  // PRIC (poligonos_pric)
  const pricKey = (nombre: string, categoria: string) => `${nombre}::${categoria}`;
  const isPricCategoriaSelected = (nombre: string, categoria: string) =>
    selectedPricKeys.includes(pricKey(nombre, categoria));
  const isPricNombreFullySelected = (nombre: string) => {
    const cats = pricCategoriasByNombre[nombre] || [];
    return cats.length > 0 && cats.every(c => selectedPricKeys.includes(pricKey(nombre, c)));
  };
  const isPricNombrePartiallySelected = (nombre: string) => {
    const cats = pricCategoriasByNombre[nombre] || [];
    const some = cats.some(c => selectedPricKeys.includes(pricKey(nombre, c)));
    return some && !isPricNombreFullySelected(nombre);
  };
  const togglePricCategoria = (nombre: string, categoria: string) => {
    const k = pricKey(nombre, categoria);
    setSelectedPricKeys(prev => prev.includes(k) ? prev.filter(x => x !== k) : [...prev, k]);
  };
  const togglePricNombre = (nombre: string) => {
    const cats = pricCategoriasByNombre[nombre] || [];
    const keys = cats.map(c => pricKey(nombre, c));
    if (isPricNombreFullySelected(nombre)) {
      setSelectedPricKeys(prev => prev.filter(k => !keys.includes(k)));
    } else {
      setSelectedPricKeys(prev => Array.from(new Set([...prev, ...keys])));
    }
  };
  const selectAllPric = () => {
    const all: string[] = [];
    pricNombres.forEach(n => (pricCategoriasByNombre[n] || []).forEach(c => all.push(pricKey(n, c))));
    setSelectedPricKeys(all);
  };
  const deselectAllPric = () => setSelectedPricKeys([]);

  const togglePricLimite = () => {
    setPricLimiteEnabled(prev => {
      const next = !prev;
      window.dispatchEvent(new CustomEvent("pric:limiteToggle", { detail: { enabled: next } }));
      return next;
    });
  };


  const value: SidebarFiltersContextValue = {
    regionsWithComunas,
    loadingComunas,
    coordsReady,
    selectedRegion,
    selectedComunas,
    filteredComunas,
    setRegion,
    setComunaSingle,
    toggleComuna,
    selectAllComunas,
    deselectAllComunas,
    capasWithCategorias,
    selectedCapas,
    selectedCategorias,
    expandedCapas,
    toggleCapa,
    toggleCategoria,
    toggleExpandCapa,
    selectAllCategoriasForCapa,
    deselectAllCategoriasForCapa,
    areAllCategoriasSelected,
    getSelectedCategoriasCount,
    isCategoriaSelected,
    medioambienteCapas,
    selectedMedioambienteCategorias,
    expandedMedioambienteCapas,
    expandedMedioambienteCategorias,
    toggleMedioambientePoligono,
    toggleExpandMedioambienteCapa,
    toggleExpandMedioambienteCategoria,
    selectAllMedioambienteCapa,
    deselectAllMedioambienteCapa,
    areAllMedioambienteCapaSelected,
    getSelectedMedioambienteCategoriasCount,
    selectAllMedioambienteCategoriaGroup,
    deselectAllMedioambienteCategoriaGroup,
    areAllMedioambienteCategoriaGroupSelected,
    pricNombres,
    pricCategoriasByNombre,
    pricCountByNombre,
    pricCountByCategoria,
    pricTotalPoligonos,
    selectedPricKeys,
    togglePricNombre,
    togglePricCategoria,
    isPricNombreFullySelected,
    isPricNombrePartiallySelected,
    isPricCategoriaSelected,
    selectAllPric,
    deselectAllPric,
    pricLimiteEnabled,
    togglePricLimite,
  };

  return (
    <SidebarFiltersContext.Provider value={value}>
      {children}
    </SidebarFiltersContext.Provider>
  );
}

// ============= Shared styling helpers =============
const HOVER_TINT = "hover:bg-[#EFF6FF]";
// Light gray used for the tree-style guide lines that connect a chevron to
// the list it expands. Kept as one constant so trunk + ticks always match.
const TREE_LINE_COLOR = "#E5E7EB";

// Fixed-size circular count badge: equal width/height regardless of the
// number of digits, used everywhere a counter is shown (section headers and
// per-capa/per-categoria sub-counters alike).
function CountBadge({
  count,
  colorClass = "bg-primary/10 text-primary",
}: {
  count: number;
  colorClass?: string;
}) {
  if (!count || count <= 0) return null;
  return (
    <span
      className={cn(
        "flex items-center justify-center w-5 h-5 rounded-full text-[9px] font-medium leading-none flex-shrink-0",
        colorClass
      )}
    >
      {count}
    </span>
  );
}

/**
 * Tree-style guide elements that visually connect an expand/collapse chevron
 * to the list it controls:
 * - `TreeTrunk` is the vertical line running the full height of an expanded
 *   block. It must be placed inside a `relative` wrapper, positioned under
 *   the chevron that toggles that block (left = button padding + half the
 *   icon width).
 * - `TreeTick` is the short horizontal line on each row that links it back
 *   to the trunk. It must be placed inside a `relative` row, and its left
 *   offset is negative (it reaches left, into the row's own left padding,
 *   back toward the trunk).
 * Both are purely decorative.
 */
function TreeTrunk({ left }: { left: number }) {
  return (
    <div
      aria-hidden="true"
      className="absolute top-0 bottom-0 w-px pointer-events-none"
      style={{ left, backgroundColor: TREE_LINE_COLOR }}
    />
  );
}

function TreeTick({ left, width }: { left: number; width: number }) {
  return (
    <span
      aria-hidden="true"
      className="absolute top-1/2 -translate-y-1/2 h-px pointer-events-none"
      style={{ left, width, backgroundColor: TREE_LINE_COLOR }}
    />
  );
}

interface SectionTriggerProps {
  icon: ReactNode;
  label: string;
  count?: number;
  countColorClass?: string;
  open: boolean;
  tooltip?: string;
}

function SectionTriggerInner({ icon, label, count, countColorClass, open, tooltip }: SectionTriggerProps) {
  return (
    <div
      title={tooltip || label}
     className={cn(
  "w-full flex items-center justify-between px-3 py-2.5 rounded-[13px] transition-colors duration-150",
  HOVER_TINT
)}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="text-foreground/80 flex-shrink-0">{icon}</span>
        <span className="font-medium text-[13px] text-foreground truncate">{label}</span>
        {count !== undefined && (
          <CountBadge count={count} {...(countColorClass ? { colorClass: countColorClass } : {})} />
        )}
      </div>
      <ChevronRight
        className={cn(
          "h-4 w-4 text-[#9CA3AF] transition-transform duration-200 flex-shrink-0",
          open && "rotate-90"
        )}
      />
    </div>
  );
}

// ============= Sections =============

/** Fixed (non-collapsible) Regiones y Comunas at the top of the sidebar. */
export function RegionesYComunasFixed() {
  const {
    regionsWithComunas, loadingComunas, coordsReady, selectedRegion, selectedComunas, filteredComunas,
    setRegion, toggleComuna, selectAllComunas, deselectAllComunas,
  } = useSidebarFilters();
  const comunasLocked = loadingComunas || !coordsReady;
  const { hasPermission } = useAuth();
  const [open, setOpen] = useState(false);
  if (!hasPermission("regiones_comunas")) return null;

  const allComunaIds = filteredComunas.map(c => c.comuna.toLowerCase().replace(/\s+/g, "-"));
  const isAllSelected = selectedComunas.length > 0 && allComunaIds.length > 0 && allComunaIds.every(id => selectedComunas.includes(id));
  const triggerLabel = !selectedRegion
    ? "Selecciona Comuna..."
    : selectedComunas.length === 0
      ? "Selecciona Comuna..."
      : isAllSelected
        ? "Todas las comunas"
        : selectedComunas.length === 1
          ? (filteredComunas.find(c => c.comuna.toLowerCase().replace(/\s+/g, "-") === selectedComunas[0])?.comuna || "1 comuna")
          : `${selectedComunas.length} comunas`;

  return (
    <div className="px-2 py-2" title="Selecciona la región y comunas para filtrar el mapa">
      <div className="flex items-center gap-2.5 px-1 pb-2">
        <MapPin className="h-4 w-4" style={{ color: "#3B82F6" }} />
        <span className="font-semibold text-[13px] text-foreground">Regiones y Comunas</span>
      </div>
      <div className="space-y-2 px-1">
        <Select value={selectedRegion} onValueChange={setRegion} disabled={loadingComunas}>
          <SelectTrigger className="h-9 text-xs bg-white border-border rounded-[13px]">
            <SelectValue placeholder="Selecciona Región..." />
          </SelectTrigger>
          <SelectContent className="z-[9999] bg-popover border border-border rounded-[13px] shadow-none !shadow-none">
            {regionsWithComunas.map(r => (
              <SelectItem
                key={r.region}
                value={r.region}
                className="text-xs pl-8 pr-2 py-1.5 rounded-[10px]"
              >
                {r.region}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Multi-select comunas — bloqueado hasta que los polígonos hayan cargado */}
        <div className="relative">
          <button
            type="button"
            disabled={!selectedRegion || comunasLocked}
            onClick={() => setOpen(o => !o)}
            className={cn(
              "w-full h-9 text-xs bg-white border border-border rounded-[13px] flex items-center justify-between px-3 transition-colors",
              (!selectedRegion || comunasLocked) ? "opacity-50 cursor-not-allowed" : "hover:bg-[#F9FAFB]"
            )}
            title={comunasLocked ? "Cargando polígonos de comunas..." : undefined}
          >
            <span className={cn("truncate", selectedComunas.length === 0 && "text-muted-foreground")}>
              {comunasLocked ? "Cargando polígonos..." : triggerLabel}
            </span>
            <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", open && "rotate-180")} />
          </button>
          {open && selectedRegion && !comunasLocked && (

            <>
              <div className="fixed inset-0 z-[9998]" onClick={() => setOpen(false)} />
              <div
                className="absolute left-0 right-0 mt-1 z-[9999] bg-popover border border-border rounded-[13px] shadow-lg max-h-[280px] overflow-y-auto p-1"
              >
                <button
  type="button"
  onClick={() => (isAllSelected ? deselectAllComunas() : selectAllComunas())}
  className="w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-[10px] hover:bg-[#EFF6FF] transition-colors duration-150"
>
                  <Checkbox checked={isAllSelected} className="h-3.5 w-3.5 pointer-events-none" />
                  <span className="font-medium">Todas las comunas</span>
                </button>
                <div className="h-px bg-border my-1" />
                {filteredComunas.map(c => {
                  const id = c.comuna.toLowerCase().replace(/\s+/g, "-");
                  const checked = selectedComunas.includes(id);
                  return (
                   <button
  key={id}
  type="button"
  onClick={() => toggleComuna(id)}
  className="w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-[10px] hover:bg-[#EFF6FF] transition-colors duration-150"
>
                      <Checkbox checked={checked} className="h-3.5 w-3.5 pointer-events-none" />
                      <span className="truncate">{c.comuna}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}


/** Capas Base section. */
export function CapasBaseSection() {
  const { hasPermission } = useAuth();
  const ctx = useSidebarFilters();
  const [open, setOpen] = useState(false);
  if (!hasPermission("capas")) return null;
  const locked = !ctx.selectedRegion;

  return (
    <Collapsible open={locked ? false : open} onOpenChange={(v) => { if (!locked) setOpen(v); }}>
      <CollapsibleTrigger asChild disabled={locked}>
        <button className={cn("w-full", locked && "opacity-60 cursor-not-allowed")} title={locked ? "Selecciona una región para activar" : undefined}>
          <SectionTriggerInner
            open={open}
            icon={<Layers className="h-4 w-4 text-blue-500" />}
            label="Capas Base"
            count={ctx.capasWithCategorias.reduce((acc, c) => acc + ctx.getSelectedCategoriasCount(c.capa), 0)}
            countColorClass="bg-blue-50 text-blue-600"
            tooltip={locked ? "Selecciona una región para activar" : "Activa capas base de información territorial"}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-200">
        <div className="px-3 pt-1 pb-2 space-y-1">
          {ctx.capasWithCategorias.length === 0 ? (
            <p className="text-[11px] text-muted-foreground px-2 py-1">No hay capas disponibles</p>
          ) : (
            ctx.capasWithCategorias.map(capaData => (
              <div key={capaData.capa} className="rounded-lg">
                <div className="flex items-center">
                  <button onClick={() => ctx.toggleExpandCapa(capaData.capa)} className="p-1.5 mr-1.5 hover:bg-[#EFF6FF] rounded-md transition-colors">
                    <ChevronRight className={cn("h-3 w-3 text-[#9CA3AF] transition-transform", ctx.expandedCapas.includes(capaData.capa) && "rotate-90")} />
                  </button>
                  <div className="flex items-center gap-2 flex-1 py-1.5 pr-2">
                    <Checkbox
                      id={`capa-${capaData.capa}`}
                      checked={ctx.areAllCategoriasSelected(capaData)}
                      onCheckedChange={(checked) => checked ? ctx.selectAllCategoriasForCapa(capaData) : ctx.deselectAllCategoriasForCapa(capaData)}
                      className="h-3.5 w-3.5 border-gray-300 data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                    />
                    <Label htmlFor={`capa-${capaData.capa}`} className="text-[11px] cursor-pointer flex-1 font-medium text-foreground">
                      {capaData.capa}
                    </Label>
                    <CountBadge
                      count={ctx.getSelectedCategoriasCount(capaData.capa)}
                      colorClass="bg-blue-50 text-blue-600"
                    />
                  </div>
                </div>
                {ctx.expandedCapas.includes(capaData.capa) && capaData.categorias.length > 0 && (
                  <div className="relative pl-7 pr-2 py-1 space-y-1">
                    {/* Trunk: aligned under the capa chevron (p-1.5 + half of h-3 icon = 12px) */}
                    <TreeTrunk left={12} />
                    {capaData.categorias.map(categoria => (
                      <div key={categoria} className="relative flex items-center gap-2">
                        {/* Tick: bridges the trunk (12px) to where the row content starts (pl-7 = 28px) */}
                        <TreeTick left={-16} width={16} />
                        <Checkbox
                          id={`cat-${capaData.capa}-${categoria}`}
                          checked={ctx.isCategoriaSelected(categoria, capaData.capa)}
                          onCheckedChange={() => ctx.toggleCategoria(categoria, capaData.capa)}
                          className="h-3 w-3 border-border data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                        />
                        <Label htmlFor={`cat-${capaData.capa}-${categoria}`} className="text-[10px] cursor-pointer flex-1 text-muted-foreground">
                          {categoria}
                        </Label>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Medioambiente section. */
export function MedioambienteSection() {
  const { hasPermission } = useAuth();
  const ctx = useSidebarFilters();
  const [open, setOpen] = useState(false);
  if (!hasPermission("medioambiente")) return null;
  const locked = !ctx.selectedRegion;

  return (
    <Collapsible open={locked ? false : open} onOpenChange={(v) => { if (!locked) setOpen(v); }}>
      <CollapsibleTrigger asChild disabled={locked}>
        <button className={cn("w-full", locked && "opacity-60 cursor-not-allowed")} title={locked ? "Selecciona una región para activar" : undefined}>
          <SectionTriggerInner
            open={open}
            icon={<Leaf className="h-4 w-4 text-emerald-500" />}
            label="Medio Ambiente"
            count={ctx.selectedMedioambienteCategorias.length}
            countColorClass="bg-emerald-50 text-emerald-600"
            tooltip={locked ? "Selecciona una región para activar" : "Polígonos de áreas medioambientales"}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-200">
        <div className="px-3 pt-1 pb-2 space-y-1">
          {ctx.medioambienteCapas.length === 0 ? (
            <p className="text-[11px] text-muted-foreground px-2 py-1">No hay datos disponibles</p>
          ) : (
            ctx.medioambienteCapas.map(capaData => (
              <div key={capaData.capa}>
                <div className="flex items-center">
                  <button onClick={() => ctx.toggleExpandMedioambienteCapa(capaData.capa)} className="p-1.5 mr-1.5 hover:bg-[#EFF6FF] rounded-md transition-colors">
                    <ChevronRight className={cn("h-3 w-3 text-[#9CA3AF] transition-transform", ctx.expandedMedioambienteCapas.includes(capaData.capa) && "rotate-90")} />
                  </button>
                  <div className="flex items-center gap-2 flex-1 py-1.5 pr-2">
                    <Checkbox
                      id={`ma-${capaData.capa}`}
                      checked={ctx.areAllMedioambienteCapaSelected(capaData.capa)}
                      onCheckedChange={(checked) => checked ? ctx.selectAllMedioambienteCapa(capaData.capa) : ctx.deselectAllMedioambienteCapa(capaData.capa)}
                      className="h-3.5 w-3.5 border-gray-300 data-[state=checked]:bg-emerald-500 data-[state=checked]:border-emerald-500"
                    />
                    <Label className="text-[11px] cursor-pointer flex-1 font-medium text-foreground" onClick={() => ctx.toggleExpandMedioambienteCapa(capaData.capa)}>
                      {capaData.capa}
                    </Label>
                    <CountBadge
                      count={ctx.getSelectedMedioambienteCategoriasCount(capaData.capa)}
                      colorClass="bg-emerald-50 text-emerald-600"
                    />
                  </div>
                </div>
                {ctx.expandedMedioambienteCapas.includes(capaData.capa) && capaData.categorias.length > 0 && (
                  <div className="relative pl-6 pr-2 py-1 space-y-1">
                    {/* Trunk: aligned under the capa chevron (p-1.5 + half of h-3 icon = 12px) */}
                    <TreeTrunk left={12} />
                    {capaData.categorias.map(catGroup => (
                      <div key={`${capaData.capa}-${catGroup.categoria}`}>
                        {catGroup.isGroup ? (
                          <div>
                            <div className="relative flex items-center">
                              {/* Tick: bridges the capa trunk (12px) to where this row's content starts (pl-6 = 24px) */}
                              <TreeTick left={-12} width={12} />
                              <button onClick={() => ctx.toggleExpandMedioambienteCategoria(capaData.capa, catGroup.categoria)} className="p-1 mr-1.5 hover:bg-[#EFF6FF] rounded transition-colors">
                                <ChevronRight className={cn("h-2.5 w-2.5 text-[#9CA3AF] transition-transform", ctx.expandedMedioambienteCategorias.includes(`${capaData.capa}::${catGroup.categoria}`) && "rotate-90")} />
                              </button>
                              <Checkbox
                                checked={ctx.areAllMedioambienteCategoriaGroupSelected(capaData.capa, catGroup.categoria)}
                                onCheckedChange={(checked) => checked ? ctx.selectAllMedioambienteCategoriaGroup(capaData.capa, catGroup.categoria) : ctx.deselectAllMedioambienteCategoriaGroup(capaData.capa, catGroup.categoria)}
                                className="h-3 w-3 border-border data-[state=checked]:bg-emerald-500 data-[state=checked]:border-emerald-500 mr-1.5"
                              />
                              <Label className="text-[10px] cursor-pointer flex-1 py-1 pr-2 text-muted-foreground font-medium" onClick={() => ctx.toggleExpandMedioambienteCategoria(capaData.capa, catGroup.categoria)}>
                                {catGroup.categoria}
                                <span className="ml-1 text-[9px]">({catGroup.poligonos.length})</span>
                              </Label>
                            </div>
                            {ctx.expandedMedioambienteCategorias.includes(`${capaData.capa}::${catGroup.categoria}`) && (
                              <div className="relative pl-6 pr-2 py-1 space-y-1">
                                {/* Trunk: aligned under the categoria-group chevron (p-1 + half of h-2.5 icon = 9px) */}
                                <TreeTrunk left={9} />
                                {catGroup.poligonos.map((pol, idx) => {
                                  const uk = `${capaData.capa}::${catGroup.categoria}::${pol.etiqueta || ""}`;
                                  return (
                                    <div key={uk + idx} className="relative flex items-center gap-2">
                                      {/* Tick: bridges this trunk (9px) to where the row content starts (pl-6 = 24px) */}
                                      <TreeTick left={-15} width={15} />
                                      <Checkbox
                                        checked={ctx.selectedMedioambienteCategorias.includes(uk)}
                                        onCheckedChange={() => ctx.toggleMedioambientePoligono(capaData.capa, catGroup.categoria, pol.etiqueta || "")}
                                        className="h-2.5 w-2.5 border-border data-[state=checked]:bg-emerald-500 data-[state=checked]:border-emerald-500"
                                      />
                                      <Label className="text-[9px] cursor-pointer flex-1 text-muted-foreground">{pol.etiqueta || catGroup.categoria}</Label>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        ) : (
                          catGroup.poligonos.map((pol, idx) => {
                            const uk = `${capaData.capa}::${catGroup.categoria}::${pol.etiqueta || ""}`;
                            return (
                              <div key={uk + idx} className="relative flex items-center gap-2 py-0.5">
                                {/* Tick: bridges the capa trunk (12px) to where this row's content starts (pl-6 = 24px) */}
                                <TreeTick left={-12} width={12} />
                                <Checkbox
                                  checked={ctx.selectedMedioambienteCategorias.includes(uk)}
                                  onCheckedChange={() => ctx.toggleMedioambientePoligono(capaData.capa, catGroup.categoria, pol.etiqueta || "")}
                                  className="h-3 w-3 border-border data-[state=checked]:bg-emerald-500 data-[state=checked]:border-emerald-500"
                                />
                                <Label className="text-[10px] cursor-pointer flex-1 text-muted-foreground">{pol.etiqueta || catGroup.categoria}</Label>
                              </div>
                            );
                          })
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Planes Reguladores del Territorio.
 * Fuente: tabla `poligonos_pric` (nombre_zona_pric + categoria_zona_pric).
 * Layout numerado en dos bloques:
 *   1. Nombre de la Zona  — selecciona/deselecciona en grupo todas sus categorías.
 *   2. Categoría de Zona  — selección individual (mostradas agrupadas por nombre).
 * Ambos bloques son independientes: el usuario puede filtrar sólo por nombres,
 * sólo por categorías, o combinar ambos.
 */
export function PlanReguladorSection() {
  const { hasPermission } = useAuth();
  const ctx = useSidebarFilters();
  const [open, setOpen] = useState(false);
  const [expandedNombres, setExpandedNombres] = useState<string[]>([]);
  if (!hasPermission("plan_regulador")) return null;

  const toggleExpand = (n: string) =>
    setExpandedNombres(prev => prev.includes(n) ? prev.filter(x => x !== n) : [...prev, n]);

  const totalCategorias = ctx.selectedPricKeys.length;
  const locked = !ctx.selectedRegion;

  return (
    <Collapsible open={locked ? false : open} onOpenChange={(v) => { if (!locked) setOpen(v); }}>
      <CollapsibleTrigger asChild disabled={locked}>
        <button className={cn("w-full", locked && "opacity-60 cursor-not-allowed")} title={locked ? "Selecciona una región para activar" : undefined}>
          <SectionTriggerInner
            open={open}
            icon={<FileText className="h-4 w-4 text-amber-500" />}
            label="Planes Reguladores"
            count={totalCategorias}
            countColorClass="bg-amber-50 text-amber-600"
            tooltip={locked ? "Selecciona una región para activar" : "Zonificación normativa del territorio (poligonos_pric)"}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-200">
        <div className="px-3 pt-2 pb-3 space-y-3">
          {/* ═══ Límite oficial del PRIC ═══ */}
          <div className="rounded-lg border border-indigo-200 bg-indigo-50/60 p-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="pric-limite-toggle"
                checked={ctx.pricLimiteEnabled}
                onCheckedChange={ctx.togglePricLimite}
                className="h-4 w-4 border-indigo-400 data-[state=checked]:bg-indigo-600 data-[state=checked]:border-indigo-600"
              />
              <div className="flex-1 min-w-0">
                <Label
                  htmlFor="pric-limite-toggle"
                  className="text-[11.5px] font-semibold text-indigo-900 cursor-pointer leading-tight block"
                >
                  Límite PRIC
                </Label>
                <p className="text-[9.5px] text-indigo-700/70 leading-tight mt-0.5">
                  Ámbito oficial de aplicación (contorno)
                </p>
              </div>
              <span className={cn(
                "h-2.5 w-2.5 rounded-full border",
                ctx.pricLimiteEnabled ? "bg-indigo-600 border-indigo-700" : "bg-transparent border-indigo-300"
              )} />
            </div>
          </div>

          {ctx.pricNombres.length === 0 ? (
            <p className="text-[11px] text-muted-foreground px-2 py-1">No hay zonas disponibles</p>
          ) : (
            <>
              {/* Header + acciones globales */}
              <div className="flex items-center justify-between px-1">
                <p className="text-[9.5px] font-semibold uppercase tracking-widest text-[#9CA3AF]">
                  Nombre de la Zona · {ctx.pricTotalPoligonos} polígonos
                </p>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={ctx.selectAllPric}
                    className="text-[9.5px] font-medium text-amber-600 hover:text-amber-700 transition-colors"
                  >
                    Todos
                  </button>
                  <span className="text-muted-foreground/40 text-[9px]">·</span>
                  <button
                    onClick={ctx.deselectAllPric}
                    className="text-[9.5px] font-medium text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Limpiar
                  </button>
                </div>
              </div>

              {/* Bloque unificado: cada Nombre de Zona con sus categorías anidadas */}
              <div className="rounded-lg border border-amber-100 bg-amber-50/40 p-1.5 space-y-0.5">
                {ctx.pricNombres.map(nombre => {
                  const full = ctx.isPricNombreFullySelected(nombre);
                  const partial = ctx.isPricNombrePartiallySelected(nombre);
                  const cats = ctx.pricCategoriasByNombre[nombre] || [];
                  const expanded = expandedNombres.includes(nombre);
                  const selCount = cats.filter(c => ctx.isPricCategoriaSelected(nombre, c)).length;
                  const polCount = ctx.pricCountByNombre[nombre] || 0;
                  return (
                    <div
                      key={nombre}
                      className={cn(
                        "rounded-md transition-colors",
                        full || partial ? "bg-white shadow-sm" : "hover:bg-white/70"
                      )}
                    >
                      <div className="flex items-center gap-1.5 py-1 px-1.5">
                        <button
                          type="button"
                          onClick={() => toggleExpand(nombre)}
                          className="shrink-0 p-0.5 rounded hover:bg-amber-100/70"
                          aria-label={expanded ? "Contraer" : "Expandir"}
                        >
                          {expanded ? (
                            <ChevronDown className="h-3 w-3 text-amber-700" />
                          ) : (
                            <ChevronRight className="h-3 w-3 text-amber-700" />
                          )}
                        </button>
                        <Checkbox
                          id={`pric-n-${nombre}`}
                          checked={full ? true : partial ? "indeterminate" : false}
                          onCheckedChange={() => ctx.togglePricNombre(nombre)}
                          className={cn(
                            "h-3.5 w-3.5 border-amber-300",
                            "data-[state=checked]:bg-amber-500 data-[state=checked]:border-amber-500",
                            partial && "bg-amber-200 border-amber-400"
                          )}
                        />
                        <Label
                          htmlFor={`pric-n-${nombre}`}
                          className="text-[11px] cursor-pointer flex-1 font-medium text-foreground leading-tight"
                        >
                          {nombre}
                        </Label>
                        <span
                          title={`${cats.length} categorías · ${polCount} polígonos`}
                          className={cn(
                            "text-[9px] font-medium tabular-nums px-1.5 py-0.5 rounded-full",
                            selCount > 0
                              ? "bg-amber-500 text-white"
                              : "bg-amber-100 text-amber-700"
                          )}
                        >
                          {selCount > 0 ? `${selCount}/${cats.length} · ${polCount}` : `${cats.length} · ${polCount}`}
                        </span>
                      </div>
                      {expanded && cats.length > 0 && (
                        <div className="pl-7 pr-1.5 pb-1.5 pt-0.5 space-y-0.5 border-l-2 border-amber-200 ml-3.5 mb-1">
                          {cats.map(cat => {
                            const checked = ctx.isPricCategoriaSelected(nombre, cat);
                            return (
                              <div
                                key={cat}
                                className={cn(
                                  "flex items-center gap-2 py-0.5 px-1.5 rounded transition-colors",
                                  checked ? "bg-amber-50" : "hover:bg-amber-50/60"
                                )}
                              >
                                <Checkbox
                                  id={`pric-c-${nombre}-${cat}`}
                                  checked={checked}
                                  onCheckedChange={() => ctx.togglePricCategoria(nombre, cat)}
                                  className="h-3 w-3 border-amber-300 data-[state=checked]:bg-amber-500 data-[state=checked]:border-amber-500"
                                />
                                <Label
                                  htmlFor={`pric-c-${nombre}-${cat}`}
                                  className="text-[10.5px] cursor-pointer flex-1 text-foreground/80 leading-tight"
                                >
                                  {cat}
                                </Label>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Uppercase muted category subheader with horizontal divider above. */
export function SidebarSectionHeader({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <div className="pt-3" title={title}>
      <div className="h-px bg-[#F3F4F6] mb-2" />
      <p className="px-3 text-[10px] font-semibold uppercase tracking-widest text-[#9CA3AF]">
        {children}
      </p>
    </div>
  );
}

// ============= Favoritos (capas guardadas) =============
import { useFavorites } from "@/hooks/useFavorites";

const FAV_TYPE_LABEL: Record<string, string> = {
  activo: "Activo",
  proyecto: "Proyecto",
  poligono: "Polígono",
  planRegulador: "Plan Regulador",
  comuna: "Comuna",
  pric: "PRIC",
};

export function FavoritesSection() {
  const [open, setOpen] = useState(false);
  const { items, open: openFav, remove } = useFavorites();

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button className="w-full">
          <SectionTriggerInner
            open={open}
            icon={<Star className="h-4 w-4" style={{ color: "#F59E0B", fill: "#F59E0B" }} />}
            label="Capas Favoritas"
            count={items.length}
            countColorClass="bg-amber-50 text-amber-600"
            tooltip="Tus capas, proyectos y polígonos marcados como favoritos"
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-200">
        <div className="px-3 pt-1 pb-2 space-y-1">
          {items.length === 0 ? (
            <p className="text-[11px] text-muted-foreground px-2 py-1.5 leading-relaxed">
              Aún no tienes favoritos. Marca cualquier elemento del mapa con el botón ★ del encabezado de su tarjeta.
            </p>
          ) : (
            items.map(item => (
              <div
                key={item.id}
                className="group flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-[#EFF6FF] transition-colors"
              >
                <button
                  type="button"
                  onClick={() => openFav(item)}
                  className="flex-1 min-w-0 flex items-center gap-2 text-left"
                  title={`Abrir ${item.title}`}
                >
                  <Star className="h-3.5 w-3.5 shrink-0" style={{ color: item.color || "#F59E0B", fill: item.color || "#F59E0B" }} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[11.5px] font-medium text-foreground truncate">{item.title}</div>
                    <div className="text-[9.5px] uppercase tracking-wide text-muted-foreground">
                      {FAV_TYPE_LABEL[item.type] || item.type}
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => remove(item.id)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-white text-muted-foreground hover:text-destructive"
                  title="Quitar de favoritos"
                  aria-label="Quitar de favoritos"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

