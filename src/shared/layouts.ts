// Layouts verticales (gameplay + facecam) y decisión segura a partir del análisis visual. Puro.

export const LAYOUT_IDS = ['gameplay_full', 'game_top_cam_bottom', 'cam_top_game_bottom', 'game_cam_float', 'no_facecam', 'split_horizontal', 'split_vertical', 'custom'] as const;
export type LayoutId = (typeof LAYOUT_IDS)[number];
export type LayoutChoice = 'auto' | LayoutId;

export const LAYOUT_LABELS: Record<LayoutId, string> = {
  gameplay_full: 'Sin cámara: sólo gameplay',
  game_top_cam_bottom: 'Gameplay arriba + cámara abajo',
  cam_top_game_bottom: 'Cámara arriba + gameplay abajo',
  game_cam_float: 'Cámara flotante',
  no_facecam: 'Vídeo entero con fondo difuminado',
  split_horizontal: 'División horizontal (mitad izquierda arriba, derecha abajo)',
  split_vertical: 'División vertical (dos columnas)',
  custom: 'Personalizado (cámara donde quieras)',
};

/** Plantillas principales del editor; el resto son herramientas avanzadas (no soluciones de facecam). */
export const MAIN_TEMPLATES: readonly LayoutId[] = ['cam_top_game_bottom', 'game_top_cam_bottom', 'game_cam_float', 'custom', 'gameplay_full'];
export const ADVANCED_TEMPLATES: readonly LayoutId[] = ['no_facecam', 'split_horizontal', 'split_vertical'];

/** Layouts que necesitan saber dónde está la facecam. */
export const NEEDS_CAM: readonly LayoutId[] = ['game_top_cam_bottom', 'cam_top_game_bottom', 'game_cam_float'];

/** Rectángulo normalizado 0–1 respecto al fotograma de origen. */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type VisualClass = 'sin_facecam' | 'facecam_superior' | 'facecam_inferior' | 'facecam_izquierda' | 'facecam_derecha' | 'pantalla_completa' | 'incierto';

export const VISUAL_LABELS: Record<VisualClass, string> = {
  sin_facecam: 'Sin facecam',
  facecam_superior: 'Facecam arriba',
  facecam_inferior: 'Facecam abajo',
  facecam_izquierda: 'Facecam a la izquierda',
  facecam_derecha: 'Facecam a la derecha',
  pantalla_completa: 'Cámara a pantalla completa',
  incierto: 'No se pudo determinar',
};

export interface VisualResult {
  cls: VisualClass;
  /** 0–1. */
  confidence: number;
  cam?: NormRect;
  engine: string;
  /** Diagnóstico explicable de la detección (qué se analizó y por qué se aceptó o no). */
  diagnostic?: DetectionDiagnostic;
}

export interface DetectionDiagnostic {
  /** Fotogramas analizados y ventanas del clip comparadas. */
  samples: number;
  windows: number;
  /** Fracción de ventanas que vieron la misma cámara (0–1). */
  consistency: number;
  /** Rectángulo final elegido (si lo hay). */
  rect?: NormRect;
  /** Motivo de la decisión o del fallback. */
  reason: string;
  /** Rectángulos candidatos de cada ventana analizada (con su confianza). */
  candidates?: { rect: NormRect; confidence: number }[];
}

/** Mensaje cuando no hay confianza suficiente: nunca se inventa una cámara. */
export const NO_CAM_CONFIRMED = 'No pudimos confirmar la cámara. Ajusta el recuadro manualmente.';

/** Confianza mínima para aplicar automáticamente un layout con facecam. */
export const AUTO_CONFIDENCE = 0.6;

export interface LayoutDecision {
  layout: LayoutId;
  /** Layout sugerido cuando no hay confianza suficiente para aplicarlo solo. */
  suggestion?: LayoutId;
  reason: string;
}

/**
 * Decide el layout de un clip. Nunca aplica un layout con facecam sin confianza suficiente:
 * en ese caso usa «Sin cámara: sólo gameplay» y deja la sugerencia para que la elija el usuario.
 */
export function decideLayout(pref: LayoutChoice, v: VisualResult | undefined): LayoutDecision {
  if (pref !== 'auto') {
    if ((NEEDS_CAM.includes(pref) || pref === 'custom') && (!v?.cam || v.confidence < AUTO_CONFIDENCE)) {
      return { layout: 'gameplay_full', suggestion: pref, reason: `Tu plantilla preferida necesita la cámara. ${NO_CAM_CONFIRMED}` };
    }
    return { layout: pref, reason: 'Layout preferido.' };
  }
  if (!v || v.cls === 'incierto') return { layout: 'gameplay_full', reason: 'Análisis visual no concluyente: se usa el recorte seguro.' };
  if (v.cls === 'sin_facecam' || v.cls === 'pantalla_completa') return { layout: 'gameplay_full', reason: VISUAL_LABELS[v.cls] };
  // Como un Short: cámara arriba y gameplay abajo, esté donde esté la cámara en el original.
  const suggestion: LayoutId = 'cam_top_game_bottom';
  if (v.confidence >= AUTO_CONFIDENCE && v.cam) return { layout: suggestion, reason: `${VISUAL_LABELS[v.cls]} (confianza ${Math.round(v.confidence * 100)} %).` };
  return {
    layout: 'gameplay_full',
    suggestion,
    reason: `${NO_CAM_CONFIRMED} (posible ${VISUAL_LABELS[v.cls].toLowerCase()}, confianza ${Math.round(v.confidence * 100)} %).`,
  };
}

export function validRect(r: unknown): r is NormRect {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  const ok = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  if (!ok(o.x) || !ok(o.y) || !ok(o.w) || !ok(o.h)) return false;
  const { x, y, w, h } = o as unknown as NormRect;
  return x >= 0 && y >= 0 && w >= 0.03 && h >= 0.03 && x + w <= 1.0001 && y + h <= 1.0001;
}
