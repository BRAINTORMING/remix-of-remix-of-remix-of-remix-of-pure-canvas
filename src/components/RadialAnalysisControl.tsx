import { useEffect, useState } from "react";
import { Target, ChevronRight, MapPin, Lock } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { showPaidLockToast } from "@/lib/planLocks";
import ManualCoordinatesInput from "./ManualCoordinatesInput";

interface RadialAnalysisControlProps {
  selectedRegion?: string;
}

/**
 * Radial analysis: user picks a center point on the map and a radius (km).
 * Dispatches window events so MapView can react without prop drilling.
 *  - "radial:set"   { active, center, radiusKm }
 *  - "radial:pickMode" { enabled }
 * Listens:
 *  - "radial:pointPicked" { lat, lng }
 */
export default function RadialAnalysisControl({ selectedRegion }: RadialAnalysisControlProps) {
  const { isFreePlan } = useAuth();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(false);
  const [center, setCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [radiusKm, setRadiusKm] = useState<number>(10);

  const hasRegion = Boolean(selectedRegion);
  const pointLocked = isFreePlan; // free users can activate but can't place the center

  // Listen for clicks coming from the map
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { lat: number; lng: number };
      if (!detail) return;
      setCenter({ lat: detail.lat, lng: detail.lng });
      window.dispatchEvent(new CustomEvent("radial:pickMode", { detail: { enabled: false } }));
    };
    window.addEventListener("radial:pointPicked", handler);
    return () => window.removeEventListener("radial:pointPicked", handler);
  }, []);

  // Listen for the global "clear all filters" signal coming from the sidebar.
  useEffect(() => {
    const onReset = () => {
      setActive(false);
      setCenter(null);
    };
    window.addEventListener('filters:clearAll', onReset);
    return () => window.removeEventListener('filters:clearAll', onReset);
  }, []);

  // Sync state with the map
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("radial:set", {
        detail: { active, center, radiusKm },
      })
    );
  }, [active, center, radiusKm]);

  // Toggle pick mode on the map (cursor crosshair).
  // Free users can activate but the point picker stays disabled.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("radial:pickMode", {
        detail: { enabled: active && hasRegion && !center && !pointLocked },
      })
    );
  }, [active, hasRegion, center, pointLocked]);

  // If a free user activates the tool, surface the lock message.
  useEffect(() => {
    if (active && pointLocked && !center) {
      showPaidLockToast();
    }
  }, [active, pointLocked, center]);

  const handleToggleActive = (checked: boolean | "indeterminate") => {
    const next = Boolean(checked);
    setActive(next);
    if (!next) {
      setCenter(null);
    }
  };

  const handleClearPoint = () => {
    setCenter(null);
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="overflow-hidden">
        <CollapsibleTrigger asChild>
         <button className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-[#EFF6FF] transition-colors duration-150 rounded-[13px]" title="Define un radio de análisis alrededor de un punto del mapa">
            <div className="flex items-center gap-2.5 min-w-0">
              <Target className="h-4 w-4 text-primary flex-shrink-0" />
              <span className="font-medium text-[13px] text-foreground">Análisis Radial</span>
              {active && (
                <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full font-medium">
                  {radiusKm} km
                </span>
              )}
            </div>
            <ChevronRight
              className={cn(
                "h-4 w-4 text-[#9CA3AF] transition-transform duration-200 flex-shrink-0",
                open && "rotate-90"
              )}
            />
          </button>
        </CollapsibleTrigger>


        <CollapsibleContent className="overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 duration-200">

          <div className="p-3 pt-1 space-y-3">
            {/* Activation checkbox */}
            <div
              className={cn(
                "flex items-start gap-2 p-2 rounded-md border transition-colors",
                active
                  ? "border-[hsl(var(--accent))]/40 bg-[hsl(var(--accent))]/5"
                  : "border-border bg-card/95"
              )}
            >
              <Checkbox
                id="radial-active"
                checked={active}
                onCheckedChange={handleToggleActive}
                className="h-3.5 w-3.5 mt-0.5 border-border data-[state=checked]:bg-[hsl(var(--accent))] data-[state=checked]:border-[hsl(var(--accent))]"
              />
              <div className="flex-1">
                <Label
                  htmlFor="radial-active"
                  className="text-[11px] cursor-pointer font-medium text-foreground"
                >
                  Activar análisis radial
                </Label>
                {active && !hasRegion && (
                  <p className="text-[10px] text-[hsl(var(--accent))] mt-1 leading-tight">
                    ⚠ Selecciona una región en el filtro "Regiones y Comunas" para continuar.
                  </p>
                )}
                {active && hasRegion && !center && !pointLocked && (
                  <p className="text-[10px] text-muted-foreground mt-1 leading-tight">
                    Haz clic en el mapa para fijar el punto central.
                  </p>
                )}
                {active && pointLocked && !center && (
                  <p className="text-[10px] text-amber-600 mt-1 leading-tight inline-flex items-center gap-1">
                    <Lock className="h-3 w-3" />
                    Posicionar el punto requiere un Plan de Pago.
                  </p>
                )}
              </div>
            </div>

            {/* Coordinate display */}
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                Ubicación
              </Label>
              <div
                className={cn(
                  "rounded-md border px-2.5 py-2 text-[11px] font-mono transition-colors",
                  center
                    ? "border-[hsl(var(--accent))]/40 bg-card text-foreground"
                    : "border-border bg-muted/40 text-muted-foreground italic"
                )}
              >
                {center ? (
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <MapPin className="h-3 w-3 text-[hsl(var(--accent))] flex-shrink-0" />
                      <span className="truncate">
                        {center.lat.toFixed(5)}°, {center.lng.toFixed(5)}°
                      </span>
                    </div>
                    <button
                      onClick={handleClearPoint}
                      className="text-[9px] text-muted-foreground hover:text-[hsl(var(--accent))] transition-colors flex-shrink-0"
                    >
                      Cambiar
                    </button>
                  </div>
                ) : (
                  <span>Sin ubicación seleccionada</span>
                )}
              </div>
            </div>

            {/* Alternativa: coordenadas manuales — escribe en el mismo estado */}
            {!pointLocked && (
              <ManualCoordinatesInput
                eventName="radial:pointPicked"
                buttonLabel="Fijar punto central"
                initial={center}
              />
            )}


            {/* Radius slider */}
            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between">
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                  Radio
                </Label>
                <span className="text-[11px] font-semibold text-[hsl(var(--accent))] tabular-nums">
                  {radiusKm} km
                </span>
              </div>
              <Slider
                value={[radiusKm]}
                min={1}
                max={100}
                step={1}
                onValueChange={(v) => setRadiusKm(v[0])}
                disabled={!active}
              />
              <div className="flex justify-between text-[9px] text-muted-foreground tabular-nums">
                <span>1 km</span>
                <span>50 km</span>
                <span>100 km</span>
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
