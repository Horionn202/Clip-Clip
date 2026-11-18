// Selección de clips por rondas con Ollama: meta exacta, relleno de huecos y validación de calidad.
import type { AnalysisReport, AnalysisRound, DurationPreset } from '../shared/types';
import { MAX_CLIPS } from '../shared/types';
import { UserFacingError, parseModelResponse } from '../shared/validation';
import { effectiveTarget, feasibleMax, freeGaps, selectRound, type Candidate, type TimedWord } from '../shared/selection';

/** Llamada al LLM (inyectable para pruebas). `maxItems` = clips pedidos (para salida estructurada). */
export type ChatFn = (system: string, user: string, maxItems: number) => Promise<string>;

/** Errores que deben abortar todo el análisis (no sólo la ronda). */
function isFatal(e: unknown): boolean {
  return e instanceof Error && (e.name === 'CancelledError' || /no está descargado/.test(e.message));
}

export interface AnalyzeInput {
  segments: TimedWord[];
  words: TimedWord[];
  duration: number;
  preset: DurationPreset;
  userTarget: number;
  chat: ChatFn;
  /** Rondas de relleno máximas tras la primera (evita bucles). */
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
Recibes una transcripción con marcas de tiempo en segundos y eliges fragmentos autocontenidos y atractivos.
Responde SÓLO con JSON válido, sin texto adicional, con esta forma:
{"clips":[{"start":<segundos>,"end":<segundos>,"title":"...","hook":"...","reason":"...","score":<0-100>}]}
Reglas obligatorias:
- Devuelve EXACTAMENTE el número de clips que se te pida.
- Los clips no se solapan entre sí ni con los intervalos ya elegidos que se indiquen.
- start y end dentro de la transcripción; duración igual a la indicada; empieza y termina en frases completas.
- Reparte los clips por distintas partes del vídeo.
- title: título concreto sobre el tema real del fragmento (no genérico).
- hook: la frase de apertura concreta que engancha, basada en lo que se dice.
- reason: por qué ese fragmento concreto funciona, mencionando su contenido.
- Nunca uses textos de relleno como «título», «hook», «por qué funciona» o «momento interesante».
- Escribe title, hook y reason en el idioma del vídeo.`;

function lines(segments: TimedWord[], ranges?: { start: number; end: number }[]): string {
  const inRanges = (s: TimedWord) => !ranges || ranges.some((r) => s.start >= r.start - 0.5 && s.end <= r.end + 0.5);
  return segments
    .filter(inRanges)
    .map((g) => `[${g.start.toFixed(1)}-${g.end.toFixed(1)}] ${g.text.replace(/\s+/g, ' ').trim()}`)
    .join('\n');
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

export async function analyzeClips(input: AnalyzeInput): Promise<AnalyzeResult> {
  const { preset, duration, words, segments } = input;
  const maxFill = Math.max(0, Math.min(5, input.maxFillRounds ?? 3));
  const feasible = feasibleMax(duration, preset);
  const target = Math.max(1, Math.min(MAX_CLIPS, input.userTarget));
  const eff = effectiveTarget(target, duration, preset);
  const report: AnalysisReport = { target, feasibleMax: feasible, effectiveTarget: eff, rounds: [], candidates: 0, rejected: 0, obtained: 0 };
  if (eff === 0) {
    throw new UserFacingError(`El vídeo dura ${Math.round(duration)} s, menos que un clip de ${preset} s. Elige un preset más corto.`);
  }

  const chosen: Candidate[] = [];
  const totalRounds = 1 + maxFill;
  let anyParsed = false;
  let lastError = '';

  const ask = async (user: string, requested: number, roundNo: number): Promise<AnalysisRound> => {
    input.checkCancelled?.();
    const round: AnalysisRound = { round: roundNo, requested, received: 0, accepted: 0, rejected: {} };
    let raws: unknown[] | null = null;
    for (let attempt = 0; attempt < 2 && raws === null; attempt++) {
      let text: string;
      try {
        // Pide un pequeño margen sobre lo necesario para poder descartar los peores.
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
    if (raws === null) {
      round.failed = true;
      return round;
    }
    anyParsed = true;
    round.received = raws.length;
    const need = eff - chosen.length;
    const sel = selectRound(raws, need, { preset, sourceDuration: duration, words, taken: chosen });
    chosen.push(...sel.accepted);
    round.accepted = sel.accepted.length;
    round.rejected = sel.rejected as Record<string, number>;
    return round;
  };

  // Ronda 1: meta exacta sobre todo el vídeo (por fragmentos si es largo).
  const chunks = chunkSegments(segments);
  const r1: AnalysisRound = { round: 1, requested: eff, received: 0, accepted: 0, rejected: {} };
  let failedChunks = 0;
  for (const [i, chunk] of chunks.entries()) {
    const span = chunk[chunk.length - 1].end - chunk[0].start;
    const share = chunks.length === 1 ? eff : Math.min(eff, Math.max(1, Math.ceil((eff * span) / duration)));
    const user = `Duración total del vídeo: ${duration.toFixed(1)} s. Duración de cada clip: ${preset} s.
Genera exactamente ${share} candidatos no solapados${chunks.length > 1 ? ' de este fragmento' : ''}, repartidos por distintas partes.

TRANSCRIPCIÓN:
${lines(chunk)}`;
    input.onProgress?.(i / (chunks.length * totalRounds), `Ronda 1: pidiendo ${eff} clips a la IA…`);
    const r = await ask(user, share, 1);
    if (r.failed) failedChunks++;
    r1.received += r.received;
    r1.accepted += r.accepted;
    mergeRejected(r1.rejected, r.rejected);
  }
  if (failedChunks === chunks.length) r1.failed = true;
  report.rounds.push(r1);
  input.log?.('ronda 1', r1);

  // Rondas de relleno: sólo los que faltan, sobre los huecos libres.
  for (let n = 2; n <= totalRounds && chosen.length < eff; n++) {
    const gaps = freeGaps(chosen, duration, preset);
    if (gaps.length === 0) break;
    const need = eff - chosen.length;
    const takenTxt = [...chosen]
      .sort((a, b) => a.start - b.start)
      .map((c) => `${c.start.toFixed(1)}-${c.end.toFixed(1)}`)
      .join(', ');
    const user = `Duración total del vídeo: ${duration.toFixed(1)} s. Duración de cada clip: ${preset} s.
Ya están elegidos estos intervalos (NO los repitas ni los solapes): ${takenTxt || 'ninguno'}.
Faltan ${need}. Genera exactamente ${need} candidatos nuevos no solapados, sólo dentro de los tramos de abajo.

TRANSCRIPCIÓN (sólo tramos libres):
${lines(segments, gaps).slice(0, 12000)}`;
    input.onProgress?.((n - 1) / totalRounds, `Ronda ${n}: faltan ${need} de ${eff}…`);
    const r = await ask(user, need, n);
    report.rounds.push(r);
    input.log?.(`ronda ${n}`, r);
    if (!r.failed && r.accepted === 0) break; // el modelo no encuentra más momentos distintos
  }

  if (!anyParsed) {
    throw new UserFacingError(lastError || 'El modelo de IA devolvió respuestas no válidas. Prueba con otro modelo en Configuración.');
  }

  chosen.sort((a, b) => a.start - b.start);
  report.obtained = chosen.length;
  report.candidates = report.rounds.reduce((a, r) => a + r.received, 0);
  report.rejected = report.rounds.reduce((a, r) => a + Object.values(r.rejected).reduce((x, y) => x + y, 0), 0);
  if (chosen.length < eff) {
    report.partialReason =
      freeGaps(chosen, duration, preset).length === 0
        ? 'no queda espacio libre en el vídeo para más clips sin solaparse'
        : 'no se encontraron más momentos distintos que cumplan los criterios';
  }
  input.onProgress?.(1, `${chosen.length}/${eff} clips seleccionados`);
  return { clips: chosen, report };
}
