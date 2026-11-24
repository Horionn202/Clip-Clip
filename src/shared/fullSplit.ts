// Modo «Dividir video completo»: el vídeo entero en clips consecutivos de la duración elegida. Puro.
// Todos los segmentos existen (cubren el vídeo sin huecos); la IA sólo los califica y marca los mejores.
import type { DurationPreset } from './types';
import { presetRange } from './validation';
import type { TimedWord } from './selection';

export type CreationMode = 'ai-highlights' | 'full-split';
export type BoundaryMode = 'exact' | 'smart';

export const CREATION_MODE_LABELS: Record<CreationMode, { label: string; help: string }> = {
  'ai-highlights': { label: 'IA encuentra momentos', help: 'La IA selecciona hasta el máximo de clips con más potencial.' },
  'full-split': { label: 'Dividir video completo', help: 'Corta todo el video en bloques consecutivos y marca cuáles tienen mayor potencial.' },
};
export const BOUNDARY_MODE_LABELS: Record<BoundaryMode, { label: string; help: string }> = {
  exact: { label: 'Cortes exactos', help: 'Cada bloque dura exactamente lo elegido (p. ej. 0–60, 60–120…).' },
  smart: { label: 'Cortes inteligentes', help: 'Cada corte se mueve unos segundos hasta una pausa o final de frase, sin perder nada del vídeo.' },
};

/** Por encima de este número de segmentos hace falta confirmarlo (y conviene subir la duración). */
export const FULL_SPLIT_SAFE_LIMIT = 200;
/** Límite absoluto, también con confirmación. */
export const FULL_SPLIT_HARD_LIMIT = 1000;
/** El último fragmento se conserva si dura al menos esto; si dura menos, se suma al anterior. */
export const SPLIT_MIN_TAIL = 5;
/** Cuánto puede moverse un corte inteligente respecto al teórico (s). */
export const SMART_SHIFT = 5;

export interface Segment {
  start: number;
  end: number;
}

const floor2 = (x: number) => Math.floor(x * 100) / 100;
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Cortes teóricos 0, p, 2p… y el final; el último resto de menos de 5 s se suma al bloque anterior. */
function exactBounds(duration: number, preset: number): number[] {
  const end = floor2(duration);
  const bounds = [0];
  for (let t = preset; t < end; t += preset) bounds.push(t);
  if (bounds.length > 1 && end - bounds[bounds.length - 1] < SPLIT_MIN_TAIL) bounds.pop();
  bounds.push(end);
  return bounds;
}

/** Puntos seguros para cortar: final de frase (signo de cierre) o pausa de al menos 0,35 s, en medio del hueco. */
export function cutPoints(words: TimedWord[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < words.length; i++) {
    const gap = words[i + 1].start - words[i].end;
    if (gap >= 0.35 || (/[.?!…]["»]?$/.test(words[i].text.trim()) && gap >= 0)) out.push(round2((words[i].end + words[i + 1].start) / 2));
  }
  return out;
}

/**
 * Divide [0, duración] en segmentos consecutivos sin huecos ni solapes.
 * - «exact»: cortes cada `preset` segundos.
 * - «smart»: cada corte interior se mueve como mucho ±5 s hasta el punto seguro más cercano (pausa o final de
 *   frase); si no hay ninguno, se queda en el teórico. Nunca se inventa ni se pierde contenido.
 * Regla del último fragmento: se conserva si dura ≥ 5 s; si dura menos, se suma al anterior
 * (125 s en bloques de 120 s → 0–120 y 120–125; 122 s → 0–122).
 */
export function splitFullVideo(duration: number, preset: DurationPreset, boundaryMode: BoundaryMode = 'exact', words: TimedWord[] = []): Segment[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const bounds = exactBounds(duration, preset);
  if (boundaryMode === 'smart' && words.length > 1) {
    const points = cutPoints(words);
    for (let i = 1; i < bounds.length - 1; i++) {
      const want = bounds[i];
      let best: number | null = null;
      for (const p of points) {
        if (Math.abs(p - want) > SMART_SHIFT) continue;
        // Siempre creciente y con al menos 1 s por segmento.
        if (p <= bounds[i - 1] + 1 || p >= bounds[i + 1] - 1) continue;
        if (best === null || Math.abs(p - want) < Math.abs(best - want)) best = p;
      }
      if (best !== null) bounds[i] = best;
    }
  }
  const out: Segment[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) out.push({ start: round2(bounds[i]), end: round2(bounds[i + 1]) });
  return out;
}

export interface SplitPlan {
  count: number;
  /** Duración del último segmento (puede ser menor que el preset, o algo mayor si absorbió un resto corto). */
  lastSec: number;
  /** Supera el límite seguro: requiere confirmación explícita. */
  needsConfirm: boolean;
  /** Supera el límite absoluto: no se puede iniciar. */
  tooMany: boolean;
}

export function splitPlan(duration: number, preset: DurationPreset): SplitPlan {
  const segs = splitFullVideo(duration, preset, 'exact');
  const last = segs[segs.length - 1];
  return { count: segs.length, lastSec: last ? round2(last.end - last.start) : 0, needsConfirm: segs.length > FULL_SPLIT_SAFE_LIMIT, tooMany: segs.length > FULL_SPLIT_HARD_LIMIT };
}

/** Duración permitida de un segmento: el último puede ser corto y un corte inteligente puede alargarlo un poco. */
export function splitRange(preset: DurationPreset): { min: number; max: number } {
  return { min: 0.5, max: preset + 2 * SMART_SHIFT + SPLIT_MIN_TAIL };
}

/** Límites de duración de un clip según el modo del trabajo (los trabajos antiguos son «ai-highlights»). */
export function clipLimits(preset: DurationPreset, mode?: CreationMode): { min: number; max: number } {
  return mode === 'full-split' ? splitRange(preset) : presetRange(preset);
}

/** Cobertura: segundos cubiertos y huecos (debe ser 100 % y sin huecos). */
export function coverage(segments: Segment[], duration: number): { coveredSec: number; gaps: Segment[] } {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const gaps: Segment[] = [];
  let cur = 0;
  let covered = 0;
  for (const s of sorted) {
    if (s.start > cur + 0.011) gaps.push({ start: cur, end: s.start });
    covered += Math.max(0, s.end - Math.max(cur, s.start));
    cur = Math.max(cur, s.end);
  }
  if (duration - cur > 0.011) gaps.push({ start: cur, end: duration });
  return { coveredSec: round2(covered), gaps };
}

/** «Segmento 12 de 48». */
export const segmentLabel = (index: number, total: number): string => `Segmento ${index} de ${total}`;

/** Resumen del trabajo: todos los segmentos se generan; los destacados son referencias, no copias. */
export function splitSummary(segments: number, featured: number): string {
  return `${segments} segmento${segments === 1 ? '' : 's'} (vídeo completo) · ${featured} ${featured === 1 ? 'destacado verificado' : 'destacados verificados'} para publicar.`;
}

export type SegmentFilter = 'todos' | 'destacados' | 'otros' | 'pendientes';
export const SEGMENT_FILTERS: { id: SegmentFilter; label: string }[] = [
  { id: 'todos', label: 'Todos los segmentos' },
  { id: 'destacados', label: 'Destacados verificados' },
  { id: 'otros', label: 'Otros segmentos' },
  { id: 'pendientes', label: 'Sin renderizar / con error' },
];

/**
 * Filtra los segmentos de un trabajo «Dividir video completo». Un destacado es el MISMO clip (no una copia):
 * los destacados salen primero por confianza; el resto, en el orden del vídeo.
 */
export function filterSegments<C extends { start: number; file?: string; dirty?: boolean; editorial?: { verification?: { confidence: number } } }>(
  clips: C[],
  filter: SegmentFilter,
  isStar: (c: C) => boolean,
): C[] {
  const byTime = [...clips].sort((a, b) => a.start - b.start);
  if (filter === 'destacados') return byTime.filter(isStar).sort((a, b) => (b.editorial?.verification?.confidence ?? 0) - (a.editorial?.verification?.confidence ?? 0));
  if (filter === 'otros') return byTime.filter((c) => !isStar(c));
  if (filter === 'pendientes') return byTime.filter((c) => !c.file || c.dirty);
  return byTime;
}
