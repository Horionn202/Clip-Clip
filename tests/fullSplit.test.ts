// «Dividir video completo»: cortes sin huecos, más de 20 clips, límite de 200, calificación por segmento,
// destacados sin copias y exportación a «Destacados». Sin red.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DURATION_PRESETS, type Clip } from '../src/shared/types';
import { FULL_SPLIT_SAFE_LIMIT, SPLIT_MIN_TAIL, clipLimits, coverage, cutPoints, filterSegments, splitFullVideo, splitPlan } from '../src/shared/fullSplit';
import { assertClipInvariants, presetRange } from '../src/shared/validation';
import { createJobSchema } from '../src/main/ipcSchemas';
import { applyClipPatch } from '../src/shared/clipEdit';
import { rateSegments, ratingBatches } from '../src/main/segmentRating';
import { VERIFIER_SYSTEM_PROMPT, isVerifiedHighlight } from '../src/shared/highlights';
import { copyClipOut } from '../src/main/exportClip';
import type { ChatFn } from '../src/main/analysis';
import type { TimedWord } from '../src/shared/selection';

const segs = (d: number, p: (typeof DURATION_PRESETS)[number], mode: 'exact' | 'smart' = 'exact', words: TimedWord[] = []) => splitFullVideo(d, p, mode, words).map((s) => [s.start, s.end]);

describe('corte exacto', () => {
  it('125 s en bloques de 60 s → 0–60, 60–120, 120–125', () => {
    expect(segs(125, 60)).toEqual([
      [0, 60],
      [60, 120],
      [120, 125],
    ]);
  });

  it('125 s en bloques de 2 min → 0–120 y 120–125 (el último se conserva si dura ≥ 5 s)', () => {
    expect(SPLIT_MIN_TAIL).toBe(5);
    expect(segs(125, 120)).toEqual([
      [0, 120],
      [120, 125],
    ]);
  });

  it('un resto de menos de 5 s se suma al bloque anterior', () => {
    expect(segs(122, 120)).toEqual([[0, 122]]);
    expect(segs(62.5, 30)).toEqual([
      [0, 30],
      [30, 62.5],
    ]);
  });

  it('vídeos más cortos que un bloque: un único segmento con todo', () => {
    expect(segs(40, 60)).toEqual([[0, 40]]);
    expect(segs(0, 60)).toEqual([]);
  });

  it('nunca hay huecos, solapes ni tiempos fuera del vídeo', () => {
    for (const p of DURATION_PRESETS) {
      for (const d of [7, 59.99, 60, 61, 125.37, 599.5, 3601.23, 7322.8]) {
        const s = splitFullVideo(d, p);
        const cov = coverage(s, d);
        expect(cov.gaps, `${d}/${p}`).toEqual([]);
        expect(cov.coveredSec).toBeCloseTo(Math.floor(d * 100) / 100, 2);
        expect(s[0].start).toBe(0);
        for (const [i, x] of s.entries()) {
          expect(x.end).toBeGreaterThan(x.start);
          expect(x.end).toBeLessThanOrEqual(d);
          if (i) expect(x.start).toBe(s[i - 1].end);
        }
      }
    }
  });
});

describe('corte inteligente', () => {
  /** Frases de 8 s: «...». al final; pausa entre frases de 0,5 s. */
  const words: TimedWord[] = [];
  for (let t = 0; t < 300; t += 8.5) for (let k = 0; k < 20; k++) words.push({ start: t + k * 0.4, end: t + k * 0.4 + 0.36, text: k === 19 ? ' fin.' : ' palabra' });

  it('mueve cada corte a la pausa o final de frase más cercano (±5 s)', () => {
    const s = splitFullVideo(300, 60, 'smart', words);
    const points = cutPoints(words);
    for (const x of s.slice(0, -1)) {
      expect(points).toContain(x.end);
      expect(Math.abs(x.end - Math.round(x.end / 60) * 60)).toBeLessThanOrEqual(5);
    }
  });

  it('conserva toda la cobertura y, sin puntos seguros, usa el corte exacto', () => {
    const s = splitFullVideo(300, 60, 'smart', words);
    expect(coverage(s, 300).gaps).toEqual([]);
    expect(s[s.length - 1].end).toBe(300);
    expect(segs(300, 60, 'smart', [])).toEqual(segs(300, 60, 'exact'));
  });
});

describe('cantidad de clips', () => {
  it('puede superar 20 clips (cubre todo el vídeo)', () => {
    expect(splitPlan(3600, 60).count).toBe(60);
    expect(createJobSchema.parse({ url: 'https://www.youtube.com/watch?v=abc', preset: 60, maxClips: 20, rightsConfirmed: true, creationMode: 'full-split', boundaryMode: 'smart' }).creationMode).toBe('full-split');
    const sixty = splitFullVideo(3600, 60);
    expect(() => assertClipInvariants(sixty, { preset: 60, maxClips: 20, sourceDuration: 3600, creationMode: 'full-split' })).not.toThrow();
    // En el modo de IA el tope de 20 sigue igual.
    expect(() => assertClipInvariants(sixty, { preset: 60, maxClips: 20, sourceDuration: 3600 })).toThrow(/máximo de clips/);
  });

  it('más de 200 segmentos exige confirmación; el último corto está permitido', () => {
    const plan = splitPlan(3601, 15);
    expect(plan.count).toBeGreaterThan(FULL_SPLIT_SAFE_LIMIT);
    expect(plan.needsConfirm).toBe(true);
    expect(splitPlan(1800, 15).needsConfirm).toBe(false);
    expect(plan.lastSec).toBeCloseTo(16, 0);
  });

  it('los trabajos de IA conservan sus límites; los de vídeo completo admiten el último corto', () => {
    expect(clipLimits(60)).toEqual(presetRange(60));
    expect(clipLimits(60, 'ai-highlights')).toEqual(presetRange(60));
    expect(clipLimits(60, 'full-split').min).toBeLessThan(5);
    const last: Clip = { id: 'z', index: 3, start: 120, end: 125, title: 't', hook: 'h', reason: 'r', score: 1 };
    expect(() => applyClipPatch('z', { start: 120, end: 124 }, { clips: [last], preset: 60, sourceDuration: 125, creationMode: 'full-split' })).not.toThrow();
    expect(() => applyClipPatch('z', { start: 120, end: 124 }, { clips: [last], preset: 60, sourceDuration: 125 })).toThrow(/entre 45 y 61/);
  });
});

describe('calificación y destacados', () => {
  // 10 min: presentación, luego la carrera empieza a los 4 min y se gana a los 8 min.
  const segments: TimedWord[] = [];
  const say = (at: number, text: string) => segments.push({ start: at, end: at + 4, text: ` ${text}` });
  for (let t = 0; t < 600; t += 5) say(t, 'Seguimos hablando un poco de cosas del juego y del día de hoy.');
  segments.find((s) => s.start === 240)!.text = ' Empieza la carrera ya, vamos con todo.';
  segments.find((s) => s.start === 480)!.text = ' He ganado la carrera de motos, primera posición.';
  const words: TimedWord[] = segments.flatMap((s) => s.text.trim().split(' ').map((w, i, a) => ({ start: s.start + (i * 4) / a.length, end: s.start + ((i + 1) * 4) / a.length - 0.05, text: ` ${w}` })));
  const split = splitFullVideo(600, 60);
  const TITLE = 'MI PRIMERA CARRERA DE MOTOS';

  /** IA simulada: puntúa alto los segmentos que hablan de la carrera; el verificador aprueba la frase del inicio. */
  const chat: ChatFn = async (system, user, n, schema) => {
    if (system === VERIFIER_SYSTEM_PROMPT) {
      const first = user.split('DURANTE')[1].match(/\[([\d.]+)\] (.*)/)!;
      const ok = /carrera/i.test(first[2]);
      return JSON.stringify({ approved: ok, event_type: ok ? (/ganado/.test(first[2]) ? 'resultado' : 'inicio_real') : 'contexto', evidence_quote: first[2], evidence_start: Number(first[1]), corrected_title: first[2], corrected_hook: first[2], confidence: 92, reason: 'Se oye en el segmento.' });
    }
    if (!schema || !('properties' in schema) || !(schema as { properties: Record<string, unknown> }).properties.segments) return JSON.stringify({});
    const ids = [...user.matchAll(/SEGMENTO id=(\d+)/g)].map((m) => Number(m[1]));
    return JSON.stringify({
      segments: ids.map((id) => {
        const hot = id === 5 || id === 9;
        return { id, score: hot ? 95 : 40, topic_relevance: hot ? 95 : 30, hook_strength: hot ? 90 : 40, payoff_strength: hot ? 90 : 40, self_contained: 80, moment_type: hot ? 'accion' : 'relleno', title: hot ? 'La carrera' : 'Charla', why: hot ? 'Momento de la carrera' : 'Conversación' };
      }),
    });
  };

  it('todos los segmentos existen; la IA sólo califica y marca los mejores como destacados verificados', async () => {
    const r = await rateSegments({ segs: split, segments, words, duration: 600, preset: 60, title: TITLE, chat });
    expect(r.clips).toHaveLength(split.length);
    expect(r.clips.map((c) => [c.start, c.end])).toEqual(split.map((s) => [s.start, s.end]));
    const stars = r.clips.filter((c) => isVerifiedHighlight(c.editorial));
    expect(stars.map((c) => c.start)).toEqual([240, 480]);
    for (const c of stars) {
      expect(c.editorial!.verification!.quote).toMatch(/carrera/i);
      expect(c.editorial!.verification!.evidenceStart - c.start).toBeLessThanOrEqual(15);
    }
    for (const c of r.clips.filter((x) => !isVerifiedHighlight(x.editorial))) {
      expect(c.editorial?.featured).toBe(false);
      expect(typeof c.editorial?.score).toBe('number');
    }
    expect(r.report.featured).toBe(2);
  });

  it('caso real: ids en texto o sin id, y segmentos olvidados que se piden aparte', async () => {
    const calls: number[][] = [];
    const sloppy: ChatFn = async (_s, user, _n, schema) => {
      if (!schema || !(schema as { properties: Record<string, unknown> }).properties.segments) return '{}';
      const ids = [...user.matchAll(/SEGMENTO id=(\d+)/g)].map((m) => Number(m[1]));
      calls.push(ids);
      const item = (id: number | string) => ({ id, score: 60, topic_relevance: 60, hook_strength: 60, payoff_strength: 60, self_contained: 60, moment_type: 'accion', title: `Tramo ${id}`, why: 'Algo pasa' });
      // Primer lote: ids en texto y se «olvida» el último; reintentos: sin id válido pero uno por segmento.
      if (ids.length > 1) return JSON.stringify({ segments: ids.slice(0, -1).map((i) => item(String(i))) });
      return JSON.stringify({ segments: [item('x')] });
    };
    const r = await rateSegments({ segs: split, segments, words, duration: 600, preset: 60, title: TITLE, chat: sloppy });
    expect(r.clips.every((c) => c.editorial?.momentType === 'accion')).toBe(true);
    expect(calls.some((c) => c.length === 1)).toBe(true);
  });

  it('si la IA no responde, los segmentos siguen todos, con nota local y sin estrellas', async () => {
    const r = await rateSegments({ segs: split, segments, words, duration: 600, preset: 60, title: TITLE, chat: async () => 'no es json' });
    expect(r.clips).toHaveLength(split.length);
    expect(r.clips.every((c) => !c.editorial?.featured && c.editorial?.auto)).toBe(true);
  });

  it('un evento a mitad de un segmento no lo convierte en destacado (los segmentos no se mueven)', async () => {
    const mid = segments.map((s) => (s.start === 240 ? { ...s, text: ' Seguimos hablando.' } : s.start === 270 ? { ...s, text: ' Empieza la carrera ya, vamos con todo.' } : s));
    const r = await rateSegments({ segs: split, segments: mid, words: [], duration: 600, preset: 60, title: TITLE, chat });
    expect(r.clips.find((c) => c.start === 240)?.editorial?.featured).toBe(false);
    expect(r.clips.map((c) => c.start)).toEqual(split.map((s) => s.start));
  });

  it('los lotes cubren todos los segmentos una sola vez', () => {
    const b = ratingBatches(split, segments, 900);
    expect(b.flat()).toEqual(split.map((_, i) => i));
    expect(b.length).toBeGreaterThan(1);
  });

  it('las pestañas filtran sin crear copias: un destacado es el mismo clip', () => {
    const clips = split.map((s, i) => ({ id: `c${i}`, start: s.start, file: i === 3 ? undefined : `${i}.mp4`, editorial: i === 5 ? { verification: { confidence: 90 } } : undefined }));
    const star = (c: (typeof clips)[number]) => !!c.editorial;
    expect(filterSegments(clips, 'destacados', star).map((c) => c.id)).toEqual(['c5']);
    expect(filterSegments(clips, 'destacados', star)[0]).toBe(clips[5]);
    expect(filterSegments(clips, 'otros', star)).toHaveLength(split.length - 1);
    expect(filterSegments(clips, 'pendientes', star).map((c) => c.id)).toEqual(['c3']);
    expect(filterSegments(clips, 'todos', star)).toHaveLength(split.length);
  });
});

describe('exportar destacados sin duplicar dentro de la app', () => {
  let root = '';
  beforeEach(() => (root = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-export-'))));
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('copia sólo a la carpeta externa «Destacados»; dentro del trabajo cada clip existe una vez', () => {
    const jobsDir = path.join(root, 'jobs');
    const clipsDir = path.join(jobsDir, 'job-1', 'clips');
    fs.mkdirSync(clipsDir, { recursive: true });
    for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(clipsDir, `0${i}.mp4`), `clip ${i}`);
    const exportDir = path.join(root, 'Clip Clip Exports');
    const before = fs.readdirSync(clipsDir).sort();
    const out = copyClipOut({ jobsDir, clipsDir, clip: { file: '02.mp4', index: 2 }, exportDir, subfolder: 'Destacados' });
    expect(out).toBe(path.join(exportDir, 'Destacados', '02.mp4'));
    expect(fs.readFileSync(out, 'utf8')).toBe('clip 2');
    expect(fs.readdirSync(clipsDir).sort()).toEqual(before);
    // Una segunda exportación no sobrescribe: crea «02 (2).mp4».
    expect(path.basename(copyClipOut({ jobsDir, clipsDir, clip: { file: '02.mp4', index: 2 }, exportDir, subfolder: 'Destacados' }))).toBe('02 (2).mp4');
  });

  it('nunca exporta dentro de los datos internos ni clips con cambios sin renderizar', () => {
    const jobsDir = path.join(root, 'jobs');
    const clipsDir = path.join(jobsDir, 'job-1', 'clips');
    fs.mkdirSync(clipsDir, { recursive: true });
    fs.writeFileSync(path.join(clipsDir, '01.mp4'), 'x');
    expect(() => copyClipOut({ jobsDir, clipsDir, clip: { file: '01.mp4', index: 1 }, exportDir: path.join(jobsDir, 'job-1') })).toThrow(/datos internos/);
    expect(() => copyClipOut({ jobsDir, clipsDir, clip: { file: '01.mp4', index: 1, dirty: true }, exportDir: path.join(root, 'out') })).toThrow(/sin renderizar/);
  });
});
