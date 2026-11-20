// Borrado masivo de trabajos con «Deshacer». Sólo toca jobs/<id> (validado) y, si se pide, los exports registrados
// de esos clips (archivos de vídeo, fuera de la carpeta interna). Nada se borra al instante: las carpetas se apartan
// a una zona de espera y, pasado el plazo para deshacer, van a la Papelera de reciclaje.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Job } from '../shared/types';
import { DELETABLE_STATUSES, jobTitle, needsTypedConfirm, typedConfirmOk, type BulkOptions, type BulkPlan, type BulkResult } from '../shared/bulk';
import { UserFacingError } from '../shared/validation';
import { isInside } from './paths';
import { listJobFiles } from './storageManager';

const VIDEO = /\.(mp4|mov|webm|mkv)$/i;
export const UNDO_MS = 15_000;

/**
 * ¿Se puede borrar este export? Sólo si es el archivo registrado de un clip de los trabajos elegidos, es un vídeo,
 * existe como archivo (no carpeta) y no está dentro de la carpeta interna. Nunca rutas sugeridas por nadie más.
 */
export function deletableExport(p: string | undefined, jobsDir: string): p is string {
  if (!p || !path.isAbsolute(p) || !VIDEO.test(p)) return false;
  if (isInside(jobsDir, p)) return false;
  try {
    return fs.lstatSync(p).isFile();
  } catch {
    return false;
  }
}

/** Carpeta interna de un trabajo, validada: dentro de jobsDir y distinta de jobsDir. */
export function safeJobDir(jobsDir: string, id: string): string {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) throw new UserFacingError('Identificador de trabajo no válido.');
  const dir = path.resolve(jobsDir, id);
  if (!isInside(jobsDir, dir) || dir === path.resolve(jobsDir)) throw new UserFacingError('Ruta fuera de la carpeta de trabajos.');
  return dir;
}

const sizeOf = (p: string) => {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
};

export interface PlanDeps {
  jobsDir: string;
  /** Trabajos ocupados aunque su estado sea terminal (re-render, retranscripción…). */
  busy: ReadonlySet<string>;
}

export function planBulkDelete(all: Job[], ids: readonly string[], o: BulkOptions, d: PlanDeps): BulkPlan {
  const want = new Set(ids);
  const plan: BulkPlan = { jobs: [], skipped: [], clipCount: 0, internalBytes: 0, exportBytes: 0, exportCount: 0, keptExports: 0, needsTypedConfirm: false };
  // Un export que también figura en un trabajo NO elegido no se toca.
  const sharedOutside = new Set(all.filter((j) => !want.has(j.id)).flatMap((j) => j.clips.map((c) => c.exportedPath)).filter(Boolean).map((p) => path.resolve(p!).toLowerCase()));
  for (const j of all) {
    if (!want.has(j.id)) continue;
    if (!DELETABLE_STATUSES.includes(j.status)) {
      plan.skipped.push({ id: j.id, title: jobTitle(j), reason: 'está en curso' });
      continue;
    }
    if (d.busy.has(j.id)) {
      plan.skipped.push({ id: j.id, title: jobTitle(j), reason: 'se está renderizando o transcribiendo' });
      continue;
    }
    const bytes = listJobFiles(safeJobDir(d.jobsDir, j.id)).reduce((a, f) => a + f.bytes, 0);
    let exports = 0;
    for (const c of j.clips) {
      if (!deletableExport(c.exportedPath, d.jobsDir)) continue;
      if (o.deleteExports && !sharedOutside.has(path.resolve(c.exportedPath).toLowerCase())) {
        exports++;
        plan.exportBytes += sizeOf(c.exportedPath);
      } else plan.keptExports++;
    }
    const clips = j.clips.length;
    plan.jobs.push({ id: j.id, title: jobTitle(j), clips, bytes, exports });
    plan.clipCount += clips;
    plan.internalBytes += bytes;
    plan.exportCount += exports;
  }
  for (const id of want) if (!all.some((j) => j.id === id)) plan.skipped.push({ id, title: id, reason: 'ya no existe' });
  plan.needsTypedConfirm = needsTypedConfirm(plan.jobs.length, plan.clipCount);
  return plan;
}

export interface DeleterDeps {
  jobsDir: string;
  /** Zona de espera (dentro de los datos de la app, mismo disco que jobsDir). */
  pendingDir: string;
  getJobs: () => Job[];
  putJob: (j: Job) => void;
  removeJob: (id: string) => void;
  /** Datos de publicación de un trabajo: se borran al confirmar (no antes, para poder deshacer). */
  forgetPublish: (id: string) => void;
  trash: (p: string) => Promise<void>;
  busy: () => ReadonlySet<string>;
  log?: (msg: string, extra?: unknown) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

interface Batch {
  id: string;
  jobs: Job[];
  exports: string[];
  timer: unknown;
}

export class BulkDeleter {
  private batches = new Map<string, Batch>();
  constructor(private d: DeleterDeps) {}

  plan(ids: readonly string[], o: BulkOptions): BulkPlan {
    return planBulkDelete(this.d.getJobs(), ids, o, { jobsDir: this.d.jobsDir, busy: this.d.busy() });
  }

  /** Aparta los trabajos (se pueden recuperar con `undo` durante UNDO_MS) y programa el borrado definitivo. */
  delete(ids: readonly string[], o: BulkOptions, typed?: string): BulkResult {
    const plan = this.plan(ids, o);
    if (!plan.jobs.length) throw new UserFacingError(plan.skipped.length ? `No se puede borrar: ${plan.skipped[0].title} ${plan.skipped[0].reason}.` : 'No hay trabajos seleccionados.');
    if (!typedConfirmOk(plan.jobs.length, plan.clipCount, typed)) throw new UserFacingError('Para borrar tantos elementos escribe BORRAR.');
    const id = randomUUID();
    const dest = path.join(this.d.pendingDir, id);
    fs.mkdirSync(dest, { recursive: true });
    const all = new Map(this.d.getJobs().map((j) => [j.id, j]));
    const batch: Batch = { id, jobs: [], exports: [], timer: null };
    const errors: string[] = [];
    let freed = 0;
    let clips = 0;
    for (const pj of plan.jobs) {
      const job = all.get(pj.id)!;
      try {
        const dir = safeJobDir(this.d.jobsDir, job.id);
        if (fs.existsSync(dir)) fs.renameSync(dir, path.join(dest, job.id));
        this.d.removeJob(job.id);
        batch.jobs.push(job);
        freed += pj.bytes;
        clips += pj.clips;
        if (o.deleteExports && pj.exports) {
          const shared = new Set(this.d.getJobs().flatMap((j) => j.clips.map((c) => c.exportedPath)).filter(Boolean).map((p) => path.resolve(p!).toLowerCase()));
          for (const c of job.clips) if (deletableExport(c.exportedPath, this.d.jobsDir) && !shared.has(path.resolve(c.exportedPath).toLowerCase())) (batch.exports.push(c.exportedPath), (freed += sizeOf(c.exportedPath)));
        }
      } catch (e) {
        errors.push(`${pj.title}: ${(e as Error).message}`);
      }
    }
    const set = this.d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    batch.timer = set(() => void this.finalize(id), UNDO_MS);
    this.batches.set(id, batch);
    this.d.log?.('borrado masivo', { batch: id, jobs: batch.jobs.length, exports: batch.exports.length, errors: errors.length });
    return { batchId: id, jobs: batch.jobs.length, clips, freedBytes: freed, exportsDeleted: batch.exports.length, undoUntil: new Date(Date.now() + UNDO_MS).toISOString(), errors };
  }

  /** Recupera un lote apartado (carpetas y entradas del historial). */
  undo(batchId: string): number {
    const b = this.batches.get(batchId);
    if (!b) throw new UserFacingError('Ya no se puede deshacer: el plazo terminó.');
    (this.d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout)))(b.timer);
    this.batches.delete(batchId);
    const src = path.join(this.d.pendingDir, batchId);
    for (const j of b.jobs) {
      const from = path.join(src, j.id);
      const to = safeJobDir(this.d.jobsDir, j.id);
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
      this.d.putJob(j);
    }
    try {
      fs.rmdirSync(src);
    } catch {
      /* no vacía: se limpiará en el próximo inicio */
    }
    this.d.log?.('borrado masivo deshecho', { batch: batchId, jobs: b.jobs.length });
    return b.jobs.length;
  }

  /** Borrado definitivo: carpetas apartadas y exports a la Papelera. */
  async finalize(batchId: string): Promise<void> {
    const b = this.batches.get(batchId);
    if (!b) return;
    this.batches.delete(batchId);
    for (const j of b.jobs) this.d.forgetPublish(j.id);
    for (const p of b.exports) await this.d.trash(p).catch((e) => this.d.log?.('borrado masivo: export', { p, e: String(e) }));
    const dir = path.join(this.d.pendingDir, batchId);
    if (isInside(this.d.pendingDir, dir) && dir !== path.resolve(this.d.pendingDir) && fs.existsSync(dir)) await this.d.trash(dir).catch(() => fs.rmSync(dir, { recursive: true, force: true }));
  }

  /** Al cerrar la app: lo pendiente se confirma. */
  async finalizeAll(): Promise<void> {
    for (const id of [...this.batches.keys()]) await this.finalize(id);
  }

  /** Restos de una sesión anterior que se cerró de golpe: van a la Papelera. */
  async sweepLeftovers(): Promise<void> {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.d.pendingDir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(this.d.pendingDir, e);
      if (!this.batches.has(e) && isInside(this.d.pendingDir, p)) await this.d.trash(p).catch(() => undefined);
    }
  }
}
