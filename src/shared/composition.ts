// Composición no destructiva de un clip (ClipLayout). Puro. Todo en coordenadas NORMALIZADAS 0–1:
// funciona con cualquier resolución de origen y de salida. El render (main/layoutRender.ts) lo traduce a píxeles.
import type { LayoutId, NormRect, VisualResult } from './layouts';
import { AUTO_CONFIDENCE, NEEDS_CAM, validRect } from './layouts';

export type AspectRatio = '9:16' | '1:1' | '16:9';
export const ASPECT_RATIOS: AspectRatio[] = ['9:16', '1:1', '16:9'];
export const ASPECT_LABELS: Record<AspectRatio, string> = { '9:16': '9:16 vertical', '1:1': '1:1 cuadrado', '16:9': '16:9 horizontal' };

/** Tamaño de salida (pares) para cada aspecto. */
export function outputSize(a: AspectRatio = '9:16'): { w: number; h: number } {
  return a === '1:1' ? { w: 1080, h: 1080 } : a === '16:9' ? { w: 1920, h: 1080 } : { w: 1080, h: 1920 };
}

export type CompositionMode = 'auto' | 'gameplay-facecam' | 'split-horizontal' | 'split-vertical' | 'full-frame' | 'custom';
export type CamCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'custom';

/** Modo de composición al que corresponde cada plantilla. */
export const TEMPLATE_MODE: Record<LayoutId, CompositionMode> = {
  gameplay_full: 'full-frame',
  no_facecam: 'full-frame',
  game_top_cam_bottom: 'gameplay-facecam',
  cam_top_game_bottom: 'gameplay-facecam',
  game_cam_float: 'gameplay-facecam',
  split_horizontal: 'split-horizontal',
  split_vertical: 'split-vertical',
  custom: 'custom',
};

export interface ClipLayout {
  mode: CompositionMode;
  /** Plantilla concreta (define el filtergraph). */
  template: LayoutId;
  /** Dónde está la facecam en el vídeo de origen. */
  facecamRect?: NormRect;
  /** Encuadre dentro de la facecam: desplazamiento -1..1 y zoom ≥ 1. */
  facecamCrop: { x: number; y: number; zoom: number };
  /** Esquina de la cámara en los modos flotante y personalizado. */
  facecamPosition: CamCorner;
  /** Caja de la cámara en la SALIDA (modo personalizado o esquina «custom»). */
  overlayRect?: NormRect;
  /** Encuadre del gameplay: desplazamiento horizontal -1..1 y zoom ≥ 1. */
  gameplayCrop: { x: number; zoom: number };
  outputAspectRatio: AspectRatio;
  confidence: number;
  manualOverride: boolean;
  source: 'auto-detection' | 'user-edited' | 'fallback';
  /** La detección no fue fiable: mostrar «Revisar composición». */
  needsReview?: boolean;
}

export const DEFAULT_COMPOSITION: ClipLayout = {
  mode: 'full-frame',
  template: 'gameplay_full',
  facecamCrop: { x: 0, y: 0, zoom: 1 },
  facecamPosition: 'top-right',
  gameplayCrop: { x: 0, zoom: 1 },
  outputAspectRatio: '9:16',
  confidence: 0,
  manualOverride: false,
  source: 'fallback',
};

/** Área segura de las apps verticales (fracción de la salida): arriba la cabecera, abajo descripción y botones. */
export const SAFE_AREA = { top: 0.1, bottom: 0.2, left: 0.04, right: 0.14 };

const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));

/** Caja de la cámara en la salida para cada esquina (normalizada). */
export function cornerRect(c: CamCorner, size = 0.4, aspect = 4 / 3, out = outputSize()): NormRect {
  const w = size;
  const h = (w * out.w) / aspect / out.h;
  const mx = SAFE_AREA.left;
  const top = SAFE_AREA.top;
  const bottom = 1 - SAFE_AREA.bottom - h;
  const right = 1 - SAFE_AREA.right - w;
  const pos = { 'top-left': [mx, top], 'top-right': [right, top], 'bottom-left': [mx, bottom], 'bottom-right': [right, bottom], custom: [right, top] }[c];
  return { x: clamp(pos[0], 0, 1 - w), y: clamp(pos[1], 0, 1 - h), w, h };
}

/** Recorta un rectángulo al fotograma y fuerza un tamaño mínimo (nunca sale de la imagen). */
export function clampRect(r: NormRect, min = 0.05): NormRect {
  const w = clamp(r.w, min, 1);
  const h = clamp(r.h, min, 1);
  return { x: clamp(r.x, 0, 1 - w), y: clamp(r.y, 0, 1 - h), w, h };
}

/** Composición efectiva de un clip, compatible con clips antiguos (sólo `layout` y `camRect`). */
export function compositionOf(clip: { layout?: LayoutId; camRect?: NormRect; composition?: Partial<ClipLayout>; visual?: VisualResult }): ClipLayout {
  const template = clip.composition?.template ?? clip.layout ?? 'gameplay_full';
  const c: ClipLayout = {
    ...DEFAULT_COMPOSITION,
    confidence: clip.visual?.confidence ?? 0,
    source: clip.composition?.source ?? (clip.camRect ? 'auto-detection' : 'fallback'),
    ...clip.composition,
    template,
    mode: TEMPLATE_MODE[template] ?? 'full-frame',
    facecamRect: clip.composition?.facecamRect ?? clip.camRect,
  };
  c.facecamCrop = { ...DEFAULT_COMPOSITION.facecamCrop, ...clip.composition?.facecamCrop };
  c.gameplayCrop = { ...DEFAULT_COMPOSITION.gameplayCrop, ...clip.composition?.gameplayCrop };
  return c;
}

/** Errores que impiden renderizar una composición (vacío = válida). */
export function compositionErrors(c: ClipLayout): string[] {
  const e: string[] = [];
  if ((NEEDS_CAM.includes(c.template) || c.template === 'custom') && !validRect(c.facecamRect)) e.push('Esta plantilla necesita la posición de la cámara: dibújala sobre el fotograma.');
  if (c.overlayRect && !validRect(c.overlayRect)) e.push('La caja de la cámara en la salida no es válida.');
  if (c.gameplayCrop.zoom < 1 || c.gameplayCrop.zoom > 4 || c.facecamCrop.zoom < 1 || c.facecamCrop.zoom > 4) e.push('El zoom debe estar entre 1 y 4.');
  return e;
}

// ---------- Detección robusta (combinación de varios análisis) ----------

export function iou(a: NormRect, b: NormRect): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}

/**
 * Combina los análisis de varias ventanas del clip. La región elegida debe repetirse (IoU alto) en la mayoría:
 * una cara que aparece en un momento del gameplay no es una facecam. La confianza se multiplica por la consistencia.
 */
export function combineDetections(parts: VisualResult[]): VisualResult & { consistency: number } {
  const withCam = parts.filter((p) => p.cam && p.cls !== 'incierto' && p.cls !== 'sin_facecam' && p.cls !== 'pantalla_completa');
  const engine = parts[0]?.engine ?? 'combinado';
  if (!parts.length) return { cls: 'incierto', confidence: 0, engine, consistency: 0 };
  if (withCam.length === 0) {
    const allNone = parts.every((p) => p.cls === 'sin_facecam');
    return { cls: allNone ? 'sin_facecam' : 'incierto', confidence: allNone ? Math.min(...parts.map((p) => p.confidence)) : 0, engine, consistency: allNone ? 1 : 0 };
  }
  // Candidata = la que más coincide con las demás.
  let best = withCam[0];
  let bestAgree = -1;
  for (const a of withCam) {
    const agree = withCam.reduce((n, b) => n + (iou(a.cam!, b.cam!) >= 0.5 ? 1 : 0), 0);
    if (agree > bestAgree || (agree === bestAgree && a.confidence > best.confidence)) {
      best = a;
      bestAgree = agree;
    }
  }
  const consistency = bestAgree / parts.length;
  const agreeing = withCam.filter((b) => iou(best.cam!, b.cam!) >= 0.5);
  // Rectángulo final: unión de los que coinciden (así no se corta la cámara si una ventana la vio más pequeña).
  const x0 = Math.min(...agreeing.map((p) => p.cam!.x));
  const y0 = Math.min(...agreeing.map((p) => p.cam!.y));
  const x1 = Math.max(...agreeing.map((p) => p.cam!.x + p.cam!.w));
  const y1 = Math.max(...agreeing.map((p) => p.cam!.y + p.cam!.h));
  const cam = clampRect({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, 0.03);
  const avg = agreeing.reduce((s, p) => s + p.confidence, 0) / agreeing.length;
  const confidence = Math.round(avg * consistency * 100) / 100;
  return { cls: best.cls, confidence, cam, engine: `${engine}×${parts.length}`, consistency };
}

/** Composición inicial a partir de la decisión automática. Sin confianza suficiente: recorte seguro y «Revisar». */
export function autoComposition(template: LayoutId, visual: VisualResult | undefined, aspect: AspectRatio = '9:16'): ClipLayout {
  const reliable = !!visual?.cam && visual.confidence >= AUTO_CONFIDENCE;
  return {
    ...DEFAULT_COMPOSITION,
    template,
    mode: TEMPLATE_MODE[template],
    facecamRect: visual?.cam,
    outputAspectRatio: aspect,
    confidence: visual?.confidence ?? 0,
    source: reliable ? 'auto-detection' : 'fallback',
    needsReview: !reliable && !!visual?.cam,
  };
}
