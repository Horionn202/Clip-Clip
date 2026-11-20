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
  settings: Pick<Settings, 'cropOffsetX' | 'subtitleFontSize'> & Partial<Pick<Settings, 'subtitleStyle' | 'subtitleActiveColor'>>;
  signal?: AbortSignal;
  run?: typeof runProcess;
}

/** Entrada del filtergraph a partir de la composición del clip (compatible con clips antiguos). */
export function layoutInputFor(clip: Clip, srcW: number, srcH: number, offsetX: number): LayoutInput {
  const c = compositionOf(clip);
  const out = outputSize(c.outputAspectRatio);
  // La caja de salida por defecto usa la proporción REAL de la cámara elegida (así no hay que rellenar ni deformar).
  const camAspect = c.sourceFacecamRect ? Math.min(3, Math.max(0.5, (c.sourceFacecamRect.w * srcW) / (c.sourceFacecamRect.h * srcH))) : 4 / 3;
  const outputCam =
    c.template === 'custom' || c.facecamPosition === 'custom'
      ? c.outputFacecamRect ?? cornerRect('top-right', 0.4, camAspect, out)
      : c.template === 'game_cam_float'
        ? cornerRect(c.facecamPosition, 0.4, camAspect, out)
        : undefined;
  return {
    layout: c.template,
    srcW,
    srcH,
    // El desplazamiento del clip, si se fijó, manda sobre el ajuste global.
    // Sólo un desplazamiento elegido a mano (incluido 0) manda sobre el ajuste global; el automático no.
    offsetX: clip.composition?.manualOverride && clip.composition.gameplayCrop?.x !== undefined ? clip.composition.gameplayCrop.x : offsetX,
    sourceCam: c.sourceFacecamRect,
    out,
    gameZoom: c.gameplayCrop.zoom,
    camCrop: c.facecamCrop,
    outputCam,
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
  fs.writeFileSync(path.join(env.clipsDir, assName), buildAss(env.words, clip.start, clip.end, env.settings.subtitleFontSize, clip.subtitleCues, outputSize(compositionOf(clip).outputAspectRatio), { style: env.settings.subtitleStyle, activeColor: env.settings.subtitleActiveColor }), 'utf8');
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
  let name: string;
  try {
    name = await placeRendered(env.clipsDir, tmp, out);
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignorar */
    }
    throw e;
  }
  for (const old of new Set([clip.file, out])) {
    if (!old || old === name) continue;
    try {
      fs.unlinkSync(path.join(env.clipsDir, old));
    } catch {
      /* en uso (Windows): se queda y se sustituirá en el próximo render */
    }
  }
  return name;
}

const busy = (e: unknown) => ['EPERM', 'EBUSY', 'EACCES'].includes((e as NodeJS.ErrnoException)?.code ?? '');
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Mueve el render terminado a su nombre final. En Windows un MP4 abierto (el reproductor de Resultados o del editor)
 * no se puede sustituir: se reintenta un momento y, si sigue en uso, el clip nuevo se guarda con otro nombre en vez de
 * fallar (el anterior se borra cuando se pueda). Devuelve el nombre usado.
 */
export async function placeRendered(dir: string, tmp: string, out: string, retries = 5): Promise<string> {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(path.join(dir, tmp), path.join(dir, out));
      return out;
    } catch (e) {
      if (!busy(e)) throw e;
      if (i >= retries) break;
      await pause(150);
    }
  }
  const alt = out.replace(/\.mp4$/i, `_v${Date.now().toString(36)}.mp4`);
  fs.renameSync(path.join(dir, tmp), path.join(dir, alt));
  return alt;
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
