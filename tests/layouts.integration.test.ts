// Integración real con FFmpeg: vídeo sintético con «gameplay» en movimiento y una facecam fija con marco.
// Comprueba el análisis visual sobre fotogramas reales y que cada layout produce 1080×1920. Se omite sin FFmpeg.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findExecutable } from '../src/main/deps';
import { runProcess } from '../src/main/proc';
import { frameEdgeAnalyzer, sampleFrames } from '../src/main/visual';
import { renderClip, renderPreview } from '../src/main/clipRender';
import { LAYOUT_IDS } from '../src/shared/layouts';
import type { Clip } from '../src/shared/types';

const ffmpeg = findExecutable('ffmpeg', '', null);
const ffprobe = findExecutable('ffprobe', '', null);
let dir = '';
let src = '';

describe.skipIf(!ffmpeg || !ffprobe)('layouts con FFmpeg real', () => {
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-layout-'));
    src = path.join(dir, 'source.mp4');
    // testsrc2 se mueve en cada fotograma; encima, un recuadro fijo (marco blanco) abajo a la derecha = «facecam».
    const r = await runProcess(
      ffmpeg!,
      ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=12',
        '-filter_complex', '[0:v]drawbox=x=900:y=430:w=340:h=250:color=white:t=8,drawbox=x=908:y=438:w=324:h=234:color=0x405060:t=fill[v]',
        '-map', '[v]', '-map', '1:a', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', src],
      { timeoutMs: 120000 },
    );
    expect(r.code).toBe(0);
  }, 120000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('el análisis visual encuentra la facecam en fotogramas reales', async () => {
    const frames = await sampleFrames(ffmpeg!, src, 1, 11, path.join(dir, 'frames'), 6);
    expect(frames.length).toBe(6);
    const v = frameEdgeAnalyzer.analyze(frames);
    expect(v.cls).toBe('facecam_inferior');
    expect(v.cam!.x).toBeGreaterThan(0.6);
    expect(v.cam!.y).toBeGreaterThan(0.5);
  }, 120000);

  it.each(LAYOUT_IDS)('layout %s → MP4 1080×1920', async (layout) => {
    const clipsDir = path.join(dir, `clips_${layout}`);
    fs.mkdirSync(clipsDir, { recursive: true });
    const clip: Clip = { id: 'aaaaaaaa-1', index: 1, start: 1, end: 7, title: 'Prueba', hook: 'h', reason: 'r', score: 1, layout, camRect: { x: 0.7, y: 0.6, w: 0.27, h: 0.35 } };
    const env = { ffmpeg: ffmpeg!, clipsDir, sourcePath: src, srcW: 1280, srcH: 720, words: [{ start: 1.2, end: 1.8, text: ' Hola' }], settings: { cropOffsetX: 0, subtitleFontSize: 60 } };
    const file = await renderClip(clip, env);
    const p = await runProcess(ffprobe!, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', path.join(clipsDir, file)]);
    expect(JSON.parse(p.stdout).streams[0]).toMatchObject({ width: 1080, height: 1920 });
    expect(fs.readdirSync(clipsDir).some((f) => f.includes('.part.'))).toBe(false);
  }, 120000);

  it('re-render con otro título sustituye el archivo anterior', async () => {
    const clipsDir = path.join(dir, 'clips_rename');
    fs.mkdirSync(clipsDir, { recursive: true });
    const env = { ffmpeg: ffmpeg!, clipsDir, sourcePath: src, srcW: 1280, srcH: 720, words: [], settings: { cropOffsetX: 0, subtitleFontSize: 60 } };
    const clip: Clip = { id: 'aaaaaaaa-1', index: 1, start: 1, end: 5, title: 'Antes', hook: 'h', reason: 'r', score: 1 };
    clip.file = await renderClip(clip, env);
    const second = await renderClip({ ...clip, title: 'Después' }, env);
    expect(fs.readdirSync(clipsDir).filter((f) => f.endsWith('.mp4'))).toEqual([second]);
  }, 120000);

  it('vista previa de un layout en JPEG', async () => {
    const framesDir = path.join(dir, 'frames');
    const env = { ffmpeg: ffmpeg!, clipsDir: dir, sourcePath: src, srcW: 1280, srcH: 720, settings: { cropOffsetX: 0, subtitleFontSize: 60 } };
    const clip: Clip = { id: 'aaaaaaaa-1', index: 1, start: 1, end: 7, title: 'P', hook: 'h', reason: 'r', score: 1, layout: 'cam_top_game_bottom', camRect: { x: 0.7, y: 0.6, w: 0.27, h: 0.35 } };
    const name = await renderPreview(env, clip, framesDir, '01_preview.jpg');
    expect(fs.statSync(path.join(framesDir, name)).size).toBeGreaterThan(1000);
  }, 120000);
});
