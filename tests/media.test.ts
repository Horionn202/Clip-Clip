import { describe, it, expect } from 'vitest';
import { escapeAssText, buildAss, centerCrop, renderArgs, assTime, parseWhisperJson } from '../src/main/media';

describe('subtítulos ASS', () => {
  it('neutraliza tags de override, barras y saltos', () => {
    const e = escapeAssText('hola {\\pos(0,0)\\c&HFF&} mundo\\Nnuevo\nlinea');
    expect(e).not.toMatch(/[{}\\\n]/);
    expect(e).toContain('hola');
  });
  it('genera eventos relativos al clip', () => {
    const ass = buildAss([{ start: 10, end: 10.5, text: ' hola' }, { start: 10.5, end: 11, text: ' {mundo}' }], 10, 40);
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,HOLA ｛MUNDO｝');
    expect(ass).toContain('PlayResY: 1920');
  });
  it('assTime', () => {
    expect(assTime(3725.456)).toBe('1:02:05.46');
  });
});

describe('encuadre', () => {
  it('crop central 16:9 → 9:16', () => {
    expect(centerCrop(0).compute(1920, 1080)).toEqual({ x: 656, y: 0, w: 606, h: 1080 });
  });
  it('desplazamiento a los extremos sin salirse', () => {
    expect(centerCrop(-1).compute(1920, 1080).x).toBe(0);
    const r = centerCrop(1).compute(1920, 1080);
    expect(r.x + r.w).toBeLessThanOrEqual(1920);
  });
  it('vídeo ya vertical', () => {
    expect(centerCrop(0).compute(1080, 1920)).toEqual({ x: 0, y: 0, w: 1080, h: 1920 });
  });
});

describe('argumentos FFmpeg', () => {
  const crop = { x: 0, y: 0, w: 2, h: 2 };
  it('rechaza nombres de subtítulos inseguros', () => {
    expect(() => renderArgs({ source: 's.mp4', start: 0, end: 1, crop, assFile: "a',x=.ass", output: 'o.mp4' })).toThrow();
  });
  it('pasa la ruta de origen como argumento separado', () => {
    const a = renderArgs({ source: 'C:\\a b\\src.mp4', start: 1, end: 31, crop, assFile: '01.ass', output: 'o.mp4' });
    expect(a[a.indexOf('-i') + 1]).toBe('C:\\a b\\src.mp4');
    expect(a.join(' ')).toContain('ass=01.ass');
  });
});

describe('whisper', () => {
  it('parsea palabras con timestamps', () => {
    const r = parseWhisperJson(
      JSON.stringify({ segments: [{ start: 0, end: 2, text: ' Hola mundo', words: [{ start: 0, end: 1, word: ' Hola' }, { start: 1, end: 2, word: ' mundo' }] }] }),
    );
    expect(r.words).toHaveLength(2);
    expect(r.segments[0].text).toBe('Hola mundo');
  });
});
