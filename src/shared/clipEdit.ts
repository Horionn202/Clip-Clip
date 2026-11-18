// Edición individual de un clip con validación (rango, duración del preset, solapes, facecam). Puro.
import type { Clip, ClipPatch, DurationPreset } from './types';
import { NEEDS_CAM } from './layouts';
import { UserFacingError, overlaps, presetRange } from './validation';

export interface EditContext {
  clips: Clip[];
  preset: DurationPreset;
  sourceDuration: number;
}

/** Devuelve el clip actualizado (sin mutar) o lanza un error claro. `dirty` indica que hace falta re-renderizar. */
export function applyClipPatch(clipId: string, patch: ClipPatch, ctx: EditContext): Clip {
  const cur = ctx.clips.find((c) => c.id === clipId);
  if (!cur) throw new UserFacingError('El clip no existe.');
  const next: Clip = { ...cur };
  let needsRender = false;

  if (patch.title !== undefined) next.title = patch.title.replace(/[\u0000-\u001f]/g, ' ').trim();
  if (patch.hook !== undefined) next.hook = patch.hook.replace(/[\u0000-\u001f]/g, ' ').trim();

  if (patch.start !== undefined || patch.end !== undefined) {
    const start = Math.round((patch.start ?? cur.start) * 100) / 100;
    const end = Math.round((patch.end ?? cur.end) * 100) / 100;
    const { min, max } = presetRange(ctx.preset);
    if (start < 0 || end > ctx.sourceDuration + 0.01 || end <= start) throw new UserFacingError('El rango queda fuera del vídeo.');
    if (end - start < min - 0.01 || end - start > max + 0.01) {
      throw new UserFacingError(`El clip debe durar entre ${min} y ${max} s (preset de ${ctx.preset} s).`);
    }
    const other = ctx.clips.find((c) => c.id !== clipId && overlaps(c, { start, end }));
    if (other) throw new UserFacingError(`El nuevo rango se solapa con el clip ${other.index}.`);
    if (start !== cur.start || end !== cur.end) needsRender = true;
    next.start = start;
    next.end = end;
  }

  if (patch.camRect !== undefined) {
    const changed = JSON.stringify(patch.camRect ?? null) !== JSON.stringify(cur.camRect ?? null);
    next.camRect = patch.camRect ?? undefined;
    if (changed && NEEDS_CAM.includes(next.layout ?? 'gameplay_full')) needsRender = true;
  }
  if (patch.layout !== undefined && patch.layout !== (cur.layout ?? 'gameplay_full')) {
    next.layout = patch.layout;
    needsRender = true;
  }
  if (NEEDS_CAM.includes(next.layout ?? 'gameplay_full') && !next.camRect) {
    throw new UserFacingError('Este layout necesita la posición de la facecam: ajústala antes de aplicarlo.');
  }
  // El hook no está en el vídeo (los subtítulos salen de la transcripción): sólo cambian datos.
  next.dirty = cur.dirty || needsRender;
  return next;
}

/** Recuento real de clips renderizados y vigentes (sin cambios pendientes). */
export function readyCount(clips: Clip[]): { ready: number; total: number } {
  return { ready: clips.filter((c) => c.file && !c.dirty).length, total: clips.length };
}
