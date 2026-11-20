// LayoutStrategy: construye el filtergraph de FFmpeg de cada layout vertical 1080×1920. Puro y testeable.
import type { LayoutId, NormRect } from '../shared/layouts';
import { NEEDS_CAM } from '../shared/layouts';

export const OUT_W = 1080;
export const OUT_H = 1920;
/** Reparto vertical en layouts apilados (como un Short): facecam 40 % (768 px) + gameplay 60 % (1152 px). */
export const GAME_H = 1152;
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

/** Selección de la cámara en píxeles pares, siempre dentro del fotograma (nunca se recorta más de lo elegido). */
export function selectionPx(sel: PxRect, srcW: number, srcH: number): PxRect {
  const x = evenPos(Math.min(Math.max(0, sel.x), srcW - 2));
  const y = evenPos(Math.min(Math.max(0, sel.y), srcH - 2));
  return { x, y, w: even(Math.min(sel.w + (sel.x - x), srcW - x)), h: even(Math.min(sel.h + (sel.y - y), srcH - y)) };
}

export type CamFit = 'cover' | 'contain';

/**
 * Desenfoque del fondo de `contain` acotado al tamaño del panel. FFmpeg rechaza un radio mayor que la mitad del
 * plano: en YUV 4:2:0 el croma mide la mitad, así que su radio máximo es min(ancho, alto)/4. Con paneles pequeños
 * (p. ej. una cámara flotante de 54 px) un radio fijo rompería la vista previa y el render.
 */
export function blurFor(tw: number, th: number, wanted = 18): string {
  const m = Math.min(tw, th);
  const luma = Math.max(0, Math.min(wanted, Math.floor(m / 2) - 1));
  const chroma = Math.max(0, Math.min(wanted, Math.floor(m / 4) - 1));
  return `boxblur=luma_radius=${luma}:luma_power=2:chroma_radius=${chroma}:chroma_power=2`;
}

/**
 * Ventana «cover» dentro de la selección: el mayor rectángulo con el aspecto del panel que cabe en la cámara elegida,
 * dividido por el zoom y desplazado por el encuadre (-1..1). Nunca sale de la selección ni del fotograma, así que el
 * panel se llena sin barras y sin deformar; sólo se recorta lo imprescindible.
 */
export function coverRect(sel: PxRect, aspect: number, srcW: number, srcH: number, crop: { x: number; y: number; zoom: number } = { x: 0, y: 0, zoom: 1 }): PxRect {
  // Se recorta un 1 % de cada borde: el marco de la ventana y el píxel de borde que la detección (a 160×90) no
  // puede separar del fondo no aparecen como una franja de gameplay. En «cover» el panel se recorta igualmente.
  const raw = selectionPx(sel, srcW, srcH);
  const ix = Math.max(2, raw.w * 0.01);
  const iy = Math.max(2, raw.h * 0.01);
  const s = selectionPx({ x: raw.x + ix, y: raw.y + iy, w: raw.w - 2 * ix, h: raw.h - 2 * iy }, srcW, srcH);
  let w = s.w;
  let h = w / aspect;
  if (h > s.h) {
    h = s.h;
    w = h * aspect;
  }
  const z = Math.max(1, Math.min(4, crop.zoom || 1));
  w /= z;
  h /= z;
  const cl = (n: number) => Math.max(-1, Math.min(1, n || 0));
  // Centro de la selección (punto focal) + encuadre manual dentro del margen que deja el recorte.
  const cx = s.x + s.w / 2 + ((s.w - w) / 2) * cl(crop.x);
  const cy = s.y + s.h / 2 + ((s.h - h) / 2) * cl(crop.y);
  const W = even(Math.min(w, s.w));
  const H = even(Math.min(h, s.h));
  const x = evenPos(Math.min(Math.max(s.x, cx - W / 2), s.x + s.w - W));
  const y = evenPos(Math.min(Math.max(s.y, cy - H / 2), s.y + s.h - H));
  return { x: Math.min(x, srcW - W), y: Math.min(y, srcH - H), w: W, h: H };
}

/**
 * Subgrafo de la facecam: `[inL]` → `[outL]` de tw×th, a partir de `sourceFacecamRect` (la cámara en el vídeo original).
 * - `cover` (por defecto, como un Short): llena el panel; recorta sólo lo imprescindible alrededor del centro de la
 *   selección, con zoom y encuadre del usuario. Nunca hay barras negras ni deformación.
 * - `contain` («Mostrar cámara completa»): la cámara entera sobre un fondo desenfocado de la propia cámara (nunca negro).
 */
export function camChain(sel: PxRect, tw: number, th: number, srcW: number, srcH: number, inL = 'csrc', outL = 'c', fit: CamFit = 'cover', crop: { x: number; y: number; zoom: number } = { x: 0, y: 0, zoom: 1 }): string {
  if (fit === 'cover') {
    const r = coverRect(sel, tw / th, srcW, srcH, crop);
    return `[${inL}]crop=${r.w}:${r.h}:${r.x}:${r.y},scale=${tw}:${th}:flags=lanczos,setsar=1[${outL}]`;
  }
  const z = zoomRect(selectionPx(sel, srcW, srcH), crop.zoom, srcW, srcH, crop.x, crop.y);
  const c = `crop=${z.w}:${z.h}:${z.x}:${z.y}`;
  if (Math.abs(z.w / z.h / (tw / th) - 1) <= 0.02) return `[${inL}]${c},scale=${tw}:${th}:flags=lanczos,setsar=1[${outL}]`;
  return (
    `[${inL}]${c},split=2[${outL}bgs][${outL}fgs];` +
    `[${outL}bgs]scale=${tw}:${th}:force_original_aspect_ratio=increase,crop=${tw}:${th},${blurFor(tw, th)},eq=brightness=-0.08,setsar=1[${outL}bg];` +
    `[${outL}fgs]scale=${tw}:${th}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,setsar=1[${outL}fg];` +
    `[${outL}bg][${outL}fg]overlay=(W-w)/2:(H-h)/2[${outL}]`
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
  /** Cámara DENTRO del vídeo original: lo único que se recorta de la fuente. */
  sourceCam?: NormRect;
  /** Tamaño de salida (por defecto 1080×1920). */
  out?: { w: number; h: number };
  /** Zoom del gameplay (≥ 1) y encuadre dentro de la cámara. */
  gameZoom?: number;
  camCrop?: { x: number; y: number; zoom: number };
  /** Cámara DENTRO del vídeo final (normalizada a la salida): sólo «flotante» y «personalizado». */
  outputCam?: NormRect;
  /** Cómo encaja la cámara en su panel: `cover` (llenar, por defecto) o `contain` (cámara completa). */
  camFit?: CamFit;
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
  if ((NEEDS_CAM.includes(i.layout) || i.layout === 'custom') && !i.sourceCam) throw new Error(`El layout ${i.layout} necesita la posición de la facecam.`);
  const cc = i.camCrop ?? { x: 0, y: 0, zoom: 1 };
  // Selección de la cámara en el original (sin zoom): el zoom y el encuadre los aplica camChain según el modo.
  const camPx = i.sourceCam ? selectionPx(toPx(i.sourceCam, srcW, srcH), srcW, srcH) : undefined;
  const fit: CamFit = i.camFit ?? 'cover';
  const gz = i.gameZoom ?? 1;
  const crop = (r: PxRect) => `crop=${r.w}:${r.h}:${r.x}:${r.y}`;
  // El desplazamiento también actúa dentro del recorte ampliado (si no, con el mismo aspecto no habría margen para moverlo).
  const game = (aspect: number, cam?: PxRect) => zoomRect(gameplayCrop(aspect, srcW, srcH, i.offsetX, cam), gz, srcW, srcH, i.offsetX);
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
        `${camChain(camPx!, W, cH, srcW, srcH, 'csrc', 'c', fit, cc)};` +
        `${top}vstack=inputs=2[v]`
      );
    }
    case 'game_cam_float':
    case 'custom': {
      const g = game(W / H, camPx);
      const def = { x: 1 - 0.4 - 40 / W, y: 140 / H, w: 0.4, h: (0.4 * W * 0.75) / H };
      const b = box(i.outputCam ?? def);
      return (
        `[0:v]split=2[gsrc][csrc];` +
        `[gsrc]${crop(g)},scale=${W}:${H}:flags=lanczos,setsar=1[base];` +
        `${camChain(camPx!, b.w, b.h, srcW, srcH, 'csrc', 'cam', fit, cc)};` +
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
