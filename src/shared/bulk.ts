// Selección masiva y reglas de confirmación de borrados (puro, sin Node).
import type { Job } from './types';

/** Estados en los que un trabajo puede borrarse (nunca en curso). */
export const DELETABLE_STATUSES: readonly Job['status'][] = ['completed', 'failed', 'cancelled'];

/** A partir de aquí hay que escribir «BORRAR» para confirmar. */
export const TYPED_CONFIRM = { jobs: 10, clips: 50, word: 'BORRAR' } as const;

export function needsTypedConfirm(jobs: number, clips: number): boolean {
  return jobs >= TYPED_CONFIRM.jobs || clips >= TYPED_CONFIRM.clips;
}

export function typedConfirmOk(jobs: number, clips: number, typed: string | undefined): boolean {
  return !needsTypedConfirm(jobs, clips) || (typed ?? '').trim() === TYPED_CONFIRM.word;
}

/** Selección de ids: inmutable y fácil de probar. */
export type Selection = ReadonlySet<string>;

export function toggle(sel: Selection, id: string): Set<string> {
  const n = new Set(sel);
  if (n.has(id)) n.delete(id);
  else n.add(id);
  return n;
}

/** Marca/desmarca todos los `ids` (p. ej. la página visible o todo lo filtrado). */
export function setMany(sel: Selection, ids: readonly string[], on: boolean): Set<string> {
  const n = new Set(sel);
  for (const id of ids) on ? n.add(id) : n.delete(id);
  return n;
}

/** Estado del checkbox global para un conjunto de ids. */
export function selectionState(sel: Selection, ids: readonly string[]): 'none' | 'some' | 'all' {
  const n = ids.filter((id) => sel.has(id)).length;
  return n === 0 ? 'none' : n === ids.length ? 'all' : 'some';
}

/** Quita de la selección lo que ya no existe o no es visible con el filtro actual. */
export function pruneSelection(sel: Selection, visible: readonly string[]): Set<string> {
  const v = new Set(visible);
  return new Set([...sel].filter((id) => v.has(id)));
}

export interface BulkOptions {
  /** También borra los clips exportados de esos trabajos (Papelera). */
  deleteExports: boolean;
}

export interface BulkPlan {
  jobs: { id: string; title: string; clips: number; bytes: number; exports: number }[];
  skipped: { id: string; title: string; reason: string }[];
  clipCount: number;
  /** Datos internos (carpeta del trabajo). */
  internalBytes: number;
  /** Exportaciones que se borrarían (sólo con deleteExports). */
  exportBytes: number;
  exportCount: number;
  /** Exportaciones que se conservan. */
  keptExports: number;
  needsTypedConfirm: boolean;
}

export interface ClipPlan {
  jobId: string;
  clips: number;
  /** El usuario eligió todos los clips: se elimina el trabajo completo (sin registros vacíos). */
  wholeJob: boolean;
  bytes: number;
  exportCount: number;
  exportBytes: number;
  keptExports: number;
}

export interface BulkResult {
  batchId: string;
  /** Trabajos que de verdad se apartaron (los que fallaron siguen en el historial). */
  deletedIds: string[];
  jobs: number;
  clips: number;
  freedBytes: number;
  exportsDeleted: number;
  /** Hasta cuándo se puede deshacer (ISO). */
  undoUntil: string;
  errors: string[];
}

export const jobTitle = (j: Pick<Job, 'sourceTitle' | 'url'>): string => j.sourceTitle || 'Trabajo sin título';
