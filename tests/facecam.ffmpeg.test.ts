// Prueba REAL con FFmpeg: vídeo sintético con gameplay en blanco y negro (sin colores) y una «facecam» magenta
// con cuadrados verdes en sus cuatro esquinas. Comprueba que el resultado contiene la cámara ENTERA (las cuatro
// esquinas), sin deformarla, en su sitio y en cada formato; que la detección la encuentra y que sin cámara no se
// inventa ninguna; y que el karaoke pinta en azul sólo la palabra que se dice. Se omite si no hay FFmpeg.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findExecutable } from '../src/main/deps';
import { layoutInputFor, renderClip, type RenderEnv } from '../src/main/clipRender';
import { runProcess } from '../src/main/proc';
import { sampleFrames, frameEdgeAnalyzer } from '../src/main/visual';
import { ASPECT_RATIOS, combineDetections, outputSize, type AspectRatio } from '../src/shared/composition';
import { decideLayout, type LayoutId, type NormRect } from '../src/shared/layouts';
import { GAME_H, OUT_H } from '../src/main/layoutRender';
import type { Clip } from '../src/shared/types';

const ffmpeg = findExecutable('ffmpeg', '', null);
const SW = 1920;
const SH = 1080;
// Cámara del vídeo sintético (px) y su rectángulo normalizado: es lo que el usuario marcaría en el original.
const CAM_PX = { x: 1440, y: 700, w: 400, h: 300 };
const CAM: NormRect = { x: CAM_PX.x / SW, y: CAM_PX.y / SH, w: CAM_PX.w / SW, h: CAM_PX.h / SH };

type Px = (x: number, y: number) => [number, number, number];
const isMagenta = ([r, g, b]: [number, number, number]) => r > 170 && b > 170 && g < 100;
const isGreen = ([r, g, b]: [number, number, number]) => g > 160 && r < 110 && b < 110;
// Turquesa Surf (#00C285) de la palabra activa.
const isBlue = ([r, g, b]: [number, number, number]) => r < 70 && g > 150 && b > 90 && b < 180;

async function frameAt(file: string, t: number, dir: string, w: number, h: number): Promise<Px> {
  const raw = path.join(dir, `f_${path.basename(file)}_${t}.rgb`);
  const r = await runProcess(ffmpeg!, ['-hide_banner', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw], { timeoutMs: 60000 });
  expect(r.code).toBe(0);
  const buf = fs.readFileSync(raw);
  return (x, y) => {
    const i = (Math.floor(y) * w + Math.floor(x)) * 3;
    return [buf[i], buf[i + 1], buf[i + 2]];
  };
}

/** Caja que ocupa un color dentro de una región (px de salida). */
function bbox(px: Px, test: (c: [number, number, number]) => boolean, r: { x: number; y: number; w: number; h: number }) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  let n = 0;
  for (let y = r.y; y < r.y + r.h; y += 2)
    for (let x = r.x; x < r.x + r.w; x += 2)
      if (test(px(x, y))) {
        n++;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  return { n, x0, y0, x1, y1 };
}

function countIn(px: Px, test: (c: [number, number, number]) => boolean, x0: number, y0: number, x1: number, y1: number) {
  let n = 0;
  for (let y = Math.max(0, y0); y < y1; y += 2) for (let x = Math.max(0, x0); x < x1; x += 2) if (test(px(x, y))) n++;
  return n;
}

const clip = (template: LayoutId, aspect: AspectRatio, extra: Partial<Clip> = {}): Clip => ({
  id: `c-${template}-${aspect}`,
  index: 1,
  start: 0,
  end: 2,
  title: `${template}-${aspect.replace(':', 'x')}`,
  hook: '',
  reason: '',
  score: 80,
  layout: template,
  camRect: CAM,
  composition: { template, sourceFacecamRect: CAM, facecamPosition: 'bottom-left', outputAspectRatio: aspect, manualOverride: true } as Clip['composition'],
  ...extra,
});

describe.skipIf(!ffmpeg)('FFmpeg real: la facecam sale entera, en su sitio y sin deformar', () => {
  let dir = '';
  let withCam = '';
  let noCam = '';
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cam-'));
    withCam = path.join(dir, 'gameplay_cam.mp4');
    noCam = path.join(dir, 'gameplay.mp4');
    // Gameplay: autómata celular en blanco y negro (se mueve y no tiene colores que se confundan con la cámara).
    const game = `cellauto=s=${SW}x${SH}:rate=25:rule=110:random_fill_ratio=0.5:seed=7,format=yuv420p`;
    const corner = (x: number, y: number) => `drawbox=x=${x}:y=${y}:w=60:h=60:color=0x00FF00:t=fill`;
    const { x, y, w, h } = CAM_PX;
    const cam = [`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=0xFF00FF:t=fill`, corner(x, y), corner(x + w - 60, y), corner(x, y + h - 60), corner(x + w - 60, y + h - 60)].join(',');
    const a = await runProcess(ffmpeg!, ['-hide_banner', '-y', '-f', 'lavfi', '-i', `${game},${cam}`, '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', withCam], { timeoutMs: 180000 });
    expect(a.code).toBe(0);
    const b = await runProcess(ffmpeg!, ['-hide_banner', '-y', '-f', 'lavfi', '-i', game, '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', noCam], { timeoutMs: 180000 });
    expect(b.code).toBe(0);
  }, 240000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const env = (source: string, extra: Partial<RenderEnv> = {}): RenderEnv => ({ ffmpeg: ffmpeg!, clipsDir: dir, sourcePath: source, srcW: SW, srcH: SH, words: [], settings: { cropOffsetX: 0, subtitleFontSize: 72 }, ...extra });

  const slotOf = (c: Clip, template: LayoutId, out: { w: number; h: number }) => {
    const gH = Math.floor((out.h * (GAME_H / OUT_H)) / 2) * 2;
    if (template === 'cam_top_game_bottom') return { x: 0, y: 0, w: out.w, h: out.h - gH };
    if (template === 'game_top_cam_bottom') return { x: 0, y: gH, w: out.w, h: out.h - gH };
    const o = layoutInputFor(c, SW, SH, 0).outputCam!;
    return { x: Math.round(o.x * out.w), y: Math.round(o.y * out.h), w: Math.round(o.w * out.w), h: Math.round(o.h * out.h) };
  };
  const isCam = (p: [number, number, number]) => isMagenta(p) || isGreen(p);
  const isBlack = ([r, g, b]: [number, number, number]) => r < 24 && g < 24 && b < 24;
  // Bordes del panel (2 px hacia dentro): columnas izquierda/derecha y filas superior/inferior.
  const edges = (s: { x: number; y: number; w: number; h: number }) => {
    const pts: [number, number][] = [];
    for (let y = s.y + 2; y < s.y + s.h - 2; y += 4) pts.push([s.x + 2, y], [s.x + s.w - 3, y]);
    for (let x = s.x + 2; x < s.x + s.w - 2; x += 4) pts.push([x, s.y + 2], [x, s.y + s.h - 3]);
    return pts;
  };

  for (const template of ['cam_top_game_bottom', 'game_top_cam_bottom', 'game_cam_float', 'custom'] as LayoutId[]) {
    for (const aspect of ASPECT_RATIOS) {
      it(`cover · ${template} · ${aspect}: la cámara llena su panel, sin barras negras ni gameplay dentro`, async () => {
        const out = outputSize(aspect);
        const c = clip(template, aspect, template === 'custom' ? { composition: { template, sourceFacecamRect: CAM, outputFacecamRect: { x: 0.05, y: 0.1, w: 0.5, h: 0.3 }, outputAspectRatio: aspect, manualOverride: true } as Clip['composition'] } : {});
        const file = await renderClip(c, env(withCam));
        const px = await frameAt(path.join(dir, file), 1, dir, out.w, out.h);
        const slot = slotOf(c, template, out);
        const pts = edges(slot);
        // Ningún borde del panel es negro: no hay barras laterales ni superiores.
        expect(pts.filter(([x, y]) => isBlack(px(x, y))).length).toBe(0);
        // Todo el panel es cámara (magenta/verde): no se añadió gameplay de alrededor ni relleno.
        const camShare = pts.filter(([x, y]) => isCam(px(x, y))).length / pts.length;
        expect(camShare).toBeGreaterThan(0.97);
        // El centro de la cámara está en el centro del panel (recorte centrado en la selección).
        expect(isMagenta(px(slot.x + slot.w / 2, slot.y + slot.h / 2))).toBe(true);
      }, 90000);
    }
  }

  for (const aspect of ASPECT_RATIOS) {
    it(`contain · ${aspect}: cámara completa sobre fondo desenfocado de la propia cámara (nunca negro)`, async () => {
      const out = outputSize(aspect);
      const c = clip('cam_top_game_bottom', aspect, { title: `contain-${aspect.replace(':', 'x')}`, composition: { template: 'cam_top_game_bottom', sourceFacecamRect: CAM, facecamFit: 'contain', outputAspectRatio: aspect, manualOverride: true } as Clip['composition'] });
      const file = await renderClip(c, env(withCam));
      const px = await frameAt(path.join(dir, file), 1, dir, out.w, out.h);
      const slot = slotOf(c, 'cam_top_game_bottom', out);
      const pts = edges(slot);
      expect(pts.filter(([x, y]) => isBlack(px(x, y))).length).toBe(0);
      // Las cuatro esquinas verdes de la cámara están dentro del panel (se ve entera).
      const g = bbox(px, isGreen, slot);
      const m = bbox(px, isMagenta, slot);
      expect(g.n).toBeGreaterThan(20);
      expect(m.n).toBeGreaterThan(50);
    }, 90000);
  }

  it('detección: encuentra la cámara del vídeo sintético y la elige con confianza', async () => {
    const frames = await sampleFrames(ffmpeg!, withCam, 0, 4, path.join(dir, 'frames'), 12);
    expect(frames.length).toBeGreaterThanOrEqual(9);
    const third = Math.floor(frames.length / 3);
    const parts = [frames, frames.slice(0, third), frames.slice(third, 2 * third), frames.slice(2 * third)].map((f) => frameEdgeAnalyzer.analyze(f));
    const { consistency, ...v } = combineDetections(parts, { samples: frames.length, srcAspect: SW / SH });
    expect(v.cam).toBeDefined();
    expect(consistency).toBeGreaterThanOrEqual(0.5);
    // El rectángulo detectado cubre la cámara real (margen de la resolución de análisis 160×90).
    expect(v.cam!.x).toBeLessThanOrEqual(CAM.x + 0.003);
    expect(v.cam!.y).toBeLessThanOrEqual(CAM.y + 0.006);
    expect(v.cam!.x + v.cam!.w).toBeGreaterThanOrEqual(CAM.x + CAM.w - 0.003);
    expect(v.cam!.y + v.cam!.h).toBeGreaterThanOrEqual(CAM.y + CAM.h - 0.006);
    // Y sin pasarse demasiado (margen de seguridad de 1–2 px de análisis).
    expect(v.cam!.w).toBeLessThan(CAM.w + 0.04);
    expect(v.diagnostic?.samples).toBe(frames.length);
    expect(decideLayout('auto', v).layout).not.toBe('gameplay_full');
  }, 120000);

  it('vídeo sin facecam: no se inventa una cámara y se usa «Sin cámara: sólo gameplay»', async () => {
    const frames = await sampleFrames(ffmpeg!, noCam, 0, 4, path.join(dir, 'frames'), 12);
    const third = Math.floor(frames.length / 3);
    const parts = [frames, frames.slice(0, third), frames.slice(third, 2 * third), frames.slice(2 * third)].map((f) => frameEdgeAnalyzer.analyze(f));
    const { consistency: _c, ...v } = combineDetections(parts, { samples: frames.length, srcAspect: SW / SH });
    const d = decideLayout('auto', v);
    expect(d.layout).toBe('gameplay_full');
    const file = await renderClip(clip('gameplay_full', '9:16', { camRect: undefined, composition: undefined }), env(noCam));
    const px = await frameAt(path.join(dir, file), 1, dir, 1080, 1920);
    expect(bbox(px, isMagenta, { x: 0, y: 0, w: 1080, h: 1920 }).n).toBe(0);
  }, 120000);

  it('karaoke: frase entera visible y sólo la palabra que se dice en Turquesa Surf', async () => {
    // «Mira, mira qué músculos» con tiempos por palabra.
    const words = [
      { start: 0.2, end: 0.7, text: 'Mira,' },
      { start: 0.8, end: 1.3, text: 'mira' },
      { start: 1.4, end: 1.7, text: 'qué' },
      { start: 1.7, end: 1.95, text: 'músculos' },
    ];
    const c = clip('gameplay_full', '9:16', { camRect: undefined, composition: undefined, title: 'karaoke' });
    const file = await renderClip(c, env(noCam, { words, settings: { cropOffsetX: 0, subtitleFontSize: 90, subtitleStyle: 'karaoke' } }));
    const band = { x: 0, y: 1150, w: 1080, h: 450 };
    // Primera «MIRA» activa: el azul está a la izquierda de la frase.
    const first = bbox(await frameAt(path.join(dir, file), 0.45, dir, 1080, 1920), isBlue, band);
    // Segunda «MIRA» activa: el azul se movió a la derecha (la primera volvió a blanco).
    const second = bbox(await frameAt(path.join(dir, file), 1.05, dir, 1080, 1920), isBlue, band);
    expect(first.n).toBeGreaterThan(20);
    expect(second.n).toBeGreaterThan(20);
    expect(second.x0).toBeGreaterThan(first.x1);
    // Silencio entre palabras (0.75 s): nada en azul.
    expect(bbox(await frameAt(path.join(dir, file), 0.75, dir, 1080, 1920), isBlue, band).n).toBe(0);
    // Con estilo estándar no hay azul.
    const std = await renderClip({ ...c, title: 'estandar' }, env(noCam, { words, settings: { cropOffsetX: 0, subtitleFontSize: 90, subtitleStyle: 'standard' } }));
    expect(bbox(await frameAt(path.join(dir, std), 0.45, dir, 1080, 1920), isBlue, band).n).toBe(0);
  }, 120000);
});
