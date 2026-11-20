// Layouts verticales (gameplay + facecam) y decisión segura a partir del análisis visual. Puro.

export const LAYOUT_IDS = ['gameplay_full', 'game_top_cam_bottom', 'cam_top_game_bottom', 'game_cam_float', 'no_facecam', 'split_horizontal', 'split_vertical', 'custom'] as const;
export type LayoutId = (typeof LAYOUT_IDS)[number];
export type LayoutChoice = 'auto' | LayoutId;

export const LAYOUT_LABELS: Record<LayoutId, string> = {
  gameplay_full: 'Gameplay completo (recorte vertical)',
  game_top_cam_bottom: 'Gameplay arriba + facecam abajo',
  cam_top_game_bottom: 'Facecam arriba + gameplay abajo',
  game_cam_float: 'Gameplay vertical + facecam flotante',
  no_facecam: 'Sin facecam (vídeo entero con fondo difuminado)',
  split_horizontal: 'División horizontal (mitad izquierda arriba, derecha abajo)',
  split_vertical: 'División vertical (dos columnas)',
  custom: 'Personalizado (cámara donde quieras)',
};

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
}

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
 * en ese caso usa «Gameplay completo» y deja la sugerencia para que la elija el usuario.
 */
export function decideLayout(pref: LayoutChoice, v: VisualResult | undefined): LayoutDecision {
  if (pref !== 'auto') {
    if (NEEDS_CAM.includes(pref) && !v?.cam) {
      return { layout: 'gameplay_full', suggestion: pref, reason: 'Tu layout preferido necesita la posición de la facecam y no se detectó: ajústala a mano.' };
    }
    return { layout: pref, reason: 'Layout preferido.' };
  }
  if (!v || v.cls === 'incierto') return { layout: 'gameplay_full', reason: 'Análisis visual no concluyente: se usa el recorte seguro.' };
  if (v.cls === 'sin_facecam' || v.cls === 'pantalla_completa') return { layout: 'gameplay_full', reason: VISUAL_LABELS[v.cls] };
  const suggestion: LayoutId = v.cls === 'facecam_superior' ? 'cam_top_game_bottom' : 'game_top_cam_bottom';
  if (v.confidence >= AUTO_CONFIDENCE && v.cam) return { layout: suggestion, reason: `${VISUAL_LABELS[v.cls]} (confianza ${Math.round(v.confidence * 100)} %).` };
  return {
    layout: 'gameplay_full',
    suggestion,
    reason: `Posible ${VISUAL_LABELS[v.cls].toLowerCase()} con poca confianza (${Math.round(v.confidence * 100)} %): revisa la sugerencia.`,
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
