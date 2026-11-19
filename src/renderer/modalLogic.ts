// Lógica pura de las ventanas modales (testeable sin DOM).

export const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),summary';

/** Índice del siguiente elemento con foco al pulsar Tab / Shift+Tab, cerrando el ciclo dentro del modal. */
export function nextFocusIndex(count: number, current: number, shift: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return shift ? count - 1 : 0;
  return shift ? (current - 1 + count) % count : (current + 1) % count;
}

export const UNSAVED_MESSAGE = 'Hay cambios sin guardar. ¿Cerrar y descartarlos?';

/** Cerrar sin guardar: si hay cambios, se pide confirmación. */
export function canClose(dirty: boolean, ask: (msg: string) => boolean): boolean {
  return !dirty || ask(UNSAVED_MESSAGE);
}
