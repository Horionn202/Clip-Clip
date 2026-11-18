import type { TimedWord } from '../src/shared/selection';

/** Transcripción sintética: ~2,5 palabras/s, frases de 10 palabras con mayúscula inicial y punto final. */
export function syntheticTranscript(duration: number): { words: TimedWord[]; segments: TimedWord[] } {
  const words: TimedWord[] = [];
  const segments: TimedWord[] = [];
  let t = 0;
  let n = 0;
  while (t + 4 <= duration) {
    const seg: TimedWord[] = [];
    for (let i = 0; i < 10; i++) {
      const base = `voz${n % 50}`;
      const text = i === 0 ? ` ${base[0].toUpperCase()}${base.slice(1)}` : i === 9 ? ` ${base}${n % 7 === 0 ? '?' : '.'}` : ` ${base}`;
      seg.push({ start: t, end: t + 0.38, text });
      t += 0.4;
      n++;
    }
    words.push(...seg);
    segments.push({ start: seg[0].start, end: seg[9].end, text: seg.map((w) => w.text).join('') });
  }
  return { words, segments };
}

const TOPICS = [
  ['ahorro', 'compra', 'mercado'],
  ['viaje', 'montaña', 'mochila'],
  ['cocina', 'receta', 'horno'],
  ['deporte', 'carrera', 'zapatillas'],
  ['música', 'guitarra', 'concierto'],
  ['estudio', 'examen', 'apuntes'],
  ['jardín', 'plantas', 'riego'],
  ['coche', 'motor', 'gasolina'],
  ['juego', 'nivel', 'jefe'],
  ['perro', 'paseo', 'parque'],
];

export function goodClip(start: number, preset = 30, i = 0) {
  // Temas distintos por clip: así no se consideran ideas repetidas.
  const [a, b, c] = TOPICS[i % TOPICS.length];
  const n = Math.floor(i / TOPICS.length);
  return {
    start,
    end: start + preset,
    title: `Cómo mejorar tu ${a} con la ${b} ${n || ''}`.trim(),
    hook: `La voz${i} revela el secreto del ${c} que nadie cuenta`,
    reason: `Explica de forma concreta el punto ${i + 1} con un ejemplo claro y una conclusión`,
    score: 80,
  };
}
