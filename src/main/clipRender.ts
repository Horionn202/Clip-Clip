// Render de un único clip con su layout. Lo usan el pipeline y el re-render individual.
import fs from 'node:fs';
import path from 'node:path';
import type { Clip, Settings } from '../shared/types';
import { UserFacingError, safeFileName } from '../shared/validation';
import { buildAss, type Word } from './media';
import { layoutFilter, layoutRenderArgs, previewArgs, type LayoutInput } from './layoutRender';
import { compositionErrors, compositionOf, cornerRect, outputSize } from '../shared/composition';
import { runProcess } from './proc';

export interface RenderEnv {
  ffmpeg: string;
  clipsDir: string;
  sourcePath: string;
  srcW: number;
  srcH: number;
  words: Word[];
  settings: Pick<Settings, 'cropOffsetX' | 'subtitleFontSize'>;
  signal?: AbortSignal;
  run?: typeof runProcess;
}

/** Entrada del filtergraph a partir de la composición del clip (compatible con clips antiguos). */
export function layoutInputFor(clip: Clip, srcW: number, srcH: number, offsetX: number): LayoutInput {
  const c = compositionOf(clip);
  const out = outputSize(c.outputAspectRatio);
  const overlay = c.template === 'custom' || c.facecamPosition === 'custom' ? c.overlayRect ?? cornerRect('top-right', 0.4, 4 / 3, out) : c.template === 'game_cam_float' ? cornerRect(c.facecamPosition, 0.4, 4 / 3, out) : undefined;
  return {
    layout: c.template,
    srcW,
    srcH,
    // El desplazamiento del clip, si se fijó, manda sobre el ajuste global.
    // Sólo un desplazamiento elegido a mano (incluido 0) manda sobre el ajuste global; el automático no.
    offsetX: clip.composition?.manualOverride && clip.composition.gameplayCrop?.x !== undefined ? clip.composition.gameplayCrop.x : offsetX,
    cam: c.facecamRect,
    out,
    gameZoom: c.gameplayCrop.zoom,
    camCrop: c.facecamCrop,
    overlay,
  };
}

export function clipFileName(clip: Clip): string {
  return `${String(clip.index).padStart(2, '0')}_${safeFileName(clip.title)}.mp4`;
}

/** Renderiza el clip y devuelve el nombre del MP4. Si cambia el nombre, borra el anterior (archivo creado por la app). */
export async function renderClip(clip: Clip, env: RenderEnv, onProgress?: (fraction: number) => void): Promise<string> {
  // Composición inválida (p. ej. «Personalizado» sin cámara): error claro, sin llegar a FFmpeg ni tocar el MP4 actual.
  const errs = compositionErrors(compositionOf(clip));
  if (errs.length) throw new UserFacingError(errs[0]);
  const assName = `${String(clip.index).padStart(2, '0')}.ass`;
  fs.writeFileSync(path.join(env.clipsDir, assName), buildAss(env.words, clip.start, clip.end, env.settings.subtitleFontSize, clip.subtitleCues, outputSize(compositionOf(clip).outputAspectRatio)), 'utf8');
  const out = clipFileName(clip);
  const tmp = `${out}.part.mp4`;
  const filter = layoutFilter(layoutInputFor(clip, env.srcW, env.srcH, env.settings.cropOffsetX));
  const total = clip.end - clip.start;
  const r = await (env.run ?? runProcess)(env.ffmpeg, layoutRenderArgs({ source: env.sourcePath, start: clip.start, end: clip.end, filter, assFile: assName, output: tmp }), {
    cwd: env.clipsDir,
    signal: env.signal,
    timeoutMs: 60 * 60 * 1000,
    onStdout: (l) => {
      const m = l.match(/^out_time_us=(\d+)/);
      if (m && onProgress) onProgress(Math.min(1, parseInt(m[1]) / 1e6 / total));
    },
  });
  const tmpPath = path.join(env.clipsDir, tmp);
  if (r.code !== 0 || !fs.existsSync(tmpPath)) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignorar */
    }
    throw new UserFacingError(`No se pudo renderizar el clip ${clip.index}.`, r.stderr);
  }
  // Sustitución atómica: el clip anterior sólo se reemplaza cuando el nuevo está completo.
  fs.renameSync(tmpPath, path.join(env.clipsDir, out));
  if (clip.file && clip.file !== out) {
    try {
      fs.unlinkSync(path.join(env.clipsDir, clip.file));
    } catch {
      /* ignorar */
    }
  }
  return out;
}

/** Fotograma de vista previa (360×640) con el layout aplicado. */
export async function renderPreview(env: Omit<RenderEnv, 'words'>, clip: Clip, framesDir: string, outName: string): Promise<string> {
  const errs = compositionErrors(compositionOf(clip));
  if (errs.length) throw new UserFacingError(errs[0]);
  fs.mkdirSync(framesDir, { recursive: true });
  const filter = layoutFilter(layoutInputFor(clip, env.srcW, env.srcH, env.settings.cropOffsetX));
  const r = await (env.run ?? runProcess)(env.ffmpeg, previewArgs({ source: env.sourcePath, at: (clip.start + clip.end) / 2, filter, output: path.join(framesDir, outName) }), {
    signal: env.signal,
    timeoutMs: 60_000,
  });
  if (r.code !== 0) throw new UserFacingError('No se pudo generar la vista previa.', r.stderr);
  return outName;
}

/** Fotograma de referencia del origen (640×360) para ajustar la facecam a mano. */
export async function renderThumb(ffmpeg: string, source: string, at: number, framesDir: string, outName: string, signal?: AbortSignal): Promise<string | null> {
  fs.mkdirSync(framesDir, { recursive: true });
  const r = await runProcess(ffmpeg, ['-hide_banner', '-y', '-ss', at.toFixed(2), '-i', source, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', path.join(framesDir, outName)], {
    signal,
    timeoutMs: 60_000,
  });
  return r.code === 0 ? outName : null;
}
