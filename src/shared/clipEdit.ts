// Edición individual de un clip con validación (rango, duración del preset, solapes, facecam). Puro.
import type { Clip, ClipPatch, DurationPreset, RenderedState } from './types';
import { NEEDS_CAM } from './layouts';
import { compositionErrors, compositionOf } from './composition';
import { sanitizeCues, shiftCue } from './cues';
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
  if (patch.composition !== undefined) {
    if (patch.composition === null) {
      // Volver a la automática sólo cuenta como cambio si había una composición guardada.
      if (next.composition) needsRender = true;
      next.composition = undefined;
    } else {
      const merged = compositionOf({ ...next, composition: { ...next.composition, ...patch.composition } });
      const errs = compositionErrors(merged);
      if (errs.length) throw new UserFacingError(errs[0]);
      next.composition = { ...merged, manualOverride: true, source: 'user-edited', needsReview: false };
      // layout/camRect se mantienen sincronizados (compatibilidad con el resto de la app).
      next.layout = merged.template;
      next.camRect = merged.sourceFacecamRect;
      needsRender = true;
    }
  }
  // Subtítulos editados a mano y nuevo tramo: se desplazan para seguir pegados a las mismas palabras del vídeo.
  if (patch.subtitleCues === undefined && next.subtitleCues && (next.start !== cur.start || next.end !== cur.end)) {
    const shift = cur.start - next.start;
    next.subtitleCues = sanitizeCues(next.subtitleCues.map((c) => shiftCue(c, shift)).filter((c) => c.end > 0), next.end - next.start);
  }
  if (patch.subtitleCues !== undefined) {
    const before = JSON.stringify(cur.subtitleCues ?? null);
    next.subtitleCues = patch.subtitleCues === null ? undefined : sanitizeCues(patch.subtitleCues, next.end - next.start);
    if (JSON.stringify(next.subtitleCues ?? null) !== before) needsRender = true;
  }
  if ((NEEDS_CAM.includes(next.layout ?? 'gameplay_full') || next.layout === 'custom') && !next.camRect) {
    throw new UserFacingError('Este layout necesita la posición de la facecam: ajústala antes de aplicarlo.');
  }
  // El hook no está en el vídeo (los subtítulos salen de la transcripción): sólo cambian datos.
  // Con el estado renderizado conocido, «pendiente» = difiere del MP4 actual (deshacer los cambios lo limpia).
  next.dirty = cur.rendered && cur.file ? differsFromRendered(next, cur.rendered) : cur.dirty || needsRender;
  return next;
}

/** Instantánea de lo que se renderiza (se guarda al terminar cada render). */
export function renderedState(c: Clip): RenderedState {
  return { start: c.start, end: c.end, layout: c.layout ?? 'gameplay_full', camRect: c.camRect, composition: compositionKey(c), cues: c.subtitleCues ? JSON.stringify(c.subtitleCues) : undefined };
}

/** Huella de lo que afecta al render en la composición (sin confianza ni origen). */
export function compositionKey(c: Clip): string | undefined {
  if (!c.composition) return undefined;
  const k = compositionOf(c);
  return JSON.stringify([k.template, k.sourceFacecamRect, k.facecamCrop, k.facecamPosition, k.outputFacecamRect, k.gameplayCrop, k.outputAspectRatio, !!k.manualOverride, ...(k.facecamFit === 'contain' ? ['contain'] : [])]);
}

export function differsFromRendered(c: Clip, r: RenderedState): boolean {
  const layout = c.layout ?? 'gameplay_full';
  if (c.start !== r.start || c.end !== r.end || layout !== r.layout) return true;
  if ((compositionKey(c) ?? '') !== (r.composition ?? '')) return true;
  if ((c.subtitleCues ? JSON.stringify(c.subtitleCues) : '') !== (r.cues ?? '')) return true;
  // La facecam sólo importa si el layout la usa.
  return NEEDS_CAM.includes(layout) && JSON.stringify(c.camRect ?? null) !== JSON.stringify(r.camRect ?? null);
}

/** Recuento real de clips renderizados y vigentes (sin cambios pendientes). */
export function readyCount(clips: Clip[]): { ready: number; total: number } {
  return { ready: clips.filter((c) => c.file && !c.dirty).length, total: clips.length };
}
