// Subtítulos: cues cortos construidos a partir de los timestamps de CADA palabra. Puro (sin Node).
// Reglas: 2–5 palabras, nunca una palabra en un cue que empieza después de ella ni antes de que se diga,
// cortes en silencios, puntuación fuerte y límite de lectura. Tiempos relativos al inicio del clip.

export interface TimedWord {
  start: number;
  end: number;
  text: string;
}

export interface Cue {
  start: number;
  end: number;
  text: string;
}

export interface CueOptions {
  maxWords: number;
  minWords: number;
  maxChars: number;
  /** Duración máxima de un cue (s). */
  maxDuration: number;
  /** Silencio entre palabras que obliga a cortar (s). */
  gapSplit: number;
  /** Duración mínima visible de un cue (s), sin solapar con el siguiente. */
  minDuration: number;
}

export const CUE_DEFAULTS: CueOptions = { maxWords: 5, minWords: 2, maxChars: 28, maxDuration: 2.6, gapSplit: 0.55, minDuration: 0.35 };

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const endsSentence = (s: string) => /[.!?…]["»”']?$/.test(s);
const endsClause = (s: string) => /[,;:]["»”']?$/.test(s);

/**
 * Palabras saneadas: sin vacías, con tiempos finitos, ordenadas y sin solapes (cada palabra termina, como mucho,
 * cuando empieza la siguiente). Whisper a veces devuelve palabras con end < start o solapadas.
 */
export function normalizeWords(words: TimedWord[]): TimedWord[] {
  const ws = words
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && clean(w.text))
    .map((w) => ({ start: Math.max(0, w.start), end: Math.max(w.start, w.end), text: clean(w.text) }))
    .sort((a, b) => a.start - b.start);
  for (let i = 0; i < ws.length - 1; i++) if (ws[i].end > ws[i + 1].start) ws[i].end = Math.max(ws[i].start, ws[i + 1].start);
  return ws;
}

/** Palabras del tramo del clip. Una palabra que empezó antes del clip no se arrastra (se oiría cortada). */
export function wordsInClip(words: TimedWord[], clipStart: number, clipEnd: number): TimedWord[] {
  return normalizeWords(words).filter((w) => w.start >= clipStart - 0.05 && w.start < clipEnd);
}

export function buildCues(words: TimedWord[], clipStart: number, clipEnd: number, o: CueOptions = CUE_DEFAULTS): Cue[] {
  const ws = wordsInClip(words, clipStart, clipEnd);
  const groups: TimedWord[][] = [];
  let cur: TimedWord[] = [];
  const chars = (g: TimedWord[]) => g.map((w) => w.text).join(' ').length;
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const gap = w.start - prev.end;
      const tooLong = cur.length >= o.maxWords || chars([...cur, w]) > o.maxChars || w.end - cur[0].start > o.maxDuration;
      const pause = gap >= o.gapSplit;
      // Puntuación fuerte siempre corta; una coma sólo si el cue ya tiene el mínimo de palabras.
      const punct = endsSentence(prev.text) || (endsClause(prev.text) && cur.length >= o.minWords);
      if (tooLong || pause || punct) {
        groups.push(cur);
        cur = [];
      }
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);

  const cues: Cue[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const st = Math.max(0, g[0].start - clipStart);
    const nextStart = i + 1 < groups.length ? groups[i + 1][0].start - clipStart : clipEnd - clipStart;
    let en = Math.min(g[g.length - 1].end - clipStart, clipEnd - clipStart);
    // Duración mínima legible, sin invadir el cue siguiente (así ninguna frase aparece antes de decirse).
    if (en - st < o.minDuration) en = Math.min(st + o.minDuration, nextStart);
    if (en <= st) continue;
    cues.push({ start: round(st), end: round(en), text: g.map((w) => w.text).join(' ') });
  }
  return cues;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Valida cues editados: ordenados, sin solapes, dentro del clip y con texto. Devuelve los cues corregidos. */
export function sanitizeCues(cues: Cue[], clipDuration: number): Cue[] {
  const out: Cue[] = [];
  for (const c of [...cues].sort((a, b) => a.start - b.start)) {
    const text = clean(c.text).slice(0, 120);
    if (!text || !Number.isFinite(c.start) || !Number.isFinite(c.end)) continue;
    const start = Math.max(0, Math.min(c.start, clipDuration), out.length ? out[out.length - 1].end : 0);
    const end = Math.min(clipDuration, Math.max(c.end, start + 0.1));
    if (end <= start) continue;
    out.push({ start: round(start), end: round(end), text });
  }
  return out;
}

/** Divide un cue por la palabra `at` (repartiendo el tiempo según el número de caracteres). */
export function splitCue(cues: Cue[], index: number, at: number): Cue[] {
  const c = cues[index];
  if (!c) return cues;
  const words = c.text.split(' ');
  if (at <= 0 || at >= words.length) return cues;
  const a = words.slice(0, at).join(' ');
  const b = words.slice(at).join(' ');
  const mid = round(c.start + (c.end - c.start) * (a.length / (a.length + b.length)));
  return [...cues.slice(0, index), { start: c.start, end: mid, text: a }, { start: mid, end: c.end, text: b }, ...cues.slice(index + 1)];
}

/** Une el cue `index` con el siguiente. */
export function mergeCues(cues: Cue[], index: number): Cue[] {
  const a = cues[index];
  const b = cues[index + 1];
  if (!a || !b) return cues;
  return [...cues.slice(0, index), { start: a.start, end: b.end, text: `${a.text} ${b.text}` }, ...cues.slice(index + 2)];
}

/**
 * Normalización prudente (sin LLM): sólo espacios, espacio antes de puntuación y mayúscula inicial tras punto.
 * Nunca cambia, añade ni quita palabras.
 */
export function normalizeText(s: string): string {
  let t = clean(s).replace(/\s+([,.;:!?…])/g, '$1');
  t = t.replace(/(^|[.!?…]\s+)(\p{Ll})/gu, (_m, p: string, c: string) => p + c.toUpperCase());
  return t;
}
