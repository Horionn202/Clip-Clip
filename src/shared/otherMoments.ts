// «Otros momentos»: completa hasta el máximo pedido con tramos que la IA no propuso. Puro y determinista.
// Los modelos pequeños devuelven pocos candidatos o frases contiguas que se solapan: la cantidad no puede depender de ellos.
import type { DurationPreset } from './types';
import { formatTime, overlaps, presetRange } from './validation';
import { MIN_WORDS_PER_SEC, isGenericText, localScore, titleFromSentence, type Candidate, type TimedWord, type TopicOptions } from './selection';
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

/**
 * Devuelve hasta `need` tramos sin solapes, en frases completas y con voz. Prioriza llegar al número pedido y,
 * a igual número, la mejor puntuación. Nunca salen como destacados: la IA no los ha valorado.
 */
export function otherMoments(o: OtherMomentsInput): Candidate[] {
  if (o.need <= 0) return [];
  const { min, max } = presetRange(o.preset);
  const { keywords } = o.topic;
  const round = (x: number) => Math.round(x * 100) / 100;
  const pool: Candidate[] = [];

  for (const [i, first] of o.segments.entries()) {
    const start = round(first.start);
    if (o.filler.some((f) => start >= f.start && start < f.end)) continue;
    // Dos finales en frase completa: el más largo del preset y el más corto válido (para encajar en huecos).
    let shortest = -1;
    let longest = -1;
    for (let j = i; j < o.segments.length && o.segments[j].end - start <= max; j++) {
      if (o.segments[j].end - start < min) continue;
      if (shortest < 0) shortest = j;
      longest = j;
    }
    if (longest < 0) continue;
    for (const last of new Set([longest, shortest])) {
      const end = round(Math.min(o.segments[last].end, o.duration));
      if (end - start < min || end - start > max) continue;
      if (o.taken.some((t) => overlaps(t, { start, end }))) continue;

      const inside = o.segments.slice(i, last + 1);
      const text = inside.map((s) => s.text.trim()).join(' ');
      if (text.split(/\s+/).length / (end - start) < MIN_WORDS_PER_SEC) continue;

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
      pool.push({ start, end, title, hook, reason: why, llmScore: null, localScore: local, score, editorial: { ...parts, score, featured: false, auto: true, why } });
    }
  }

  // Intervalos ponderados con límite: row[n] = mejor combinación de n tramos entre los vistos hasta ahora.
  pool.sort((a, b) => a.end - b.end);
  type Plan = { total: number; picked: Candidate[] };
  const rows: Plan[][] = [[{ total: 0, picked: [] }]];
  for (const [i, c] of pool.entries()) {
    let p = i;
    while (p > 0 && overlaps(pool[p - 1], c)) p--;
    const row = [...rows[i]];
    for (let n = 1; n <= o.need && n <= rows[p].length; n++) {
      const before = rows[p][n - 1];
      // La duración completa pesa: un clip corto sólo entra si hace falta para encajar uno más.
      const total = before.total + c.score + (20 * (c.end - c.start)) / max;
      if (!row[n] || total > row[n].total) row[n] = { total, picked: [...before.picked, c] };
    }
    rows.push(row);
  }
  const best = rows[rows.length - 1];
  return best[best.length - 1].picked;
}
