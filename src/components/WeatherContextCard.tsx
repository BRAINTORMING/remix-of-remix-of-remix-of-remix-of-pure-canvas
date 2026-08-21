import { useState } from 'react';
import { CloudSun, ChevronDown, Thermometer, Wind, CloudRain, Sun } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ZoneWeatherContext } from '@/hooks/useZoneWeatherContext';

interface Props {
  data: ZoneWeatherContext | null;
  loading?: boolean;
  categoria?: string | null;
  defaultOpen?: boolean;
  className?: string;
}

function barColor(v: number) {
  if (v >= 70) return 'bg-teal-500';
  if (v >= 45) return 'bg-amber-500';
  return 'bg-red-500';
}
function chipCls(v: number) {
  if (v >= 70) return 'bg-emerald-500/10 text-emerald-700 border-emerald-500/25';
  if (v >= 45) return 'bg-amber-500/10 text-amber-700 border-amber-500/25';
  return 'bg-red-500/10 text-red-700 border-red-500/25';
}

function haceX(iso?: string) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return 'recién';
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return 'hace menos de 1 h';
  return `hace ${h} h`;
}

function Stat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-border bg-background/60 px-2 py-1.5">
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <p className="text-xs font-semibold text-foreground tabular-nums">{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground tabular-nums">{sub}</p>}
    </div>
  );
}

export default function WeatherContextCard({ data, loading, categoria, defaultOpen = false, className }: Props) {
  const [open, setOpen] = useState(defaultOpen);

  if (loading) {
    return (
      <div className={cn('rounded-lg border border-border bg-background/50 p-2.5 space-y-2 animate-pulse', className)}>
        <div className="h-3 w-40 rounded bg-muted" />
        <div className="h-1.5 w-full rounded bg-muted" />
      </div>
    );
  }

  if (!data || data.indice_contexto_climatico == null) return null;

  const idx = data.indice_contexto_climatico;
  const r = data.resumen ?? {};
  const esEnergetica = !!categoria && categoria.toLowerCase().includes('energ');
  const usaSolar = (data.aptitud_solar ?? 0) >= (data.aptitud_eolica ?? 0);
  const aptValor = usaSolar ? data.aptitud_solar : data.aptitud_eolica;

  return (
    <div className={cn('rounded-lg border border-border bg-background/50 p-2.5', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 text-left"
        aria-expanded={open}
      >
        <CloudSun className="h-3.5 w-3.5 text-sky-600 flex-shrink-0" />
        <span className="text-xs font-semibold text-foreground flex-1 truncate">Monitoreo Territorial · Tiempo</span>
        <span className={cn('rounded-full border px-1.5 py-0.5 text-[10px] font-semibold tabular-nums flex-shrink-0', chipCls(idx))}>
          {idx}/100
        </span>
        <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      <div className="mt-1.5">
        <div className="h-1.5 w-full rounded bg-muted overflow-hidden">
          <div className={cn('h-full rounded transition-all', barColor(idx))} style={{ width: `${Math.min(100, Math.max(0, idx))}%` }} />
        </div>
        <p className="mt-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">Índice de contexto climático</p>
      </div>

      {open && (
        <div className="mt-2 space-y-2">
          <div className="grid grid-cols-2 gap-1.5">
            <Stat
              icon={<Thermometer className="h-3 w-3" />}
              label="Temperatura prom."
              value={r.temperatura_prom != null ? `${r.temperatura_prom} °C` : '—'}
              sub={r.temperatura_min != null && r.temperatura_max != null ? `min ${r.temperatura_min}° · máx ${r.temperatura_max}°` : undefined}
            />
            <Stat
              icon={<Wind className="h-3 w-3" />}
              label="Viento prom."
              value={r.viento_prom_kmh != null ? `${r.viento_prom_kmh} km/h` : '—'}
              sub={r.viento_max_kmh != null ? `máx ${r.viento_max_kmh} km/h` : undefined}
            />
            <Stat
              icon={<CloudRain className="h-3 w-3" />}
              label="Lluvia 48 h"
              value={r.lluvia_acumulada_mm != null ? `${r.lluvia_acumulada_mm} mm` : '—'}
            />
            <Stat
              icon={<Sun className="h-3 w-3" />}
              label="Irradiancia / UV"
              value={r.irradiancia_prom_wm2 != null ? `${r.irradiancia_prom_wm2} W/m²` : '—'}
              sub={r.uv_max != null ? `UV máx ${r.uv_max}` : undefined}
            />
          </div>

          {esEnergetica && aptValor != null && (
            <div className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold', chipCls(aptValor))}>
              {usaSolar ? '☀️' : '🌬️'} {usaSolar ? 'Aptitud solar' : 'Aptitud eólica'}: {aptValor}/100
            </div>
          )}

          <p className="text-[10px] text-muted-foreground italic">
            Datos: Open-Meteo · actualizado {haceX(data.generado_en)}
          </p>
        </div>
      )}
    </div>
  );
}
