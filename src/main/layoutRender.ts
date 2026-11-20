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

/** true si el recorte ampliado contiene entera la selección de la facecam. */
export function containsSelection(c: PxRect, sel: PxRect): boolean {
  return c.x <= sel.x + 1 && c.y <= sel.y + 1 && c.x + c.w >= sel.x + sel.w - 1 && c.y + c.h >= sel.y + sel.h - 1;
}

/**
 * Cadena de filtros de la facecam a tw×th. Normalmente amplía la selección al aspecto de destino; si esa
 * ampliación no cabe en el fotograma (p. ej. una selección muy alta), conserva la selección entera y la
 * rellena con bandas en vez de recortar parte de la cámara.
 */
export function camChain(sel: PxRect, tw: number, th: number, srcW: number, srcH: number): string {
  const c = fitAspect(sel, tw / th, srcW, srcH);
  if (containsSelection(c, sel)) return `crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${tw}:${th}:flags=lanczos,setsar=1`;
  const s = { x: evenPos(sel.x), y: evenPos(sel.y), w: even(Math.min(sel.w, srcW - evenPos(sel.x))), h: even(Math.min(sel.h, srcH - evenPos(sel.y))) };
  return (
    `crop=${s.w}:${s.h}:${s.x}:${s.y},` +
    `scale=${tw}:${th}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,` +
    `pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`
  );
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
  /** Tamaño de salida (por defecto 1080×1920). */
  out?: { w: number; h: number };
  /** Zoom del gameplay (≥ 1) y encuadre dentro de la cámara. */
  gameZoom?: number;
  camCrop?: { x: number; y: number; zoom: number };
  /** Caja de la cámara en la salida (normalizada) para «flotante» y «personalizado». */
  overlay?: NormRect;
}

/** Aplica zoom (≥ 1) a un recorte, alrededor de su centro, sin salir del fotograma. */
export function zoomRect(r: PxRect, zoom: number, srcW: number, srcH: number, panX = 0, panY = 0): PxRect {
  const z = Math.max(1, Math.min(4, zoom || 1));
  if (z === 1 && !panX && !panY) return r;
  const w = r.w / z;
  const h = r.h / z;
  const cx = r.x + r.w / 2 + ((r.w - w) / 2) * Math.max(-1, Math.min(1, panX));
  const cy = r.y + r.h / 2 + ((r.h - h) / 2) * Math.max(-1, Math.min(1, panY));
  const x = Math.min(Math.max(0, cx - w / 2), srcW - w);
  const y = Math.min(Math.max(0, cy - h / 2), srcH - h);
  return { x: evenPos(x), y: evenPos(y), w: even(w), h: even(h) };
}

/**
 * Filtergraph que produce la etiqueta [v] (tamaño de salida, SAR 1). Lanza si el layout necesita facecam
 * y no hay rectángulo: nunca se inventa una posición.
 */
export function layoutFilter(i: LayoutInput): string {
  const { srcW, srcH } = i;
  const W = even(i.out?.w ?? OUT_W);
  const H = even(i.out?.h ?? OUT_H);
  const gH = even(H * (GAME_H / OUT_H));
  const cH = H - gH;
  if ((NEEDS_CAM.includes(i.layout) || i.layout === 'custom') && !i.cam) throw new Error(`El layout ${i.layout} necesita la posición de la facecam.`);
  const cc = i.camCrop ?? { x: 0, y: 0, zoom: 1 };
  const camPx = i.cam ? zoomRect(toPx(i.cam, srcW, srcH), cc.zoom, srcW, srcH, cc.x, cc.y) : undefined;
  const gz = i.gameZoom ?? 1;
  const crop = (r: PxRect) => `crop=${r.w}:${r.h}:${r.x}:${r.y}`;
  const game = (aspect: number, cam?: PxRect) => zoomRect(gameplayCrop(aspect, srcW, srcH, i.offsetX, cam), gz, srcW, srcH);
  // Caja de la cámara en la salida (píxeles pares, dentro del lienzo).
  const box = (r: NormRect) => {
    const w = even(Math.min(W, r.w * W));
    const h = even(Math.min(H, r.h * H));
    return { w, h, x: evenPos(Math.min(W - w, Math.max(0, r.x * W))), y: evenPos(Math.min(H - h, Math.max(0, r.y * H))) };
  };
  switch (i.layout) {
    case 'gameplay_full': {
      const g = game(W / H);
      return `[0:v]${crop(g)},scale=${W}:${H}:flags=lanczos,setsar=1[v]`;
    }
    case 'no_facecam':
      // Se ve el vídeo entero (nada se oculta) sobre un fondo difuminado del propio vídeo.
      return (
        `[0:v]split=2[bgsrc][fgsrc];` +
        `[bgsrc]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:2,setsar=1[bg];` +
        `[fgsrc]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,setsar=1[fg];` +
        `[bg][fg]overlay=(W-w)/2:(H-h)/2[v]`
      );
    case 'game_top_cam_bottom':
    case 'cam_top_game_bottom': {
      const g = game(W / gH, camPx);
      const top = i.layout === 'game_top_cam_bottom' ? '[g][c]' : '[c][g]';
      return (
        `[0:v]split=2[gsrc][csrc];` +
        `[gsrc]${crop(g)},scale=${W}:${gH}:flags=lanczos,setsar=1[g];` +
        `[csrc]${camChain(camPx!, W, cH, srcW, srcH)}[c];` +
        `${top}vstack=inputs=2[v]`
      );
    }
    case 'game_cam_float':
    case 'custom': {
      const g = game(W / H, camPx);
      const def = { x: 1 - 0.4 - 40 / W, y: 140 / H, w: 0.4, h: (0.4 * W * 0.75) / H };
      const b = box(i.overlay ?? def);
      return (
        `[0:v]split=2[gsrc][csrc];` +
        `[gsrc]${crop(g)},scale=${W}:${H}:flags=lanczos,setsar=1[base];` +
        `[csrc]${camChain(camPx!, b.w, b.h, srcW, srcH)}[cam];` +
        `[base][cam]overlay=${b.x}:${b.y}[v]`
      );
    }
    case 'split_horizontal': {
      // Mitad izquierda del origen arriba y mitad derecha abajo (p. ej. dos jugadores o cámara + juego lado a lado).
      const half = H / 2;
      const left = zoomRect(fitAspect({ x: 0, y: 0, w: srcW / 2, h: srcH }, W / half, srcW / 2, srcH), gz, srcW / 2, srcH);
      const right = { ...left, x: evenPos(left.x + srcW / 2) };
      return (
        `[0:v]split=2[a][b];` +
        `[a]${crop(left)},scale=${W}:${even(half)}:flags=lanczos,setsar=1[top];` +
        `[b]${crop(right)},scale=${W}:${H - even(half)}:flags=lanczos,setsar=1[bot];` +
        `[top][bot]vstack=inputs=2[v]`
      );
    }
    case 'split_vertical': {
      const half = even(W / 2);
      const l = zoomRect(fitAspect({ x: 0, y: 0, w: srcW / 2, h: srcH }, half / H, srcW / 2, srcH), gz, srcW / 2, srcH);
      const r = { ...l, x: evenPos(l.x + srcW / 2) };
      return (
        `[0:v]split=2[a][b];` +
        `[a]${crop(l)},scale=${half}:${H}:flags=lanczos,setsar=1[lf];` +
        `[b]${crop(r)},scale=${W - half}:${H}:flags=lanczos,setsar=1[rt];` +
        `[lf][rt]hstack=inputs=2[v]`
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
  return ['-hide_banner', '-y', '-ss', p.at.toFixed(2), '-i', p.source, '-filter_complex', `${p.filter};[v]scale=360:-2[vout]`, '-map', '[vout]', '-frames:v', '1', '-q:v', '4', p.output];
}
