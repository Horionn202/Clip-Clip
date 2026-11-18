// Contrato «hasta 20 clips»: meta efectiva, validación de calidad y puntuación local determinista.
// Puro (sin Node/Electron): lo usan main, renderer y tests.
import { MAX_CLIPS, type DurationPreset } from './types';
import { overlaps, presetRange } from './validation';

/** Máximo matemático de clips sin solapes: floor(duración / preset), con tope 20. */
export function feasibleMax(durationSec: number, preset: DurationPreset): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  return Math.min(MAX_CLIPS, Math.floor(durationSec / preset + 1e-9));
}

/** Meta efectiva = min(meta del usuario, 20, máximo factible). */
export function effectiveTarget(userTarget: number, durationSec: number, preset: DurationPreset): number {
  const t = Math.max(1, Math.min(MAX_CLIPS, Math.floor(userTarget)));
  return Math.min(t, feasibleMax(durationSec, preset));
}

/** Segundos de vídeo necesarios para N clips del preset (sin contar contexto entre clips). */
export function requiredDuration(target: number, preset: DurationPreset): number {
  return Math.min(MAX_CLIPS, target) * preset;
}

/** Recomendación legible cuando el vídeo no da para la meta. */
export function feasibilityAdvice(userTarget: number, durationSec: number, preset: DurationPreset): string | null {
  const max = feasibleMax(durationSec, preset);
  if (max === 0) return `El vídeo (${Math.round(durationSec)} s) es más corto que un clip de ${preset} s. Elige un preset más corto.`;
  if (userTarget > max) {
    return `Con ${Math.round(durationSec)} s de vídeo caben como máximo ${max} clips de ${preset} s sin solaparse; la meta se ajustará a ${max}.`;
  }
  return null;
}

export function resultSummary(obtained: number, target: number, reason?: string): string {
  const base = `${obtained}/${target} clips generados`;
  if (obtained >= target) return base;
  return `${base}: ${reason ?? 'no se encontraron más momentos distintos que cumplan los criterios'}`;
}

// ---- Validación de calidad ----

export type RejectReason =
  | 'formato'
  | 'timestamps'
  | 'duracion'
  | 'solape'
  | 'titulo'
  | 'hook'
  | 'razon'
  | 'placeholder'
  | 'poca_voz'
  | 'sobrante';

export const REJECT_LABELS: Record<RejectReason, string> = {
  formato: 'formato inválido',
  timestamps: 'marcas de tiempo imposibles',
  duracion: 'duración fuera del preset',
  solape: 'solapa con otro clip',
  titulo: 'título vacío o genérico',
  hook: 'hook vacío o genérico',
  razon: 'razón vacía o genérica',
  placeholder: 'texto de plantilla copiado',
  poca_voz: 'casi sin voz en el tramo',
  sobrante: 'excede la meta',
};

const PLACEHOLDERS = [
  'titulo corto y llamativo',
  'frase gancho de apertura',
  'por que funciona',
  'clip sin titulo',
  'titulo',
  'hook',
  'reason',
  'razon',
  'gancho',
  'title',
  'lorem ipsum',
  'n/a',
  'na',
  'none',
  'null',
  'undefined',
  'todo',
  'tbd',
  'ejemplo',
  'example',
  'texto',
  'clip',
  'clip 1',
  'momento interesante',
  'momento viral',
  'parte interesante',
  'es interesante',
  'es viral',
  'engaging content',
  'interesting moment',
];

export function normText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[¿?¡!.,:;"'«»“”()\[\]{}…-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** true si el texto es vacío, demasiado corto, una plantilla o un genérico. */
export function isGenericText(s: string, minLen: number): boolean {
  const n = normText(s);
  if (n.length < minLen) return true;
  if (PLACEHOLDERS.includes(n)) return true;
  if (/^(clip|titulo|title|hook|razon|reason)\s*\d*$/.test(n)) return true;
  if (/^(x|\.|-|_|\s)+$/.test(n)) return true;
  // texto de plantilla del prompt con cualquier relleno alrededor
  if (/(titulo corto y llamativo|frase gancho de apertura|por que funciona\b$)/.test(n)) return true;
  return false;
}

export interface TimedWord {
  start: number;
  end: number;
  text: string;
}

export interface Candidate {
  start: number;
  end: number;
  title: string;
  hook: string;
  reason: string;
  /** Score del LLM 0–100 (o null si no es válido). */
  llmScore: number | null;
  /** Puntuación local determinista 0–100. */
  localScore: number;
  /** Puntuación final usada para ordenar. */
  score: number;
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (/^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(t)) return t.split(':').reduce((a, p) => a * 60 + parseFloat(p), 0);
    const n = Number(t);
    if (t !== '' && Number.isFinite(n)) return n;
  }
  return null;
};

const clean = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

function snap(t: number, words: TimedWord[], kind: 'start' | 'end'): number {
  let best = t;
  let bestDist = 1.5;
  for (const w of words) {
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
 * Puntuación local determinista (0–100): densidad de habla, frases completas en los bordes,
 * signos de énfasis y coincidencia del hook con lo que realmente se dice.
 */
export function localScore(start: number, end: number, hook: string, words: TimedWord[]): number {
  const inside = words.filter((w) => w.start >= start - 0.05 && w.end <= end + 0.05);
  const dur = Math.max(1, end - start);
  const wps = inside.length / dur; // ~2–3 palabras/s en habla normal
  const density = Math.min(1, wps / 2.5);
  const text = inside.map((w) => w.text).join(' ');
  const emphasis = Math.min(1, (text.match(/[?!¿¡]/g) ?? []).length / 3);
  const first = inside[0]?.text.trim() ?? '';
  const last = inside[inside.length - 1]?.text.trim() ?? '';
  const cleanStart = /^[A-ZÁÉÍÓÚÑ¿¡"«]/.test(first) ? 1 : 0;
  const cleanEnd = /[.?!…"»]$/.test(last) ? 1 : 0;
  const tw = new Set(normText(text).split(' ').filter((w) => w.length > 3));
  const hw = normText(hook).split(' ').filter((w) => w.length > 3);
  const grounding = hw.length ? hw.filter((w) => tw.has(w)).length / hw.length : 0;
  const s = 0.45 * density + 0.15 * emphasis + 0.1 * cleanStart + 0.1 * cleanEnd + 0.2 * grounding;
  return Math.round(Math.max(0, Math.min(1, s)) * 100);
}

/** Primera frase hablada del clip (hasta un signo de cierre o ~14 palabras): hook real, no inventado. */
export function openingPhrase(words: TimedWord[], start: number, end: number): string {
  const inside = words.filter((w) => w.start >= start - 0.05 && w.end <= end + 0.05);
  const out: string[] = [];
  for (const w of inside) {
    out.push(w.text.trim());
    if (out.length >= 4 && /[.?!…]$/.test(w.text.trim())) break;
    if (out.length >= 14) break;
  }
  return out.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

export interface EvaluateOptions {
  preset: DurationPreset;
  sourceDuration: number;
  words: TimedWord[];
  /** Clips ya aceptados (para rechazar solapes). */
  taken: { start: number; end: number }[];
}

export type Evaluation = { ok: true; candidate: Candidate } | { ok: false; reason: RejectReason };

/** Valida y normaliza un candidato crudo del LLM. Nunca lanza. */
export function evaluateCandidate(raw: unknown, o: EvaluateOptions): Evaluation {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'formato' };
  const r = raw as Record<string, unknown>;
  let start = num(r.start ?? r.start_time ?? r.inicio);
  let end = num(r.end ?? r.end_time ?? r.fin);
  const D = o.sourceDuration;
  if (start === null || end === null || start < 0 || start >= D || end <= start) return { ok: false, reason: 'timestamps' };

  const title = clean(r.title ?? r.titulo, 100);
  let hook = clean(r.hook ?? r.gancho, 200);
  const reason = clean(r.reason ?? r.motivo ?? r.razon, 300);
  const tmpl = [title, hook, reason].map(normText);
  if (tmpl.some((t) => /titulo corto y llamativo|frase gancho de apertura/.test(t))) return { ok: false, reason: 'placeholder' };
  if (isGenericText(title, 6)) return { ok: false, reason: 'titulo' };
  if (isGenericText(reason, 15) || normText(reason) === normText(hook) || normText(reason) === normText(title)) return { ok: false, reason: 'razon' };
  // Hook vacío, genérico o copia del título: se repara con la frase real de apertura (si hay transcripción).
  const hookNeedsRepair = isGenericText(hook, 12) || normText(hook) === normText(title);
  if (hookNeedsRepair && o.words.length === 0) return { ok: false, reason: 'hook' };

  // Duración: ajusta al preset desde el inicio y encaja en límites de palabra.
  const { min, max } = presetRange(o.preset);
  start = snap(start, o.words, 'start');
  end = Math.min(snap(end, o.words, 'end'), D);
  if (end - start > max || end - start < min) {
    end = Math.min(D, snap(start + o.preset, o.words, 'end'));
    if (end - start > max) end = start + o.preset;
    if (end - start < min && D - o.preset >= 0) {
      end = D;
      start = Math.max(0, D - o.preset);
    }
  }
  start = Math.round(start * 100) / 100;
  end = Math.round(Math.min(end, D) * 100) / 100;
  const dur = end - start;
  if (dur < min - 0.01 || dur > max + 0.01) return { ok: false, reason: 'duracion' };
  if (o.taken.some((t) => overlaps(t, { start, end }))) return { ok: false, reason: 'solape' };
  if (hookNeedsRepair) {
    hook = openingPhrase(o.words, start, end);
    if (isGenericText(hook, 12)) return { ok: false, reason: 'hook' };
  }

  const ls = localScore(start, end, hook, o.words);
  if (o.words.length > 0 && ls < 15) return { ok: false, reason: 'poca_voz' };
  const llm = num(r.score);
  const llmScore = llm !== null && llm >= 0 && llm <= 100 ? llm : null; // scores fuera de rango no cuentan
  const score = Math.round(llmScore === null ? ls : 0.6 * ls + 0.4 * llmScore);
  return { ok: true, candidate: { start, end, title, hook, reason, llmScore, localScore: ls, score } };
}

export interface RoundSelection {
  accepted: Candidate[];
  rejected: Partial<Record<RejectReason, number>>;
}

/**
 * Evalúa los candidatos de una ronda y elige, por puntuación, los que no solapan con `taken`
 * ni entre sí, hasta `need`.
 */
export function selectRound(raws: unknown[], need: number, o: Omit<EvaluateOptions, 'taken'> & { taken: Candidate[] | { start: number; end: number }[] }): RoundSelection {
  const rejected: Partial<Record<RejectReason, number>> = {};
  const bump = (r: RejectReason) => (rejected[r] = (rejected[r] ?? 0) + 1);
  const valid: Candidate[] = [];
  // Sin recorte por prefijo: se puntúa todo antes de ordenar (cada respuesta del LLM ya viene acotada).
  // El tope sólo protege de entradas patológicas.
  for (const raw of raws.slice(0, 5000)) {
    const ev = evaluateCandidate(raw, { ...o, taken: o.taken });
    if (ev.ok) valid.push(ev.candidate);
    else bump(ev.reason);
  }
  valid.sort((a, b) => b.score - a.score || a.start - b.start);
  const accepted: Candidate[] = [];
  const taken = [...o.taken];
  for (const c of valid) {
    if (accepted.length >= need) {
      bump('sobrante');
      continue;
    }
    if (taken.some((t) => overlaps(t, c))) {
      bump('solape');
      continue;
    }
    accepted.push(c);
    taken.push(c);
  }
  return { accepted, rejected };
}

/** Huecos libres (≥ preset) entre clips ya elegidos: se envían al modelo en las rondas de relleno. */
export function freeGaps(taken: { start: number; end: number }[], duration: number, preset: number): { start: number; end: number }[] {
  const sorted = [...taken].sort((a, b) => a.start - b.start);
  const gaps: { start: number; end: number }[] = [];
  let cur = 0;
  for (const t of sorted) {
    if (t.start - cur >= preset) gaps.push({ start: cur, end: t.start });
    cur = Math.max(cur, t.end);
  }
  if (duration - cur >= preset) gaps.push({ start: cur, end: duration });
  return gaps;
}
