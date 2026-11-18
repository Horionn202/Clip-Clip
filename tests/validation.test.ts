import { describe, it, expect } from 'vitest';
import { MAX_CLIPS } from '../src/shared/types';
import {
  normalizeCandidates,
  parseModelResponse,
  validateVideoUrl,
  validateMaxClips,
  assertClipInvariants,
  presetRange,
  overlaps,
  safeFileName,
  UserFacingError,
} from '../src/shared/validation';

const mk = (start: number, end: number, score = 50) => ({ start, end, title: `t${start}`, hook: 'h', reason: 'r', score });

describe('máximo de 20 clips', () => {
  it('rechaza maxClips fuera de 1..20', () => {
    expect(() => validateMaxClips(0)).toThrow(UserFacingError);
    expect(() => validateMaxClips(21)).toThrow(UserFacingError);
    expect(() => validateMaxClips(3.5)).toThrow(UserFacingError);
    expect(validateMaxClips(20)).toBe(20);
  });
  it('nunca devuelve más de 20 aunque el modelo proponga 50', () => {
    const many = Array.from({ length: 50 }, (_, i) => mk(i * 31, i * 31 + 30, i));
    const r = normalizeCandidates(many, { preset: 30, maxClips: 20, sourceDuration: 50 * 31 + 10 });
    expect(r.clips.length).toBe(MAX_CLIPS);
    expect(r.warnings.join(' ')).toMatch(/limitar/);
  });
  it('respeta un máximo menor elegido por el usuario', () => {
    const many = Array.from({ length: 10 }, (_, i) => mk(i * 31, i * 31 + 30));
    expect(normalizeCandidates(many, { preset: 30, maxClips: 3, sourceDuration: 400 }).clips.length).toBe(3);
  });
  it('assertClipInvariants falla con más del máximo', () => {
    const c = Array.from({ length: 21 }, (_, i) => ({ start: i * 31, end: i * 31 + 30 }));
    expect(() => assertClipInvariants(c, { preset: 30, maxClips: 20, sourceDuration: 10000 })).toThrow();
  });
});

describe('no solapamiento', () => {
  it('elimina solapes priorizando la mayor puntuación', () => {
    const r = normalizeCandidates([mk(0, 30, 10), mk(10, 40, 90), mk(40, 70, 50)], { preset: 30, maxClips: 5, sourceDuration: 100 });
    expect(r.clips.map((c) => c.start)).toEqual([10, 40]);
    for (let i = 1; i < r.clips.length; i++) expect(overlaps(r.clips[i - 1], r.clips[i])).toBe(false);
  });
  it('clips contiguos no cuentan como solape', () => {
    expect(overlaps({ start: 0, end: 30 }, { start: 30, end: 60 })).toBe(false);
  });
  it('assertClipInvariants detecta solapes', () => {
    expect(() =>
      assertClipInvariants([{ start: 0, end: 30 }, { start: 20, end: 50 }], { preset: 30, maxClips: 5, sourceDuration: 100 }),
    ).toThrow(/solapados/);
  });
});

describe('duraciones y timestamps', () => {
  it('descarta timestamps imposibles', () => {
    const r = normalizeCandidates(
      [mk(-5, 25), mk(200, 230), mk(50, 40), { start: 'abc', end: 10 }, { start: NaN, end: 30 }, null, 'x'],
      { preset: 30, maxClips: 5, sourceDuration: 100 },
    );
    expect(r.clips).toEqual([]);
  });
  it('ajusta un clip demasiado largo al preset', () => {
    const r = normalizeCandidates([mk(10, 90)], { preset: 30, maxClips: 5, sourceDuration: 100 });
    expect(r.clips[0].end - r.clips[0].start).toBe(30);
  });
  it('ajusta un clip que se pasa del final del vídeo', () => {
    const r = normalizeCandidates([mk(90, 120)], { preset: 30, maxClips: 5, sourceDuration: 100 });
    expect(r.clips[0]).toMatchObject({ start: 70, end: 100 });
  });
  it('todos los resultados cumplen el rango del preset', () => {
    for (const preset of [15, 30, 45, 60] as const) {
      const { min, max } = presetRange(preset);
      const r = normalizeCandidates([mk(0, 3), mk(100, 100 + preset * 3), mk(400, 400 + preset)], { preset, maxClips: 5, sourceDuration: 1000 });
      expect(r.clips.length).toBeGreaterThan(0);
      for (const c of r.clips) {
        expect(c.end - c.start).toBeGreaterThanOrEqual(min);
        expect(c.end - c.start).toBeLessThanOrEqual(max);
        expect(c.end).toBeLessThanOrEqual(1000);
      }
    }
  });
  it('acepta timestamps en formato mm:ss', () => {
    const r = normalizeCandidates([{ start: '1:00', end: '1:30', title: 'x', score: 1 }], { preset: 30, maxClips: 1, sourceDuration: 200 });
    expect(r.clips[0]).toMatchObject({ start: 60, end: 90 });
  });
  it('falla con mensaje claro si el vídeo es más corto que el preset', () => {
    expect(() => normalizeCandidates([mk(0, 10)], { preset: 60, maxClips: 1, sourceDuration: 20 })).toThrow(/preset/);
  });
});

describe('respuesta del modelo', () => {
  it('acepta {clips:[...]} y arrays directos', () => {
    expect(parseModelResponse('{"clips":[{"start":1}]}')).toHaveLength(1);
    expect(parseModelResponse('[{"start":1},{"start":2}]')).toHaveLength(2);
  });
  it('rescata JSON envuelto en texto', () => {
    expect(parseModelResponse('Aquí tienes: {"clips":[{"start":1}]} ¡suerte!')).toHaveLength(1);
  });
  it('lanza error claro con JSON inválido', () => {
    expect(() => parseModelResponse('no es json')).toThrow(UserFacingError);
    expect(() => parseModelResponse('{"clips": [')).toThrow(/JSON/);
    expect(() => parseModelResponse('{"foo": 1}')).toThrow(/lista/);
  });
});

describe('URL', () => {
  it('acepta URLs públicas https', () => {
    expect(validateVideoUrl(' https://www.youtube.com/watch?v=abc ')).toBe('https://www.youtube.com/watch?v=abc');
  });
  it.each([
    '',
    'ftp://x.com/a',
    'file:///C:/x.mp4',
    'javascript:alert(1)',
    'https://localhost/x',
    'http://127.0.0.1:8080',
    'http://192.168.1.4/v',
    'https://user:pw@site.com/v',
    'https://intranet/v',
    'https://a.com/ b',
    '--exec=calc',
  ])('rechaza %s', (u) => expect(() => validateVideoUrl(u)).toThrow(UserFacingError));
});

describe('nombres de archivo', () => {
  it('genera nombres seguros en Windows', () => {
    expect(safeFileName('¿Qué <pasa>: "aquí"?/\\|*')).toBe('Que_pasa_aqui');
    expect(safeFileName('CON')).toBe('_CON');
    expect(safeFileName('...')).toBe('clip');
    expect(safeFileName('a'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
});
