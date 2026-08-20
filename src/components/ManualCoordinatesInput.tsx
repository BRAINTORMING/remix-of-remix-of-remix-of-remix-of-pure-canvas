import { useState } from "react";
import { Keyboard, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * Ingreso manual de coordenadas.
 *
 * No crea un flujo paralelo: al confirmar despacha exactamente el mismo evento
 * (`pric:pointPicked` / `radial:pointPicked`) que emite el mapa cuando el
 * usuario hace clic con "Activar Ubicación", de modo que el estado, el
 * marcador y la consulta al backend son idénticos en ambos caminos.
 */

const LAT_MIN = -56;
const LAT_MAX = -17;
const LNG_MIN = -76;
const LNG_MAX = -66;

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

export function parseCoordinate(
  raw: string,
  kind: "lat" | "lng",
): { value: number } | { error: string } {
  const v = raw.trim();
  if (!v) return { error: "Requerido" };
  if (v.includes(",")) return { error: "Usa punto decimal (ej: -20.215678)" };
  if (/[°'"NSEWnsew]/.test(v)) return { error: "Formato inválido: usa grados decimales" };
  if (!DECIMAL_RE.test(v)) return { error: "Formato inválido: usa grados decimales" };
  const n = Number(v);
  if (!Number.isFinite(n)) return { error: "Formato inválido" };
  if (kind === "lat" && (n < LAT_MIN || n > LAT_MAX))
    return { error: `Latitud fuera de rango (${LAT_MIN} a ${LAT_MAX})` };
  if (kind === "lng" && (n < LNG_MIN || n > LNG_MAX))
    return { error: `Longitud fuera de rango (${LNG_MIN} a ${LNG_MAX})` };
  return { value: n };
}

interface ManualCoordinatesInputProps {
  /** Evento que el mapa/estado ya escucha para un punto elegido. */
  eventName?: "pric:pointPicked" | "radial:pointPicked";
  /** Callback opcional adicional tras validar (mismo punto). */
  onConfirm?: (point: { lat: number; lng: number }) => void;
  buttonLabel?: string;
  className?: string;
  /** Valores iniciales para prellenar los campos. */
  initial?: { lat: number; lng: number } | null;
}

export default function ManualCoordinatesInput({
  eventName = "pric:pointPicked",
  onConfirm,
  buttonLabel = "Consultar",
  className,
  initial,
}: ManualCoordinatesInputProps) {
  const [openManual, setOpenManual] = useState(false);
  const [lat, setLat] = useState(initial ? String(initial.lat) : "");
  const [lng, setLng] = useState(initial ? String(initial.lng) : "");
  const [errors, setErrors] = useState<{ lat?: string; lng?: string }>({});

  const handleConfirm = () => {
    const rLat = parseCoordinate(lat, "lat");
    const rLng = parseCoordinate(lng, "lng");
    const next: { lat?: string; lng?: string } = {};
    if ("error" in rLat) next.lat = rLat.error;
    if ("error" in rLng) next.lng = rLng.error;
    setErrors(next);
    if ("error" in rLat || "error" in rLng) return;

    const point = { lat: (rLat as { value: number }).value, lng: (rLng as { value: number }).value };
    // Cancela cualquier modo de selección en el mapa y reutiliza el mismo canal.
    window.dispatchEvent(
      new CustomEvent(eventName === "radial:pointPicked" ? "radial:pickMode" : "pric:pickMode", {
        detail: { enabled: false },
      }),
    );
    window.dispatchEvent(new CustomEvent(eventName, { detail: point }));
    onConfirm?.(point);
  };

  return (
    <div className={cn("rounded-md border border-border bg-card/70", className)}>
      <button
        type="button"
        onClick={() => setOpenManual((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-[11px] font-medium text-foreground hover:bg-muted/50 transition-colors rounded-md"
      >
        <Keyboard className="h-3.5 w-3.5 text-muted-foreground" />
        Ingresar coordenadas manualmente
      </button>

      {openManual && (
        <div className="px-3 pb-3 pt-1 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">Latitud</Label>
              <Input
                inputMode="decimal"
                value={lat}
                onChange={(e) => setLat(e.target.value.slice(0, 20))}
                placeholder="-20.215678"
                className={cn("h-8 text-[11px]", errors.lat && "border-destructive")}
              />
              {errors.lat && <p className="text-[10px] text-destructive leading-tight">{errors.lat}</p>}
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">Longitud</Label>
              <Input
                inputMode="decimal"
                value={lng}
                onChange={(e) => setLng(e.target.value.slice(0, 20))}
                placeholder="-70.123456"
                className={cn("h-8 text-[11px]", errors.lng && "border-destructive")}
              />
              {errors.lng && <p className="text-[10px] text-destructive leading-tight">{errors.lng}</p>}
            </div>
          </div>
          <Button type="button" size="sm" onClick={handleConfirm} className="h-7 w-full text-[11px] gap-1">
            <Check className="h-3.5 w-3.5" />
            {buttonLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
