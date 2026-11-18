// LayoutStrategy: construye el filtergraph de FFmpeg de cada layout vertical 1080×1920. Puro y testeable.
import type { LayoutId, NormRect } from '../shared/layouts';
import { NEEDS_CAM } from '../shared/layouts';

export const OUT_W = 1080;
export const OUT_H = 1920;
/** Reparto vertical en layouts apilados: gameplay 1216 px + facecam 704 px. */
export const GAME_H = 1216;
export const CAM_H = OUT_H - GAME_H;

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
const evenPos = (n: number) => Math.max(0, Math.floor(n / 2) * 2);

export interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Ajusta un rectángulo al aspecto pedido expandiéndolo alrededor de su centro (sin recortar la cámara)
 * y lo mantiene dentro del fotograma.
 */
export function fitAspect(r: PxRect, aspect: number, srcW: number, srcH: number): PxRect {
  let w = r.w;
  let h = r.h;
  if (w / h > aspect) h = w / aspect;
  else w = h * aspect;
  if (w > srcW) {
    w = srcW;
    h = w / aspect;
  }
  if (h > srcH) {
    h = srcH;
    w = h * aspect;
  }
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const x = Math.min(Math.max(0, cx - w / 2), srcW - w);
  const y = Math.min(Math.max(0, cy - h / 2), srcH - h);
  return { x: evenPos(x), y: evenPos(y), w: even(w), h: even(h) };
}

export function toPx(r: NormRect, srcW: number, srcH: number): PxRect {
  return { x: r.x * srcW, y: r.y * srcH, w: r.w * srcW, h: r.h * srcH };
}

/**
 * Recorte de gameplay con el aspecto dado, a toda la altura. Si hay facecam, se desplaza para no
 * incluirla cuando es posible; si no, usa el desplazamiento horizontal del usuario (-1..1).
 */
export function gameplayCrop(aspect: number, srcW: number, srcH: number, offsetX: number, cam?: PxRect): PxRect {
  let h = srcH;
  let w = h * aspect;
  if (w > srcW) {
    w = srcW;
    h = w / aspect;
  }
  const free = srcW - w;
  let x = (free / 2) * (1 + Math.max(-1, Math.min(1, offsetX)));
  if (cam) {
    const camCx = cam.x + cam.w / 2;
    // Facecam a la derecha → gameplay pegado a la izquierda de la cámara (y viceversa).
    if (camCx > srcW / 2) x = Math.min(x, Math.max(0, cam.x - w));
    else x = Math.max(x, Math.min(free, cam.x + cam.w));
  }
  return { x: evenPos(Math.min(Math.max(0, x), free)), y: evenPos((srcH - h) / 2), w: even(w), h: even(h) };
}

export interface LayoutInput {
  layout: LayoutId;
  srcW: number;
  srcH: number;
  offsetX: number;
  cam?: NormRect;
}

/**
 * Filtergraph que produce la etiqueta [v] (1080×1920, SAR 1). Lanza si el layout necesita facecam
 * y no hay rectángulo: nunca se inventa una posición.
 */
export function layoutFilter(i: LayoutInput): string {
  const { srcW, srcH } = i;
  if (NEEDS_CAM.includes(i.layout) && !i.cam) throw new Error(`El layout ${i.layout} necesita la posición de la facecam.`);
  const camPx = i.cam ? toPx(i.cam, srcW, srcH) : undefined;
  const crop = (r: PxRect) => `crop=${r.w}:${r.h}:${r.x}:${r.y}`;
  switch (i.layout) {
    case 'gameplay_full': {
      const g = gameplayCrop(OUT_W / OUT_H, srcW, srcH, i.offsetX);
      return `[0:v]${crop(g)},scale=${OUT_W}:${OUT_H}:flags=lanczos,setsar=1[v]`;
    }
    case 'no_facecam':
      // Se ve el vídeo entero (nada se oculta) sobre un fondo difuminado del propio vídeo.
      return (
        `[0:v]split=2[bgsrc][fgsrc];` +
        `[bgsrc]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},boxblur=20:2,setsar=1[bg];` +
        // Cabe entero en 1080×1920 en ambos ejes (vídeos anchos o más estrechos que 9:16), con dimensiones pares.
        `[fgsrc]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,setsar=1[fg];` +
        `[bg][fg]overlay=(W-w)/2:(H-h)/2[v]`
      );
    case 'game_top_cam_bottom':
    case 'cam_top_game_bottom': {
      const g = gameplayCrop(OUT_W / GAME_H, srcW, srcH, i.offsetX, camPx);
      const c = fitAspect(camPx!, OUT_W / CAM_H, srcW, srcH);
      const top = i.layout === 'game_top_cam_bottom' ? '[g][c]' : '[c][g]';
      return (
        `[0:v]split=2[gsrc][csrc];` +
        `[gsrc]${crop(g)},scale=${OUT_W}:${GAME_H}:flags=lanczos,setsar=1[g];` +
        `[csrc]${crop(c)},scale=${OUT_W}:${CAM_H}:flags=lanczos,setsar=1[c];` +
        `${top}vstack=inputs=2[v]`
      );
    }
    case 'game_cam_float': {
      const g = gameplayCrop(OUT_W / OUT_H, srcW, srcH, i.offsetX, camPx);
      const c = fitAspect(camPx!, 4 / 3, srcW, srcH);
      return (
        `[0:v]split=2[gsrc][csrc];` +
        `[gsrc]${crop(g)},scale=${OUT_W}:${OUT_H}:flags=lanczos,setsar=1[base];` +
        `[csrc]${crop(c)},scale=432:324:flags=lanczos,setsar=1[cam];` +
        `[base][cam]overlay=W-w-40:140[v]`
      );
    }
  }
}

/** Argumentos de FFmpeg para renderizar un clip con layout y subtítulos (ASS por nombre relativo al cwd). */
export function layoutRenderArgs(p: { source: string; start: number; end: number; filter: string; assFile: string | null; output: string }): string[] {
  if (p.assFile && !/^[A-Za-z0-9_.-]+\.ass$/.test(p.assFile)) throw new Error('Nombre de subtítulos no seguro');
  const graph = p.assFile ? `${p.filter};[v]ass=${p.assFile}[vout]` : `${p.filter};[v]null[vout]`;
  return [
    '-hide_banner',
    '-y',
    '-ss',
    p.start.toFixed(2),
    '-to',
    p.end.toFixed(2),
    '-i',
    p.source,
    '-filter_complex',
    graph,
    '-map',
    '[vout]',
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '21',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    p.output,
  ];
}

/** Un solo fotograma (JPEG pequeño) con el layout aplicado, para la vista previa. */
export function previewArgs(p: { source: string; at: number; filter: string; output: string }): string[] {
  return ['-hide_banner', '-y', '-ss', p.at.toFixed(2), '-i', p.source, '-filter_complex', `${p.filter};[v]scale=360:640[vout]`, '-map', '[vout]', '-frames:v', '1', '-q:v', '4', p.output];
}
