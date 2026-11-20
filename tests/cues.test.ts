import { describe, it, expect } from 'vitest';
import { activeWordIndex, buildCues, mergeCues, normalizeText, normalizeWords, sanitizeCues, splitCue, wordTimings, wordsFromSegments, wordsInClip } from '../src/shared/cues';
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

describe('karaoke por palabra', () => {
  // «Mira, mira qué músculos»: cuatro palabras con sus tiempos de Whisper.
  const words = [W(0, 0.3, 'Mira,'), W(0.35, 0.6, 'mira'), W(0.7, 0.9, 'qué'), W(0.9, 1.5, 'músculos')];
  const cue = buildCues(words, 0, 10)[0];
  it('la frase entera visible y sólo la palabra que se dice en azul', async () => {
    const { karaokeEvents, assColor } = await import('../src/main/media');
    const blue = assColor('#3B82F6');
    expect(blue).toBe('&H00F6823B');
    const evs = karaokeEvents(cue, blue);
    for (const e of evs) {
      expect(e.text.replace(/\{[^}]*\}/g, '')).toBe('MIRA, MIRA QUÉ MÚSCULOS');
      expect((e.text.match(/\\1c&H00F6823B&/g) ?? []).length).toBeLessThanOrEqual(1);
    }
    const at = (t: number) => evs.find((e) => t >= e.start && t < e.end)!.text;
    expect(at(0.1)).toBe(`{\\1c${blue}&}MIRA,{\\1c&H00FFFFFF&} MIRA QUÉ MÚSCULOS`);
    expect(at(0.4)).toBe(`MIRA, {\\1c${blue}&}MIRA{\\1c&H00FFFFFF&} QUÉ MÚSCULOS`);
    expect(at(0.8)).toBe(`MIRA, MIRA {\\1c${blue}&}QUÉ{\\1c&H00FFFFFF&} MÚSCULOS`);
    // Silencio entre palabras: ninguna activa.
    expect(at(0.32)).toBe('MIRA, MIRA QUÉ MÚSCULOS');
  });
  it('ASS karaoke frente a estándar y fallback sin tiempos por palabra', () => {
    expect(buildAss(words, 0, 10, 72, undefined, undefined, { style: 'karaoke' })).toContain('\\1c&H00F6823B&');
    expect(buildAss(words, 0, 10, 72, undefined, undefined, { style: 'standard' })).not.toContain('\\1c');
    const approx = wordsFromSegments([W(0, 2, 'hola qué tal')]);
    expect(buildAss(approx, 0, 10, 72, undefined, undefined, { style: 'karaoke' })).not.toContain('\\1c');
  });
  it('texto editado: tiempos repartidos provisionalmente y marcados como aproximados', () => {
    const t = wordTimings({ start: 1, end: 3, text: 'hola mundo' });
    expect(t.every((w) => w.approx)).toBe(true);
    expect(t[0].start).toBe(1);
    expect(t[1].end).toBeCloseTo(3, 2);
    expect(t[0].end).toBeLessThanOrEqual(t[1].start);
  });
  it('dividir y unir conservan los tiempos reales de cada palabra', () => {
    const s = splitCue([cue], 0, 2);
    expect(s[1].start).toBe(0.7);
    expect(s[0].words?.map((w) => w.text)).toEqual(['Mira,', 'mira']);
    expect(mergeCues(s, 0)[0].words?.length).toBe(4);
  });
  it('nunca una palabra activa antes de decirse', () => {
    const ws = wordTimings(cue);
    ws.forEach((w, i) => {
      expect(activeWordIndex(ws, w.start - 0.01)).not.toBe(i);
      expect(activeWordIndex(ws, w.start + 0.01)).toBe(i);
    });
  });
});

describe('revisión Codex (PR 17)', () => {
  it('transcripción sin tiempos por palabra: los cues del editor quedan marcados y no inventan tiempos', () => {
    const cues = buildCues(wordsFromSegments([W(0, 2, 'hola qué tal'), W(3, 4, 'adiós amigo')]), 0, 10);
    expect(cues.length).toBeGreaterThan(0);
    for (const c of cues) {
      expect(c.noWordTiming).toBe(true);
      expect(c.words).toBeUndefined();
    }
    // Se conserva al dividir, unir y sanear (lo que se guarda).
    expect(splitCue(cues, 0, 1).every((c) => c.noWordTiming)).toBe(true);
    expect(mergeCues(cues, 0)[0].noWordTiming).toBe(true);
    expect(sanitizeCues(cues, 10).every((c) => c.noWordTiming)).toBe(true);
  });
  it('dividir un texto con espacios repetidos o finales no falla', () => {
    expect(splitCue([{ start: 0, end: 1, text: 'hola ' }], 0, 1)).toEqual([{ start: 0, end: 1, text: 'hola ' }]);
    const s = splitCue([{ start: 0, end: 2, text: 'hola   mundo  bonito ' }], 0, 1);
    expect(s.map((c) => c.text)).toEqual(['hola', 'mundo bonito']);
  });
});
