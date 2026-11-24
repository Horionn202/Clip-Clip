// «Otros momentos»: completa hasta el máximo pedido con tramos que la IA no propuso. Puro y determinista.
// Los modelos pequeños devuelven pocos candidatos o frases contiguas que se solapan: la cantidad no puede depender de ellos.
import { LONG_CLIP_SEC, type DurationPreset } from './types';
import { formatTime, overlaps, presetRange } from './validation';
import { LONG_CLIP_MAX_SILENCE, MIN_WORDS_PER_SEC, isGenericText, localScore, sentencesIn, titleFromSentence, type Candidate, type TimedWord, type TopicOptions } from './selection';
import { editorialScore, localTopicRelevance, topicHits } from './editorialBrief';

export interface OtherMomentsInput {
  segments: TimedWord[];
  words: TimedWord[];
  duration: number;
  preset: DurationPreset;
  topic: TopicOptions;
  /** Clips ya elegidos: no se pisan. */
  taken: { start: number; end: number }[];
  /** Tramos que la IA marcó como relleno: ningún clip adicional empieza ahí. */
  filler: { start: number; end: number }[];
  need: number;
}

/** Puntos extra por duración completa: un clip corto sólo entra si hace falta para encajar uno más. */
const FULL_LENGTH_BONUS = 20;
/** Pesa más que cualquier puntuación: a igual número de clips, gana el que corta en frases completas. */
const SENTENCE_BONUS = 200;

/**
 * Devuelve hasta `need` tramos sin solapes y con voz. Prioridades, en orden: llegar al número pedido, cortar en
 * frases completas (palabras con signos o pausas) y la mejor puntuación. Los segmentos de Whisper, que pueden
 * partir una frase, sólo se usan si sin ellos no se llega o no hay tiempos por palabra.
 * Nunca salen como destacados: la IA no los ha valorado.
 */
export function otherMoments(o: OtherMomentsInput): Candidate[] {
  if (o.need <= 0) return [];
  const { min, max } = presetRange(o.preset);
  const { keywords } = o.topic;
  const round = (x: number) => Math.round(x * 100) / 100;
  const pool: { clip: Candidate; weight: number }[] = [];

  const addFrom = (units: TimedWord[], bonus: number): void => {
    for (const [i, first] of units.entries()) {
      const start = round(first.start);
      if (o.filler.some((f) => start >= f.start && start < f.end)) continue;
      // De TODOS los finales válidos se guardan el más corto (para encajar en huecos) y el más largo.
      let count = 0;
      let shortest = -1;
      let longest = -1;
      // Silencio más largo entre frases del tramo (en clips largos no puede pasar de LONG_CLIP_MAX_SILENCE).
      let silence = 0;
      for (let j = i; j < units.length && units[j].end - start <= max; j++) {
        count += units[j].text.trim().split(/\s+/).length;
        if (j > i) silence = Math.max(silence, units[j].start - units[j - 1].end);
        if (o.preset >= LONG_CLIP_SEC && silence > LONG_CLIP_MAX_SILENCE) break;
        const end = round(Math.min(units[j].end, o.duration));
        if (end - start < min) continue;
        if (o.taken.some((t) => overlaps(t, { start, end }))) break; // cualquier final posterior también lo pisa
        if (count / (end - start) < MIN_WORDS_PER_SEC) continue;
        if (shortest < 0) shortest = j;
        longest = j;
      }
      if (longest < 0) continue;

      for (const last of new Set([longest, shortest])) {
        const end = round(Math.min(units[last].end, o.duration));
        const inside = units.slice(i, last + 1);
        const text = inside.map((s) => s.text.trim()).join(' ');
        const hits = inside.map((s) => topicHits(s.text, keywords));
        const main = inside[hits.indexOf(Math.max(...hits))];
        const named = titleFromSentence(main.text);
        const title = isGenericText(named, 6) ? `Momento en ${formatTime(start)}` : named;
        const hook = first.text.trim().slice(0, 200);
        const local = localScore(start, end, hook, o.words.length ? o.words : inside, o.preset);
        const topicRelevance = localTopicRelevance(text, keywords);
        const parts = { topicRelevance, hookStrength: local, payoffStrength: 50, selfContained: 60 };
        const score = editorialScore({ ...parts, local });
        const why = 'Momento adicional elegido por la app: la IA no lo propuso. Revísalo antes de publicar.';
        pool.push({
          clip: { start, end, title, hook, reason: why, llmScore: null, localScore: local, score, editorial: { ...parts, score, featured: false, auto: true, why } },
          weight: score + bonus + (FULL_LENGTH_BONUS * (end - start)) / max,
        });
      }
    }
  };
  if (o.words.length) addFrom(sentencesIn(o.words, 0, o.duration), SENTENCE_BONUS);
  addFrom(o.segments, 0);

  // Intervalos ponderados con límite: row[n] = mejor combinación de n tramos entre los vistos hasta ahora.
  pool.sort((a, b) => a.clip.end - b.clip.end);
  type Plan = { total: number; picked: Candidate[] };
  const rows: Plan[][] = [[{ total: 0, picked: [] }]];
  for (const [i, { clip, weight }] of pool.entries()) {
    let p = i;
    while (p > 0 && overlaps(pool[p - 1].clip, clip)) p--;
    const row = [...rows[i]];
    for (let n = 1; n <= o.need && n <= rows[p].length; n++) {
      const before = rows[p][n - 1];
      const total = before.total + weight;
      if (!row[n] || total > row[n].total) row[n] = { total, picked: [...before.picked, clip] };
    }
    rows.push(row);
  }
  const best = rows[rows.length - 1];
  return best[best.length - 1].picked;
}
