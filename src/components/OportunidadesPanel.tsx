import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { externalSupabase } from '@/integrations/supabase/externalClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Slider } from '@/components/ui/slider';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import {
  Compass,
  FileCheck2,
  Route as RouteIcon,
  Info,
  Loader2,
  Crosshair,
  MapPin,
  ArrowRight,
  X,
  Lightbulb,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';


// N8N webhook antiguo, dejado a propósito como referencia para poder comparar
// respuestas en paralelo si es necesario. NO se llama desde aquí.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const LEGACY_N8N_WEBHOOK =
  'https://gdudex2026.app.n8n.cloud/webhook/df1d3d2e-e2dd-4221-b3d8-1d50bf4fad70';

export type OportunidadModo = 'exploracion' | 'punto_fijo' | 'camino_minimo';

interface TipoProyectoRow {
  tipo: string;
  categoria: string;
  requiere_superficie_util?: boolean | null;
}

interface Candidato {
  id?: string;
  nombre?: string;
  etiqueta?: string;
  tipo_nodo?: string;
  comuna?: string;
  lat?: number;
  lon?: number;
  distancia_m?: number;
  costo_contexto?: number;
  // Contexto enriquecido (modos A y C)
  nivel?: 'bajo' | 'medio' | 'alto';
  motivo_principal?: string;
  proyectos_cercanos_count?: number;
  humedales_cercanos_count?: number;
  activos_cercanos_count?: number;
  tiene_restriccion_cercana?: boolean;
}

interface DictamenResp {
  dictamen?: string;
  motivos?: string[];
}

interface Precedente {
  proyecto?: string;
  estado?: string;
  sector?: string;
  senal?: 'positiva' | 'negativa' | 'pendiente' | 'neutra_debil' | 'sin_clasificar';
  distancia_m?: number;
}

interface ProyectoCercano {
  nombre?: string;
  estado?: string;
  sector?: string;
  distancia_m?: number;
}
interface AmbientalCercano {
  nombre?: string;
  capa?: string;
  distancia_m?: number;
}
interface ActivoCercano {
  nombre?: string;
  categoria?: string;
  distancia_m?: number;
}
interface RestriccionEncima {
  nombre?: string;
  categoria?: string;
}
interface ContextoEnriquecido {
  proyectos_cercanos?: ProyectoCercano[];
  ambiental_cercano?: AmbientalCercano[];
  activos_cercanos?: ActivoCercano[];
  restriccion_pric_encima?: RestriccionEncima[];
  tiene_restriccion_directa?: boolean;
}
interface CitaNormativa {
  categoria?: string;
  fragmento?: string;
}

interface ConsultarViabilidadResponse {
  modo?: OportunidadModo;
  candidatos?: Candidato[];
  ruta?: Candidato[];
  respuesta_narrativa?: string;
  dictamen?: DictamenResp;
  costo_contexto_detalle?: Array<{ etiqueta: string; valor: number }>;
  precedentes?: Precedente[];
  contexto_enriquecido?: ContextoEnriquecido;
  citas_normativa?: CitaNormativa[];
  error?: string;
}


const modoInfo: Record<
  OportunidadModo,
  { label: string; icon: React.ComponentType<{ className?: string }>; tooltip: string; color: string }
> = {
  exploracion: {
    label: 'Explorar zona',
    icon: Compass,
    tooltip:
      'Busca oportunidades cerca de un punto sin necesidad de definir un proyecto todavía. Ideal para tener una primera mirada rápida de qué zonas cercanas tienen menor costo regulatorio.',
    color: '#00BFA5',
  },
  punto_fijo: {
    label: 'Evaluar mi proyecto',
    icon: FileCheck2,
    tooltip:
      'Evalúa la viabilidad real de un proyecto específico (tipo, tamaño, ubicación exacta) contra la normativa vigente. Es el análisis más preciso — usa la misma lógica que la Evaluación PRIC.',
    color: '#FFB300',
  },
  camino_minimo: {
    label: 'Mejor ubicación cercana',
    icon: RouteIcon,
    tooltip:
      'Encuentra, a partir de un punto de referencia, las zonas vecinas con menor costo regulatorio para tu tipo de inversión — como una ruta hacia la opción más conveniente cerca de ti.',
    color: '#2979FF',
  },
};

function colorByCosto(c: number, min: number, max: number): string {
  if (max === min) return 'bg-emerald-500';
  const t = (c - min) / (max - min);
  if (t < 0.34) return 'bg-emerald-500';
  if (t < 0.67) return 'bg-amber-500';
  return 'bg-red-500';
}

function dictamenBadge(d?: string) {
  if (!d) return { label: 'sin dictamen', cls: 'bg-muted text-muted-foreground' };
  if (d === 'viable') return { label: 'Viable', cls: 'bg-emerald-500/15 text-emerald-700 border border-emerald-500/30' };
  if (d === 'requiere_revision_manual')
    return { label: 'Requiere revisión manual', cls: 'bg-amber-500/15 text-amber-700 border border-amber-500/30' };
  return { label: d.replace(/_/g, ' '), cls: 'bg-red-500/15 text-red-700 border border-red-500/30' };
}

function senalIcon(s?: Precedente['senal']) {
  switch (s) {
    case 'positiva':
      return '✅';
    case 'negativa':
      return '❌';
    case 'pendiente':
      return '⏳';
    default:
      return '—';
  }
}

function colorDotByNivel(n?: 'bajo' | 'medio' | 'alto'): string {
  if (n === 'alto') return 'bg-red-500';
  if (n === 'medio') return 'bg-amber-500';
  return 'bg-emerald-500';
}

function formatDistancia(m?: number): string {
  if (m == null) return '';
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m)} m`;
}

function estadoBadgeCls(estado?: string): { cls: string; icon: string } {
  const e = (estado || '').toLowerCase();
  if (e.includes('aprob')) return { cls: 'bg-emerald-500/15 text-emerald-700 border border-emerald-500/30', icon: '✅' };
  if (e.includes('rechaz')) return { cls: 'bg-red-500/15 text-red-700 border border-red-500/30', icon: '❌' };
  if (e.includes('calific') || e.includes('trámite') || e.includes('tramite') || e.includes('evaluacion') || e.includes('evaluación'))
    return { cls: 'bg-amber-500/15 text-amber-700 border border-amber-500/30', icon: '⏳' };
  return { cls: 'bg-muted text-muted-foreground border border-border', icon: '•' };
}


interface OportunidadesPanelProps {
  /** Controls visibility of the side drawer */
  open: boolean;
  onClose: () => void;
  /** Ubicación viene del picker del mapa o del selector de región */
  currentPoint?: { lat: number; lng: number } | null;
  onRequestPickPoint?: () => void;
  isPickingPoint?: boolean;
  pickMode?: boolean;
}

export default function OportunidadesPanel({
  open,
  onClose,
  currentPoint,
  onRequestPickPoint,
  isPickingPoint,
  pickMode,
}: OportunidadesPanelProps) {

  const { toast } = useToast();
  const [modo, setModo] = useState<OportunidadModo | null>(null);

  // Modo A
  const [radioKm, setRadioKm] = useState<number>(5);

  // Modo B — mismos campos que Evaluación PRIC (misma fuente de datos)
  const [tiposProyecto, setTiposProyecto] = useState<TipoProyectoRow[]>([]);
  const [tipoProyecto, setTipoProyecto] = useState('');
  const [categoria, setCategoria] = useState('');
  const [destinoEspecifico, setDestinoEspecifico] = useState('');
  const [destinosDisponibles, setDestinosDisponibles] = useState<string[]>([]);
  const [superficieTerreno, setSuperficieTerreno] = useState('');
  const [superficieEdificada, setSuperficieEdificada] = useState('');
  const [huellaBasal, setHuellaBasal] = useState('');
  const [alturaProyecto, setAlturaProyecto] = useState('');
  const [preguntaTexto, setPreguntaTexto] = useState('');

  // Modo C
  const [factorCosto, setFactorCosto] = useState<number>(50);

  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<ConsultarViabilidadResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Modo A "Explorar zona": pinta un círculo con el radio (reutiliza la capa
  // de Análisis Radial en el mapa) y zoom al punto. Se limpia cuando el modo
  // cambia, el panel se cierra o se pierde el punto.
  useEffect(() => {
    if (!open) return;
    if (modo === 'exploracion' && currentPoint) {
      window.dispatchEvent(
        new CustomEvent('radial:set', {
          detail: { active: true, center: { lat: currentPoint.lat, lng: currentPoint.lng }, radiusKm: radioKm },
        }),
      );
    } else {
      window.dispatchEvent(new CustomEvent('radial:set', { detail: { active: false } }));
    }
  }, [open, modo, currentPoint?.lat, currentPoint?.lng, radioKm]);

  useEffect(() => {
    // Limpia el círculo al cerrar el drawer.
    if (!open) {
      window.dispatchEvent(new CustomEvent('radial:set', { detail: { active: false } }));
    }
  }, [open]);

  // Guardar cámara al abrir el panel y restaurarla al cerrarlo, para que el
  // mapa siempre vuelva a la posición inicial cuando el usuario sale de una
  // consulta de Oportunidades.
  useEffect(() => {
    if (open) {
      window.dispatchEvent(new CustomEvent('oportunidades:panelOpen'));
      return () => {
        window.dispatchEvent(new CustomEvent('oportunidades:panelClose'));
      };
    }
  }, [open]);

  // Al cambiar de modo o limpiar la respuesta, volver a la posición inicial
  // del mapa (excepto en "exploración", que ya centra el mapa vía radial:set).
  useEffect(() => {
    if (!open) return;
    if (modo !== 'exploracion') {
      window.dispatchEvent(new CustomEvent('oportunidades:panelClose'));
      // Re-armar el save de cámara para la próxima consulta de este modo.
      window.dispatchEvent(new CustomEvent('oportunidades:panelOpen'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modo]);



  // Cargar tipos de proyecto (misma tabla que usa Evaluación PRIC — SSOT)
  useEffect(() => {
    if (modo !== 'punto_fijo' || !externalSupabase || tiposProyecto.length > 0) return;
    (async () => {
      try {
        const sb = externalSupabase as unknown as {
          from: (t: string) => { select: (c: string) => Promise<{ data: unknown; error: unknown }> };
        };
        const { data } = await sb
          .from('tipo_proyecto_pric')
          .select('tipo, categoria, requiere_superficie_util');
        setTiposProyecto((data as TipoProyectoRow[]) || []);
      } catch (e) {
        console.error('Error tipos:', e);
      }
    })();
  }, [modo, tiposProyecto.length]);

  const tiposUnicos = useMemo(() => [...new Set(tiposProyecto.map((t) => t.tipo))].sort(), [tiposProyecto]);
  const categoriasDisponibles = useMemo(
    () => (!tipoProyecto ? [] : tiposProyecto.filter((t) => t.tipo === tipoProyecto).map((t) => t.categoria).sort()),
    [tipoProyecto, tiposProyecto],
  );

  useEffect(() => {
    setCategoria('');
    setDestinoEspecifico('');
    setDestinosDisponibles([]);
  }, [tipoProyecto]);

  useEffect(() => {
    setDestinoEspecifico('');
    setDestinosDisponibles([]);
    if (!externalSupabase || !categoria) return;
    let cancelled = false;
    (async () => {
      try {
        const sb = externalSupabase as unknown as {
          from: (t: string) => {
            select: (c: string) => {
              eq: (col: string, val: string) => {
                not: (col: string, op: string, val: null) => Promise<{ data: unknown; error: unknown }>;
              };
            };
          };
        };
        const { data } = await sb
          .from('estacionamientos_factor')
          .select('destino_especifico')
          .eq('categoria_proyecto', categoria)
          .not('destino_especifico', 'is', null);
        if (cancelled) return;
        const uniq = Array.from(
          new Set(
            ((data as Array<{ destino_especifico: string | null }>) || [])
              .map((r) => r.destino_especifico)
              .filter((v): v is string => Boolean(v)),
          ),
        ).sort();
        setDestinosDisponibles(uniq);
      } catch (e) {
        console.error('Error destinos:', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [categoria]);

  const puntoValido = !!currentPoint;

  const validateModoB = (): string | null => {
    if (!categoria) return 'Selecciona una categoría de proyecto.';
    if (!puntoValido) return 'Selecciona una ubicación en el mapa.';
    return null;
  };

  const runConsulta = async () => {
    if (!modo) return;
    setErrorMsg(null);
    setResponse(null);

    if (modo !== 'exploracion' && modo !== 'camino_minimo' && !puntoValido) {
      setErrorMsg('Selecciona una ubicación en el mapa.');
      return;
    }
    if (modo === 'exploracion' && !puntoValido) {
      setErrorMsg('Selecciona un punto en el mapa para explorar la zona.');
      return;
    }
    if (modo === 'camino_minimo' && !puntoValido) {
      setErrorMsg('Selecciona un punto de referencia en el mapa.');
      return;
    }

    let dictamenInput: unknown = null;
    if (modo === 'punto_fijo') {
      const err = validateModoB();
      if (err) {
        setErrorMsg(err);
        return;
      }
      // Reutiliza el mismo RPC que "Evaluación PRIC" para obtener el dictamen
      // real. Luego se lo pasamos al edge function para que genere la narrativa.
      if (externalSupabase) {
        try {
          const sb = externalSupabase as unknown as {
            rpc: (fn: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
          };
          const { data, error } = await sb.rpc('evaluar_proyecto_pric', {
            p_lon: currentPoint!.lng,
            p_lat: currentPoint!.lat,
            p_categoria_proyecto: categoria,
            p_destino_especifico: destinoEspecifico || null,
            p_superficie_terreno: superficieTerreno ? parseFloat(superficieTerreno) : null,
            p_superficie_edificada: superficieEdificada ? parseFloat(superficieEdificada) : null,
            p_huella_basal: huellaBasal ? parseFloat(huellaBasal) : null,
            p_altura_proyecto: alturaProyecto ? parseFloat(alturaProyecto) : null,
            p_superficie_util: null,
          });
          if (!error) dictamenInput = data;
        } catch (e) {
          console.error('RPC dictamen error:', e);
        }
      }
    }

    setLoading(true);
    try {
      const payload =
        modo === 'exploracion'
          ? { modo, lat: currentPoint!.lat, lon: currentPoint!.lng, radio_m: radioKm * 1000 }
          : modo === 'camino_minimo'
          ? { modo, lat: currentPoint!.lat, lon: currentPoint!.lng, max_saltos: 8, factor_costo: factorCosto }
          : {
              modo,
              lat: currentPoint!.lat,
              lon: currentPoint!.lng,
              categoria_proyecto: categoria,
              destino_especifico: destinoEspecifico || null,
              superficie_terreno: superficieTerreno ? parseFloat(superficieTerreno) : null,
              superficie_edificada: superficieEdificada ? parseFloat(superficieEdificada) : null,
              huella_basal: huellaBasal ? parseFloat(huellaBasal) : null,
              altura_proyecto: alturaProyecto ? parseFloat(alturaProyecto) : null,
              pregunta_texto: preguntaTexto || undefined,
              dictamen_input: dictamenInput,
            };

      const { data, error } = await supabase.functions.invoke('consultar-viabilidad', { body: payload });
      if (error) throw error;
      const resp = data as ConsultarViabilidadResponse;
      if (resp?.error) {
        setErrorMsg(resp.error);
      } else {
        setResponse(resp);
        // Notificar al mapa para pintar pines/ruta si aplica
        if (modo === 'exploracion' && resp?.candidatos) {
          window.dispatchEvent(new CustomEvent('oportunidades:candidatos', { detail: resp.candidatos }));
          // El círculo (radial:set) ya centra el mapa en exploración.
        }
        if (modo === 'punto_fijo' && currentPoint) {
          // Zoom al punto evaluado para contextualizarlo con las capas cercanas.
          window.dispatchEvent(
            new CustomEvent('oportunidades:fit', {
              detail: { center: currentPoint, zoom: 15, padding: 120 },
            }),
          );
        }
        if (modo === 'camino_minimo' && resp?.ruta) {
          window.dispatchEvent(
            new CustomEvent('oportunidades:ruta', {
              detail: { origen: currentPoint, puntos: resp.ruta },
            }),
          );
          // Zoom que cubra el origen + los candidatos con coordenadas.
          const pts: [number, number][] = [];
          if (currentPoint) pts.push([currentPoint.lng, currentPoint.lat]);
          resp.ruta.forEach((c) => {
            if (typeof c.lat === 'number' && typeof c.lon === 'number') {
              pts.push([c.lon, c.lat]);
            }
          });
          if (pts.length > 0) {
            window.dispatchEvent(
              new CustomEvent('oportunidades:fit', {
                detail: pts.length === 1 ? { center: currentPoint, zoom: 13 } : { points: pts, zoom: 13, padding: 140 },
              }),
            );
          }
        }

    } catch (e) {
      console.error(e);
      setErrorMsg('No fue posible completar la consulta. Intenta nuevamente.');
      toast({ title: 'Error', description: 'Fallo la consulta de oportunidades.', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const precargarModoB = (c: Candidato) => {
    setModo('punto_fijo');
    if (c.lat && c.lon) {
      window.dispatchEvent(new CustomEvent('pric:pointPicked', { detail: { lat: c.lat, lng: c.lon } }));
    }
  };

  if (!open) return null;

  return (
    <TooltipProvider delayDuration={150}>
      <div className={cn('fixed inset-y-0 right-0 z-[2000] flex', pickMode && 'pointer-events-none')}>
        <div
          className={cn(
            'flex-1 transition-colors',
            pickMode ? 'bg-transparent pointer-events-none' : 'bg-foreground/30 pointer-events-auto',
          )}
          onClick={() => !pickMode && onClose()}
        />

        {pickMode && (
          <div className="pointer-events-auto fixed top-4 left-1/2 -translate-x-1/2 z-[2100] flex items-center gap-2 rounded-full bg-primary text-white px-4 py-2 shadow-lg animate-in fade-in-0 slide-in-from-top-2 duration-200">
            <Crosshair className="h-4 w-4" />
            <span className="text-xs font-medium">Haz clic en el mapa para fijar el punto</span>
            <button
              type="button"
              onClick={() => onRequestPickPoint?.()}
              className="ml-2 text-[10px] underline underline-offset-2 opacity-90 hover:opacity-100"
            >
              Cancelar
            </button>
          </div>
        )}

        <div
          className={cn(
            'w-[520px] max-w-[90vw] flex flex-col font-graphik animate-in slide-in-from-right duration-300 pointer-events-auto transition-opacity overflow-y-auto',
            pickMode && 'opacity-60 hover:opacity-100',
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
              <div className="h-8 w-8 rounded-xl flex items-center justify-center" style={{ background: 'hsl(var(--primary))' }}>
                <Lightbulb className="h-4 w-4 text-white" />
              </div>
              <div>
                <h2 className="text-sm font-display font-semibold text-foreground">Oportunidades</h2>
                <p className="text-[10px] text-muted-foreground font-medium">Consulta de viabilidad e inversión</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-all"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 px-5 py-4 space-y-3">

        {/* Selector de modo */}
        <div className="grid grid-cols-3 gap-2">
          {(Object.keys(modoInfo) as OportunidadModo[]).map((k) => {
            const info = modoInfo[k];
            const Icon = info.icon;
            const selected = modo === k;
            return (
              <div key={k} className="relative">
                <button
                  onClick={() => {
                    setModo(k);
                    setResponse(null);
                    setErrorMsg(null);
                  }}
                  className={cn(
                    'w-full flex items-center justify-center gap-1.5 px-2 py-2.5 rounded-[14px] text-[11px] font-semibold transition-all duration-[140ms] ease-out border text-center',
                    selected ? 'text-white border-transparent' : 'text-foreground hover:-translate-y-0.5 hover:scale-[1.02]',
                  )}
                  style={
                    selected
                      ? { background: info.color }
                      : { background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }
                  }
                >
                  <Icon className="h-3.5 w-3.5 flex-shrink-0" />
                  <span className="truncate">{info.label}</span>
                </button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-background border border-border flex items-center justify-center hover:bg-secondary"
                      aria-label={`Información sobre ${info.label}`}
                    >
                      <Info className="h-2.5 w-2.5 text-muted-foreground" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs text-xs leading-relaxed">
                    {info.tooltip}
                  </TooltipContent>
                </Tooltip>
              </div>
            );
          })}
        </div>

        {modo && (
          <>
            {/* Selector de punto en mapa */}
            <div
              className={cn(
                'flex items-center justify-between gap-3 rounded-md border px-3 py-2 transition-colors',
                isPickingPoint ? 'border-primary/40 bg-primary/5' : 'border-border bg-card/70',
              )}
            >
              <div className="flex items-start gap-2 min-w-0">
                <MapPin
                  className={cn('h-4 w-4 mt-0.5 flex-shrink-0', isPickingPoint ? 'text-primary' : 'text-muted-foreground')}
                />
                <div className="min-w-0">
                  <p className="text-[11px] font-medium text-foreground leading-tight">Ubicación en el mapa</p>
                  <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                    {currentPoint
                      ? `lat ${currentPoint.lat.toFixed(5)}, lng ${currentPoint.lng.toFixed(5)}`
                      : isPickingPoint
                      ? 'Haz clic en el mapa para fijar el punto.'
                      : 'Actívalo y haz clic en el mapa.'}
                  </p>
                </div>
              </div>
              <Button
                type="button"
                variant={isPickingPoint ? 'default' : 'outline'}
                size="sm"
                onClick={onRequestPickPoint}
                className="h-7 px-2.5 text-[11px] gap-1 flex-shrink-0"
              >
                <Crosshair className="h-3.5 w-3.5" />
                {isPickingPoint ? 'Cancelar' : currentPoint ? 'Cambiar' : 'Activar'}
              </Button>
            </div>

            {/* Formulario por modo */}
            {modo === 'exploracion' && (
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground flex items-center justify-between">
                  <span>Radio de búsqueda</span>
                  <span className="text-primary font-semibold">{radioKm} km</span>
                </Label>
                <Slider min={1} max={10} step={1} value={[radioKm]} onValueChange={(v) => setRadioKm(v[0])} />
              </div>
            )}

            {modo === 'camino_minimo' && (
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground flex items-center justify-between">
                  <span>Priorizar menor costo sobre cercanía</span>
                  <span className="text-primary font-semibold">{factorCosto}</span>
                </Label>
                <Slider min={0} max={100} step={5} value={[factorCosto]} onValueChange={(v) => setFactorCosto(v[0])} />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>Más cercano</span>
                  <span>Menor costo</span>
                </div>
              </div>
            )}

            {modo === 'punto_fijo' && (
              <div className="space-y-2.5">
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">Tipo de proyecto</Label>
                    <select
                      className="w-full h-8 rounded-md border border-border bg-card px-2 text-xs"
                      value={tipoProyecto}
                      onChange={(e) => setTipoProyecto(e.target.value)}
                    >
                      <option value="">Seleccione…</option>
                      {tiposUnicos.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">
                      Categoría <span className="text-destructive">*</span>
                    </Label>
                    <select
                      className="w-full h-8 rounded-md border border-border bg-card px-2 text-xs"
                      value={categoria}
                      onChange={(e) => setCategoria(e.target.value)}
                      disabled={!tipoProyecto}
                    >
                      <option value="">Seleccione…</option>
                      {categoriasDisponibles.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {destinosDisponibles.length > 0 && (
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">Destino específico</Label>
                    <select
                      className="w-full h-8 rounded-md border border-border bg-card px-2 text-xs"
                      value={destinoEspecifico}
                      onChange={(e) => setDestinoEspecifico(e.target.value)}
                    >
                      <option value="">(opcional)</option>
                      {destinosDisponibles.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">Sup. terreno (m²)</Label>
                    <Input
                      type="number"
                      value={superficieTerreno}
                      onChange={(e) => setSuperficieTerreno(e.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">Sup. edificada (m²)</Label>
                    <Input
                      type="number"
                      value={superficieEdificada}
                      onChange={(e) => setSuperficieEdificada(e.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">Huella basal (m²)</Label>
                    <Input
                      type="number"
                      value={huellaBasal}
                      onChange={(e) => setHuellaBasal(e.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">Altura (m)</Label>
                    <Input
                      type="number"
                      value={alturaProyecto}
                      onChange={(e) => setAlturaProyecto(e.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <Label className="text-[11px] text-muted-foreground">¿Alguna pregunta adicional?</Label>
                  <Textarea
                    value={preguntaTexto}
                    onChange={(e) => setPreguntaTexto(e.target.value)}
                    rows={2}
                    className="text-xs"
                    placeholder="Ej: ¿Qué instrumentos aplican en este predio?"
                  />
                </div>
              </div>
            )}

            <Button onClick={runConsulta} disabled={loading} className="w-full h-9 text-xs font-semibold">
              {loading ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                  {modo === 'punto_fijo' ? 'Analizando normativa aplicable…' : 'Consultando…'}
                </>
              ) : (
                <>Consultar oportunidades</>
              )}
            </Button>

            {errorMsg && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {errorMsg}
              </div>
            )}
          </>
        )}

        {/* Resultados */}
        {response && !errorMsg && (
          <div className="mt-2 space-y-3">
            {/* Modo A */}
            {response.candidatos && response.candidatos.length > 0 && (
              <div className="space-y-2">
                <p className="text-[10px] text-muted-foreground italic">
                  Vista exploratoria — sin dictamen definitivo. Haz clic en “Evaluar en detalle” para un análisis completo.
                </p>
                {response.candidatos.map((c, i) => (
                  <div key={c.id ?? i} className="rounded-lg border border-border p-2.5 bg-background/60">
                    <div className="flex items-center gap-2">
                      <span className={cn('h-2.5 w-2.5 rounded-full flex-shrink-0', colorDotByNivel(c.nivel))} />
                      <span className="text-xs font-semibold text-foreground flex-1 truncate">
                        {c.nombre ?? c.etiqueta ?? 'Zona candidata'}
                      </span>
                      <span className="text-[10px] text-muted-foreground flex-shrink-0">
                        {formatDistancia(c.distancia_m)}
                      </span>
                    </div>
                    {c.motivo_principal && (
                      <p className="mt-1 text-[10px] text-muted-foreground leading-snug pl-4">{c.motivo_principal}</p>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-4">
                      {c.proyectos_cercanos_count != null && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-secondary text-[10px] px-1.5 py-0.5 text-foreground">
                          🏗️ {c.proyectos_cercanos_count} proyectos cerca
                        </span>
                      )}
                      {c.humedales_cercanos_count != null && c.humedales_cercanos_count > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 text-sky-700 border border-sky-500/20 text-[10px] px-1.5 py-0.5">
                          💧 {c.humedales_cercanos_count} humedal{c.humedales_cercanos_count === 1 ? '' : 'es'} cerca
                        </span>
                      )}
                      {c.activos_cercanos_count != null && c.activos_cercanos_count > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-secondary text-[10px] px-1.5 py-0.5 text-foreground">
                          📍 {c.activos_cercanos_count} activo{c.activos_cercanos_count === 1 ? '' : 's'} cerca
                        </span>
                      )}
                    </div>
                    <div className="mt-1.5 flex items-center justify-between pl-4">
                      <span className="text-[10px] text-muted-foreground">
                        Costo relativo: <b>{c.costo_contexto ?? '—'}</b>
                      </span>
                      <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={() => precargarModoB(c)}>
                        Evaluar en detalle <ArrowRight className="h-3 w-3 ml-1" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Modo C */}
            {response.ruta && response.ruta.length > 0 && (
              <div className="space-y-2">
                <p className="text-[10px] text-muted-foreground italic">
                  Esta es una estimación rápida — haz clic en un resultado para evaluarlo en detalle.
                </p>
                <ol className="space-y-1.5">
                  {response.ruta.map((c, i) => (
                    <li
                      key={c.id ?? i}
                      onClick={() => precargarModoB(c)}
                      className="rounded-lg border border-border p-2.5 bg-background/60 flex items-center gap-2 cursor-pointer hover:border-primary/40 transition-colors"
                    >
                      <span className="h-5 w-5 rounded-full bg-primary/10 text-primary text-[10px] font-bold flex items-center justify-center flex-shrink-0">
                        {i + 1}
                      </span>
                      <span className="text-xs flex-1 truncate">{c.nombre ?? c.etiqueta ?? 'Candidato'}</span>
                      {c.tiene_restriccion_cercana && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-amber-600 text-sm leading-none" aria-label="Restricción cercana">⚠️</span>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-[220px] text-[11px]">
                            Esta zona tiene una restricción registrada cerca — revísala en detalle antes de decidir.
                          </TooltipContent>
                        </Tooltip>
                      )}
                      <span className="text-[10px] text-muted-foreground flex-shrink-0">
                        {formatDistancia(c.distancia_m)}
                      </span>
                      <ArrowRight className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                    </li>
                  ))}
                </ol>
              </div>
            )}


            {/* Modo B */}
            {(response.respuesta_narrativa || response.contexto_enriquecido || (response.citas_normativa && response.citas_normativa.length > 0)) && (
              <div className="space-y-2.5">
                {response.respuesta_narrativa && (
                  <div className="prose prose-sm max-w-none text-foreground">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{response.respuesta_narrativa}</ReactMarkdown>
                  </div>
                )}

                {/* Aviso destacado si el punto está sobre una restricción directa */}
                {response.contexto_enriquecido?.tiene_restriccion_directa && (
                  <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
                    <p className="text-xs font-semibold text-amber-800 leading-tight">
                      ⚠️ Este punto está directamente sobre una zona de restricción.
                    </p>
                    {response.contexto_enriquecido.restriccion_pric_encima && response.contexto_enriquecido.restriccion_pric_encima.length > 0 && (
                      <ul className="mt-1.5 space-y-0.5 text-[11px] text-amber-900 list-disc pl-4">
                        {response.contexto_enriquecido.restriccion_pric_encima.map((r, i) => (
                          <li key={i}>
                            <b>{r.nombre ?? 'Zona'}</b>
                            {r.categoria ? ` — ${r.categoria}` : ''}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {/* Secciones colapsables de contexto enriquecido */}
                {response.contexto_enriquecido?.proyectos_cercanos && response.contexto_enriquecido.proyectos_cercanos.length > 0 && (
                  <details className="rounded-lg border border-border bg-background/50 p-2.5">
                    <summary className="cursor-pointer text-xs font-semibold text-foreground">
                      Proyectos cercanos ({response.contexto_enriquecido.proyectos_cercanos.length})
                    </summary>
                    <ul className="mt-2 space-y-1.5">
                      {response.contexto_enriquecido.proyectos_cercanos.map((p, i) => {
                        const b = estadoBadgeCls(p.estado);
                        return (
                          <li key={i} className="text-[11px] flex items-center gap-2">
                            <span className="flex-1 min-w-0 truncate"><b>{p.nombre ?? '—'}</b>{p.sector ? ` · ${p.sector}` : ''}</span>
                            {p.estado && (
                              <span className={cn('inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium flex-shrink-0', b.cls)}>
                                <span>{b.icon}</span>{p.estado}
                              </span>
                            )}
                            <span className="text-[10px] text-muted-foreground flex-shrink-0">{formatDistancia(p.distancia_m)}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                )}

                {response.contexto_enriquecido?.ambiental_cercano && response.contexto_enriquecido.ambiental_cercano.length > 0 && (
                  <details className="rounded-lg border border-border bg-background/50 p-2.5">
                    <summary className="cursor-pointer text-xs font-semibold text-foreground">
                      Áreas ambientales cercanas ({response.contexto_enriquecido.ambiental_cercano.length})
                    </summary>
                    <ul className="mt-2 space-y-1.5">
                      {response.contexto_enriquecido.ambiental_cercano.map((a, i) => (
                        <li key={i} className="text-[11px] flex items-center gap-2">
                          <span className="flex-1 min-w-0 truncate"><b>{a.nombre ?? '—'}</b></span>
                          {a.capa && (
                            <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-emerald-500/10 text-emerald-700 border border-emerald-500/20 flex-shrink-0">
                              {a.capa}
                            </span>
                          )}
                          <span className="text-[10px] text-muted-foreground flex-shrink-0">{formatDistancia(a.distancia_m)}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}

                {response.contexto_enriquecido?.activos_cercanos && response.contexto_enriquecido.activos_cercanos.length > 0 && (
                  <details className="rounded-lg border border-border bg-background/50 p-2.5">
                    <summary className="cursor-pointer text-xs font-semibold text-foreground">
                      Infraestructura y actividad cercana ({response.contexto_enriquecido.activos_cercanos.length})
                    </summary>
                    <ul className="mt-2 space-y-1.5">
                      {response.contexto_enriquecido.activos_cercanos.map((a, i) => (
                        <li key={i} className="text-[11px] flex items-center gap-2">
                          <span className="flex-1 min-w-0 truncate"><b>{a.nombre ?? '—'}</b></span>
                          {a.categoria && (
                            <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-secondary text-foreground flex-shrink-0">
                              {a.categoria}
                            </span>
                          )}
                          <span className="text-[10px] text-muted-foreground flex-shrink-0">{formatDistancia(a.distancia_m)}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}

                <details className="rounded-lg border border-border bg-background/50 p-2.5">
                  <summary className="cursor-pointer text-xs font-semibold text-foreground">Ver detalle técnico</summary>
                  <div className="mt-2 space-y-2">
                    {response.dictamen && (
                      <div>
                        <span
                          className={cn(
                            'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold',
                            dictamenBadge(response.dictamen.dictamen).cls,
                          )}
                        >
                          {dictamenBadge(response.dictamen.dictamen).label}
                        </span>
                        {response.dictamen.motivos && response.dictamen.motivos.length > 0 && (
                          <ul className="mt-1.5 space-y-0.5 text-[11px] text-muted-foreground list-disc pl-4">
                            {response.dictamen.motivos.map((m, i) => (
                              <li key={i}>{m}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}

                    {response.costo_contexto_detalle && response.costo_contexto_detalle.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-[11px] font-medium">Costo contexto</p>
                        {response.costo_contexto_detalle.map((r, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <span className="text-[10px] w-32 truncate">{r.etiqueta}</span>
                            <div className="flex-1 h-2 rounded bg-muted overflow-hidden">
                              <div className="h-full bg-primary" style={{ width: `${Math.min(100, r.valor)}%` }} />
                            </div>
                            <span className="text-[10px] tabular-nums">{r.valor}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {response.precedentes && response.precedentes.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-[11px] font-medium">Precedentes</p>
                        <ul className="space-y-0.5">
                          {response.precedentes.map((p, i) => (
                            <li key={i} className="text-[11px] flex items-center gap-1.5" title={p.proyecto ?? ''}>
                              <span className="flex-shrink-0">{senalIcon(p.senal)}</span>
                              <span className="flex-1 min-w-0 truncate font-semibold">{p.proyecto ?? '—'}</span>
                              {p.estado && (
                                <span className="text-[10px] text-muted-foreground flex-shrink-0 truncate max-w-[40%]">{p.estado}</span>
                              )}
                              <span className="text-[10px] text-muted-foreground flex-shrink-0 tabular-nums">{formatDistancia(p.distancia_m)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </details>

                {/* Normativa relacionada */}
                {response.citas_normativa && response.citas_normativa.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold text-foreground">Normativa relacionada</p>
                    <div className="space-y-1.5">
                      {response.citas_normativa.map((c, i) => (
                        <blockquote
                          key={i}
                          className="rounded-md border-l-2 border-primary/40 bg-background/60 px-3 py-2"
                        >
                          {c.categoria && (
                            <span className="inline-block text-[9px] font-semibold uppercase tracking-wide text-primary/80 mb-1">
                              {c.categoria.replace(/_/g, ' ')}
                            </span>
                          )}
                          <p className="text-[11px] text-foreground leading-snug italic">{c.fragmento}</p>
                        </blockquote>
                      ))}
                    </div>
                    <p className="text-[10px] text-muted-foreground italic">
                      Fragmentos de referencia — no reemplazan asesoría legal.
                    </p>
                  </div>
                )}
              </div>
            )}

          </div>
        )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}


