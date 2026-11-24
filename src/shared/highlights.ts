// Fase B: verificador de destacados. Puro (la llamada a la IA se inyecta).
// La IA propone y el CÓDIGO comprueba: un destacado necesita una cita que exista en la transcripción del clip,
// cerca de su inicio, de un evento que ya ocurre (no preparación, trayecto ni intención) y confianza ≥ 80.
// Todo lo que no lo demuestre sigue disponible como «Otro momento».
import { LONG_CLIP_SEC, type ClipEditorial, type DurationPreset, type HighlightEvent } from './types';
import { formatTime, overlaps, presetRange } from './validation';
import { LONG_CLIP_MAX_SILENCE, LONG_CLIP_MIN_STRUCTURE, MIN_WORDS_PER_SEC, longestSilence, isGenericText, localScore, speechRate, titleFromSentence, type Candidate, type TimedWord } from './selection';
import { editorialScore, normWords, topicHits, type EditorialBrief } from './editorialBrief';

export const EVIDENCE_WINDOW_SEC = 15;
export const MIN_CONFIDENCE = 80;
/** Segundos de contexto que ve el verificador antes y después del clip. */
export const CONTEXT_SEC = 20;

/** Relevancia según el EVENTO (no según las palabras que coinciden). 0 = nunca puede ser destacado. */
export const EVENT_INFO: Record<HighlightEvent, { label: string; relevance: number }> = {
  introduccion: { label: 'Introducción', relevance: 0 },
  preparacion: { label: 'Preparación', relevance: 0 },
  desplazamiento: { label: 'Desplazamiento', relevance: 0 },
  llegada: { label: 'Llegada', relevance: 0 },
  contexto: { label: 'Contexto', relevance: 0 },
  inicio_real: { label: 'Inicio real', relevance: 100 },
  accion_activa: { label: 'Acción en curso', relevance: 85 },
  choque_accion: { label: 'Choque o acción', relevance: 85 },
  resultado: { label: 'Victoria o resultado', relevance: 95 },
  reaccion: { label: 'Reacción', relevance: 70 },
  revelacion: { label: 'Revelación', relevance: 80 },
  explicacion: { label: 'Explicación', relevance: 75 },
  humor: { label: 'Humor', relevance: 70 },
};
const EVENTS = Object.keys(EVENT_INFO) as HighlightEvent[];
/** Tipos sin evento físico: además tienen que hablar del tema. */
const NEEDS_TOPIC: HighlightEvent[] = ['reaccion', 'revelacion', 'explicacion', 'humor'];

export interface HighlightContext {
  title: string;
  brief: EditorialBrief;
  keywords: string[];
  segments: TimedWord[];
  words: TimedWord[];
  duration: number;
  preset: DurationPreset;
}

export interface Verdict {
  approved: boolean;
  title: string;
  hook: string;
  event: HighlightEvent;
  quote: string;
  evidenceStart: number;
  confidence: number;
  reason: string;
}

const plain = (s: string): string => normWords(s).join(' ');
const textOf = (xs: TimedWord[]): string => xs.map((x) => x.text.trim()).join(' ');
const startingIn = (xs: TimedWord[], from: number, to: number): TimedWord[] => xs.filter((x) => x.start >= from - 0.3 && x.start <= to);

// ---- Qué se dice de verdad (frases, nunca palabras clave aisladas) ----

/** Presentación, trayecto y preparativos: hablar del evento no es el evento. */
const NON_EVENT =
  /\b(bienvenid[oa]s?|hoy (vamos|nos vamos|voy|os traigo)|nos vamos a (jugar|ir)|vamos (para|hacia|de camino|camino)|de camino|voy (para|hacia)|para jugar|estamos a \w+ (millas|kilometros|metros)|mientras iba|para ir practicando|explorar carreras|pagar la entrada|entrada para|antes de empezar|vamos a (jugar|preparar|elegir)|welcome|on (my|our) way)\b/;
export const isPreparation = (text: string): boolean => NON_EVENT.test(plain(text));

/** Delante de la frase la convierte en futuro, condición o negación («cuando empiece», «no he ganado», «iba a…»). */
const NOT_YET = /\b(cuando|antes de que|antes de|va a|van a|vamos a ver si|voy a|iba a|a punto de|hasta que|para que|todavia no|aun no|no|(?<!ahora )si|hoy|luego|despues|manana)( \w+)? $/;

function happens(text: string, cue: RegExp): boolean {
  const t = plain(text);
  for (const m of t.matchAll(cue)) if (!NOT_YET.test(t.slice(0, m.index))) return true;
  return false;
}

/** Inicios que valen por sí solos. */
const START_EXPLICIT = /\b(salimos(?! (de|del|a|al|para|hacia|por)\b)|vamos a correr|arrancamos|tres dos uno|3 2 1|mi primer\w* \w+( \w+){0,3} ahora si|ahora si( \w+){0,2} mi primer\w*|here we go|lets race)\b/g;
/** Inicios que sólo valen si la frase nombra el tema («empezó la carrera», no «empezó a llover»). */
const START_WITH_TOPIC = /\b(empieza(?! a)|empezo(?! a)|empezamos|empezando ya|ha empezado(?! a)|comienza(?! a)|comenzo(?! a)|ha comenzado(?! a)|arranca la (carrera|partida)|arranca el (reto|partido|combate)|it begins|starts now|has started)\b/g;
/** Ganar y perder se distinguen: un título de victoria no se verifica con una derrota. */
const WIN = /\b(he ganado|hemos ganado|ha ganado|gane|ganamos|lo consegui|lo he conseguido|lo hemos conseguido|lo logre|victoria|i won|we won)\b/g;
const LOSS = /\b(he perdido|hemos perdido|ha perdido|perdi|perdimos|derrota|he quedado ultimo|hemos quedado ultimos|i lost|we lost)\b/g;
const RESULT = new RegExp(`${WIN.source}|${LOSS.source}|\\b(he quedado|hemos quedado)\\b`, 'g');
const IMPACT = /\b(choque|choco|choca|chocado|chocamos|me estrello|me estrelle|estrellado|me caigo|me he caido|me la pego|accidente|golpazo|la que le metio|crash|crashed)\b/g;

const startsTopic = (text: string, keywords: string[]): boolean => topicHits(text, keywords) > 0 && happens(text, START_WITH_TOPIC);
export const saysStart = (text: string, keywords: string[]): boolean => happens(text, START_EXPLICIT) || startsTopic(text, keywords);

/** Títulos que describen el clip o la verificación en vez del evento. */
const META_TITLE = /\b(candidato|candidata|clip|fragmento|tramo|transcripcion|verificador|evidencia|el video muestra|este video|segmento)\b/;

type Claim = 'inicio' | 'victoria' | 'derrota' | 'resultado' | 'choque';
const CLAIM_LABEL: Record<Claim, string> = { inicio: 'un inicio', victoria: 'una victoria', derrota: 'una derrota', resultado: 'un resultado', choque: 'un choque' };

/** Qué eventos afirma un título. */
export function titleClaims(title: string): Claim[] {
  const t = plain(title);
  const out: Claim[] = [];
  if (/\b(inicio|comienzo|comienza|comenzo|empieza|empezo|empezamos|arranque|arranca|arrancamos|salida|salimos|start|starts|begins)\b/.test(t)) out.push('inicio');
  const win = /\b(victoria|gana|gane|gano|ganar|ganado|ganamos|triunfo|podio|wins|win|won)\b/.test(t);
  const loss = /\b(derrota|pierdo|pierde|pierden|perdemos|perdio|perdido|perder|perdi|ultimo|loses|lost)\b/.test(t);
  if (win) out.push('victoria');
  if (loss) out.push('derrota');
  if (!win && !loss && /\b(resultado|clasificacion)\b/.test(t)) out.push('resultado');
  if (/\b(choque|choca|choco|chocamos|accidente|estrella contra|se estrella|crash|crashes)\b/.test(t)) out.push('choque');
  return out;
}

function saysClaim(text: string, claim: Claim, keywords: string[]): boolean {
  if (claim === 'inicio') return saysStart(text, keywords);
  // Una victoria no se demuestra con «he perdido» (ni con «no he ganado», que ya filtra `happens`).
  if (claim === 'victoria') return happens(text, WIN) && !happens(text, LOSS);
  if (claim === 'derrota') return happens(text, LOSS) && !happens(text, WIN);
  return happens(text, claim === 'resultado' ? RESULT : IMPACT);
}

/**
 * Momento en que empieza de verdad el evento que promete el título, si se dice. Antes de él todo es preparación.
 * Sólo se aplica con títulos que prometen un evento y si la frase aparece en la primera mitad del vídeo
 * (más tarde podría ser una segunda carrera o partida).
 */
export function promisedEventStart(c: HighlightContext): number | null {
  if (!/\b(primer\w*|carreras?|partidas?|retos?|combates?|partidos?|torneos?|race|races|first)\b/.test(plain(c.title))) return null;
  const seg = c.segments.find((s) => startsTopic(s.text, c.keywords));
  return seg && seg.start <= c.duration / 2 ? seg.start : null;
}

// ---- Candidatos que aspiran a destacado ----

/** Tramo del preset que empieza en `at` y cierra en frase completa. null si no cabe o casi no tiene voz. */
export function windowAt(at: number, c: HighlightContext): { start: number; end: number } | null {
  const { min, max } = presetRange(c.preset);
  const round = (x: number) => Math.round(x * 100) / 100;
  let start = Math.max(0, at);
  if (c.duration - start < min) start = Math.max(0, c.duration - min);
  if (at - start > EVIDENCE_WINDOW_SEC - 1) return null;
  start = round(start);
  let end = Math.min(c.duration, start + c.preset);
  for (const s of c.segments) if (s.end - start >= min && s.end - start <= max && s.end <= c.duration) end = s.end;
  end = round(end);
  if (end - start < min - 0.01) return null;
  if (c.words.length && speechRate(start, end, c.words) < MIN_WORDS_PER_SEC) return null;
  // Clips largos: ni un silencio largo dentro (igual que en la selección).
  if (c.preset >= LONG_CLIP_SEC && longestSilence(start, end, c.words.length ? c.words : c.segments) > LONG_CLIP_MAX_SILENCE) return null;
  return { start, end };
}

/** Momentos con una frase explícita de inicio o de resultado: la IA de selección puede no haberlos propuesto. */
export function evidenceMoments(c: HighlightContext): Candidate[] {
  const eventAt = promisedEventStart(c);
  const said = c.segments.filter((s) => !isPreparation(s.text) && (eventAt === null || s.start >= eventAt));
  const spread = (xs: TimedWord[]): TimedWord[] => xs.filter((s, i) => i === 0 || s.start - xs[i - 1].start >= c.preset);
  const starts = spread(said.filter((s) => startsTopic(s.text, c.keywords) || happens(s.text, START_EXPLICIT))).slice(0, 2);
  const results = spread(said.filter((s) => happens(s.text, RESULT) && topicHits(s.text, c.keywords) > 0)).slice(-2);
  return [...starts, ...results].flatMap((s) => {
    const w = windowAt(s.start, c);
    if (!w) return [];
    const local = localScore(w.start, w.end, s.text, c.words.length ? c.words : c.segments, c.preset);
    const parts = { topicRelevance: 60, hookStrength: local, payoffStrength: 50, selfContained: 60 };
    const score = editorialScore({ ...parts, local });
    const why = 'La transcripción dice explícitamente que el evento ocurre aquí.';
    return [{ ...w, title: titleFromSentence(s.text), hook: s.text.trim().slice(0, 200), reason: why, llmScore: null, localScore: local, score, editorial: { ...parts, score, featured: false, why } }];
  });
}

// ---- Llamada al verificador ----

export const VERIFIER_SYSTEM_PROMPT = `Eres el verificador final de los clips que se publicarán tal cual en TikTok, Shorts o Reels.
Recibes UN candidato con la transcripción de antes, durante y después. Tu trabajo es desconfiar: aprueba sólo si el evento ocurre de verdad dentro del candidato.
Primero clasifica lo que pasa al principio del candidato (event_type):
- introduccion: saludo, presentación o decir lo que se va a hacer.
- preparacion: elegir vehículo, pagar, practicar, planear.
- desplazamiento: ir hacia el sitio. «Vamos para el circuito para jugar mi primera carrera» es desplazamiento, NO un inicio.
- llegada: llegar al sitio, sin que empiece todavía.
- contexto: conversación o explicación incidental.
- inicio_real: se dice que empieza AHORA («empieza la carrera», «salimos», «mi primera carrera ahora sí»).
- accion_activa: el evento ya está en curso.
- choque_accion: un choque o una acción concreta dentro del evento.
- resultado: ya se ha ganado, perdido o conseguido. «Tengo que ganar» NO es un resultado.
- reaccion, revelacion, explicacion, humor: sólo si cumplen la promesa del título y se entienden solos.
Reglas:
- approved=false si es introduccion, preparacion, desplazamiento, llegada o contexto, o si dudas.
- evidence_quote: copia literal, palabra por palabra, de una frase de DURANTE que demuestre el evento. Nunca de ANTES ni de DESPUÉS.
- evidence_start: el segundo que aparece junto a esa frase.
- corrected_title: describe sólo lo que ocurre en esa frase y en ese momento. No anuncies un evento que aún no ocurre.
- corrected_hook: frase literal de los primeros 15 segundos del candidato.
- confidence: entero de 0 a 100. reason: motivo breve y concreto.
- El brief y el título propuesto pueden estar equivocados: cree sólo a la transcripción.
Responde SÓLO con JSON y escribe los textos en el idioma del vídeo.`;

export function verifierSchema(): object {
  return {
    type: 'object',
    properties: {
      event_type: { type: 'string', enum: EVENTS },
      evidence_quote: { type: 'string' },
      evidence_start: { type: 'number' },
      approved: { type: 'boolean' },
      corrected_title: { type: 'string' },
      corrected_hook: { type: 'string' },
      confidence: { type: 'integer', minimum: 0, maximum: 100 },
      reason: { type: 'string' },
    },
    required: ['event_type', 'evidence_quote', 'evidence_start', 'approved', 'corrected_title', 'corrected_hook', 'confidence', 'reason'],
  };
}

export function verifierUserPrompt(clip: Candidate, c: HighlightContext): string {
  // Sólo las palabras que caen en cada tramo: lo que se dice después del final no está en el clip.
  const part = (from: number, to: number): string =>
    spoken(c, from, to)
      .map((p) => `[${p.start.toFixed(1)}] ${p.text}`)
      .join('\n') || '(sin voz)';
  return `TÍTULO ORIGINAL: ${c.title}
PROMESA DEL TÍTULO: ${c.brief.titlePromise || c.title}

CANDIDATO: de ${clip.start.toFixed(2)} s a ${clip.end.toFixed(2)} s
TÍTULO PROPUESTO: ${clip.title}
HOOK PROPUESTO: ${clip.hook}
RAZÓN PROPUESTA: ${clip.editorial?.why || clip.reason}

ANTES (contexto, no sirve como evidencia):
${part(clip.start - CONTEXT_SEC, clip.start)}

DURANTE (única fuente de evidencia):
${part(clip.start, clip.end)}

DESPUÉS (contexto, no sirve como evidencia):
${part(clip.end, clip.end + CONTEXT_SEC)}`;
}

/** Valida el JSON del verificador campo a campo. null = inutilizable (no se aprueba). Nunca lanza. */
export function parseVerdict(raw: string): Verdict | null {
  let d: unknown;
  try {
    d = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const r = d as Record<string, unknown>;
  if (typeof r.approved !== 'boolean' || !EVENTS.includes(r.event_type as HighlightEvent)) return null;
  const { confidence, evidence_start: at } = r;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 100) return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  const texts = [r.corrected_title, r.corrected_hook, r.evidence_quote, r.reason];
  if (!texts.every((x): x is string => typeof x === 'string')) return null;
  const [title, hook, quote, reason] = texts.map((x) => x.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300));
  return { approved: r.approved, title: title.slice(0, 100), hook: hook.slice(0, 200), event: r.event_type as HighlightEvent, quote, evidenceStart: at, confidence: Math.round(confidence), reason };
}

// ---- Reglas de evidencia ----

/** Palabras con tiempo; sin ellas, las de cada segmento repartidas dentro de él. */
function timedWords(c: HighlightContext): TimedWord[] {
  if (c.words.length) return c.words;
  return c.segments.flatMap((s) => {
    const ws = s.text.trim().split(/\s+/).filter(Boolean);
    const step = (s.end - s.start) / Math.max(1, ws.length);
    return ws.map((text, i) => ({ start: s.start + i * step, end: s.start + (i + 1) * step, text }));
  });
}

/** Busca la cita literal (sin tildes ni signos) dentro del clip; si se repite, la más cercana al tiempo indicado. */
export function locateQuote(quote: string, clip: { start: number; end: number }, c: HighlightContext, near = clip.start): TimedWord | null {
  const wanted = normWords(quote);
  if (!wanted.length) return null;
  const said = timedWords(c)
    .filter((w) => w.start >= clip.start - 0.05 && w.end <= clip.end + 0.05)
    .flatMap((w) => normWords(w.text).map((token) => ({ token, w })));
  let found: TimedWord | null = null;
  for (let i = 0; i + wanted.length <= said.length; i++) {
    if (!wanted.every((t, k) => said[i + k].token === t)) continue;
    const span = said.slice(i, i + wanted.length).map((x) => x.w);
    const original = [...new Set(span)];
    const hit = { start: span[0].start, end: span[span.length - 1].end, text: textOf(original) };
    if (!found || Math.abs(hit.start - near) < Math.abs(found.start - near)) found = hit;
  }
  return found;
}

interface Spoken {
  start: number;
  end: number;
  /** Sólo lo que se dice dentro del tramo. */
  text: string;
  /** La frase entera, para no perder un «no» o un «cuando» que quedó fuera. */
  full: string;
}

/** Lo que se oye en [from, to], frase a frase, recortado a las palabras que caen dentro. */
function spoken(c: HighlightContext, from: number, to: number): Spoken[] {
  const ws = timedWords(c);
  return c.segments.flatMap((s) => {
    const inSeg = ws.filter((w) => w.start >= s.start - 0.05 && w.start < s.end + 0.05);
    const inside = inSeg.filter((w) => w.start >= from - 0.05 && w.end <= to + 0.05);
    return inside.length ? [{ start: inside[0].start, end: inside[inside.length - 1].end, text: textOf(inside), full: s.text.trim() }] : [];
  });
}

/** El evento se dice dentro del tramo y su frase completa no lo niega ni lo pone en futuro. */
function heardClaim(p: Spoken, claim: Claim, keywords: string[]): boolean {
  return saysClaim(p.text, claim, keywords) && saysClaim(p.full, claim, keywords);
}

/** Frase completa (segmentos de la transcripción) que contiene la cita. */
function sentenceAround(evidence: TimedWord, c: HighlightContext): string {
  const around = c.segments.filter((s) => s.end > evidence.start - 0.05 && s.start < evidence.end + 0.05);
  return around.length ? textOf(around) : evidence.text;
}

export type Decision =
  | { kind: 'verified'; title: string; hook: string; evidence: TimedWord; support: { start: number; end: number } }
  | { kind: 'move'; to: number }
  | { kind: 'rejected'; reason: string };

/** Aplica las reglas a la respuesta del verificador. El modelo no puede saltárselas. */
export function decide(v: Verdict, clip: Candidate, c: HighlightContext, eventAt: number | null = promisedEventStart(c)): Decision {
  const no = (reason: string): Decision => ({ kind: 'rejected', reason });
  const info = EVENT_INFO[v.event];
  if (info.relevance === 0) return no(`Es ${info.label.toLowerCase()}, no el evento.`);
  if (!v.approved) return no('El verificador no lo aprobó.');
  if (v.confidence < MIN_CONFIDENCE) return no(`Confianza insuficiente (${v.confidence} %).`);
  if (!v.quote) return no('Sin cita de evidencia.');
  if (!v.reason) return no('Sin motivo.');
  const evidence = locateQuote(v.quote, clip, c, v.evidenceStart);
  if (!evidence) return no('La cita no existe en la transcripción del clip.');
  // La cita se juzga dentro de su frase completa: un recorte no puede quitar un «no», un «cuando» o un trayecto.
  const said = { ...evidence, text: sentenceAround(evidence, c) };
  const nWords = normWords(evidence.text).length;
  if (nWords < 3 && !saysStart(evidence.text, c.keywords) && !happens(evidence.text, RESULT)) return no('La cita es demasiado corta para demostrar un evento.');
  if (isPreparation(said.text)) return no('La cita habla de presentación, trayecto o preparativos.');
  if (eventAt !== null && evidence.start < eventAt - EVIDENCE_WINDOW_SEC) return no(`Ocurre antes de que empiece el evento del título (${formatTime(eventAt)}).`);

  // La evidencia tardía mueve el inicio a su frase; el tramo nuevo se vuelve a verificar.
  if (evidence.start - clip.start > EVIDENCE_WINDOW_SEC) {
    const seg = c.segments.filter((s) => s.start <= evidence.start + 0.3).pop();
    return { kind: 'move', to: seg && evidence.start - seg.start <= EVIDENCE_WINDOW_SEC ? seg.start : evidence.start };
  }

  const inside = startingIn(c.segments, clip.start, clip.end);
  const windowText = textOf(inside);
  let title = v.title;
  // Un título que no comparte nada con lo que se dice, o que habla del propio clip («El candidato empieza…»),
  // no es fiable: se usa la frase real.
  if (isGenericText(title, 6) || META_TITLE.test(plain(title)) || topicHits(windowText, normWords(title).filter((w) => w.length > 3)) === 0) title = titleFromSentence(evidence.text);
  if (isGenericText(title, 6)) return no('Sin un título fiable.');

  const needed = new Set<Claim>(titleClaims(title));
  if (v.event === 'inicio_real') needed.add('inicio');
  if (v.event === 'resultado') needed.add('resultado');
  // Todo lo que respalda el título queda anotado: si al editar se recorta, se pierde la estrella.
  const support = { start: evidence.start, end: evidence.end };
  for (const claim of needed) {
    const early = spoken(c, clip.start, Math.min(clip.end, clip.start + EVIDENCE_WINDOW_SEC));
    if (heardClaim({ start: evidence.start, end: evidence.end, text: evidence.text, full: said.text }, claim, c.keywords)) continue;
    const backer = early.find((p) => heardClaim(p, claim, c.keywords));
    if (backer) {
      support.start = Math.min(support.start, backer.start);
      support.end = Math.max(support.end, backer.end);
      continue;
    }
    const later = spoken(c, clip.start, clip.end).find((p) => heardClaim(p, claim, c.keywords));
    if (later) return { kind: 'move', to: later.start };
    return no(`Afirma ${CLAIM_LABEL[claim]} que no se oye en el clip.`);
  }
  if (NEEDS_TOPIC.includes(v.event) && topicHits(windowText, c.keywords) === 0) return no('No tiene relación con la promesa del título.');

  // El hook tiene que oírse al principio; si no, se usa la propia evidencia.
  const heard = locateQuote(v.hook, clip, c);
  const hook = heard && heard.start - clip.start <= EVIDENCE_WINDOW_SEC && normWords(v.hook).length >= 3 ? heard.text : evidence.text;
  return { kind: 'verified', title, hook: hook.slice(0, 200), evidence, support };
}

/** «Otro momento»: sin estrella, sin relevancia inflada y sin un título que anuncie lo que no se oye. */
export function asOtherMoment(clip: Candidate, c: HighlightContext, rejectedBecause?: string): Candidate {
  if (!clip.editorial) return clip;
  const inside = startingIn(c.segments, clip.start, clip.end);
  const unsupported = titleClaims(clip.title).some((claim) => {
    const where = spoken(c, clip.start, claim === 'inicio' ? Math.min(clip.end, clip.start + EVIDENCE_WINDOW_SEC) : clip.end);
    return !where.some((p) => heardClaim(p, claim, c.keywords));
  });
  let title = clip.title;
  if (unsupported) {
    const neutral = inside.find((s) => normWords(s.text).length >= 3 && !isGenericText(titleFromSentence(s.text), 6) && titleClaims(s.text).length === 0);
    title = neutral ? titleFromSentence(neutral.text) : `Momento en ${formatTime(clip.start)}`;
  }
  const editorial: ClipEditorial = { ...clip.editorial, featured: false, verification: undefined, topicRelevance: Math.min(60, clip.editorial.topicRelevance) };
  if (rejectedBecause) editorial.notVerified = rejectedBecause;
  return { ...clip, title, editorial };
}

export interface HighlightRun {
  /** Destacados verificados, sin solapes entre sí. */
  verified: Candidate[];
  /** Clips de la selección que no pasan (siguen como «Otro momento»). */
  others: Candidate[];
  checked: number;
  rejected: { start: number; title: string; reason: string }[];
}

/** Verifica los aspirantes de la selección y los momentos con evidencia explícita. Un fallo de la IA nunca aprueba. */
export async function verifyHighlights(o: {
  selected: Candidate[];
  moments: Candidate[];
  context: HighlightContext;
  max: number;
  model: string;
  ask: (system: string, user: string, schema: object) => Promise<string>;
  onProgress?: (n: number, of: number) => void;
  checkCancelled?: () => void;
}): Promise<HighlightRun> {
  const c = o.context;
  const eventAt = promisedEventStart(c);
  const aspirants = o.selected
    .filter((x) => x.editorial?.featured)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  const extra = o.moments.filter((m) => !aspirants.some((a) => Math.abs(a.start - m.start) < 5));
  const rejected: HighlightRun['rejected'] = [];
  // Un clip largo sólo puede ser destacado con gancho y desenlace claros, venga de la selección o de la evidencia.
  const longOk = (x: Candidate) => c.preset < LONG_CLIP_SEC || ((x.editorial?.hookStrength ?? 0) >= LONG_CLIP_MIN_STRUCTURE && (x.editorial?.payoffStrength ?? 0) >= LONG_CLIP_MIN_STRUCTURE);
  for (const x of [...extra, ...aspirants].filter((x) => !longOk(x))) rejected.push({ start: x.start, title: x.title, reason: 'Clip largo sin gancho y desenlace claros.' });
  const queue = [...extra, ...aspirants].filter(longOk);
  const why = new Map<Candidate, string>();
  const passed: { from: Candidate; clip: Candidate; priority: number }[] = [];

  for (const [i, from] of queue.entries()) {
    o.onProgress?.(i + 1, queue.length);
    let clip = from;
    let reason = 'El verificador no respondió.';
    // Como mucho un cambio de inicio, que se vuelve a verificar con el tramo exacto.
    for (let attempt = 0; attempt < 2; attempt++) {
      o.checkCancelled?.();
      let raw: string;
      try {
        raw = await o.ask(VERIFIER_SYSTEM_PROMPT, verifierUserPrompt(clip, c), verifierSchema());
      } catch (e) {
        if (e instanceof Error && e.name === 'CancelledError') throw e;
        reason = `El verificador falló: ${e instanceof Error ? e.message : String(e)}`;
        break;
      }
      const v = parseVerdict(raw);
      if (!v) {
        reason = 'El verificador devolvió una respuesta no válida.';
        break;
      }
      const d = decide(v, clip, c, eventAt);
      if (d.kind === 'rejected') {
        reason = d.reason;
        break;
      }
      if (d.kind === 'move') {
        reason = 'La evidencia no está cerca del inicio.';
        const w = attempt === 0 ? windowAt(d.to, c) : null;
        if (!w) break;
        clip = { ...clip, ...w };
        continue;
      }
      const base = from.editorial!;
      const topicRelevance = Math.round((EVENT_INFO[v.event].relevance * v.confidence) / 100);
      const score = editorialScore({ topicRelevance, hookStrength: base.hookStrength, payoffStrength: base.payoffStrength, selfContained: base.selfContained, local: clip.localScore });
      const editorial: ClipEditorial = {
        ...base,
        featured: true,
        auto: undefined,
        notVerified: undefined,
        score,
        topicRelevance,
        why: v.reason,
        verification: { model: o.model, confidence: v.confidence, eventType: v.event, quote: d.evidence.text, evidenceStart: d.evidence.start, evidenceEnd: d.evidence.end, supportStart: d.support.start, supportEnd: d.support.end },
      };
      passed.push({ from, clip: { ...clip, title: d.title, hook: d.hook, reason: v.reason, score, editorial }, priority: topicRelevance });
      reason = '';
      break;
    }
    if (reason) {
      why.set(from, reason);
      rejected.push({ start: from.start, title: from.title, reason });
    }
  }

  const verified: typeof passed = [];
  for (const p of passed.sort((a, b) => b.priority - a.priority || a.clip.start - b.clip.start)) {
    // La misma regla de solape que comprueba el render (sin margen).
    const clash = verified.some((v) => overlaps(v.clip, p.clip));
    if (verified.length < o.max && !clash) verified.push(p);
    else {
      const reason = clash ? 'Coincide con otro destacado verificado.' : 'Supera el máximo de clips.';
      why.set(p.from, reason);
      rejected.push({ start: p.from.start, title: p.from.title, reason });
    }
  }
  const used = new Set(verified.map((v) => v.from));
  const others = o.selected.filter((x) => !used.has(x)).map((x) => asOtherMoment(x, c, why.get(x)));
  return { verified: verified.map((v) => v.clip), others, checked: queue.length, rejected };
}

/** Destacado de verdad. Los de versiones anteriores (sin verificar) no lo son. */
export function isVerifiedHighlight(e: ClipEditorial | undefined): boolean {
  const v = e?.verification;
  return !!e?.featured && !!e.why && !!v?.quote && v.confidence >= MIN_CONFIDENCE && EVENT_INFO[v.eventType]?.relevance > 0;
}

/** Tras editar: si la evidencia sale del principio del clip o el título anuncia otro evento, pierde la estrella. */
export function editorialAfterEdit(e: ClipEditorial | undefined, before: { title: string }, after: { title: string; start: number; end: number }): ClipEditorial | undefined {
  const v = e?.verification;
  if (!e || !v) return e;
  const from = Math.min(v.evidenceStart, v.supportStart ?? v.evidenceStart);
  const to = Math.max(v.evidenceEnd, v.supportEnd ?? v.evidenceEnd);
  const moved = from < after.start - 0.05 || v.evidenceStart - after.start > EVIDENCE_WINDOW_SEC || to > after.end + 0.05;
  // La verificación sólo vale para el título verificado: cualquier cambio de palabras la anula (mayúsculas o signos no).
  const retitled = plain(after.title) !== plain(before.title);
  if (!moved && !retitled) return e;
  return { ...e, featured: false, verification: undefined, notVerified: moved ? 'Al editar el tramo, la evidencia ya no está al principio del clip.' : 'Se cambió el título verificado: vuelve a verificarlo para destacarlo.' };
}
