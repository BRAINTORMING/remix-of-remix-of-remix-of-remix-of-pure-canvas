import { useState, useEffect, useMemo, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, FileSearch, X, ChevronDown, ChevronRight, CheckCircle2, AlertTriangle, XCircle, Info, HelpCircle, Crosshair, MapPin, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { externalSupabase } from '@/integrations/supabase/externalClient';
import { useToast } from '@/hooks/use-toast';

interface TipoProyectoPRIC {
  tipo: string;
  categoria: string;
  descripcion: string | null;
  requiere_superficie_util?: boolean | null;
}

type DictamenTipo =
  | 'viable'
  | 'viable_condicionado'
  | 'no_viable'
  | 'requiere_revision_manual'
  | 'sin_zona_identificada_en_este_instrumento'
  | 'fuera_del_ambito_de_aplicacion'
  | string;

interface NormasGrupoUso {
  cc?: number | null;
  os?: number | null;
  altura_max_m?: number | null;
}

interface DictamenInstrumento {
  instrumento: string;
  dictamen: DictamenTipo;
  motivos?: string[];
  zona_uso_suelo?: string | null;
  normas_grupo_uso?: NormasGrupoUso | null;
  subdivision_minima_aplicada_m2?: number | null;
  restricciones_aplicadas?: Array<{ capa?: string; nota?: string; codigo?: string }>;
  riesgos_detectados?: Array<{ capa?: string; codigo_zona?: string }>;
  patrimonio_detectado?: Array<{ capa?: string; codigo_zona?: string }>;
}

interface NarrativaInstrumento {
  instrumento: string;
  narrativa: string;
}

interface EvaluacionResultado {
  resuelto?: boolean;
  motivo?: string;
  cobertura?: string;
  comuna?: string;
  region?: string;
  dictamenes_por_instrumento?: DictamenInstrumento[];
  narrativas?: NarrativaInstrumento[];
  estacionamientos?: { cupos_requeridos?: number; nota?: string } | null;
  restricciones_ambientales_universales?: Array<{ capa: string }>;
  dentro_limite_oficial_pric?: boolean;
  comuna_aproximada?: boolean;
  nota?: string;
}

export interface EvaluacionPRICData {
  nombreProyecto: string;
  tipoProyecto: string;
  categoria: string;
  latitud: number;
  longitud: number;
  superficiePredio: number;
  superficieTotalConstruir: number;
  superficieOcupacionSuelo: number;
  alturaMaxima: number;
  superficieUtilConstruida: number;
  descripcion: string;
}

interface EvaluacionPRICModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: EvaluacionPRICData) => void;
  isLoading?: boolean;
}

// Descriptions for each "tipo" (project type)
const tipoDescriptions: Record<string, string> = {
  'Proyectos Residenciales': 'Edificaciones destinadas principalmente a la habitabilidad y el descanso, incluyendo vivienda permanente, vivienda social (hasta 1.000 UF) y hospedaje temporal.',
  'Equipamiento': 'Edificaciones destinadas a prestar servicios a la comunidad: científico/cultura, comercio, salud, educación, seguridad, deporte, servicios y esparcimiento.',
  'Actividades Productivas': 'Proyectos clasificados según nivel de externalidades: inofensivas, molestas, contaminantes/peligrosas y logística/bodegaje.',
  'Infraestructura': 'Instalaciones de gran envergadura: sanitaria (plantas de agua), energética (centrales), y transporte (terminales, puertos, aeropuertos).',
  'Espacio Público': 'Áreas verdes intercomunales, espacio público (vial) y equipamiento turístico-recreacional en planicies costeras.',
};

// Descriptions for each "categoria"
const categoriaDescriptions: Record<string, string> = {
  'Vivienda': 'Construcciones destinadas a la residencia permanente de personas.',
  'Vivienda Social': 'Conjuntos habitacionales con un valor de hasta 1.000 UF; el Plan otorga facilidades especiales para su ubicación incluso en ciertas áreas rurales (ARU).',
  'Hospedaje': 'Proyectos destinados a alojamiento temporal: hoteles, apart-hoteles y moteles.',
  'Científico y Cultura': 'Centros de investigación, museos y centros de difusión (permitidos incluso en áreas protegidas APVN con restricciones de altura).',
  'Comercio': 'Supermercados, locales comerciales, estaciones de servicio y restaurantes.',
  'Salud': 'Hospitales, clínicas y consultorios.',
  'Educación': 'Colegios e instituciones de educación técnica o superior.',
  'Salud y Educación': 'Hospitales, clínicas, consultorios, colegios e instituciones de educación técnica o superior.',
  'Seguridad': 'Cuarteles de bomberos y unidades policiales.',
  'Deporte': 'Gimnasios y centros deportivos.',
  'Seguridad y Deporte': 'Cuarteles de bomberos, unidades policiales, gimnasios y centros deportivos.',
  'Servicios': 'Oficinas y bancos.',
  'Social y Esparcimiento': 'Parques de entretenciones y casinos.',
  'Inofensivas': 'Actividades que no causan daños ni molestias al vecindario.',
  'Molestas': 'Actividades que pueden causar ruidos, vibraciones u olores; deben ubicarse preferentemente en la Zona Productiva Molesta (ZPM).',
  'Contaminantes y Peligrosas': 'Proyectos de alto impacto con emisiones nocivas o riesgos críticos, restringidos a la Zona Productiva Contaminante (ZPC).',
  'Logística y Bodegaje': 'Instalaciones destinadas al acopio y distribución de mercancías.',
  'Sanitaria': 'Plantas de captación y tratamiento de agua potable o servidas, y rellenos sanitarios (zonas ZI-S).',
  'Energética': 'Centrales de generación o distribución de energía y redes de telecomunicaciones (zonas ZI-E).',
  'Transporte': 'Terminales de carga terrestre, recintos marítimos/portuarios (ZI-TP) e instalaciones aeroportuarias (ZI-TA).',
  'Áreas Verdes Intercomunales': 'Parques y plazas que sirven como amortiguadores ambientales entre zonas industriales y residenciales.',
  'Espacio Público': 'Sistema vial y espacios de uso público general.',
  'Turístico Recreacional': 'Balnearios, campamentos turísticos y equipamiento de esparcimiento ligero en planicies costeras.',
};

// Custom dropdown with hover tooltips
function TooltipSelect({
  value,
  onChange,
  items,
  descriptions,
  placeholder,
  disabled,
  hasError,
}: {
  value: string;
  onChange: (v: string) => void;
  items: string[];
  descriptions: Record<string, string>;
  placeholder: string;
  disabled?: boolean;
  hasError?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        className={cn(
          "flex h-8 w-full items-center justify-between rounded-md border px-3 py-2 text-xs font-medium transition-all duration-[140ms]",
          "bg-card border-border text-foreground",
          "focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none",
          !value && "text-muted-foreground",
          hasError && "border-destructive",
          disabled && "opacity-50 cursor-not-allowed"
        )}
      >
        <span className="truncate">{value || placeholder}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 opacity-50 transition-transform", isOpen && "rotate-180")} />
      </button>

      {isOpen && items.length > 0 && (
        <div className="absolute top-full left-0 mt-1 w-full z-[9999] bg-popover border border-border rounded-lg shadow-xl overflow-hidden">
          <div className="max-h-52 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
            {items.map((item) => (
              <div
                key={item}
                className="relative"
                onMouseEnter={() => setHoveredItem(item)}
                onMouseLeave={() => setHoveredItem(null)}
              >
                <button
                  type="button"
                  onClick={() => { onChange(item); setIsOpen(false); setHoveredItem(null); }}
                  className={cn(
                    "w-full text-left px-3 py-2 text-xs text-foreground hover:bg-secondary transition-colors",
                    value === item && "bg-primary/10 text-primary"
                  )}
                >
                  {item}
                </button>

                {/* Tooltip on hover */}
                {hoveredItem === item && descriptions[item] && (
                  <div
                    className="absolute left-full top-0 ml-2 w-64 p-3 bg-card border border-primary/30 rounded-lg shadow-2 z-[10000] pointer-events-none animate-in fade-in-0 zoom-in-95 duration-150"
                  >
                    <p className="text-[10px] font-semibold text-primary mb-1">{item}</p>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">{descriptions[item]}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function EvaluacionPRICModal({
  open,
  onOpenChange,
  onSubmit,
  isLoading = false
}: EvaluacionPRICModalProps) {
  const { toast } = useToast();
  
  const [nombreProyecto, setNombreProyecto] = useState('');
  const [tipoProyecto, setTipoProyecto] = useState('');
  const [categoria, setCategoria] = useState('');
  const [destinoEspecifico, setDestinoEspecifico] = useState('');
  const [destinosDisponibles, setDestinosDisponibles] = useState<string[]>([]);
  const [isLoadingDestinos, setIsLoadingDestinos] = useState(false);
  const [latitud, setLatitud] = useState('');
  const [longitud, setLongitud] = useState('');
  const [superficiePredio, setSuperficiePredio] = useState('');
  const [superficieTotalConstruir, setSuperficieTotalConstruir] = useState('');
  const [superficieOcupacionSuelo, setSuperficieOcupacionSuelo] = useState('');
  const [alturaMaxima, setAlturaMaxima] = useState('');
  const [superficieUtilConstruida, setSuperficieUtilConstruida] = useState('');
  const [descripcion, setDescripcion] = useState('');

  const [tiposProyecto, setTiposProyecto] = useState<TipoProyectoPRIC[]>([]);
  const [isLoadingTipos, setIsLoadingTipos] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [isEvaluando, setIsEvaluando] = useState(false);
  const [resultado, setResultado] = useState<EvaluacionResultado | null>(null);
  const [resultadoError, setResultadoError] = useState<string | null>(null);
  const [pickMode, setPickMode] = useState(false);

  // Sync pick mode with the map and listen for picked points
  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(new CustomEvent('pric:pickMode', { detail: { enabled: pickMode } }));
    return () => {
      window.dispatchEvent(new CustomEvent('pric:pickMode', { detail: { enabled: false } }));
    };
  }, [pickMode, open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { lat: number; lng: number };
      if (!detail) return;
      setLatitud(detail.lat.toFixed(6));
      setLongitud(detail.lng.toFixed(6));
      setErrors(prev => ({ ...prev, latitud: '', longitud: '' }));
      setPickMode(false);
    };
    window.addEventListener('pric:pointPicked', handler);
    return () => window.removeEventListener('pric:pointPicked', handler);
  }, [open]);

  // Ensure pick mode disables when modal closes
  useEffect(() => {
    if (!open) setPickMode(false);
  }, [open]);


  useEffect(() => {
    const fetchTipos = async () => {
      if (!externalSupabase || !open) return;
      setIsLoadingTipos(true);
      try {
        const sb = externalSupabase as unknown as { from: (t: string) => { select: (c: string) => Promise<{ data: unknown; error: unknown }> } };
        const { data, error } = await sb.from('tipo_proyecto_pric').select('tipo, categoria, descripcion, requiere_superficie_util');
        if (error) {
          console.error('Error fetching tipos proyecto:', error);
          toast({ title: "Error", description: "No se pudieron cargar los tipos de proyecto", variant: "destructive" });
          return;
        }
        setTiposProyecto((data as TipoProyectoPRIC[]) || []);
      } catch (err) {
        console.error('Error:', err);
      } finally {
        setIsLoadingTipos(false);
      }
    };
    fetchTipos();
  }, [open, toast]);

  const tiposUnicos = useMemo(() => {
    const unique = [...new Set(tiposProyecto.map(t => t.tipo))];
    return unique.sort();
  }, [tiposProyecto]);

  const categoriasDisponibles = useMemo(() => {
    if (!tipoProyecto) return [];
    return tiposProyecto
      .filter(t => t.tipo === tipoProyecto)
      .map(t => t.categoria)
      .sort();
  }, [tipoProyecto, tiposProyecto]);

  const requiereSuperficieUtil = useMemo(() => {
    if (!tipoProyecto || !categoria) return false;
    const match = tiposProyecto.find(t => t.tipo === tipoProyecto && t.categoria === categoria);
    return Boolean(match?.requiere_superficie_util);
  }, [tipoProyecto, categoria, tiposProyecto]);

  useEffect(() => { setCategoria(''); setDestinoEspecifico(''); setDestinosDisponibles([]); }, [tipoProyecto]);

  // Load destinos específicos when categoria changes
  useEffect(() => {
    setDestinoEspecifico('');
    setDestinosDisponibles([]);
    if (!externalSupabase || !categoria) return;
    let cancelled = false;
    (async () => {
      setIsLoadingDestinos(true);
      try {
        const sb = externalSupabase as unknown as {
          from: (t: string) => {
            select: (c: string) => {
              eq: (col: string, val: string) => {
                not: (col: string, op: string, val: null) => Promise<{ data: unknown; error: unknown }>
              }
            }
          }
        };
        const { data, error } = await sb
          .from('estacionamientos_factor')
          .select('destino_especifico')
          .eq('categoria_proyecto', categoria)
          .not('destino_especifico', 'is', null);
        if (cancelled) return;
        if (error) {
          console.error('Error fetching destinos:', error);
          return;
        }
        const unique = Array.from(new Set(((data as Array<{ destino_especifico: string | null }>) || [])
          .map(r => r.destino_especifico)
          .filter((v): v is string => Boolean(v))));
        setDestinosDisponibles(unique.sort());
      } finally {
        if (!cancelled) setIsLoadingDestinos(false);
      }
    })();
    return () => { cancelled = true; };
  }, [categoria]);

  const validateLatitud = (value: string) => { const num = parseFloat(value); return !isNaN(num) && num >= -90 && num <= 90; };
  const validateLongitud = (value: string) => { const num = parseFloat(value); return !isNaN(num) && num >= -180 && num <= 180; };
  const validatePositiveNumber = (value: string) => { const num = parseFloat(value); return !isNaN(num) && num > 0; };

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};
    if (!nombreProyecto.trim()) newErrors.nombreProyecto = 'Requerido';
    else if (nombreProyecto.length > 50) newErrors.nombreProyecto = 'Máximo 50 caracteres';
    if (!tipoProyecto) newErrors.tipoProyecto = 'Requerido';
    if (!categoria) newErrors.categoria = 'Requerido';
    if (destinosDisponibles.length > 0 && !destinoEspecifico) newErrors.destinoEspecifico = 'Requerido';
    if (!latitud.trim()) newErrors.latitud = 'Requerido';
    else if (!validateLatitud(latitud)) newErrors.latitud = 'Latitud inválida (-90 a 90)';
    if (!longitud.trim()) newErrors.longitud = 'Requerido';
    else if (!validateLongitud(longitud)) newErrors.longitud = 'Longitud inválida (-180 a 180)';
    if (!superficiePredio.trim()) newErrors.superficiePredio = 'Requerido';
    else if (!validatePositiveNumber(superficiePredio)) newErrors.superficiePredio = 'Valor inválido';
    if (!superficieTotalConstruir.trim()) newErrors.superficieTotalConstruir = 'Requerido';
    else if (!validatePositiveNumber(superficieTotalConstruir)) newErrors.superficieTotalConstruir = 'Valor inválido';
    if (!superficieOcupacionSuelo.trim()) newErrors.superficieOcupacionSuelo = 'Requerido';
    else if (!validatePositiveNumber(superficieOcupacionSuelo)) newErrors.superficieOcupacionSuelo = 'Valor inválido';
    if (!alturaMaxima.trim()) newErrors.alturaMaxima = 'Requerido';
    else if (!validatePositiveNumber(alturaMaxima)) newErrors.alturaMaxima = 'Valor inválido';
    if (requiereSuperficieUtil) {
      if (!superficieUtilConstruida.trim()) newErrors.superficieUtilConstruida = 'Requerido';
      else if (!validatePositiveNumber(superficieUtilConstruida)) newErrors.superficieUtilConstruida = 'Valor inválido';
    } else if (superficieUtilConstruida.trim() && !validatePositiveNumber(superficieUtilConstruida)) {
      newErrors.superficieUtilConstruida = 'Valor inválido';
    }
    if (descripcion.length > 500) newErrors.descripcion = 'Máximo 500 caracteres';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validateForm()) return;
    setResultado(null);
    setResultadoError(null);

    if (!externalSupabase) {
      setResultadoError('Ocurrió un error al evaluar el proyecto, intenta nuevamente');
      return;
    }

    setIsEvaluando(true);
    try {
      const sb = externalSupabase as unknown as {
        rpc: (fn: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>
      };
      const { data, error } = await sb.rpc('evaluar_proyecto_pric', {
        p_lon: parseFloat(longitud),
        p_lat: parseFloat(latitud),
        p_categoria_proyecto: categoria,
        p_destino_especifico: destinoEspecifico || null,
        p_superficie_terreno: parseFloat(superficiePredio),
        p_superficie_edificada: parseFloat(superficieTotalConstruir),
        p_huella_basal: parseFloat(superficieOcupacionSuelo),
        p_altura_proyecto: parseFloat(alturaMaxima),
        p_superficie_util: superficieUtilConstruida ? parseFloat(superficieUtilConstruida) : null,
      });

      if (error) {
        console.error('RPC evaluar_proyecto_pric error:', error);
        setResultadoError('Ocurrió un error al evaluar el proyecto, intenta nuevamente');
        return;
      }
      setResultado((data as EvaluacionResultado) || {});

      // Notify parent (for tracking/telemetry) without blocking the UI.
      try {
        onSubmit({
          nombreProyecto: nombreProyecto.trim(), tipoProyecto, categoria,
          latitud: parseFloat(latitud), longitud: parseFloat(longitud),
          superficiePredio: parseFloat(superficiePredio),
          superficieTotalConstruir: parseFloat(superficieTotalConstruir),
          superficieOcupacionSuelo: parseFloat(superficieOcupacionSuelo),
          alturaMaxima: parseFloat(alturaMaxima),
          superficieUtilConstruida: superficieUtilConstruida ? parseFloat(superficieUtilConstruida) : 0,
          descripcion: descripcion.trim(),
        });
      } catch { /* ignore */ }
    } catch (err) {
      console.error('Error evaluando proyecto:', err);
      setResultadoError('Ocurrió un error al evaluar el proyecto, intenta nuevamente');
    } finally {
      setIsEvaluando(false);
    }
  };

  useEffect(() => {
    if (!open) {
      setNombreProyecto(''); setTipoProyecto(''); setCategoria('');
      setDestinoEspecifico(''); setDestinosDisponibles([]);
      setLatitud(''); setLongitud(''); setSuperficiePredio('');
      setSuperficieTotalConstruir(''); setSuperficieOcupacionSuelo('');
      setAlturaMaxima(''); setSuperficieUtilConstruida('');
      setDescripcion(''); setErrors({});
      setResultado(null); setResultadoError(null);
      // Clear the map's PRIC zone-focus when the modal closes.
      window.dispatchEvent(new CustomEvent('pric:evalResult', { detail: { zones: null } }));
    }
  }, [open]);

  // Broadcast evaluated zones so the map can focus on the involved polygons only.
  useEffect(() => {
    if (!resultado || resultado.dentro_limite_oficial_pric === false) {
      window.dispatchEvent(new CustomEvent('pric:evalResult', { detail: { zones: null } }));
      return;
    }
    const dictamenes = resultado.dictamenes_por_instrumento || [];
    const zones = Array.from(new Set(
      dictamenes
        .filter(d => d.dictamen !== 'fuera_del_ambito_de_aplicacion' && d.dictamen !== 'sin_zona_identificada_en_este_instrumento')
        .map(d => d.zona_uso_suelo)
        .filter((z): z is string => !!z && z.trim().length > 0)
    ));
    window.dispatchEvent(new CustomEvent('pric:evalResult', { detail: { zones: zones.length > 0 ? zones : null } }));
  }, [resultado]);

  const isFormComplete = Boolean(
    nombreProyecto.trim() && tipoProyecto && categoria && latitud.trim() && longitud.trim() &&
    superficiePredio.trim() && superficieTotalConstruir.trim() && superficieOcupacionSuelo.trim() &&
    alturaMaxima.trim() &&
    (!requiereSuperficieUtil || superficieUtilConstruida.trim()) &&
    (destinosDisponibles.length === 0 || destinoEspecifico)
  );

  const busy = isLoading || isEvaluando;

  if (!open) return null;

  const inputClass = "h-8 bg-card border-border text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-primary/20 text-xs font-medium transition-all duration-[140ms]";

  return (
    <div className={cn("fixed inset-y-0 right-0 z-[2000] flex", pickMode && "pointer-events-none")}>
      <div
        className={cn(
          "flex-1 transition-colors",
          pickMode ? "bg-transparent pointer-events-none" : "bg-foreground/30 pointer-events-auto"
        )}
        onClick={() => !pickMode && onOpenChange(false)}
      />

      {pickMode && (
        <div className="pointer-events-auto fixed top-4 left-1/2 -translate-x-1/2 z-[2100] flex items-center gap-2 rounded-full bg-primary text-white px-4 py-2 shadow-lg animate-in fade-in-0 slide-in-from-top-2 duration-200">
          <Crosshair className="h-4 w-4" />
          <span className="text-xs font-medium">Haz clic en el mapa para fijar el punto de evaluación</span>
          <button
            type="button"
            onClick={() => setPickMode(false)}
            className="ml-2 text-[10px] underline underline-offset-2 opacity-90 hover:opacity-100"
          >
            Cancelar
          </button>
        </div>
      )}

      
      <div 
        className={cn(
          "w-[520px] max-w-[90vw] flex flex-col font-graphik animate-in slide-in-from-right duration-300 pointer-events-auto transition-opacity",
          pickMode && "opacity-60 hover:opacity-100"
        )}
        style={{
          background: 'hsl(var(--background))',
          borderLeft: '1px solid hsl(var(--border))',
          boxShadow: '0 0 48px rgba(0,0,0,0.08), -4px 0 24px rgba(0,0,0,0.06)',
        }}
      >
        {/* Header */}
        <div className="px-5 py-3 flex items-center justify-between flex-shrink-0" style={{ borderBottom: '1px solid hsl(var(--border))' }}>
          <div className="flex items-center gap-2.5">
            <div 
              className="h-8 w-8 rounded-xl flex items-center justify-center"
              style={{ background: 'hsl(var(--primary))' }}
            >
              <FileSearch className="h-4 w-4 text-white" />
            </div>
            <div>
              <h2 className="text-sm font-display font-semibold text-foreground">Evaluación PRIC</h2>
              <p className="text-[10px] text-muted-foreground font-medium">Plan Regulador Intercomunal Costero</p>
            </div>
          </div>
          <Button 
            variant="ghost" size="icon" 
            className="h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-all duration-[140ms]" 
            onClick={() => onOpenChange(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Form */}
        <div className="flex-1 px-5 py-4 space-y-4 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
          {/* Nombre */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">
              Nombre del Proyecto <span className="text-destructive">*</span>
            </Label>
            <Input
              value={nombreProyecto}
              onChange={(e) => setNombreProyecto(e.target.value.slice(0, 50))}
              placeholder="Ingrese el nombre del proyecto"
              maxLength={50}
              className={cn(inputClass, errors.nombreProyecto && "border-destructive")}
            />
            {errors.nombreProyecto && <p className="text-[10px] text-destructive">{errors.nombreProyecto}</p>}
          </div>

          {/* Tipo + Categoría with tooltip dropdowns */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">
                Tipo de Proyecto <span className="text-destructive">*</span>
              </Label>
              <TooltipSelect
                value={tipoProyecto}
                onChange={setTipoProyecto}
                items={tiposUnicos}
                descriptions={tipoDescriptions}
                placeholder={isLoadingTipos ? "Cargando..." : "Seleccione tipo"}
                disabled={isLoadingTipos}
                hasError={!!errors.tipoProyecto}
              />
              {errors.tipoProyecto && <p className="text-[10px] text-destructive">{errors.tipoProyecto}</p>}
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">
                Categoría <span className="text-destructive">*</span>
              </Label>
              <TooltipSelect
                value={categoria}
                onChange={setCategoria}
                items={categoriasDisponibles}
                descriptions={categoriaDescriptions}
                placeholder={!tipoProyecto ? "Seleccione tipo primero" : "Seleccione categoría"}
                disabled={!tipoProyecto || categoriasDisponibles.length === 0}
                hasError={!!errors.categoria}
              />
              {errors.categoria && <p className="text-[10px] text-destructive">{errors.categoria}</p>}
            </div>
          </div>



          {/* Destino específico (condicional) */}
          {(isLoadingDestinos || destinosDisponibles.length > 0) && (
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">
                Destino específico <span className="text-destructive">*</span>
              </Label>
              <TooltipSelect
                value={destinoEspecifico}
                onChange={setDestinoEspecifico}
                items={destinosDisponibles}
                descriptions={{}}
                placeholder={isLoadingDestinos ? "Cargando..." : "Seleccione destino"}
                disabled={isLoadingDestinos || destinosDisponibles.length === 0}
                hasError={!!errors.destinoEspecifico}
              />
              {errors.destinoEspecifico && <p className="text-[10px] text-destructive">{errors.destinoEspecifico}</p>}
            </div>
          )}

          {/* Selector en mapa */}
          <div
            className={cn(
              "flex items-center justify-between gap-3 rounded-md border px-3 py-2 transition-colors",
              pickMode
                ? "border-primary/40 bg-primary/5"
                : "border-border bg-card/70"
            )}
          >
            <div className="flex items-start gap-2 min-w-0">
              <MapPin className={cn("h-4 w-4 mt-0.5 flex-shrink-0", pickMode ? "text-primary" : "text-muted-foreground")} />
              <div className="min-w-0">
                <p className="text-[11px] font-medium text-foreground leading-tight">
                  Seleccionar punto en el mapa
                </p>
                <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                  {pickMode
                    ? "Haz clic en el mapa para autocompletar latitud y longitud."
                    : "Actívalo para rellenar las coordenadas con un clic en el mapa."}
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant={pickMode ? "default" : "outline"}
              size="sm"
              onClick={() => setPickMode(v => !v)}
              className="h-7 px-2.5 text-[11px] gap-1 flex-shrink-0"
            >
              <Crosshair className="h-3.5 w-3.5" />
              {pickMode ? "Cancelar" : "Activar"}
            </Button>
          </div>

          {/* Lat + Lng + Sup */}
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Latitud <span className="text-destructive">*</span></Label>
              <Input value={latitud} onChange={(e) => setLatitud(e.target.value.slice(0, 50))} placeholder="-20.215678" maxLength={50} className={cn(inputClass, errors.latitud && "border-destructive")} />
              {errors.latitud && <p className="text-[10px] text-destructive">{errors.latitud}</p>}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Longitud <span className="text-destructive">*</span></Label>
              <Input value={longitud} onChange={(e) => setLongitud(e.target.value.slice(0, 50))} placeholder="-70.123456" maxLength={50} className={cn(inputClass, errors.longitud && "border-destructive")} />
              {errors.longitud && <p className="text-[10px] text-destructive">{errors.longitud}</p>}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Sup. Predio <span className="text-destructive">*</span></Label>
              <div className="relative">
                <Input type="number" value={superficiePredio} onChange={(e) => setSuperficiePredio(e.target.value)} placeholder="m²" min="0" step="0.01" className={cn(inputClass, "pr-8", errors.superficiePredio && "border-destructive")} />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">m²</span>
              </div>
              {errors.superficiePredio && <p className="text-[10px] text-destructive">{errors.superficiePredio}</p>}
            </div>
          </div>

          {/* Edificación */}
          <div className="space-y-2">
            <Label className="text-xs font-medium text-muted-foreground">Edificación Proyectada</Label>
            <div className="grid grid-cols-4 gap-2">
              <div className="space-y-1">
                <span className="text-[10px] text-muted-foreground">A. Sup. Total <span className="text-destructive">*</span></span>
                <div className="relative">
                  <Input type="number" value={superficieTotalConstruir} onChange={(e) => setSuperficieTotalConstruir(e.target.value)} placeholder="m²" min="0" step="0.01" className={cn(inputClass, "pr-8", errors.superficieTotalConstruir && "border-destructive")} />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">m²</span>
                </div>
                {errors.superficieTotalConstruir && <p className="text-[10px] text-destructive">{errors.superficieTotalConstruir}</p>}
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-muted-foreground">B. Ocup. Suelo <span className="text-destructive">*</span></span>
                <div className="relative">
                  <Input type="number" value={superficieOcupacionSuelo} onChange={(e) => setSuperficieOcupacionSuelo(e.target.value)} placeholder="m²" min="0" step="0.01" className={cn(inputClass, "pr-8", errors.superficieOcupacionSuelo && "border-destructive")} />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">m²</span>
                </div>
                {errors.superficieOcupacionSuelo && <p className="text-[10px] text-destructive">{errors.superficieOcupacionSuelo}</p>}
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-muted-foreground">C. Altura máx. <span className="text-destructive">*</span></span>
                <div className="relative">
                  <Input type="number" value={alturaMaxima} onChange={(e) => setAlturaMaxima(e.target.value)} placeholder="m" min="0" step="0.1" className={cn(inputClass, "pr-6", errors.alturaMaxima && "border-destructive")} />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">m</span>
                </div>
                {errors.alturaMaxima && <p className="text-[10px] text-destructive">{errors.alturaMaxima}</p>}
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-muted-foreground">
                  D. Sup. útil {requiereSuperficieUtil ? <span className="text-destructive">*</span> : <span className="text-muted-foreground/60">(opcional)</span>}
                </span>
                <div className="relative">
                  <Input type="number" value={superficieUtilConstruida} onChange={(e) => setSuperficieUtilConstruida(e.target.value)} placeholder="m²" min="0" step="0.01" className={cn(inputClass, "pr-8", errors.superficieUtilConstruida && "border-destructive")} />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">m²</span>
                </div>
                {errors.superficieUtilConstruida && <p className="text-[10px] text-destructive">{errors.superficieUtilConstruida}</p>}
              </div>
            </div>
          </div>

          {/* Descripción */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Descripción del Proyecto</Label>
            <Textarea
              value={descripcion}
              onChange={(e) => setDescripcion(e.target.value.slice(0, 500))}
              placeholder="Descripción general del proyecto (opcional)"
              maxLength={500}
              rows={2}
              className={cn(
                "bg-card border-border text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-primary/20 resize-none text-xs min-h-[50px] font-medium transition-all duration-[140ms]",
                errors.descripcion && "border-destructive"
              )}
            />
            <div className="flex justify-between">
              {errors.descripcion && <p className="text-[10px] text-destructive">{errors.descripcion}</p>}
              <span className="text-[10px] text-muted-foreground ml-auto">{descripcion.length}/500</span>
            </div>
          </div>

          {/* Resultado de la evaluación */}
          {(resultado || resultadoError) && (
            <ResultadoSection
              resultado={resultado}
              error={resultadoError}
              proyecto={{
                supPredio: parseFloat(superficiePredio) || 0,
                supTotal: parseFloat(superficieTotalConstruir) || 0,
                ocupSuelo: parseFloat(superficieOcupacionSuelo) || 0,
                alturaMax: parseFloat(alturaMaxima) || 0,
              }}
            />
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 flex justify-center flex-shrink-0" style={{ borderTop: '1px solid hsl(var(--border))' }}>
          <Button
            onClick={handleSubmit}
            disabled={!isFormComplete || busy}
            className="px-8 py-2 h-10 min-w-[140px] rounded-[14px] font-display font-semibold text-sm text-white transition-all duration-[140ms] hover:-translate-y-0.5 disabled:opacity-40"
            style={{
              background: 'hsl(var(--primary))',
            }}
          >
            {busy ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Evaluando...</>
            ) : (
              'Evaluar'
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

function dictamenStyle(d: DictamenTipo): { label: string; className: string; Icon: typeof CheckCircle2 } {
  switch (d) {
    case 'viable':
      return { label: '✅ Viable', className: 'bg-emerald-100 text-emerald-800 border-emerald-200', Icon: CheckCircle2 };
    case 'viable_condicionado':
      return { label: '⚠️ Viable con condiciones', className: 'bg-amber-100 text-amber-800 border-amber-200', Icon: Info };
    case 'no_viable':
      return { label: '❌ No viable', className: 'bg-red-100 text-red-800 border-red-200', Icon: XCircle };
    case 'requiere_revision_manual':
      return { label: '🔍 Requiere revisión de un especialista', className: 'bg-gray-100 text-gray-800 border-gray-200', Icon: AlertTriangle };
    case 'sin_zona_identificada_en_este_instrumento':
      return { label: '— Sin datos cargados para este instrumento todavía', className: 'bg-gray-100 text-gray-600 border-gray-200', Icon: HelpCircle };
    case 'fuera_del_ambito_de_aplicacion':
      return { label: 'ℹ️ Fuera del ámbito de este plan regulador', className: 'bg-sky-100 text-sky-800 border-sky-200', Icon: Info };
    default:
      return { label: String(d), className: 'bg-gray-100 text-gray-700 border-gray-200', Icon: Info };
  }
}

const MOTIVOS_DICT: Record<string, string> = {
  excede_normas_urbanisticas: 'El proyecto supera al menos uno de los índices urbanísticos máximos permitidos en esta zona (ver detalle arriba)',
  superficie_predial_bajo_el_minimo_exigido: 'El terreno no alcanza la superficie mínima de subdivisión exigida para esta zona',
  uso_prohibido_en_zona: 'Esta categoría de proyecto está expresamente prohibida en esta zona según la Ordenanza',
  sin_regla_definida_para_esta_combinacion_zona_categoria: 'Aún no existe una regla específica cargada para esta combinación de zona y categoría de proyecto — requiere revisión de un especialista',
  normas_urbanisticas_no_cargadas_para_esta_zona: 'Esta zona todavía no tiene índices urbanísticos cargados en el sistema',
  normas_de_edificacion_remitidas_al_plan_regulador_comunal_prc: 'Las normas de edificación de esta zona (Área Urbana) dependen del Plan Regulador Comunal, no del PRIC directamente',
  requiere_estudio_de_riesgo: 'Se requiere un estudio fundado de riesgo antes de aprobar el proyecto',
  requiere_estudio_por_superposicion_con_zona_de_riesgo: 'El terreno se superpone con una zona de riesgo — se requiere estudio de mitigación',
  zona_patrimonial_requiere_autorizacion: 'Se requiere autorización específica por protección patrimonial o natural',
  uso_condicionado_en_zona: 'El uso está permitido bajo condiciones específicas que deben verificarse',
  prohibido_por_superposicion_con_restriccion: 'El proyecto está prohibido por superponerse con un área de protección o riesgo severo',
};

interface ProyectoValores {
  supPredio: number;
  supTotal: number;
  ocupSuelo: number;
  alturaMax: number;
}

function NormaRow({ label, norma, proyecto, unidad = '', decimals = 2, higherIsWorse = true }: {
  label: string;
  norma: number | null | undefined;
  proyecto: number;
  unidad?: string;
  decimals?: number;
  higherIsWorse?: boolean;
}) {
  const hasNorma = norma !== null && norma !== undefined && !Number.isNaN(Number(norma));
  const cumple = hasNorma ? (higherIsWorse ? proyecto <= Number(norma) : proyecto >= Number(norma)) : null;
  const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(decimals) : '—');
  return (
    <tr className="border-b border-border last:border-0">
      <td className="py-1.5 pr-2 text-[11px] text-foreground">{label}</td>
      <td className="py-1.5 px-2 text-[11px] text-foreground text-right tabular-nums">{hasNorma ? `${fmt(Number(norma))}${unidad ? ' ' + unidad : ''}` : '—'}</td>
      <td className="py-1.5 px-2 text-[11px] text-foreground text-right tabular-nums">{fmt(proyecto)}{unidad ? ' ' + unidad : ''}</td>
      <td className="py-1.5 pl-2 text-[11px] text-right">
        {cumple === null ? <span className="text-muted-foreground">—</span> : cumple ? <span className="text-emerald-700">✅</span> : <span className="text-red-700">❌</span>}
      </td>
    </tr>
  );
}

function InstrumentoDetalle({ d, proyecto }: { d: DictamenInstrumento; proyecto: ProyectoValores }) {
  const [open, setOpen] = useState(false);
  const esFueraDelAmbito = d.dictamen === 'fuera_del_ambito_de_aplicacion';
  const esSinDatos = d.dictamen === 'sin_zona_identificada_en_este_instrumento';
  if (esFueraDelAmbito || esSinDatos) return null;

  const cc = proyecto.supPredio > 0 ? proyecto.supTotal / proyecto.supPredio : 0;
  const os = proyecto.supPredio > 0 ? proyecto.ocupSuelo / proyecto.supPredio : 0;
  const normas = d.normas_grupo_uso;
  const subMin = d.subdivision_minima_aplicada_m2;
  const restricciones = d.restricciones_aplicadas || [];
  const riesgos = d.riesgos_detectados || [];
  const patrimonio = d.patrimonio_detectado || [];
  const motivos = d.motivos || [];

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {open ? 'Ocultar detalle del cálculo' : 'Ver detalle del cálculo'}
      </button>

      {open && (
        <div className="mt-2 space-y-2.5 rounded-md border border-border bg-secondary/30 p-2.5">
          {d.zona_uso_suelo && (
            <p className="text-[11px] text-foreground">
              <span className="text-muted-foreground">Zona identificada:</span>{' '}
              <span className="font-semibold">{d.zona_uso_suelo}</span>
            </p>
          )}

          {normas ? (
            <div>
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="py-1 pr-2 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Índice</th>
                    <th className="py-1 px-2 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Norma máx.</th>
                    <th className="py-1 px-2 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Proyecto</th>
                    <th className="py-1 pl-2 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Result.</th>
                  </tr>
                </thead>
                <tbody>
                  <NormaRow label="Coef. Constructibilidad" norma={normas.cc} proyecto={Number(cc.toFixed(2))} />
                  <NormaRow label="Coef. Ocupación de Suelo" norma={normas.os} proyecto={Number(os.toFixed(2))} />
                  <NormaRow label="Altura Máxima" norma={normas.altura_max_m} proyecto={proyecto.alturaMax} unidad="m" decimals={1} />
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground italic">
              Esta zona no tiene normas urbanísticas cargadas en el sistema todavía.
            </p>
          )}

          {subMin !== null && subMin !== undefined && (
            <div className="text-[11px] text-foreground flex items-start gap-1.5">
              <span>{proyecto.supPredio >= Number(subMin) ? '✅' : '❌'}</span>
              <span>
                <span className="text-muted-foreground">Subdivisión predial mínima:</span>{' '}
                <span className="font-semibold">{Number(subMin).toLocaleString('es-CL')} m²</span> requeridos — tu predio tiene{' '}
                <span className="font-semibold">{proyecto.supPredio.toLocaleString('es-CL')} m²</span>
              </span>
            </div>
          )}

          {restricciones.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold text-amber-800 mb-1">⚠️ Restricciones que afectaron el cálculo</p>
              <ul className="text-[11px] text-foreground/85 list-disc pl-4 space-y-0.5">
                {restricciones.map((r, i) => (
                  <li key={i}>{[r.capa, r.nota].filter(Boolean).join(' — ') || r.codigo || 'Restricción'}</li>
                ))}
              </ul>
            </div>
          )}

          {riesgos.length > 0 && (
            <p className="text-[11px] text-foreground/85">
              🌊 Zona de riesgo detectada: <span className="font-semibold">{riesgos.map(r => r.codigo_zona || r.capa).filter(Boolean).join(', ')}</span> — requiere estudio fundado de un especialista antes de construir
            </p>
          )}

          {patrimonio.length > 0 && (
            <p className="text-[11px] text-foreground/85">
              🏛️ Zona de protección patrimonial/natural{patrimonio.some(p => p.codigo_zona || p.capa) ? `: ${patrimonio.map(p => p.codigo_zona || p.capa).filter(Boolean).join(', ')}` : ''} — requiere autorización específica
            </p>
          )}

          {motivos.length > 0 && (
            <ul className="text-[11px] text-foreground/85 list-disc pl-4 space-y-0.5">
              {motivos.map((m, i) => {
                const traducido = MOTIVOS_DICT[m];
                return traducido
                  ? <li key={i}>{traducido}</li>
                  : <li key={i} className="italic text-muted-foreground">{m}</li>;
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function ResultadoSection({ resultado, error, proyecto }: { resultado: EvaluacionResultado | null; error: string | null; proyecto: ProyectoValores }) {
  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
        <p className="text-xs font-semibold text-destructive flex items-center gap-2">
          <XCircle className="h-4 w-4" /> {error}
        </p>
      </div>
    );
  }
  if (!resultado) return null;

  // Criterio principal: si el punto está fuera del límite oficial del PRIC,
  // mostrar SOLO la aclaración de alcance (no es error, no es rechazo).
  if (resultado.dentro_limite_oficial_pric === false) {
    const mensaje = resultado.nota ||
      'La coordenada consultada está fuera del área que regula el Plan Regulador Intercomunal Costero de Tarapacá. Esta evaluación no aplica para esta ubicación.';
    const comunaLabel = resultado.comuna_aproximada
      ? `Comuna más cercana (aproximada): ${resultado.comuna}`
      : `Ubicación de referencia: comuna de ${resultado.comuna}`;
    return (
      <div className="space-y-3 pt-2 border-t border-border">
        <h3 className="text-sm font-display font-semibold text-foreground">Resultado de la evaluación</h3>
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
          <p className="text-xs font-semibold text-blue-900 flex items-center gap-2">
            <Info className="h-4 w-4" /> Fuera del Ámbito de Aplicación del PRIC
          </p>
          <p className="text-[11px] text-blue-800 mt-2 leading-relaxed">{mensaje}</p>
          {resultado.comuna && (
            <p className="text-[10px] text-muted-foreground mt-2">{comunaLabel}</p>
          )}
        </div>
      </div>
    );
  }

  if (resultado.resuelto === false) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
        <p className="text-xs font-semibold text-amber-800 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" /> No se pudo ubicar el punto ingresado
        </p>
        {resultado.motivo && <p className="text-[11px] text-amber-700 mt-1">{resultado.motivo}</p>}
      </div>
    );
  }

  if (resultado.cobertura === 'sin_alcance') {
    return (
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
        <p className="text-xs font-semibold text-blue-800 flex items-center gap-2">
          <Info className="h-4 w-4" /> Esta zona todavía no está cubierta por el piloto de Gdudex
        </p>
      </div>
    );
  }

  const dictamenes = resultado.dictamenes_por_instrumento || [];
  const cupos = resultado.estacionamientos?.cupos_requeridos;
  const restriccionesAmb = resultado.restricciones_ambientales_universales || [];

  return (
    <div className="space-y-3 pt-2 border-t border-border">
      <div>
        <h3 className="text-sm font-display font-semibold text-foreground">Resultado de la evaluación</h3>
        {(resultado.comuna || resultado.region) && (
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Comuna: {resultado.comuna || '—'} — Región: {resultado.region || '—'}
          </p>
        )}
      </div>

      <div className="space-y-2">
        {dictamenes.map((d, idx) => {
          const style = dictamenStyle(d.dictamen);
          const Icon = style.Icon;
          const esFueraDelAmbito = d.dictamen === 'fuera_del_ambito_de_aplicacion';
          return (
            <div key={idx} className="rounded-lg border border-border bg-card p-3 space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs font-semibold text-foreground">{d.instrumento}</p>
                <span className={cn("inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border", style.className)}>
                  <Icon className="h-3 w-3" /> {style.label}
                </span>
              </div>
              {esFueraDelAmbito && (
                <p className="text-[11px] text-sky-700 font-medium">
                  Este punto está fuera del área normada por el PRIC
                </p>
              )}
              {!esFueraDelAmbito && d.zona_uso_suelo && (
                <p className="text-[11px] text-muted-foreground">Zona: {d.zona_uso_suelo}</p>
              )}
              <InstrumentoDetalle d={d} proyecto={proyecto} />
              {!esFueraDelAmbito && d.dictamen !== 'sin_zona_identificada_en_este_instrumento' && (
                <ExplicarConIA dictamen={d} />
              )}
            </div>
          );
        })}
      </div>

      {typeof cupos === 'number' && (
        <div className="text-xs text-foreground bg-secondary/60 rounded-lg px-3 py-2">
          Estacionamientos requeridos: <span className="font-semibold">{cupos} cupos</span> (según Cuadro 9)
        </div>
      )}

      {restriccionesAmb.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-3">
          <p className="text-xs font-semibold text-foreground mb-1">Restricciones ambientales del territorio</p>
          <ul className="text-[11px] text-foreground/80 list-disc pl-4">
            {restriccionesAmb.map((r, i) => <li key={i}>{r.capa}</li>)}
          </ul>
        </div>
      )}

      <p className="text-[10px] text-muted-foreground/80 leading-relaxed pt-1 border-t border-border">
        Esta evaluación es preliminar y automatizada. No reemplaza el pronunciamiento oficial de la Dirección de Obras Municipales ni de la Secretaría Regional Ministerial de Vivienda y Urbanismo.
      </p>
    </div>
  );
}

interface ExplicacionIA {
  narrativa?: string;
  respuesta?: string;
  explicacion?: string;
  fuentes?: Array<{ titulo?: string; articulo?: string; texto?: string; url?: string } | string>;
  [k: string]: any;
}

function ExplicarConIA({ dictamen }: { dictamen: DictamenInstrumento }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ExplicacionIA | null>(null);
  const [showFuentes, setShowFuentes] = useState(false);

  const solicitar = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      if (!externalSupabase) throw new Error('Servicio de IA no disponible');
      const { data: resp, error: fnErr } = await externalSupabase.functions.invoke('explicar-dictamen', {
        body: {
          seccion: 'pric',
          contexto: dictamen,
          pregunta_usuario: null,
        },
      });
      if (fnErr) throw fnErr;
      setData((resp as ExplicacionIA) || {});
    } catch (e: any) {
      console.error('explicar-dictamen error:', e);
      setError('No se pudo obtener la explicación. Intenta nuevamente.');
    } finally {
      setLoading(false);
    }
  };

  const narrativa = data?.narrativa || data?.respuesta || data?.explicacion || '';
  const fuentes = Array.isArray(data?.fuentes) ? data!.fuentes! : [];

  return (
    <div className="mt-2">
      {!data && !loading && (
        <button
          type="button"
          onClick={solicitar}
          className="inline-flex items-center gap-1.5 text-[11px] font-medium text-primary hover:underline"
        >
          <Sparkles className="h-3 w-3" />
          Explicar con IA
        </button>
      )}

      {loading && (
        <div className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Generando explicación...
        </div>
      )}

      {error && (
        <div className="text-[11px] text-destructive flex items-center gap-1.5">
          <AlertTriangle className="h-3 w-3" /> {error}
          <button
            type="button"
            onClick={solicitar}
            className="underline underline-offset-2 text-primary ml-1"
          >
            Reintentar
          </button>
        </div>
      )}

      {data && !loading && (
        <div className="rounded-md border border-primary/20 bg-primary/5 p-2.5 space-y-2">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
            <Sparkles className="h-3 w-3" /> Explicación IA
          </div>
          {narrativa ? (
            <p className="text-[11px] leading-relaxed text-foreground/90 whitespace-pre-wrap">{narrativa}</p>
          ) : (
            <p className="text-[11px] italic text-muted-foreground">Sin narrativa disponible.</p>
          )}
          {fuentes.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setShowFuentes(s => !s)}
                className="flex items-center gap-1 text-[10px] font-medium text-primary hover:underline"
              >
                {showFuentes ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                {showFuentes ? 'Ocultar fuentes' : `Ver fuentes (${fuentes.length})`}
              </button>
              {showFuentes && (
                <ul className="mt-1.5 space-y-1 text-[10.5px] text-foreground/80 list-disc pl-4">
                  {fuentes.map((f, i) => {
                    if (typeof f === 'string') return <li key={i}>{f}</li>;
                    const titulo = f.titulo || f.articulo || 'Fuente';
                    return (
                      <li key={i}>
                        <span className="font-semibold">{titulo}</span>
                        {f.texto ? <span className="text-muted-foreground"> — {f.texto}</span> : null}
                        {f.url ? (
                          <a href={f.url} target="_blank" rel="noreferrer" className="ml-1 text-primary underline">
                            enlace
                          </a>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
