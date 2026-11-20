// Editor y render de un clip: composición, subtítulos, fallos de render y FFmpeg real por plantilla y formato.
// La parte con FFmpeg se omite si no está instalado.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findExecutable } from '../src/main/deps';
import { renderClip, renderPreview, type RenderEnv } from '../src/main/clipRender';
import { runProcess } from '../src/main/proc';
import { applyClipPatch, renderedState, differsFromRendered } from '../src/shared/clipEdit';
import { buildCues } from '../src/shared/cues';
import { LAYOUT_IDS } from '../src/shared/layouts';
import { ASPECT_RATIOS, cornerRect, outputSize } from '../src/shared/composition';
import type { Clip } from '../src/shared/types';

const CAM = { x: 0.74, y: 0.66, w: 0.24, h: 0.3 };
const clip = (p: Partial<Clip> = {}): Clip => ({ id: 'c1', index: 1, start: 2, end: 17, title: 'Prueba', hook: '', reason: '', score: 80, ...p });
const ctx = (c: Clip) => ({ clips: [c], preset: 15 as const, sourceDuration: 60 });

describe('editor: validación y estado', () => {
  it('«Personalizado» sin cámara: error claro antes de FFmpeg y sin tocar el MP4 actual', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ed-'));
    try {
      fs.writeFileSync(path.join(dir, '01_Prueba.mp4'), 'anterior');
      let ran = false;
      const env = { ffmpeg: 'ffmpeg', clipsDir: dir, sourcePath: 'x', srcW: 1920, srcH: 1080, words: [], settings: { cropOffsetX: 0, subtitleFontSize: 72 }, run: async () => ((ran = true), { code: 0, stdout: '', stderr: '' }) } as RenderEnv;
      await expect(renderClip(clip({ file: '01_Prueba.mp4', layout: 'custom', composition: { template: 'custom' } }), env)).rejects.toThrow(/posición de la cámara/);
      await expect(renderPreview(env, clip({ layout: 'custom', composition: { template: 'custom' } }), dir, 'p.jpg')).rejects.toThrow(/posición de la cámara/);
      expect(ran).toBe(false);
      expect(fs.readFileSync(path.join(dir, '01_Prueba.mp4'), 'utf8')).toBe('anterior');
      expect(() => applyClipPatch('c1', { composition: { template: 'custom' } }, ctx(clip()))).toThrow(/cámara/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('si FFmpeg falla, se conservan el MP4 anterior y no queda archivo temporal', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ed-'));
    try {
      fs.writeFileSync(path.join(dir, '01_Prueba.mp4'), 'anterior');
      const env = { ffmpeg: 'ffmpeg', clipsDir: dir, sourcePath: 'x', srcW: 1920, srcH: 1080, words: [], settings: { cropOffsetX: 0, subtitleFontSize: 72 }, run: async () => ({ code: 1, stdout: '', stderr: 'boom' }) } as RenderEnv;
      await expect(renderClip(clip({ file: '01_Prueba.mp4' }), env)).rejects.toThrow(/No se pudo renderizar/);
      expect(fs.readFileSync(path.join(dir, '01_Prueba.mp4'), 'utf8')).toBe('anterior');
      expect(fs.readdirSync(dir).filter((f) => f.includes('.part'))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renderedState representa exactamente lo renderizado (composición y subtítulos)', () => {
    const c = applyClipPatch('c1', { composition: { template: 'game_cam_float', facecamRect: CAM, facecamPosition: 'bottom-left', outputAspectRatio: '1:1' }, subtitleCues: [{ start: 0, end: 1, text: 'hola' }] }, ctx(clip()));
    const r = { ...c, rendered: renderedState(c), dirty: false };
    expect(differsFromRendered(r, r.rendered!)).toBe(false);
    const moved = applyClipPatch('c1', { composition: { template: 'game_cam_float', facecamRect: CAM, facecamPosition: 'top-left', outputAspectRatio: '1:1' } }, ctx(r));
    expect(moved.dirty).toBe(true);
  });

  it('«Restablecer» sin cambios reales no marca el clip como pendiente', () => {
    const c = clip({ file: '01.mp4' });
    expect(applyClipPatch('c1', { composition: null, subtitleCues: null }, ctx(c)).dirty).toBeFalsy();
    const edited = clip({ file: '01.mp4', subtitleCues: [{ start: 0, end: 1, text: 'x' }] });
    expect(applyClipPatch('c1', { subtitleCues: null }, ctx(edited)).dirty).toBe(true);
  });

  it('subtítulos editados enviados junto al nuevo tramo no se desplazan dos veces', () => {
    const c = clip({ subtitleCues: [{ start: 5, end: 6, text: 'hola' }] });
    // El editor ya los envía relativos al nuevo inicio (4): el servidor no vuelve a desplazarlos.
    const n = applyClipPatch('c1', { start: 4, end: 19, subtitleCues: [{ start: 3, end: 4, text: 'hola' }] }, ctx(c));
    expect(n.subtitleCues).toEqual([{ start: 3, end: 4, text: 'hola' }]);
    // Y los que quedarían fuera del clip se recortan.
    const out = applyClipPatch('c1', { start: 2, end: 17, subtitleCues: [{ start: 14, end: 40, text: 'final' }] }, ctx(c));
    expect(out.subtitleCues).toEqual([{ start: 14, end: 15, text: 'final' }]);
  });

  it('transcripción sin palabras: sin subtítulos y sin errores', () => {
    expect(buildCues([], 0, 15)).toEqual([]);
  });
});

const ffmpeg = findExecutable('ffmpeg', '', null);
const ffprobe = findExecutable('ffprobe', '', null);

describe.skipIf(!ffmpeg || !ffprobe)('FFmpeg real: cada plantilla en 9:16, 1:1 y 16:9', () => {
  let dir = '';
  let src = '';
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tpl-'));
    src = path.join(dir, 'source.mp4');
    const g = await runProcess(ffmpeg!, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', src], { timeoutMs: 120000 });
    expect(g.code).toBe(0);
  }, 120000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  for (const template of LAYOUT_IDS) {
    for (const aspect of ASPECT_RATIOS) {
      it(`${template} · ${aspect}`, async () => {
        const out = outputSize(aspect);
        const c = clip({
          index: 1,
          start: 0,
          end: 2,
          title: `${template}-${aspect.replace(':', 'x')}`,
          layout: template,
          camRect: CAM,
          composition: { template, facecamRect: CAM, facecamPosition: 'bottom-right', overlayRect: template === 'custom' ? cornerRect('bottom-left', 0.35, 4 / 3, out) : undefined, outputAspectRatio: aspect, gameplayCrop: { x: 0.3, zoom: 1.2 }, facecamCrop: { x: 0, y: 0, zoom: 1.1 }, manualOverride: true },
        });
        const env: RenderEnv = { ffmpeg: ffmpeg!, clipsDir: dir, sourcePath: src, srcW: 1920, srcH: 1080, words: [{ start: 0.2, end: 0.6, text: 'Hola' }, { start: 0.7, end: 1.2, text: 'mundo' }], settings: { cropOffsetX: 0, subtitleFontSize: 72 } };
        const file = await renderClip(c, env);
        const p = await runProcess(ffprobe!, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', path.join(dir, file)]);
        expect(JSON.parse(p.stdout).streams[0]).toMatchObject({ width: out.w, height: out.h });
      }, 60000);
    }
  }
});
