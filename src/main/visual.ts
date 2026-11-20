// VisualAnalyzer: análisis visual ligero sólo sobre los clips candidatos.
// Motor por defecto (sin dependencias): busca el marco rectangular de una facecam superpuesta, es decir,
// bordes rectos que permanecen fijos en todos los fotogramas muestreados mientras el gameplay cambia.
// Experimental. Se puede sustituir por otro motor (p. ej. detección de caras con OpenCV) con la misma interfaz.
import fs from 'node:fs';
import path from 'node:path';
import type { NormRect, VisualClass, VisualResult } from '../shared/layouts';
import { runProcess } from './proc';

export interface GrayFrame {
  w: number;
  h: number;
  data: Uint8Array;
}

export interface VisualAnalyzer {
  readonly name: string;
  analyze(frames: GrayFrame[]): VisualResult;
}

/** Tamaño de análisis: pequeño a propósito (rápido y suficiente para bordes de un recuadro). */
export const ANALYSIS_W = 160;
export const ANALYSIS_H = 90;

/** Mapas de bordes persistentes: mínimo en el tiempo del gradiente (un borde fijo aparece en todos los fotogramas). */
function persistentEdges(frames: GrayFrame[]): { v: Float32Array; hz: Float32Array; w: number; h: number } {
  const { w, h } = frames[0];
  const v = new Float32Array(w * h).fill(Infinity);
  const hz = new Float32Array(w * h).fill(Infinity);
  for (const f of frames) {
    const d = f.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const gx = x + 1 < w ? Math.abs(d[i + 1] - d[i]) : 0;
        const gy = y + 1 < h ? Math.abs(d[i + w] - d[i]) : 0;
        if (gx < v[i]) v[i] = gx;
        if (gy < hz[i]) hz[i] = gy;
      }
    }
  }
  return { v, hz, w, h };
}

/** Cuánto cambian los fotogramas (0–255): sin movimiento no se pueden separar bordes fijos de contenido estático. */
function motion(frames: GrayFrame[]): number {
  if (frames.length < 2) return 0;
  let sum = 0;
  let n = 0;
  for (let k = 1; k < frames.length; k++) {
    const a = frames[k - 1].data;
    const b = frames[k].data;
    for (let i = 0; i < a.length; i += 3) {
      sum += Math.abs(a[i] - b[i]);
      n++;
    }
  }
  return n ? sum / n : 0;
}

export const frameEdgeAnalyzer: VisualAnalyzer = {
  name: 'marco-fijo-v1',
  analyze(frames: GrayFrame[]): VisualResult {
    const engine = this.name;
    if (frames.length < 3) return { cls: 'incierto', confidence: 0, engine };
    if (motion(frames) < 2) return { cls: 'incierto', confidence: 0, engine }; // imagen casi fija: no concluyente
    const { v, hz, w, h } = persistentEdges(frames);
    // Sumas acumuladas por columna (bordes verticales) y por fila (bordes horizontales) para medir lados en O(1).
    const colCum = new Float32Array((w + 1) * (h + 1));
    const rowCum = new Float32Array((w + 1) * (h + 1));
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) colCum[x * (h + 1) + y + 1] = colCum[x * (h + 1) + y] + Math.min(v[y * w + x], 80);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rowCum[y * (w + 1) + x + 1] = rowCum[y * (w + 1) + x] + Math.min(hz[y * w + x], 80);
    const vSide = (x: number, y0: number, y1: number) => (colCum[x * (h + 1) + y1] - colCum[x * (h + 1) + y0]) / Math.max(1, y1 - y0);
    const hSide = (y: number, x0: number, x1: number) => (rowCum[y * (w + 1) + x1] - rowCum[y * (w + 1) + x0]) / Math.max(1, x1 - x0);
    // Fondo: nivel típico de borde persistente en toda la imagen.
    let bg = 0;
    for (let i = 0; i < v.length; i++) bg += Math.min(v[i], 80) + Math.min(hz[i], 80);
    bg = bg / (2 * v.length) + 0.5;

    let best = { score: 0, x0: 0, y0: 0, x1: 0, y1: 0, minSide: 0 };
    const minW = Math.round(w * 0.12);
    const maxW = Math.round(w * 0.5);
    const minH = Math.round(h * 0.15);
    const maxH = Math.round(h * 0.6);
    // Lado que coincide con el borde del vídeo: no hay borde visible, se considera «cerrado».
    const side = (val: number, atEdge: boolean) => (atEdge ? Math.max(val, bg * 4) : val);
    for (let x0 = 0; x0 < w - minW; x0 += 2) {
      for (let x1 = x0 + minW; x1 <= Math.min(w - 1, x0 + maxW); x1 += 2) {
        for (let y0 = 0; y0 < h - minH; y0 += 2) {
          for (let y1 = y0 + minH; y1 <= Math.min(h - 1, y0 + maxH); y1 += 2) {
            const l = side(vSide(Math.max(0, x0 - 1), y0, y1), x0 === 0);
            const r = side(vSide(x1, y0, y1), x1 >= w - 1);
            const t = side(hSide(Math.max(0, y0 - 1), x0, x1), y0 === 0);
            const b = side(hSide(y1, x0, x1), y1 >= h - 1);
            const realSides = (x0 === 0 ? 0 : 1) + (x1 >= w - 1 ? 0 : 1) + (y0 === 0 ? 0 : 1) + (y1 >= h - 1 ? 0 : 1);
            if (realSides < 2) continue; // al menos dos bordes reales dentro de la imagen
            const minSide = Math.min(l, r, t, b);
            const score = minSide + (l + r + t + b) / 8;
            if (score > best.score) best = { score, x0, y0, x1, y1, minSide };
          }
        }
      }
    }
    const ratio = best.minSide / bg;
    if (ratio < 3) return { cls: ratio < 1.5 ? 'sin_facecam' : 'incierto', confidence: Math.min(0.5, ratio / 6), engine };
    // Afinado: la búsqueda va de 2 en 2 px y el borde real puede caer en el píxel de al lado (mezclado con el
    // fondo). Cada lado se ajusta ±2 px al borde más fuerte y luego se amplía 1 px hacia fuera: es preferible
    // incluir un poco de marco que cortar parte de la cámara.
    const refine = (cur: number, f: (p: number) => number, lo: number, hi: number) => {
      let bestP = cur;
      let bestV = f(cur);
      for (let p = Math.max(lo, cur - 2); p <= Math.min(hi, cur + 2); p++) if (f(p) > bestV) [bestP, bestV] = [p, f(p)];
      return bestP;
    };
    // Marcos dentro de la cámara (bordes decorativos del overlay, la propia ventana): si hay otro borde fijo
    // paralelo un poco más afuera, el bueno es el EXTERIOR. Se busca hasta ~6 % de la imagen hacia fuera.
    const outward = (cur: number, f: (p: number) => number, dir: 1 | -1, limit: number) => {
      const ref = f(cur);
      let out = cur;
      for (let k = 1, p = cur + dir; k <= Math.round(w * 0.06) && (dir > 0 ? p <= limit : p >= limit); k++, p += dir) if (f(p) >= Math.max(ref * 0.6, bg * 3)) out = p;
      return out;
    };
    const { y0: by0, y1: by1 } = best;
    let rx0 = best.x0 === 0 ? 0 : refine(best.x0, (p) => vSide(Math.max(0, p - 1), by0, by1), 1, best.x1 - minW);
    let rx1 = best.x1 >= w - 1 ? w - 1 : refine(best.x1, (p) => vSide(p, by0, by1), rx0 + minW, w - 2);
    let ry0 = best.y0 === 0 ? 0 : refine(best.y0, (p) => hSide(Math.max(0, p - 1), rx0, rx1), 1, best.y1 - minH);
    let ry1 = best.y1 >= h - 1 ? h - 1 : refine(best.y1, (p) => hSide(p, rx0, rx1), ry0 + minH, h - 2);
    if (rx0 > 0) rx0 = outward(rx0, (p) => vSide(Math.max(0, p - 1), ry0, ry1), -1, 1);
    if (rx1 < w - 1) rx1 = outward(rx1, (p) => vSide(p, ry0, ry1), 1, w - 2);
    if (ry0 > 0) ry0 = outward(ry0, (p) => hSide(Math.max(0, p - 1), rx0, rx1), -1, 1);
    if (ry1 < h - 1) ry1 = outward(ry1, (p) => hSide(p, rx0, rx1), 1, h - 2);
    const fx0 = Math.max(0, rx0 - 1);
    const fy0 = Math.max(0, ry0 - 1);
    const fx1 = Math.min(w, rx1 + 2);
    const fy1 = Math.min(h, ry1 + 2);
    const cam: NormRect = { x: fx0 / w, y: fy0 / h, w: (fx1 - fx0) / w, h: (fy1 - fy0) / h };
    const confidence = Math.max(0, Math.min(1, (ratio - 3) / 6 + 0.55));
    return { cls: classify(cam), confidence: Math.round(confidence * 100) / 100, cam, engine };
  },
};

export function classify(cam: NormRect): VisualClass {
  if (cam.w * cam.h > 0.6) return 'pantalla_completa';
  const cx = cam.x + cam.w / 2;
  const cy = cam.y + cam.h / 2;
  if (cy <= 0.35) return 'facecam_superior';
  if (cy >= 0.65) return 'facecam_inferior';
  return cx < 0.5 ? 'facecam_izquierda' : 'facecam_derecha';
}

/** Extrae `count` fotogramas en gris a 160×90 repartidos por el clip (una sola llamada a FFmpeg). */
export async function sampleFrames(ffmpeg: string, source: string, start: number, end: number, tmpDir: string, count = 6, signal?: AbortSignal): Promise<GrayFrame[]> {
  fs.mkdirSync(tmpDir, { recursive: true });
  const out = path.join(tmpDir, `sample_${Math.round(start * 100)}.gray`);
  const dur = Math.max(1, end - start);
  const r = await runProcess(
    ffmpeg,
    ['-hide_banner', '-y', '-ss', start.toFixed(2), '-t', dur.toFixed(2), '-i', source, '-an', '-vf', `fps=${(count / dur).toFixed(4)},scale=${ANALYSIS_W}:${ANALYSIS_H},format=gray`, '-frames:v', String(count), '-f', 'rawvideo', out],
    { signal, timeoutMs: 120_000 },
  );
  try {
    if (r.code !== 0 || !fs.existsSync(out)) return [];
    const buf = fs.readFileSync(out);
    const size = ANALYSIS_W * ANALYSIS_H;
    const frames: GrayFrame[] = [];
    for (let o = 0; o + size <= buf.length; o += size) frames.push({ w: ANALYSIS_W, h: ANALYSIS_H, data: new Uint8Array(buf.subarray(o, o + size)) });
    return frames;
  } finally {
    try {
      fs.unlinkSync(out);
    } catch {
      /* ignorar */
    }
  }
}
