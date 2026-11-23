// Contrato «hasta 20 clips»: meta efectiva, validación de calidad y puntuación local determinista.
// Puro (sin Node/Electron): lo usan main, renderer y tests.
import { MAX_CLIPS, type DurationPreset } from './types';
import { overlaps, presetRange } from './validation';
import type { ClipEditorial } from './types';
import { MOMENT_TYPES, editorialScore, localTopicRelevance, topicHits, type EditorialBrief, type MomentType } from './editorialBrief';

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
  | 'sobrante'
  | 'repetido'
  | 'relleno'
  | 'umbral';

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
  repetido: 'repite una idea ya elegida',
  relleno: 'relleno sin relación con el tema',
  umbral: 'no supera el filtro de calidad',
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
  /** Criterios editoriales (sólo con tema/brief). */
  editorial?: ClipEditorial;
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
export function localScore(start: number, end: number, hook: string, words: TimedWord[], preset?: number): number {
  const inside = words.filter((w) => w.start >= start - 0.05 && w.end <= end + 0.05);
  const dur = Math.max(1, end - start);
  const wps = inside.length / dur; // ~2–3 palabras/s en habla normal
  const density = Math.min(1, wps / 2.5);
  // Claridad: proporción de palabras «reales» (con letras) frente a ruido/repeticiones de la transcripción.
  const real = inside.filter((w) => /\p{L}{2,}/u.test(w.text));
  const distinct = new Set(real.map((w) => normText(w.text))).size;
  const clarity = inside.length ? Math.min(real.length / inside.length, real.length ? Math.min(1, (distinct / real.length) * 1.6) : 0) : 0;
  // Ajuste a la duración pedida (1 = exacta).
  const durationFit = preset ? Math.max(0, 1 - Math.abs(dur - preset) / preset) : 1;
  const text = inside.map((w) => w.text).join(' ');
  const emphasis = Math.min(1, (text.match(/[?!¿¡]/g) ?? []).length / 3);
  const first = inside[0]?.text.trim() ?? '';
  const last = inside[inside.length - 1]?.text.trim() ?? '';
  const cleanStart = /^[A-ZÁÉÍÓÚÑ¿¡"«]/.test(first) ? 1 : 0;
  const cleanEnd = /[.?!…"»]$/.test(last) ? 1 : 0;
  const tw = new Set(normText(text).split(' ').filter((w) => w.length > 3));
  const hw = normText(hook).split(' ').filter((w) => w.length > 3);
  const grounding = hw.length ? hw.filter((w) => tw.has(w)).length / hw.length : 0;
  const s = 0.35 * density + 0.1 * clarity + 0.1 * emphasis + 0.1 * cleanStart + 0.1 * cleanEnd + 0.15 * grounding + 0.1 * durationFit;
  return Math.round(Math.max(0, Math.min(1, s)) * 100);
}

/** Palabras por segundo dentro del tramo. */
export const MIN_WORDS_PER_SEC = 0.8;
export function speechRate(start: number, end: number, words: TimedWord[]): number {
  const n = words.filter((w) => w.start >= start - 0.05 && w.end <= end + 0.05).length;
  return n / Math.max(1, end - start);
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

export interface TopicOptions {
  /** Palabras clave del tema (título + brief). */
  keywords: string[];
  brief?: EditorialBrief;
  /** Puntuación editorial mínima (0–100). */
  minScore: number;
}

export interface EvaluateOptions {
  preset: DurationPreset;
  sourceDuration: number;
  words: TimedWord[];
  /** Clips ya aceptados (para rechazar solapes). */
  taken: { start: number; end: number }[];
  /** Criterios editoriales: relevancia al tema, umbral y alineación con la frase gancho. */
  topic?: TopicOptions;
}

export interface Sentence {
  start: number;
  end: number;
  text: string;
}

/** Frases habladas en [from, to): cortes en signos de cierre o pausas de más de 0,7 s. */
export function sentencesIn(words: TimedWord[], from: number, to: number): Sentence[] {
  const ws = words.filter((w) => w.start >= from - 0.05 && w.start < to);
  const out: Sentence[] = [];
  let cur: TimedWord[] = [];
  const flush = () => {
    if (cur.length) out.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text.trim()).join(' ') });
    cur = [];
  };
  for (const w of ws) {
    if (cur.length && w.start - cur[cur.length - 1].end > 0.7) flush();
    cur.push(w);
    if (/[.?!…]$/.test(w.text.trim())) flush();
  }
  flush();
  return out;
}

/**
 * Busca dentro del tramo la frase que de verdad trata el tema (la frase gancho) y, si el clip empieza mucho antes
 * con relleno, mueve el inicio a esa frase. Sólo añade contexto previo si también habla del tema y está pegado (≤ 6 s).
 */
export function alignToHook(start: number, end: number, words: TimedWord[], keywords: string[]): { start: number; moved: boolean; sentence?: Sentence } {
  if (!keywords.length || !words.length) return { start, moved: false };
  const ss = sentencesIn(words, start, start + (end - start) * 0.8);
  if (!ss.length) return { start, moved: false };
  const hits = ss.map((x) => topicHits(x.text, keywords));
  const best = Math.max(...hits);
  if (best < 2) return { start, moved: false };
  const bi = hits.indexOf(best);
  // El clip ya abre con el tema (o la frase está casi al principio): no se toca.
  if (hits[0] >= best || ss[bi].start - start < 4) return { start, moved: false, sentence: ss[bi] };
  let k = bi;
  while (k > 0 && hits[k - 1] >= 1 && ss[bi].start - ss[k - 1].start <= 6) k--;
  return { start: ss[k].start, moved: true, sentence: ss[bi] };
}

/** Título breve a partir de una frase real (sin repetir palabras seguidas ni signos sueltos). */
export function titleFromSentence(text: string): string {
  const ws = text.replace(/[.?!…¡¿]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ');
  const out: string[] = [];
  for (const w of ws) {
    if (out.length >= 9) break;
    out.push(w);
  }
  const t = out.join(' ').replace(/[,;:]+$/, '');
  return (t.charAt(0).toUpperCase() + t.slice(1)).slice(0, 100);
}

const num100 = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n >= 0 && n <= 100 ? n : null;
};

function momentTypeOf(v: unknown): MomentType | undefined {
  if (typeof v !== 'string') return undefined;
  const k = v.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  return (MOMENT_TYPES as string[]).includes(k) ? (k as MomentType) : undefined;
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

  const kws = o.topic?.keywords ?? [];
  const momentType = o.topic ? momentTypeOf(r.moment_type ?? r.momentType ?? r.tipo) : undefined;
  if (o.topic && momentType === 'relleno') return { ok: false, reason: 'relleno' };
  // Inicio en la frase gancho real (no en el arranque arbitrario de la ventana).
  const hookStart = o.topic ? num(r.hook_start ?? r.hookStart) : null;
  let aligned: ReturnType<typeof alignToHook> = { start, moved: false };
  if (o.topic) {
    if (hookStart !== null && hookStart > start + 3 && hookStart < end) {
      // El modelo indicó dónde empieza la frase gancho: se valida con la transcripción.
      // Frases completas alrededor (no recortadas por la ventana) y la que contiene hook_start, o la primera que empieza después.
      const around = sentencesIn(o.words, Math.max(start, hookStart - 30), hookStart + 15);
      const s2 = around.find((x) => x.start <= hookStart + 0.3 && x.end >= hookStart - 0.3) ?? around.find((x) => x.start >= hookStart - 0.3);
      if (s2 && topicHits(s2.text, kws) > 0) aligned = { start: s2.start, moved: true, sentence: s2 };
    }
    if (!aligned.moved) aligned = alignToHook(start, end, o.words, kws);
    if (aligned.moved) {
      end = aligned.start + (end - start);
      start = aligned.start;
    }
  }

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
  let finalTitle = title;
  const windowText = o.words.filter((w) => w.start >= start - 0.05 && w.end <= end + 0.05).map((w) => w.text).join(' ');
  if (o.topic && kws.length && o.words.length) {
    // Hook: si el del modelo es una frase incidental y el clip abre con el tema, se usa la frase real.
    const opening = openingPhrase(o.words, start, end);
    if ((aligned.moved || topicHits(hook, kws) === 0) && topicHits(opening, kws) > 0 && !isGenericText(opening, 12)) hook = opening;
    // Título: una frase real del tramo. Nunca una etiqueta del brief: la IA puede haber inventado ese evento.
    if (topicHits(title, kws) === 0 && topicHits(windowText, kws) >= 2) {
      finalTitle = aligned.sentence ? titleFromSentence(aligned.sentence.text) : titleFromSentence(opening);
    }
  }

  // Voz suficiente, comprobada aparte de la puntuación (los bonus de claridad/duración no pueden saltársela):
  // al menos 0,8 palabras/s de media en el tramo (≈ 24 palabras en 30 s).
  if (o.words.length > 0 && speechRate(start, end, o.words) < MIN_WORDS_PER_SEC) return { ok: false, reason: 'poca_voz' };
  const ls = localScore(start, end, hook, o.words, o.preset);
  if (o.words.length > 0 && ls < 15) return { ok: false, reason: 'poca_voz' };
  const llm = num(r.score);
  const llmScore = llm !== null && llm >= 0 && llm <= 100 ? llm : null; // scores fuera de rango no cuentan
  if (!o.topic) {
    const score = Math.round(llmScore === null ? ls : 0.6 * ls + 0.4 * llmScore);
    return { ok: true, candidate: { start, end, title, hook, reason, llmScore, localScore: ls, score } };
  }
  // Ranking editorial: relevancia al tema (IA contrastada con lo que se dice) > gancho/payoff > autonomía > técnica.
  const llmRel = num100(r.topic_relevance ?? r.topicRelevance);
  // Sin tiempos por palabra no hay texto del tramo con el que contrastar: no se penaliza (se usa la valoración de la IA).
  const localRel = o.words.length ? localTopicRelevance(windowText, kws) : null;
  const topicRelevance = Math.round(localRel === null ? (llmRel ?? 50) : llmRel === null ? localRel : 0.6 * llmRel + 0.4 * localRel);
  const hookStrength = num100(r.hook_strength ?? r.hookStrength) ?? llmScore ?? ls;
  const payoffStrength = num100(r.payoff_strength ?? r.payoffStrength) ?? llmScore ?? 50;
  const selfContained = num100(r.self_contained ?? r.selfContained) ?? 60;
  const score = editorialScore({ topicRelevance, hookStrength, payoffStrength, selfContained, local: ls });
  // El umbral no descarta: marca quién ASPIRA a destacado (lo confirma el verificador, fase B).
  const featured = score >= o.topic.minScore;
  const why = clean(r.why_selected ?? r.whySelected, 300) || reason;
  const editorial: ClipEditorial = { score, featured, topicRelevance, hookStrength, payoffStrength, selfContained, momentType, why, aligned: aligned.moved || undefined };
  return { ok: true, candidate: { start, end, title: finalTitle, hook, reason, llmScore, localScore: ls, score, editorial } };
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
  const accepted: Candidate[] = [];
  const taken = [...o.taken];
  const takenText = (o.taken as { title?: string; hook?: string }[]).filter((t) => t.title).map((t) => `${t.title} ${t.hook ?? ''}`);
  // Selección voraz por puntuación. La distancia temporal a los ya elegidos sólo DESEMPATA (misma puntuación):
  // nunca desplaza un momento fuerte por estar cerca de otro.
  const pool = [...valid];
  while (pool.length) {
    let bi = 0;
    for (let i = 1; i < pool.length; i++) {
      const a = pool[i];
      const b = pool[bi];
      if (a.score !== b.score) {
        if (a.score > b.score) bi = i;
        continue;
      }
      const da = diversityBonus(a, taken, o.sourceDuration);
      const db = diversityBonus(b, taken, o.sourceDuration);
      if (da > db || (da === db && a.start < b.start)) bi = i;
    }
    const c = pool.splice(bi, 1)[0];
    if (accepted.length >= need) {
      bump('sobrante');
      continue;
    }
    if (taken.some((t) => overlaps(t, c))) {
      bump('solape');
      continue;
    }
    const text = `${c.title} ${c.hook}`;
    if (takenText.some((t) => similarity(t, text) >= 0.6)) {
      bump('repetido');
      continue;
    }
    accepted.push(c);
    taken.push(c);
    takenText.push(text);
  }
  return { accepted, rejected };
}

/** Bonus 0–10 según la distancia al clip elegido más cercano (relativa a la duración del vídeo). */
export function diversityBonus(c: { start: number; end: number }, taken: { start: number; end: number }[], duration: number): number {
  if (taken.length === 0 || duration <= 0) return 0;
  const mid = (c.start + c.end) / 2;
  const nearest = Math.min(...taken.map((t) => Math.abs((t.start + t.end) / 2 - mid)));
  return Math.round(Math.min(1, nearest / (duration / (taken.length + 1))) * 10);
}

/** Similitud Jaccard de palabras significativas (para detectar ideas repetidas). */
export function similarity(a: string, b: string): number {
  const words = (s: string) => new Set(normText(s).split(' ').filter((w) => w.length > 3));
  const A = words(a);
  const B = words(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
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
