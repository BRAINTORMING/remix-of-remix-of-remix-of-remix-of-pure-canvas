import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface ZoneWeatherResumen {
  temperatura_prom?: number;
  temperatura_min?: number;
  temperatura_max?: number;
  viento_prom_kmh?: number;
  viento_max_kmh?: number;
  lluvia_acumulada_mm?: number;
  irradiancia_prom_wm2?: number;
  uv_max?: number;
}

export interface ZoneWeatherContext {
  indice_contexto_climatico?: number;
  resumen?: ZoneWeatherResumen;
  aptitud_solar?: number;
  aptitud_eolica?: number;
  categoria_proyecto?: string | null;
  generado_en?: string;
}

export interface ZoneWeatherRequest {
  lat: number;
  lon: number;
  radio_km?: number | null;
  categoria?: string | null;
}

const TIMEOUT_MS = 5000;

/**
 * Contexto climático complementario de una zona. Nunca bloquea ni propaga
 * errores: si falla o tarda más de 5s, devuelve data = null y la UI se oculta.
 */
export function useZoneWeatherContext(req: ZoneWeatherRequest | null) {
  const [data, setData] = useState<ZoneWeatherContext | null>(null);
  const [loading, setLoading] = useState(false);

  const key = req ? `${req.lat}|${req.lon}|${req.radio_km ?? ''}|${req.categoria ?? ''}` : null;

  useEffect(() => {
    if (!req || !key) {
      setData(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setData(null);
    setLoading(true);

    const timer = setTimeout(() => {
      if (!cancelled) {
        cancelled = true;
        setLoading(false);
        setData(null);
      }
    }, TIMEOUT_MS);

    (async () => {
      try {
        const { data: resp, error } = await supabase.functions.invoke('zone-weather-context', {
          body: {
            lat: req.lat,
            lon: req.lon,
            radio_km: req.radio_km ?? null,
            categoria_proyecto: req.categoria ?? null,
          },
        });
        if (cancelled) return;
        const payload = resp as (ZoneWeatherContext & { error?: string }) | null;
        if (error || !payload || payload.error || payload.indice_contexto_climatico == null) {
          setData(null);
        } else {
          setData(payload);
        }
      } catch (e) {
        console.warn('[zone-weather-context] omitido:', e);
        if (!cancelled) setData(null);
      } finally {
        if (!cancelled) setLoading(false);
        clearTimeout(timer);
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { data, loading };
}
