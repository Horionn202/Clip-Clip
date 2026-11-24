// Validación pura (sin Node/Electron) reutilizable en main, renderer y tests.
import { DURATION_PRESETS, MAX_CLIPS, type DurationPreset } from './types';

export class UserFacingError extends Error {
  constructor(message: string, public readonly technical?: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}

const PRIVATE_HOST = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^\[?fe80:/i,
];

/** Valida una URL de vídeo pública. Devuelve la URL normalizada o lanza UserFacingError. */
export function validateVideoUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw new UserFacingError('La URL no es válida.');
  const trimmed = raw.trim();
  if (!trimmed) throw new UserFacingError('Pega la URL de un vídeo.');
  if (trimmed.length > 2048) throw new UserFacingError('La URL es demasiado larga.');
  if (/[\s\u0000-\u001f]/.test(trimmed)) throw new UserFacingError('La URL contiene caracteres no permitidos.');
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new UserFacingError('La URL no tiene un formato válido (debe empezar por https://).');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new UserFacingError('Sólo se admiten URLs http(s).');
  }
  if (u.username || u.password) throw new UserFacingError('La URL no puede incluir usuario o contraseña.');
  const host = u.hostname;
  if (!host || PRIVATE_HOST.some((r) => r.test(host)) || !host.includes('.')) {
    throw new UserFacingError('No se permiten direcciones locales o privadas.');
  }
  return u.toString();
}

export function validatePreset(v: unknown): DurationPreset {
  if (typeof v === 'number' && (DURATION_PRESETS as readonly number[]).includes(v)) return v as DurationPreset;
  throw new UserFacingError('La duración de cada clip debe ser 15, 30, 45, 60 o 90 segundos, o 2 minutos.');
}

export function validateMaxClips(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_CLIPS) {
    throw new UserFacingError(`El número de clips debe estar entre 1 y ${MAX_CLIPS}.`);
  }
  return v;
}

/** Rango de duración aceptado para un preset: [75 % del preset, preset + 1 s]. */
export function presetRange(preset: DurationPreset): { min: number; max: number } {
  return { min: Math.max(5, Math.round(preset * 0.75)), max: preset + 1 };
}

export interface RawCandidate {
  start: number;
  end: number;
  title: string;
  hook: string;
  reason: string;
  score: number;
}

export interface NormalizeOptions {
  preset: DurationPreset;
  maxClips: number;
  sourceDuration: number;
  /** Límites de palabras para ajustar cortes (opcional). */
  wordBoundaries?: { start: number; end: number }[];
}

export interface NormalizeResult {
  clips: RawCandidate[];
  warnings: string[];
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = v.trim();
    // admite "mm:ss" o "hh:mm:ss"
    if (/^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(t)) {
      return t.split(':').reduce((acc, p) => acc * 60 + parseFloat(p), 0);
    }
    const n = Number(t);
    if (t !== '' && Number.isFinite(n)) return n;
  }
  return null;
};

const text = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Extrae candidatos de la respuesta del modelo (JSON potencialmente inválido). */
export function parseModelResponse(raw: string): unknown[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    // intenta rescatar el primer objeto/array JSON del texto
    const m = raw.match(/[[{][\s\S]*[\]}]/);
    if (!m) throw new UserFacingError('La IA devolvió una respuesta que no es JSON.', raw.slice(0, 500));
    try {
      data = JSON.parse(m[0]);
    } catch {
      throw new UserFacingError('La IA devolvió JSON inválido.', raw.slice(0, 500));
    }
  }
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const k of ['clips', 'candidates', 'results', 'items']) {
      if (Array.isArray(obj[k])) return obj[k] as unknown[];
    }
  }
  throw new UserFacingError('La respuesta de la IA no contiene una lista de clips.');
}

function snap(t: number, bounds: { start: number; end: number }[] | undefined, kind: 'start' | 'end'): number {
  if (!bounds || bounds.length === 0) return t;
  let best = t;
  let bestDist = 1.5; // sólo ajusta si hay una palabra a < 1,5 s
  for (const w of bounds) {
    const v = kind === 'start' ? w.start : w.end;
    const d = Math.abs(v - t);
    if (d < bestDist) {
      bestDist = d;
      best = v;
    }
  }
  return best;
}

/**
 * Normaliza candidatos: descarta imposibles, ajusta duración al preset, recorta a la duración real,
 * elimina solapes (priorizando score) y aplica el máximo de clips (nunca > MAX_CLIPS).
 */
export function normalizeCandidates(input: unknown[], opts: NormalizeOptions): NormalizeResult {
  const warnings: string[] = [];
  const maxClips = Math.min(validateMaxClips(opts.maxClips), MAX_CLIPS);
  const { min, max } = presetRange(opts.preset);
  const D = opts.sourceDuration;
  if (!Number.isFinite(D) || D <= 0) throw new UserFacingError('No se pudo determinar la duración del vídeo.');
  if (D < min) {
    throw new UserFacingError(
      `El vídeo dura ${Math.round(D)} s, menos que la duración mínima del preset (${min} s). Elige un preset más corto.`,
    );
  }

  const list = input.slice(0, 200);
  if (input.length > MAX_CLIPS) warnings.push(`La IA propuso ${input.length} clips; se limitarán a ${maxClips}.`);

  const valid: RawCandidate[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    let start = num(o.start ?? o.start_time ?? o.inicio);
    let end = num(o.end ?? o.end_time ?? o.fin);
    if (start === null || end === null) continue;
    if (start < 0 || start >= D || end <= start) continue; // imposible
    start = snap(start, opts.wordBoundaries, 'start');
    end = Math.min(snap(end, opts.wordBoundaries, 'end'), D);
    let dur = end - start;
    if (dur > max || dur < min) {
      // ajusta al preset exacto manteniendo el inicio
      end = start + opts.preset;
      if (end > D) {
        end = D;
        start = Math.max(0, D - opts.preset);
      }
      dur = end - start;
    }
    if (dur < min || dur > max) continue;
    const scoreN = num(o.score);
    valid.push({
      start: Math.round(start * 100) / 100,
      end: Math.round(end * 100) / 100,
      title: text(o.title ?? o.titulo, 100) || 'Clip sin título',
      hook: text(o.hook ?? o.gancho, 200),
      reason: text(o.reason ?? o.motivo, 300),
      score: scoreN === null ? 0 : Math.max(0, Math.min(100, scoreN)),
    });
  }

  // Selección voraz sin solapes, mayor score primero.
  const sorted = [...valid].sort((a, b) => b.score - a.score || a.start - b.start);
  const chosen: RawCandidate[] = [];
  for (const c of sorted) {
    if (chosen.length >= maxClips) break;
    if (chosen.some((k) => overlaps(k, c))) continue;
    chosen.push(c);
  }
  const dropped = valid.length - chosen.length;
  if (dropped > 0) warnings.push(`Se descartaron ${dropped} candidatos por solapes o por superar el máximo.`);
  chosen.sort((a, b) => a.start - b.start);
  assertClipInvariants(chosen, opts);
  return { clips: chosen, warnings };
}

export function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Comprobación final defensiva usada antes de renderizar. */
export function assertClipInvariants(clips: { start: number; end: number }[], opts: NormalizeOptions): void {
  if (clips.length > Math.min(opts.maxClips, MAX_CLIPS)) throw new UserFacingError('Se superó el máximo de clips.');
  const { min, max } = presetRange(opts.preset);
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    if (c.start < 0 || c.end > opts.sourceDuration + 0.01 || c.end <= c.start) {
      throw new UserFacingError('Un clip tiene marcas de tiempo fuera de la duración del vídeo.');
    }
    const d = c.end - c.start;
    if (d < min - 0.01 || d > max + 0.01) throw new UserFacingError('Un clip no cumple la duración del preset.');
    if (i > 0 && overlaps(sorted[i - 1], c)) throw new UserFacingError('Hay clips solapados.');
  }
}

/** Nombre de archivo seguro para Windows. */
export function safeFileName(name: string, fallback = 'clip'): string {
  let s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_.-]/g, '')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 60);
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = `_${s}`;
  return s || fallback;
}

export function formatTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
}
