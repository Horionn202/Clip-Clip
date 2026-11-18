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

export function goodClip(start: number, preset = 30, i = 0) {
  return {
    start,
    end: start + preset,
    title: `Cómo resolver el problema número ${i + 1}`,
    hook: `La voz${i} cambia todo lo que creías sobre el tema`,
    reason: `Explica de forma concreta el punto ${i + 1} con un ejemplo claro y una conclusión`,
    score: 80,
  };
}
