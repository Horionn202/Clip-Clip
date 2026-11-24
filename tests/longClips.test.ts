// Clips de hasta 2 minutos: presets 90 y 120, validación, selección, edición, directos y render real con subtítulos.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DURATION_PRESETS, MAX_CLIP_SEC, clipLengthLabel, presetLabel } from '../src/shared/types';
import { presetRange, validatePreset, assertClipInvariants } from '../src/shared/validation';
import { createJobSchema } from '../src/main/ipcSchemas';
import { effectiveTarget, evaluateCandidate, feasibilityAdvice, feasibleMax, longestSilence, requiredDuration, selectRound } from '../src/shared/selection';
import { otherMoments } from '../src/shared/otherMoments';
import { adjustRange, applyClipPatch } from '../src/shared/clipEdit';
import { liveSettingsError, minLiveBlockSec, validateLiveSettings } from '../src/shared/live';
import { estimateJob } from '../src/shared/estimates';
import { longClipRules } from '../src/main/analysis';
import { stepsFor } from '../src/renderer/components/TimeRangeEditor';
import { fallbackBrief, topicKeywords } from '../src/shared/editorialBrief';
import { findExecutable } from '../src/main/deps';
import { runProcess } from '../src/main/proc';
import { renderClip } from '../src/main/clipRender';
import type { Clip } from '../src/shared/types';
import type { TimedWord } from '../src/shared/selection';

/** Habla continua a ~2,5 palabras/s, con punto cada 10 palabras. */
function speech(duration: number, gapAt?: [number, number]): TimedWord[] {
  const out: TimedWord[] = [];
  let i = 0;
  for (let t = 0; t + 0.4 <= duration; t += 0.4) {
    if (gapAt && t >= gapAt[0] && t < gapAt[1]) continue;
    out.push({ start: t, end: t + 0.36, text: i % 10 === 9 ? ' carrera.' : i % 10 === 0 ? ' Hablo' : ' sobre' });
    i++;
  }
  return out;
}

describe('presets de 90 s y 2 min', () => {
  it('existen 15, 30, 45, 60, 90 y 120, y 120 es el máximo', () => {
    expect([...DURATION_PRESETS]).toEqual([15, 30, 45, 60, 90, 120]);
    expect(MAX_CLIP_SEC).toBe(120);
    expect(presetLabel(120)).toBe('2 min');
    expect(presetLabel(90)).toBe('90 s');
  });

  it('valida 90 y 120 y rechaza 121 y valores arbitrarios', () => {
    expect(validatePreset(90)).toBe(90);
    expect(validatePreset(120)).toBe(120);
    for (const v of [121, 75, 0, -15, 61, '60', 120.5]) expect(() => validatePreset(v), String(v)).toThrow(/2 minutos/);
    const ok = { url: 'https://www.youtube.com/watch?v=abc', maxClips: 5, rightsConfirmed: true };
    expect(createJobSchema.parse({ ...ok, preset: 120 }).preset).toBe(120);
    expect(createJobSchema.parse({ ...ok, preset: 90 }).preset).toBe(90);
    expect(createJobSchema.safeParse({ ...ok, preset: 121 }).success).toBe(false);
    expect(createJobSchema.safeParse({ ...ok, preset: 75 }).success).toBe(false);
  });

  it('mantiene la tolerancia: 75 % del preset y preset + 1 s', () => {
    expect(presetRange(120)).toEqual({ min: 90, max: 121 });
    expect(presetRange(90)).toEqual({ min: 68, max: 91 });
    expect(presetRange(60)).toEqual({ min: 45, max: 61 });
  });

  it('duraciones legibles en resultados', () => {
    expect(clipLengthLabel(90)).toBe('1 min 30 s');
    expect(clipLengthLabel(120)).toBe('2 min');
    expect(clipLengthLabel(119.6)).toBe('2 min');
    expect(clipLengthLabel(45.3)).toBe('45.3 s');
  });
});

describe('máximo factible y avisos', () => {
  it('un vídeo de 10 min no da 20 clips de 2 min: caben 5 y se avisa antes de iniciar', () => {
    expect(feasibleMax(600, 120)).toBe(5);
    expect(effectiveTarget(20, 600, 120)).toBe(5);
    expect(feasibilityAdvice(20, 600, 120)).toMatch(/como máximo 5 clips de 120 s/);
    expect(requiredDuration(20, 120)).toBe(2400);
    expect(feasibleMax(119, 120)).toBe(0);
  });

  it('el espacio y el render estimados crecen con la duración de cada clip', () => {
    const short = estimateJob(600, 50e6, null, [], { count: 5, preset: 15 });
    const long = estimateJob(600, 50e6, null, [], { count: 5, preset: 120 });
    expect(long.diskBytes).toBeGreaterThan(short.diskBytes);
    expect(long.renderSec).toBe(short.renderSec * 8);
  });
});

describe('selección con clips de 2 min', () => {
  const words = speech(1200);
  const topic = { keywords: topicKeywords(fallbackBrief('Mi carrera'), 'Mi carrera'), brief: fallbackBrief('Mi carrera'), minScore: 70 };
  const raw = (start: number, p: Record<string, unknown> = {}) => ({ start, end: start + 120, title: ['Salida en el puerto con la moto', 'Choque brutal en la autopista', 'Derrape nocturno bajo la lluvia', 'Victoria final en la playa'][[0, 60, 130, 300].indexOf(start)] ?? `Tramo ${start}`, hook: 'Hablo sobre la carrera', reason: 'Se habla de la carrera con detalle', score: 90, topic_relevance: 90, hook_strength: 90, payoff_strength: 90, self_contained: 90, moment_type: 'accion', ...p });

  it('el prompt exige gancho, contexto, desarrollo y cierre sólo con clips largos', () => {
    expect(longClipRules(120)).toMatch(/gancho.*contexto.*desarrollo.*desenlace/s);
    expect(longClipRules(120)).toMatch(/NO lo propongas/);
    expect(longClipRules(60)).toBe('');
  });

  it('no solapa y respeta la duración de 2 min', () => {
    const r = selectRound([raw(0), raw(60), raw(130), raw(300)], 5, { preset: 120, sourceDuration: 1200, words, taken: [], topic });
    expect(r.accepted.length).toBeGreaterThanOrEqual(2);
    expect(() => assertClipInvariants([...r.accepted].sort((a, b) => a.start - b.start), { preset: 120, maxClips: 5, sourceDuration: 1200 })).not.toThrow();
    for (const c of r.accepted) expect(c.end - c.start).toBeGreaterThanOrEqual(90);
  });

  it('un clip largo con un silencio largo se descarta', () => {
    const gappy = speech(1200, [40, 60]);
    expect(longestSilence(0, 120, gappy)).toBeGreaterThan(12);
    expect(evaluateCandidate(raw(0), { preset: 120, sourceDuration: 1200, words: gappy, taken: [], topic })).toEqual({ ok: false, reason: 'poca_voz' });
  });

  it('sin desenlace un clip largo no aspira a destacado (queda como otro momento)', () => {
    const ev = evaluateCandidate(raw(0, { payoff_strength: 30 }), { preset: 120, sourceDuration: 1200, words, taken: [], topic });
    if (!ev.ok) throw new Error(ev.reason);
    expect(ev.candidate.editorial?.featured).toBe(false);
    const good = evaluateCandidate(raw(0), { preset: 120, sourceDuration: 1200, words, taken: [], topic });
    if (good.ok) expect(good.candidate.editorial?.featured).toBe(true);
  });

  it('«Otros momentos» completa con tramos de 2 min sin solapes', () => {
    const segs = Array.from({ length: 120 }, (_, k) => ({ start: k * 10, end: k * 10 + 9.6, text: ' Hablo sobre la carrera con mucho detalle y sigo contando cosas.' }));
    const r = otherMoments({ segments: segs, words, duration: 1200, preset: 120, topic, taken: [], filler: [], need: 10 });
    expect(r).toHaveLength(10);
    expect(() => assertClipInvariants([...r].sort((a, b) => a.start - b.start), { preset: 120, maxClips: 10, sourceDuration: 1200 })).not.toThrow();
  });
});

describe('edición de un clip de 2 min', () => {
  const words = speech(600);
  const clip: Clip = { id: 'a', index: 1, start: 100, end: 220, title: 'Clip largo', hook: 'h', reason: 'r', score: 80, file: '01.mp4', rendered: { start: 100, end: 220, layout: 'gameplay_full' } };

  it('±30 s sólo con clips de 90 s o 2 min', () => {
    expect(stepsFor(120)).toEqual([-30, -15, -5, 5, 15, 30]);
    expect(stepsFor(90)).toContain(30);
    expect(stepsFor(60)).toEqual([-15, -5, 5, 15]);
  });

  it('respeta los límites de 2 min y ajusta a palabras', () => {
    const o = { preset: 120 as const, sourceDuration: 600, words, snap: true };
    expect(adjustRange({ start: 100, end: 220 }, { edge: 'start', to: 70 }, o).start).toBeGreaterThanOrEqual(220 - 121);
    expect(adjustRange({ start: 100, end: 220 }, { edge: 'end', to: 400 }, o).end).toBeLessThanOrEqual(221);
    expect(adjustRange({ start: 100, end: 220 }, { edge: 'start', to: 150 }, o).start).toBeLessThanOrEqual(130);
  });

  it('guardar un tramo de 2 min nuevo lo deja pendiente de render', () => {
    const next = applyClipPatch('a', { start: 130, end: 250 }, { clips: [clip], preset: 120, sourceDuration: 600 });
    expect(next.dirty).toBe(true);
    expect(() => applyClipPatch('a', { start: 100, end: 230 }, { clips: [clip], preset: 120, sourceDuration: 600 })).toThrow(/entre 90 y 121/);
  });

  it('un trabajo antiguo de 60 s sigue editándose igual', () => {
    const old: Clip = { ...clip, start: 100, end: 160, rendered: { start: 100, end: 160, layout: 'gameplay_full' } };
    expect(applyClipPatch('a', { start: 105, end: 160 }, { clips: [old], preset: 60, sourceDuration: 600 }).dirty).toBe(true);
    expect(() => applyClipPatch('a', { start: 100, end: 200 }, { clips: [old], preset: 60, sourceDuration: 600 })).toThrow(/entre 45 y 61/);
  });
});

describe('directos con clips de 90 s y 2 min', () => {
  it('el bloque mínimo sube con el preset', () => {
    expect(minLiveBlockSec(60)).toBe(70);
    expect(minLiveBlockSec(90)).toBe(135);
    expect(minLiveBlockSec(120)).toBe(180);
  });
  it('un bloque de 60 s para clips de 2 min es inválido; uno de 180 s, válido', () => {
    expect(liveSettingsError({ preset: 120, blockSec: 60 })).toMatch(/al menos 180 s/);
    expect(liveSettingsError({ preset: 120, blockSec: 180 })).toBeNull();
    expect(liveSettingsError({ preset: 90, blockSec: 100 })).toMatch(/al menos 135 s/);
  });
  it('al guardar se corrige al mínimo seguro y se mantiene el solape', () => {
    const s = validateLiveSettings({ preset: 120, blockSec: 60, overlapSec: 4 });
    expect(s).toMatchObject({ preset: 120, blockSec: 180, overlapSec: 4 });
    expect(validateLiveSettings({ preset: 90 }).blockSec).toBe(135);
    expect(validateLiveSettings({ preset: 75 as never }).preset).toBe(15);
  });
});

const ffmpeg = findExecutable('ffmpeg', '', null);
const ffprobe = findExecutable('ffprobe', '', null);
describe.skipIf(!ffmpeg || !ffprobe)('render real de un clip de 2 min', () => {
  it('MP4 vertical de 2 min con subtítulos y facecam, sin duplicar subtítulos', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-long-'));
    try {
      const src = path.join(dir, 'source.mp4');
      const gen = await runProcess(ffmpeg!, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=130', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=130', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', src], { timeoutMs: 300000 });
      expect(gen.code).toBe(0);
      const clipsDir = path.join(dir, 'clips');
      fs.mkdirSync(clipsDir);
      const words = speech(130).map((w, i) => ({ ...w, text: ` palabra${i}` }));
      const clip: Clip = { id: 'bbbbbbbb-1', index: 1, start: 5, end: 125, title: 'Clip de dos minutos', hook: 'h', reason: 'r', score: 1, layout: 'cam_top_game_bottom', camRect: { x: 0.7, y: 0.6, w: 0.27, h: 0.35 } };
      const progress: number[] = [];
      const file = await renderClip(clip, { ffmpeg: ffmpeg!, clipsDir, sourcePath: src, srcW: 1280, srcH: 720, words, settings: { cropOffsetX: 0, subtitleFontSize: 60, subtitleStyle: 'karaoke' } }, (f) => progress.push(f));
      const p = await runProcess(ffprobe!, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', path.join(clipsDir, file)]);
      const j = JSON.parse(p.stdout);
      expect(j.streams[0]).toMatchObject({ width: 1080, height: 1920 });
      expect(parseFloat(j.format.duration)).toBeCloseTo(120, 0);
      // Subtítulos: todas las palabras del tramo, ninguna de fuera, nunca dos subtítulos a la vez y todo dentro de 0–120 s.
      const ass = fs.readFileSync(path.join(clipsDir, '01.ass'), 'utf8');
      const dialogue = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
      const text = dialogue.join('\n').toUpperCase();
      const inside = words.filter((w) => w.start >= 5 && w.end <= 125).map((w) => w.text.trim().toUpperCase());
      const outside = words.filter((w) => w.end < 5 || w.start > 125).map((w) => w.text.trim().toUpperCase());
      expect(inside.length).toBeGreaterThan(250);
      for (const w of inside) expect(new RegExp(`\\b${w}\\b`).test(text), w).toBe(true);
      for (const w of outside) expect(new RegExp(`\\b${w}\\b`).test(text), w).toBe(false);
      const secs = (t: string) => t.split(':').reduce((a, x) => a * 60 + Number(x), 0);
      const spans = dialogue.map((l) => l.split(',').slice(1, 3).map(secs)).sort((a, b) => a[0] - b[0]);
      for (const [i, [a, b]] of spans.entries()) {
        expect(a).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThanOrEqual(120.01);
        if (i) expect(a, 'subtítulos superpuestos').toBeGreaterThanOrEqual(spans[i - 1][1] - 0.001);
      }
      // El progreso llega hasta el final.
      expect(Math.max(...progress)).toBeGreaterThan(0.9);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 600000);
});
