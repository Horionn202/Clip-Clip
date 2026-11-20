import { describe, it, expect } from 'vitest';
import { buildCues, mergeCues, normalizeText, normalizeWords, sanitizeCues, splitCue, wordsInClip } from '../src/shared/cues';
import { buildAss } from '../src/main/media';

const W = (start: number, end: number, text: string) => ({ start, end, text });

describe('cues por palabra', () => {
  it('cortes de 2–5 palabras y nunca una palabra antes de decirse', () => {
    const words = [W(10, 10.3, ' Hola'), W(10.3, 10.6, ' a'), W(10.6, 11, ' todos.'), W(11.1, 11.4, ' Hoy'), W(11.4, 11.7, ' vamos'), W(11.7, 12, ' a'), W(12, 12.4, ' jugar')];
    const cues = buildCues(words, 10, 40);
    expect(cues.map((c) => c.text)).toEqual(['Hola a todos.', 'Hoy vamos a jugar']);
    for (const c of cues) expect(c.end).toBeGreaterThan(c.start);
    // El segundo cue empieza exactamente cuando se dice «Hoy» (relativo al clip).
    expect(cues[1].start).toBeCloseTo(1.1, 2);
    expect(cues[0].end).toBeLessThanOrEqual(cues[1].start);
  });
  it('un silencio separa frases: «Dios» no se mezcla con lo siguiente', () => {
    const cues = buildCues([W(0, 0.4, 'Dios'), W(2.0, 2.3, 'vamos'), W(2.3, 2.6, 'allá')], 0, 30);
    expect(cues.map((c) => c.text)).toEqual(['Dios', 'vamos allá']);
    expect(cues[1].start).toBe(2);
  });
  it('límite de caracteres y de palabras', () => {
    const words = Array.from({ length: 12 }, (_, i) => W(i * 0.2, i * 0.2 + 0.18, 'palabra'));
    for (const c of buildCues(words, 0, 10)) {
      expect(c.text.split(' ').length).toBeLessThanOrEqual(5);
      expect(c.text.length).toBeLessThanOrEqual(28);
    }
  });
  it('no arrastra palabras que empezaron antes del clip y respeta el final', () => {
    expect(wordsInClip([W(9, 10.2, 'antes'), W(10.1, 10.4, 'dentro'), W(40, 41, 'fuera')], 10, 40).map((w) => w.text)).toEqual(['dentro']);
  });
  it('normaliza solapes y tiempos imposibles de Whisper', () => {
    const n = normalizeWords([W(1, 0.5, 'a'), W(0.9, 1.5, 'b'), W(NaN, 1, 'c'), W(2, 2.1, '  ')]);
    expect(n.map((w) => w.text)).toEqual(['b', 'a']);
    expect(n[0].end).toBeLessThanOrEqual(n[1].start);
  });
  it('duración mínima sin invadir el cue siguiente', () => {
    const cues = buildCues([W(0, 0.05, 'Ya.'), W(0.2, 0.5, 'Vale')], 0, 5);
    expect(cues[0].end).toBeLessThanOrEqual(cues[1].start);
  });
});

describe('edición de subtítulos', () => {
  const cues = [
    { start: 0, end: 1, text: 'hola a todos' },
    { start: 1, end: 2, text: 'qué tal' },
  ];
  it('dividir y unir', () => {
    const s = splitCue(cues, 0, 1);
    expect(s.map((c) => c.text)).toEqual(['hola', 'a todos', 'qué tal']);
    expect(s[0].end).toBe(s[1].start);
    expect(mergeCues(s, 0)[0].text).toBe('hola a todos');
  });
  it('sanea tiempos editados (orden, sin solapes, dentro del clip)', () => {
    const r = sanitizeCues([{ start: 5, end: 40, text: 'b' }, { start: 0, end: 6, text: 'a' }, { start: 1, end: 2, text: '  ' }], 30);
    expect(r).toEqual([
      { start: 0, end: 6, text: 'a' },
      { start: 6, end: 30, text: 'b' },
    ]);
  });
  it('normalización prudente: no cambia ni añade palabras', () => {
    expect(normalizeText('hola  ,  qué tal . bien')).toBe('Hola, qué tal. Bien');
  });
});

describe('ASS', () => {
  it('usa los cues editados si existen y escala al aspecto de salida', () => {
    const ass = buildAss([W(0, 1, 'auto')], 0, 10, 72, [{ start: 0.5, end: 1.5, text: 'editado' }], { w: 1080, h: 1080 });
    expect(ass).toContain('EDITADO');
    expect(ass).not.toContain('AUTO');
    expect(ass).toContain('PlayResY: 1080');
  });
});
