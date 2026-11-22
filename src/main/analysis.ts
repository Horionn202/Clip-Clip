// Selección de clips con Ollama, centrada en la calidad: primero un brief editorial del vídeo (tema, eventos,
// promesa del título) y después rondas que buscan HASTA N momentos que cumplan esa promesa. `maxClips` es un
// máximo: si sólo hay 4 momentos buenos, se devuelven 4 (nunca relleno para llegar a la cifra).
import type { AnalysisReport, AnalysisRound, DurationPreset, RankingEntry } from '../shared/types';
import { MAX_CLIPS } from '../shared/types';
import { UserFacingError, parseModelResponse } from '../shared/validation';
import { REJECT_LABELS, effectiveTarget, feasibleMax, freeGaps, selectRound, type Candidate, type TimedWord, type TopicOptions } from '../shared/selection';
import {
  BRIEF_SYSTEM_PROMPT,
  DEFAULT_MIN_CLIP_SCORE,
  DEFAULT_SELECTION_QUALITY,
  QUALITY_PROFILES,
  briefForPrompt,
  briefSchema,
  briefUserPrompt,
  fallbackBrief,
  parseBrief,
  topicKeywords,
  type EditorialBrief,
  type SelectionQuality,
} from '../shared/editorialBrief';

/**
 * Llamada al LLM (inyectable para pruebas). `maxItems` = clips pedidos (salida estructurada);
 * `schema` = esquema propio (p. ej. el del brief), con prioridad.
 */
export type ChatFn = (system: string, user: string, maxItems: number, schema?: object) => Promise<string>;

/** Errores que deben abortar todo el análisis (no sólo la ronda). */
function isFatal(e: unknown): boolean {
  return e instanceof Error && (e.name === 'CancelledError' || /no está descargado/.test(e.message));
}

export interface AnalyzeInput {
  segments: TimedWord[];
  words: TimedWord[];
  duration: number;
  preset: DurationPreset;
  /** Máximo de clips (1–20). No es una cantidad obligatoria. */
  userTarget: number;
  chat: ChatFn;
  /** Título del vídeo: activa el brief editorial y el ranking por relevancia al tema. */
  title?: string;
  description?: string;
  quality?: SelectionQuality;
  /** Puntuación editorial mínima (0–100). Por defecto 70. */
  minScore?: number;
  /** Rondas de búsqueda extra (por defecto, las del perfil de calidad). */
  maxFillRounds?: number;
  onProgress?: (p: number, message: string) => void;
  checkCancelled?: () => void;
  log?: (msg: string, extra?: unknown) => void;
}

export interface AnalyzeResult {
  clips: Candidate[];
  report: AnalysisReport;
}

export const SYSTEM_PROMPT = `Eres un editor experto en vídeos cortos (TikTok, Reels, Shorts).
Recibes el tema del vídeo y una transcripción con marcas de tiempo en segundos. Buscas los MEJORES momentos, no una cuota.
Responde SÓLO con JSON válido, sin texto adicional, con esta forma:
{"clips":[{"start":<s>,"end":<s>,"hook_start":<s>,"title":"...","hook":"...","reason":"...","score":<0-100>,"topic_relevance":<0-100>,"hook_strength":<0-100>,"payoff_strength":<0-100>,"self_contained":<0-100>,"moment_type":"revelacion|accion|reaccion|humor|logro|conflicto|explicacion|relleno","why_selected":"..."}]}
Reglas obligatorias:
- Devuelve COMO MÁXIMO el número de clips que se te pida. Si sólo hay 2 momentos buenos, devuelve 2. Nunca rellenes.
- Busca EVENTOS concretos relacionados con el tema y la promesa del título: lo que el espectador vino a ver.
- Descarta relleno: conversación incidental, contexto sin desenlace, esperas, menús, saludos.
- start debe ser el inicio de la frase gancho del evento (hook_start = segundo en que empieza esa frase). Añade contexto previo sólo si sin él no se entiende.
- Los clips no se solapan entre sí ni con los intervalos ya elegidos que se indiquen; duración igual a la indicada; empieza y termina en frases completas.
- Cada clip trata un evento distinto.
- title: describe el evento real (no copies una frase suelta sin relación con el tema).
- hook: la frase concreta de apertura que engancha, tal como se dice.
- topic_relevance: cuánto cumple el tema/promesa del título (0 = nada que ver).
- hook_strength, payoff_strength (hay desenlace/acción/recompensa), self_contained (se entiende solo).
- why_selected y reason: por qué funciona, mencionando el contenido.
- Nunca uses textos de relleno como «título», «hook», «por qué funciona» o «momento interesante».
- Escribe title, hook, reason y why_selected en el idioma del vídeo.`;

function lines(segments: TimedWord[]): string {
  return segments.map((g) => `[${g.start.toFixed(1)}-${g.end.toFixed(1)}] ${g.text.replace(/\s+/g, ' ').trim()}`).join('\n');
}

function chunkSegments(segments: TimedWord[], maxChars = 12000): TimedWord[][] {
  const chunks: TimedWord[][] = [];
  let cur: TimedWord[] = [];
  let len = 0;
  for (const s of segments) {
    const l = s.text.length + 20;
    if (len + l > maxChars && cur.length) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(s);
    len += l;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function mergeRejected(into: Record<string, number>, add: Record<string, number | undefined>): void {
  for (const [k, v] of Object.entries(add)) if (v) into[k] = (into[k] ?? 0) + v;
}

/** Primera pasada: brief editorial. Si la IA falla o devuelve algo inválido, brief local a partir del título. */
async function makeBrief(input: AnalyzeInput): Promise<EditorialBrief> {
  const title = input.title ?? '';
  try {
    input.checkCancelled?.();
    const raw = await input.chat(BRIEF_SYSTEM_PROMPT, briefUserPrompt({ title, description: input.description, duration: input.duration, segments: input.segments }), 0, briefSchema());
    const b = parseBrief(raw, input.duration);
    if (b) return b;
    input.log?.('brief: respuesta no válida; se usa el título', raw.slice(0, 300));
  } catch (e) {
    if (isFatal(e)) throw e;
    input.log?.('brief: fallo de la IA; se usa el título', e instanceof Error ? e.message : String(e));
  }
  return fallbackBrief(title, input.description);
}

export async function analyzeClips(input: AnalyzeInput): Promise<AnalyzeResult> {
  const { preset, duration, words, segments } = input;
  const editorialMode = input.title !== undefined;
  const quality = input.quality ?? DEFAULT_SELECTION_QUALITY;
  const profile = QUALITY_PROFILES[quality];
  const maxFill = Math.max(0, Math.min(5, input.maxFillRounds ?? (editorialMode ? profile.fillRounds : 3)));
  const feasible = feasibleMax(duration, preset);
  const target = Math.max(1, Math.min(MAX_CLIPS, input.userTarget));
  const eff = effectiveTarget(target, duration, preset);
  const report: AnalysisReport = { target, feasibleMax: feasible, effectiveTarget: eff, rounds: [], candidates: 0, rejected: 0, obtained: 0 };
  if (eff === 0) {
    throw new UserFacingError(`El vídeo dura ${Math.round(duration)} s, menos que un clip de ${preset} s. Elige un preset más corto.`);
  }

  // 1. Brief editorial (sólo con título: es lo que da sentido a «relevante»).
  let topic: TopicOptions | undefined;
  let context = '';
  if (editorialMode) {
    input.onProgress?.(0, 'Entendiendo de qué trata el vídeo…');
    const brief = await makeBrief(input);
    const minScore = Math.max(0, Math.min(100, input.minScore ?? DEFAULT_MIN_CLIP_SCORE));
    topic = { keywords: topicKeywords(brief, input.title ?? ''), brief, minScore };
    context = `${briefForPrompt(input.title ?? '', brief)}\n\n`;
    report.brief = brief;
    report.minScore = minScore;
    report.quality = quality;
    input.log?.('brief', brief);
  }

  const chosen: Candidate[] = [];
  const ranking: RankingEntry[] = [];
  const totalRounds = 1 + maxFill;
  let anyParsed = false;
  let lastError = '';
  const chunkChars = editorialMode ? profile.chunkChars : 12000;

  /** Pide candidatos al LLM (con un reintento). null si la IA falló o devolvió JSON inválido. */
  const fetchRaws = async (user: string, requested: number, roundNo: number): Promise<unknown[] | null> => {
    input.checkCancelled?.();
    let raws: unknown[] | null = null;
    for (let attempt = 0; attempt < 2 && raws === null; attempt++) {
      let text: string;
      try {
        // Margen sobre lo pedido para poder descartar los peores.
        text = await input.chat(SYSTEM_PROMPT, user, Math.min(MAX_CLIPS, requested + 2));
      } catch (e) {
        if (isFatal(e)) throw e;
        lastError = e instanceof Error ? e.message : String(e);
        input.log?.(`ronda ${roundNo}: fallo de la IA (intento ${attempt + 1})`, lastError);
        continue;
      }
      try {
        raws = parseModelResponse(text).slice(0, MAX_CLIPS * 2);
      } catch (e) {
        input.log?.(`ronda ${roundNo}: JSON inválido (intento ${attempt + 1})`, e instanceof UserFacingError ? e.technical : String(e));
      }
    }
    if (raws !== null) anyParsed = true;
    return raws;
  };

  /** Selecciona por puntuación entre todos los candidatos de una ronda y registra el resultado. */
  const selectInto = (round: AnalysisRound, raws: unknown[]): void => {
    round.received += raws.length;
    const sel = selectRound(raws, eff - chosen.length, { preset, sourceDuration: duration, words, taken: chosen, topic });
    chosen.push(...sel.accepted);
    round.accepted += sel.accepted.length;
    mergeRejected(round.rejected, sel.rejected);
    for (const c of sel.accepted) ranking.push({ start: c.start, end: c.end, title: c.title, score: c.score, topicRelevance: c.editorial?.topicRelevance, momentType: c.editorial?.momentType, featured: c.editorial?.featured, accepted: true });
  };

  const ask = (n: number) => `Devuelve como máximo ${n} candidatos (menos si no hay suficientes momentos buenos).`;

  // Ronda 1: todo el vídeo (por fragmentos si es largo). Cada fragmento propone sus mejores eventos, sin cuota
  // proporcional al tiempo: los candidatos de todos los fragmentos se ordenan juntos.
  const chunks = chunkSegments(segments, chunkChars);
  const r1: AnalysisRound = { round: 1, requested: eff, received: 0, accepted: 0, rejected: {} };
  const pooled: unknown[] = [];
  let failedChunks = 0;
  for (const [i, chunk] of chunks.entries()) {
    const perChunk = chunks.length === 1 ? eff : Math.min(eff, 6);
    const user = `${context}Duración total del vídeo: ${duration.toFixed(1)} s. Duración de cada clip: ${preset} s.
${ask(perChunk)}${chunks.length > 1 ? ' Sólo de este fragmento.' : ''}

TRANSCRIPCIÓN:
${lines(chunk)}`;
    input.onProgress?.(i / (chunks.length * totalRounds), `Buscando hasta ${eff} momentos que cumplan el tema…`);
    const raws = await fetchRaws(user, perChunk, 1);
    if (raws === null) failedChunks++;
    else pooled.push(...raws);
  }
  if (failedChunks === chunks.length) r1.failed = true;
  else selectInto(r1, pooled);
  report.rounds.push(r1);
  input.log?.('ronda 1', r1);

  // Rondas extra (según la calidad elegida): otra búsqueda en los tramos libres, con el mismo filtro de calidad.
  for (let n = 2; n <= totalRounds && chosen.length < eff; n++) {
    const gaps = freeGaps(chosen, duration, preset);
    if (gaps.length === 0) break;
    const need = eff - chosen.length;
    const takenTxt = [...chosen]
      .sort((a, b) => a.start - b.start)
      .map((c) => `${c.start.toFixed(1)}-${c.end.toFixed(1)}`)
      .join(', ');
    const free = segments.filter((s) => gaps.some((g) => s.start >= g.start - 0.5 && s.end <= g.end + 0.5));
    const freeChunks = chunkSegments(free, chunkChars);
    if (freeChunks.length === 0) break;
    input.onProgress?.((n - 1) / totalRounds, `Búsqueda ${n}: ¿hay más momentos buenos? (${chosen.length} de hasta ${eff})`);
    const r: AnalysisRound = { round: n, requested: need, received: 0, accepted: 0, rejected: {} };
    const pooledFill: unknown[] = [];
    let failedFill = 0;
    for (const chunk of freeChunks) {
      const user = `${context}Duración total del vídeo: ${duration.toFixed(1)} s. Duración de cada clip: ${preset} s.
Ya están elegidos estos intervalos (NO los repitas ni los solapes): ${takenTxt || 'ninguno'}.
Faltan ${need} como máximo. ${ask(need)} Sólo dentro de los tramos de abajo. Si aquí no hay nada bueno, devuelve una lista vacía.

TRANSCRIPCIÓN (sólo tramos libres${freeChunks.length > 1 ? ', un fragmento' : ''}):
${lines(chunk)}`;
      const raws = await fetchRaws(user, need, n);
      if (raws === null) failedFill++;
      else pooledFill.push(...raws);
    }
    if (failedFill === freeChunks.length) r.failed = true;
    else selectInto(r, pooledFill);
    report.rounds.push(r);
    input.log?.(`ronda ${n}`, r);
    if (!r.failed && r.accepted === 0) break; // no hay más momentos que superen el filtro
  }

  if (!anyParsed) {
    throw new UserFacingError(lastError || 'El modelo de IA devolvió respuestas no válidas. Prueba con otro modelo en Configuración.');
  }

  chosen.sort((a, b) => a.start - b.start);
  report.obtained = chosen.length;
  report.candidates = report.rounds.reduce((a, r) => a + r.received, 0);
  report.rejected = report.rounds.reduce((a, r) => a + Object.values(r.rejected).reduce((x, y) => x + y, 0), 0);
  if (editorialMode) {
    // Diagnóstico: motivos de descarte agregados (los candidatos inválidos no tienen tramo fiable).
    const rej: Record<string, number> = {};
    for (const r of report.rounds) mergeRejected(rej, r.rejected);
    for (const [k, v] of Object.entries(rej)) ranking.push({ start: 0, end: 0, title: `${v} candidato${v === 1 ? '' : 's'}`, score: 0, accepted: false, reason: REJECT_LABELS[k as keyof typeof REJECT_LABELS] ?? k });
    report.ranking = ranking.slice(0, 60);
  }
  if (editorialMode) report.featured = chosen.filter((c) => c.editorial?.featured).length;
  if (chosen.length < eff) {
    report.partialReason = editorialMode
      ? 'no se encontraron más momentos distintos que no sean relleno'
      : freeGaps(chosen, duration, preset).length === 0
        ? 'no queda espacio libre en el vídeo para más clips sin solaparse'
        : 'no se encontraron más momentos distintos que cumplan los criterios';
  }
  input.onProgress?.(1, editorialMode ? `${chosen.length} clips · ${report.featured} destacados` : `${chosen.length}/${eff} clips seleccionados`);
  return { clips: chosen, report };
}
