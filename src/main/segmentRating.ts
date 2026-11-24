// «Dividir video completo»: la IA no elige qué clips existen (todos cubren el vídeo); sólo califica cada segmento
// por lotes y los mejores pasan por el MISMO verificador de destacados. Ningún segmento se mueve ni se descarta.
import type { AnalysisReport, DurationPreset } from '../shared/types';
import { LONG_CLIP_SEC } from '../shared/types';
import { MOMENT_TYPES, DEFAULT_MIN_CLIP_SCORE, editorialScore, localTopicRelevance, topicKeywords, type MomentType } from '../shared/editorialBrief';
import { LONG_CLIP_MIN_STRUCTURE, isGenericText, localScore, openingPhrase, titleFromSentence, type Candidate, type TimedWord } from '../shared/selection';
import { asOtherMoment, verifyHighlights, type HighlightContext } from '../shared/highlights';
import { formatTime } from '../shared/validation';
import type { Segment } from '../shared/fullSplit';
import { makeBrief, type ChatFn } from './analysis';

export const RATING_SYSTEM_PROMPT = `Eres un editor de vídeos cortos. Recibes el tema del vídeo y varios SEGMENTOS consecutivos (todos se van a publicar como clips; no eliges cuáles existen).
Califica CADA segmento por separado, sólo con lo que se dice en él. Responde SÓLO con JSON:
{"segments":[{"id":<n>,"score":<0-100>,"topic_relevance":<0-100>,"hook_strength":<0-100>,"payoff_strength":<0-100>,"self_contained":<0-100>,"moment_type":"revelacion|accion|reaccion|humor|logro|conflicto|explicacion|relleno","title":"...","why":"..."}]}
Reglas:
- Un elemento por segmento recibido, con su mismo id.
- topic_relevance: cuánto cumple el tema y la promesa del título (0 = nada que ver).
- moment_type «relleno» si es espera, menús, saludos o conversación sin relación.
- title: describe lo que pasa en ESE segmento; no anuncies eventos que no se oyen en él.
- why: motivo breve y concreto.
- Escribe en el idioma del vídeo.`;

export function ratingSchema(n: number): object {
  return {
    type: 'object',
    properties: {
      segments: {
        type: 'array',
        maxItems: n,
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            score: { type: 'number' },
            topic_relevance: { type: 'number' },
            hook_strength: { type: 'number' },
            payoff_strength: { type: 'number' },
            self_contained: { type: 'number' },
            moment_type: { type: 'string', enum: MOMENT_TYPES },
            title: { type: 'string' },
            why: { type: 'string' },
          },
          required: ['id', 'score', 'topic_relevance', 'hook_strength', 'payoff_strength', 'self_contained', 'moment_type', 'title', 'why'],
        },
      },
    },
    required: ['segments'],
  };
}

/**
 * Lo que se dice DENTRO del bloque: por palabras si hay marcas de tiempo (un corte exacto puede caer a mitad de frase);
 * si no, los tramos de Whisper que se solapan con el bloque.
 */
export const text = (segments: TimedWord[], s: Segment, words: TimedWord[] = []) =>
  (words.length ? words.filter((w) => w.start >= s.start && w.start < s.end) : segments.filter((g) => g.start < s.end && g.end > s.start))
    .map((g) => g.text.trim())
    .join(' ');

/** Máximo de segmentos por lote: cada respuesta debe caber en el presupuesto de tokens (≈260 por segmento, tope 4096). */
export const MAX_BATCH_SEGMENTS = 14;

/** Lotes de segmentos con ≤ maxChars de transcripción (al menos uno por lote). */
export function ratingBatches(segs: Segment[], segments: TimedWord[], maxChars = 6000, words: TimedWord[] = []): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  let len = 0;
  segs.forEach((s, i) => {
    const l = text(segments, s, words).length + 40;
    if (cur.length && (len + l > maxChars || cur.length >= MAX_BATCH_SEGMENTS)) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(i);
    len += l;
  });
  if (cur.length) out.push(cur);
  return out;
}

const num100 = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null);

/** Convierte la nota de la IA (o, si falta, una nota local) en un candidato con criterios editoriales. Nunca lanza. */
export function rateSegment(
  s: Segment,
  raw: Record<string, unknown> | undefined,
  o: { segments: TimedWord[]; words: TimedWord[]; preset: DurationPreset; keywords: string[]; minScore: number },
): Candidate {
  const said = text(o.segments, s, o.words);
  const wordsSrc = o.words.length ? o.words : o.segments;
  const local = localScore(s.start, s.end, said.slice(0, 200), wordsSrc, o.preset);
  const localRel = localTopicRelevance(said, o.keywords);
  const mt = typeof raw?.moment_type === 'string' && (MOMENT_TYPES as string[]).includes(raw.moment_type) ? (raw.moment_type as MomentType) : undefined;
  const llmRel = num100(raw?.topic_relevance);
  // Igual que en la selección: la relevancia de la IA se contrasta con lo que se dice en el segmento.
  const topicRelevance = Math.round(llmRel === null ? localRel : 0.6 * llmRel + 0.4 * localRel);
  const hookStrength = num100(raw?.hook_strength) ?? local;
  const payoffStrength = num100(raw?.payoff_strength) ?? 50;
  const selfContained = num100(raw?.self_contained) ?? 60;
  const score = editorialScore({ topicRelevance, hookStrength, payoffStrength, selfContained, local });
  const rated = !!raw && llmRel !== null;
  const longOk = o.preset < LONG_CLIP_SEC || (hookStrength >= LONG_CLIP_MIN_STRUCTURE && payoffStrength >= LONG_CLIP_MIN_STRUCTURE);
  // Sólo aspira a destacado si la IA lo calificó, supera el umbral, no es relleno y (si es largo) tiene estructura.
  const featured = rated && mt !== 'relleno' && score >= o.minScore && longOk;
  const why = (typeof raw?.why === 'string' && raw.why.trim()) || (rated ? 'Segmento calificado por la IA.' : 'Segmento sin calificar por la IA: nota calculada en el equipo.');
  const proposed = typeof raw?.title === 'string' ? raw.title.replace(/\s+/g, ' ').trim().slice(0, 100) : '';
  const opening = o.words.length ? openingPhrase(o.words, s.start, s.end) : said.split(/(?<=[.?!])\s/)[0] ?? '';
  const fallbackTitle = titleFromSentence(opening || said) || `Segmento en ${formatTime(s.start)}`;
  const title = proposed && !isGenericText(proposed, 6) ? proposed : isGenericText(fallbackTitle, 6) ? `Segmento en ${formatTime(s.start)}` : fallbackTitle;
  const hook = (opening || said).slice(0, 200);
  return {
    start: s.start,
    end: s.end,
    title,
    hook,
    reason: why,
    llmScore: num100(raw?.score),
    localScore: local,
    score,
    editorial: { score, featured, topicRelevance, hookStrength, payoffStrength, selfContained, momentType: mt, why, auto: rated ? undefined : true },
  };
}

export interface RateInput {
  segs: Segment[];
  segments: TimedWord[];
  words: TimedWord[];
  duration: number;
  preset: DurationPreset;
  title: string;
  description?: string;
  minScore?: number;
  chat: ChatFn;
  verifier?: () => Promise<{ model: string; ask: (system: string, user: string, schema: object) => Promise<string> }>;
  onProgress?: (p: number, message: string) => void;
  checkCancelled?: () => void;
  log?: (msg: string, extra?: unknown) => void;
}

/** Califica todos los segmentos y verifica los mejores. Devuelve exactamente un candidato por segmento, en orden. */
export async function rateSegments(input: RateInput): Promise<{ clips: Candidate[]; report: AnalysisReport }> {
  const minScore = Math.max(0, Math.min(100, input.minScore ?? DEFAULT_MIN_CLIP_SCORE));
  const n = input.segs.length;
  input.onProgress?.(0, 'Entendiendo de qué trata el vídeo…');
  const brief = await makeBrief({ title: input.title, description: input.description, duration: input.duration, segments: input.segments, chat: input.chat, checkCancelled: input.checkCancelled, log: input.log });
  const keywords = topicKeywords(brief, input.title);
  const raws = new Map<number, Record<string, unknown>>();
  const batches = ratingBatches(input.segs, input.segments, 6000, input.words);
  let failed = 0;
  // Segunda pasada sólo con los segmentos que el modelo se dejó (de uno en uno): todos deben quedar calificados.
  const queue: { batch: number[]; retry: boolean }[] = batches.map((batch) => ({ batch, retry: false }));
  for (let bi = 0; bi < queue.length; bi++) {
    const { batch, retry } = queue[bi];
    input.checkCancelled?.();
    input.onProgress?.((0.85 * Math.min(bi, batches.length)) / batches.length, `${retry ? 'Completando' : 'Calificando'} segmentos ${batch[0] + 1}–${batch[batch.length - 1] + 1} de ${n}…`);
    const user = `TÍTULO: ${input.title}
TEMA PRINCIPAL: ${brief.mainTopic}
${brief.titlePromise ? `PROMESA DEL TÍTULO: ${brief.titlePromise}\n` : ''}
${batch.map((i) => `### SEGMENTO id=${i + 1} (${formatTime(input.segs[i].start)}–${formatTime(input.segs[i].end)})\n${text(input.segments, input.segs[i], input.words) || '(sin voz)'}`).join('\n\n')}`;
    try {
      const out = JSON.parse(await input.chat(RATING_SYSTEM_PROMPT, user, batch.length, ratingSchema(batch.length))) as { segments?: Record<string, unknown>[] };
      const items = Array.isArray(out.segments) ? out.segments : [];
      for (const [k, r] of items.entries()) {
        // id numérico o en texto («3»); si no sirve y el modelo devolvió uno por segmento en orden, se usa la posición.
        const asNum = typeof r.id === 'number' ? r.id : typeof r.id === 'string' && /^\d+$/.test(r.id.trim()) ? Number(r.id) : NaN;
        let id = Number.isInteger(asNum) ? asNum - 1 : -1;
        if (!batch.includes(id) && items.length === batch.length) id = batch[k];
        if (batch.includes(id) && !raws.has(id)) raws.set(id, r);
      }
      const missing = batch.filter((i) => !raws.has(i));
      if (!retry && missing.length) for (const i of missing) queue.push({ batch: [i], retry: true });
    } catch (e) {
      if (e instanceof Error && (e.name === 'CancelledError' || /no está descargado/.test(e.message))) throw e;
      failed++;
      input.log?.(`calificación: lote ${bi + 1} falló`, e instanceof Error ? e.message : String(e));
      // Respuesta truncada o inválida: se reintenta una vez en dos mitades (más cortas, caben mejor).
      if (!retry && batch.length > 1) {
        const h = Math.ceil(batch.length / 2);
        queue.push({ batch: batch.slice(0, h), retry: true }, { batch: batch.slice(h), retry: true });
      }
    }
  }
  const opts = { segments: input.segments, words: input.words, preset: input.preset, keywords, minScore };
  const rated = input.segs.map((s, i) => rateSegment(s, raws.get(i), opts));

  // Fase B: los mejores pasan por el verificador. Los segmentos no se mueven (cubren el vídeo).
  const hctx: HighlightContext = { title: input.title, brief, keywords, segments: input.segments, words: input.words, duration: input.duration, preset: input.preset };
  let clips = rated.map((c) => asOtherMoment(c, hctx));
  let verification: AnalysisReport['verification'];
  if (rated.some((c) => c.editorial?.featured)) {
    try {
      input.checkCancelled?.();
      const v = input.verifier ? await input.verifier() : { model: 'modelo de selección', ask: (s: string, u: string, schema: object) => input.chat(s, u, 0, schema) };
      const run = await verifyHighlights({
        selected: rated,
        moments: [],
        context: hctx,
        max: n,
        model: v.model,
        ask: v.ask,
        allowMove: false,
        maxAspirants: Math.min(12, Math.max(6, Math.ceil(n / 4))),
        checkCancelled: input.checkCancelled,
        onProgress: (k, of) => input.onProgress?.(0.85 + (0.14 * k) / of, `Segmentos calificados · verificando destacado ${k} de ${of} con «${v.model}»…`),
      });
      const byStart = new Map(run.verified.map((c) => [c.start, c]));
      const others = new Map(run.others.map((c) => [c.start, c]));
      // Un candidato por segmento, en orden: el verificado (mismo tramo) o el «otro segmento».
      clips = rated.map((c) => byStart.get(c.start) ?? others.get(c.start) ?? asOtherMoment(c, hctx));
      verification = { model: v.model, checked: run.checked, rejected: run.rejected };
    } catch (e) {
      if (e instanceof Error && e.name === 'CancelledError') throw e;
      input.log?.('verificador no disponible: ningún destacado', e instanceof Error ? e.message : String(e));
    }
  }
  const featured = clips.filter((c) => c.editorial?.featured).length;
  const report: AnalysisReport = {
    target: n,
    feasibleMax: n,
    effectiveTarget: n,
    rounds: [{ round: 1, requested: n, received: raws.size, accepted: n, rejected: {}, ...(failed > 0 && raws.size === 0 ? { failed: true } : {}) }],
    candidates: raws.size,
    rejected: 0,
    obtained: n,
    brief,
    minScore,
    featured,
    verification,
    ranking: clips.map((c) => ({ start: c.start, end: c.end, title: c.title, score: c.score, topicRelevance: c.editorial?.topicRelevance, momentType: c.editorial?.momentType, featured: !!c.editorial?.featured, accepted: true })).slice(0, 60),
  };
  input.onProgress?.(1, `${n} segmentos · ${featured} destacado${featured === 1 ? '' : 's'} verificado${featured === 1 ? '' : 's'}`);
  return { clips, report };
}
