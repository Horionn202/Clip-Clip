// Borrado masivo de trabajos con «Deshacer». Sólo toca jobs/<id> (validado) y, si se pide, los exports registrados
// de esos clips (archivos de vídeo, fuera de la carpeta interna). Nada se borra al instante: las carpetas se apartan
// a una zona de espera y, pasado el plazo para deshacer, van a la Papelera de reciclaje.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Job } from '../shared/types';
import { DELETABLE_STATUSES, jobTitle, needsTypedConfirm, typedConfirmOk, type BulkOptions, type BulkPlan, type BulkResult, type ClipPlan } from '../shared/bulk';
import { UserFacingError } from '../shared/validation';
import { isInside } from './paths';
import { listJobFiles } from './storageManager';

const VIDEO = /\.(mp4|mov|webm|mkv)$/i;
export const UNDO_MS = 15_000;

/** Errores de Windows cuando un archivo está abierto (reproductor, vista previa, antivirus…). */
const LOCKED = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);
export const RETRY_MS = [100, 250, 500, 1000, 2000];
export class LockedError extends UserFacingError {
  constructor(what: string) {
    super(`Windows tiene en uso ${what} (una vista previa, un reproductor o el antivirus la tiene abierta). No se ha borrado nada: cierra la vista previa y reintenta.`);
  }
}

/**
 * Mueve con reintentos cortos (backoff) si Windows tiene el archivo bloqueado. Si sigue bloqueado, lanza
 * `LockedError` sin haber tocado nada.
 */
export async function moveWithRetry(from: string, to: string, what: string, waits: readonly number[] = RETRY_MS, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!LOCKED.has(code)) throw e;
      if (i >= waits.length) throw new LockedError(what);
      await sleep(waits[i]);
    }
  }
}

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
    let exportN = 0;
    for (const c of j.clips) {
      if (!deletableExport(c.exportedPath, d.jobsDir)) continue;
      if (o.deleteExports && !sharedOutside.has(path.resolve(c.exportedPath).toLowerCase())) {
        exportN++;
        plan.exportBytes += sizeOf(c.exportedPath);
      } else plan.keptExports++;
    }
    const clips = j.clips.length;
    plan.jobs.push({ id: j.id, title: jobTitle(j), clips, bytes, exports: exportN });
    plan.clipCount += clips;
    plan.internalBytes += bytes;
    plan.exportCount += exportN;
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
  /** Guarda el historial en disco ya (el almacén lo escribe con retraso). */
  flushJobs?: () => void;
  removeJob: (id: string) => void;
  /** Datos de publicación de un trabajo: se borran al confirmar (no antes, para poder deshacer). */
  forgetPublish: (id: string) => void;
  trash: (p: string) => Promise<void>;
  busy: () => ReadonlySet<string>;
  log?: (msg: string, extra?: unknown) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /** Esperas entre reintentos (inyectable en pruebas). */
  retryWaits?: readonly number[];
}

interface Batch {
  id: string;
  jobs: Job[];
  exports: string[];
  timer: unknown;
  /** Borrado de clips sueltos: estado anterior del trabajo y archivos apartados (para «Deshacer»). */
  clips?: { before: Job; ids: string[]; moved: { from: string; to: string }[] };
  /** «Deshacer» en curso: la finalización espera (aunque un temporizador antiguo llegue a dispararse). */
  undoing?: boolean;
}

export class BulkDeleter {
  private batches = new Map<string, Batch>();
  constructor(private d: DeleterDeps) {}

  plan(ids: readonly string[], o: BulkOptions): BulkPlan {
    return planBulkDelete(this.d.getJobs(), ids, o, { jobsDir: this.d.jobsDir, busy: this.d.busy() });
  }

  /** Aparta los trabajos (se pueden recuperar con `undo` durante UNDO_MS) y programa el borrado definitivo. */
  async delete(ids: readonly string[], o: BulkOptions, typed?: string): Promise<BulkResult & { locked: string[] }> {
    const plan = this.plan(ids, o);
    if (!plan.jobs.length) throw new UserFacingError(plan.skipped.length ? `No se puede borrar: ${plan.skipped[0].title} ${plan.skipped[0].reason}.` : 'No hay trabajos seleccionados.');
    if (!typedConfirmOk(plan.jobs.length, plan.clipCount, typed)) throw new UserFacingError('Para borrar tantos elementos escribe BORRAR.');
    const id = randomUUID();
    const dest = path.join(this.d.pendingDir, id);
    fs.mkdirSync(dest, { recursive: true });
    const all = new Map(this.d.getJobs().map((j) => [j.id, j]));
    const batch: Batch = { id, jobs: [], exports: [], timer: null };
    const errors: string[] = [];
    const locked: string[] = [];
    let freed = 0;
    let clips = 0;
    for (const pj of plan.jobs) {
      let job = all.get(pj.id)!;
      try {
        const dir = safeJobDir(this.d.jobsDir, job.id);
        const staged = path.join(dest, job.id);
        // Primero se aparta la carpeta (con reintentos); sólo si se movió se quita del historial.
        if (fs.existsSync(dir)) await moveWithRetry(dir, staged, `la carpeta del trabajo «${pj.title}»`, this.d.retryWaits);
        // Estado ACTUAL tras los reintentos (p. ej. un «Deshacer» de clips hecho mientras tanto): es lo que se recupera.
        job = this.d.getJobs().find((j) => j.id === pj.id) ?? job;
        try {
          this.d.removeJob(job.id);
        } catch (e) {
          // No se pudo guardar el historial: todo vuelve a su sitio (ni borrado a medias ni carpeta perdida).
          try {
            if (fs.existsSync(staged) && !fs.existsSync(dir)) fs.renameSync(staged, dir);
          } catch {
            /* si tampoco se puede mover, se queda apartada y el trabajo sigue en el lote recuperable */
          }
          try {
            this.d.putJob(job);
          } catch {
            /* ignorar */
          }
          if (fs.existsSync(staged)) batch.jobs.push(job);
          throw e;
        }
        batch.jobs.push(job);
        freed += pj.bytes;
        clips += pj.clips;
        if (o.deleteExports && pj.exports) {
          const shared = new Set(this.d.getJobs().flatMap((j) => j.clips.map((c) => c.exportedPath)).filter(Boolean).map((p) => path.resolve(p!).toLowerCase()));
          for (const c of job.clips) if (deletableExport(c.exportedPath, this.d.jobsDir) && !shared.has(path.resolve(c.exportedPath).toLowerCase())) (batch.exports.push(c.exportedPath), (freed += sizeOf(c.exportedPath)));
        }
      } catch (e) {
        if (e instanceof LockedError) locked.push(pj.id);
        errors.push(`${pj.title}: ${(e as Error).message}`);
      }
    }
    // El manifiesto en disco permite terminar el borrado si la app se cierra durante el plazo para deshacer.
    writeManifest(dest, batch.exports);
    const set = this.d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    batch.timer = set(() => void this.finalize(id), UNDO_MS);
    this.batches.set(id, batch);
    this.d.log?.('borrado masivo', { batch: id, jobs: batch.jobs.length, exports: batch.exports.length, errors: errors.length });
    return { batchId: id, deletedIds: batch.jobs.map((j) => j.id), jobs: batch.jobs.length, clips, freedBytes: freed, exportsDeleted: batch.exports.length, undoUntil: new Date(Date.now() + UNDO_MS).toISOString(), errors, locked };
  }

  /** Qué supone borrar estos clips de un trabajo (para el modal). */
  planClips(jobId: string, clipIds: readonly string[], o: BulkOptions): ClipPlan {
    const job = this.d.getJobs().find((j) => j.id === jobId);
    if (!job) throw new UserFacingError('El trabajo no existe.');
    const want = new Set(clipIds);
    const chosen = job.clips.filter((c) => want.has(c.id));
    if (!chosen.length) throw new UserFacingError('No hay clips seleccionados.');
    const dir = safeJobDir(this.d.jobsDir, job.id);
    const others = new Set(this.d.getJobs().flatMap((j) => j.clips.filter((c) => j.id !== job.id || !want.has(c.id)).map((c) => c.exportedPath)).filter(Boolean).map((p) => path.resolve(p!).toLowerCase()));
    const plan: ClipPlan = { jobId, clips: chosen.length, wholeJob: chosen.length === job.clips.length, bytes: 0, exportCount: 0, exportBytes: 0, keptExports: 0 };
    if (plan.wholeJob) plan.bytes = listJobFiles(dir).reduce((a, f) => a + f.bytes, 0);
    else for (const c of chosen) for (const f of clipFiles(dir, c)) plan.bytes += sizeOf(f);
    for (const c of chosen) {
      if (!deletableExport(c.exportedPath, this.d.jobsDir)) continue;
      if (o.deleteExports && !others.has(path.resolve(c.exportedPath).toLowerCase())) {
        plan.exportCount++;
        plan.exportBytes += sizeOf(c.exportedPath);
      } else plan.keptExports++;
    }
    return plan;
  }

  /**
   * Borra clips de un trabajo con «Deshacer». Si son TODOS sus clips se elimina el trabajo completo (sin registros
   * vacíos). Los archivos del clip se apartan (con reintentos ante bloqueos) y, pasado el plazo, van a la Papelera.
   */
  async deleteClips(jobId: string, clipIds: readonly string[], o: BulkOptions): Promise<BulkResult & { locked: string[]; wholeJob: boolean }> {
    const plan = this.planClips(jobId, clipIds, o);
    if (plan.wholeJob) return { ...(await this.delete([jobId], o)), wholeJob: true };
    const job = this.d.getJobs().find((j) => j.id === jobId)!;
    if (!DELETABLE_STATUSES.includes(job.status) || this.d.busy().has(jobId)) throw new UserFacingError('El trabajo está en curso o renderizándose: espera a que termine.');
    const id = randomUUID();
    const dest = path.join(this.d.pendingDir, id, job.id);
    fs.mkdirSync(dest, { recursive: true });
    const dir = safeJobDir(this.d.jobsDir, job.id);
    const want = new Set(clipIds);
    const moved: { from: string; to: string }[] = [];
    // Antes de mover nada: si la app se cierra a mitad, el arranque DEVUELVE estos archivos (no los manda a la Papelera).
    const intent = job.clips.filter((x) => want.has(x.id)).flatMap((c) => clipFiles(dir, c).map((f) => ({ from: f, to: path.join(dest, path.relative(dir, f)) })));
    writeManifest(path.join(this.d.pendingDir, id), [], intent);
    try {
      for (const c of job.clips.filter((x) => want.has(x.id))) {
        for (const f of clipFiles(dir, c)) {
          const rel = path.relative(dir, f);
          const to = path.join(dest, rel);
          fs.mkdirSync(path.dirname(to), { recursive: true });
          await moveWithRetry(f, to, `el clip «${c.title}»`, this.d.retryWaits);
          moved.push({ from: f, to });
        }
      }
    } catch (e) {
      // Algo sigue bloqueado: lo ya movido vuelve a su sitio y el trabajo queda como estaba.
      const stuck: { from: string; to: string }[] = [];
      for (const m of moved.reverse()) {
        try {
          fs.renameSync(m.to, m.from);
        } catch {
          stuck.push(m);
        }
      }
      // Lo que no pudo volver queda anotado como «a restaurar»: el próximo arranque lo devuelve (nunca a la Papelera).
      if (stuck.length) writeManifest(path.join(this.d.pendingDir, id), [], stuck);
      else clearUndoneBatch(path.join(this.d.pendingDir, id));
      throw e;
    }
    const toTrash: string[] = [];
    if (o.deleteExports) {
      const others = new Set(this.d.getJobs().flatMap((j) => j.clips.filter((c) => j.id !== job.id || !want.has(c.id)).map((c) => c.exportedPath)).filter(Boolean).map((p) => path.resolve(p!).toLowerCase()));
      for (const c of job.clips) if (want.has(c.id) && deletableExport(c.exportedPath, this.d.jobsDir) && !others.has(path.resolve(c.exportedPath).toLowerCase())) toTrash.push(c.exportedPath);
    }
    // Estado ACTUAL del trabajo (tras los reintentos pudo haber un «Deshacer» u otras ediciones): sólo se quitan estos clips.
    const cur = this.d.getJobs().find((j) => j.id === job.id) ?? job;
    this.d.putJob({ ...cur, clips: cur.clips.filter((c) => !want.has(c.id)) });
    // El historial debe quedar en disco antes de confirmar el borrado en el manifiesto.
    this.d.flushJobs?.();
    const batch: Batch = { id, jobs: [], exports: toTrash, timer: null, clips: { before: job, ids: [...want], moved } };
    // Historial guardado: ahora sí es un borrado confirmado (sin «restore»).
    writeManifest(path.join(this.d.pendingDir, id), toTrash);
    batch.timer = (this.d.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(() => void this.finalize(id), UNDO_MS);
    this.batches.set(id, batch);
    this.d.log?.('borrado de clips', { batch: id, trabajo: job.id, clips: plan.clips, exports: toTrash.length });
    return { batchId: id, deletedIds: [], jobs: 0, clips: plan.clips, freedBytes: plan.bytes + plan.exportBytes, exportsDeleted: toTrash.length, undoUntil: new Date(Date.now() + UNDO_MS).toISOString(), errors: [], locked: [], wholeJob: false };
  }

  /** Recupera un lote apartado (carpetas y entradas del historial). */
  async undo(batchId: string): Promise<{ restored: number; pending: number }> {
    const b = this.batches.get(batchId);
    if (!b) throw new UserFacingError('Ya no se puede deshacer: el plazo terminó.');
    // Mientras se restaura (con reintentos) el plazo no puede vencer y mandar el lote a la Papelera.
    (this.d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout)))(b.timer);
    b.timer = null;
    b.undoing = true;
    const rearm = () => ((b.undoing = false), (b.timer = (this.d.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(() => void this.finalize(batchId), UNDO_MS)));
    const src = path.join(this.d.pendingDir, batchId);
    if (b.clips) {
      // Clips sueltos: cada archivo vuelve a su sitio y el trabajo recupera su estado anterior.
      const left: { from: string; to: string }[] = [];
      for (const m of b.clips.moved) {
        try {
          if (fs.existsSync(m.to) && !fs.existsSync(m.from)) await moveWithRetry(m.to, m.from, 'un clip', this.d.retryWaits);
        } catch {
          left.push(m);
        }
      }
      if (left.length) {
        b.clips.moved = left;
        rearm(); // nuevo plazo para reintentar
        throw new UserFacingError(`No se pudieron recuperar ${left.length} archivo(s) todavía. Vuelve a pulsar «Deshacer».`);
      }
      // Sólo vuelven los clips de este lote, en su posición original, sobre el estado ACTUAL del trabajo
      // (se respetan otros borrados y las ediciones hechas mientras tanto).
      const ids = new Set(b.clips.ids);
      const cur = this.d.getJobs().find((j) => j.id === b.clips!.before.id);
      const now = new Map((cur?.clips ?? []).map((c) => [c.id, c]));
      const clips = b.clips.before.clips.flatMap((c) => (ids.has(c.id) ? [c] : now.has(c.id) ? [now.get(c.id)!] : []));
      for (const c of cur?.clips ?? []) if (!clips.some((x) => x.id === c.id)) clips.push(c);
      this.d.putJob({ ...(cur ?? b.clips.before), clips });
      (this.d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout)))(b.timer);
      this.batches.delete(batchId);
      // Sin manifiesto: un borrado deshecho no puede decidir nada en el próximo inicio (p. ej. borrar exportados).
      clearUndoneBatch(src);
      this.d.log?.('borrado de clips deshecho', { batch: batchId, trabajo: b.clips.before.id });
      return { restored: 1, pending: 0 };
    }
    // Cada trabajo se recupera por separado: el lote sólo se da por terminado cuando TODOS están de vuelta.
    // Si alguno falla (p. ej. EPERM pasajero en Windows), sigue apartado y se puede volver a pulsar «Deshacer».
    const pending: Job[] = [];
    let restored = 0;
    let lastErr = '';
    for (const j of b.jobs) {
      try {
        const from = path.join(src, j.id);
        const to = safeJobDir(this.d.jobsDir, j.id);
        if (fs.existsSync(from) && !fs.existsSync(to)) await moveWithRetry(from, to, 'la carpeta del trabajo', this.d.retryWaits);
        this.d.putJob(j);
        restored++;
      } catch (e) {
        pending.push(j);
        lastErr = (e as Error).message;
      }
    }
    if (pending.length) {
      b.jobs = pending;
      rearm(); // nuevo plazo para reintentar
      this.d.log?.('borrado masivo: deshacer incompleto', { batch: batchId, restored, pending: pending.length, e: lastErr });
      if (!restored) throw new UserFacingError(`No se pudo recuperar ningún trabajo todavía (${lastErr}). Vuelve a intentarlo.`);
      return { restored, pending: pending.length };
    }
    (this.d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout)))(b.timer);
    this.batches.delete(batchId);
    clearUndoneBatch(src);
    this.d.log?.('borrado masivo deshecho', { batch: batchId, jobs: restored });
    return { restored, pending: 0 };
  }

  /**
   * Borrado definitivo: exports y carpeta apartada a la Papelera. Si la Papelera falla, NO se borra de forma
   * permanente: todo queda apartado y se reintenta en el próximo inicio (el manifiesto en disco lo permite).
   */
  async finalize(batchId: string): Promise<void> {
    const b = this.batches.get(batchId);
    if (!b || b.undoing) return;
    this.batches.delete(batchId);
    for (const j of b.jobs) this.d.forgetPublish(j.id);
    await this.finishBatch(batchId, b.exports);
  }

  private async finishBatch(batchId: string, exportPaths: string[]): Promise<boolean> {
    const dir = path.join(this.d.pendingDir, batchId);
    if (!isInside(this.d.pendingDir, dir) || dir === path.resolve(this.d.pendingDir)) return false;
    // Un export sólo se borra si sigue siendo borrable y ningún trabajo actual lo usa.
    const inUse = new Set(this.d.getJobs().flatMap((j) => j.clips.map((c) => c.exportedPath)).filter(Boolean).map((p) => path.resolve(p!).toLowerCase()));
    let ok = true;
    const left: string[] = [];
    for (const p of exportPaths) {
      if (!deletableExport(p, this.d.jobsDir) || inUse.has(path.resolve(p).toLowerCase())) continue;
      try {
        await this.d.trash(p);
      } catch (e) {
        ok = false;
        left.push(p);
        this.d.log?.('borrado masivo: export no enviado a la Papelera', { p, e: String(e) });
      }
    }
    if (!ok) {
      writeManifest(dir, left);
      return false;
    }
    if (!fs.existsSync(dir)) return true;
    try {
      await this.d.trash(dir);
      return true;
    } catch (e) {
      writeManifest(dir, []);
      this.d.log?.('borrado masivo: carpeta no enviada a la Papelera; se reintentará', { batch: batchId, e: String(e) });
      return false;
    }
  }

  /** Al cerrar la app: lo pendiente se confirma (y si no da tiempo, el manifiesto permite terminarlo al iniciar). */
  async finalizeAll(): Promise<void> {
    for (const id of [...this.batches.keys()]) await this.finalize(id);
  }

  /** Lotes de una sesión anterior (cierre durante el plazo o Papelera que falló): se terminan ahora. */
  async sweepLeftovers(): Promise<void> {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.d.pendingDir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(this.d.pendingDir, e);
      if (this.batches.has(e) || !isInside(this.d.pendingDir, p)) continue;
      const restore = readRestore(p);
      if (restore.length) {
        // Una vuelta atrás interrumpida: los archivos vuelven a su trabajo (validados dentro de las carpetas internas).
        let left = 0;
        for (const r of restore) {
          if (!isInside(p, r.to) || !isInside(this.d.jobsDir, r.from)) continue;
          try {
            if (fs.existsSync(r.to) && !fs.existsSync(r.from)) await moveWithRetry(r.to, r.from, 'un archivo', this.d.retryWaits);
          } catch {
            left++;
          }
        }
        if (!left) clearUndoneBatch(p);
        continue;
      }
      await this.finishBatch(e, readManifest(p));
    }
  }
}

const MANIFEST = 'manifest.json';
function writeManifest(dir: string, exportList: string[], restore: { from: string; to: string }[] = []): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify({ exports: exportList, restore }), 'utf8');
  } catch {
    /* sin manifiesto, la carpeta se reintenta igualmente */
  }
}
function readManifest(dir: string): string[] {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')) as { exports?: unknown };
    return Array.isArray(m.exports) ? m.exports.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
/** Archivos que una vuelta atrás no pudo devolver (se restauran al arrancar). */
function readRestore(dir: string): { from: string; to: string }[] {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')) as { restore?: unknown };
    return Array.isArray(m.restore) ? (m.restore as { from: unknown; to: unknown }[]).filter((x) => typeof x?.from === 'string' && typeof x?.to === 'string') as { from: string; to: string }[] : [];
  } catch {
    return [];
  }
}

/** Archivos de un clip dentro de su trabajo (MP4 interno, subtítulos y miniatura), validados dentro de la carpeta. */
function clipFiles(jobDir: string, c: { file?: string; thumb?: string; index: number }): string[] {
  const out: string[] = [];
  const add = (rel: string) => {
    const f = path.resolve(jobDir, rel);
    if (isInside(jobDir, f) && f !== path.resolve(jobDir) && fs.existsSync(f) && fs.statSync(f).isFile()) out.push(f);
  };
  if (c.file) add(path.join('clips', c.file));
  add(path.join('clips', `${String(c.index).padStart(2, '0')}.ass`));
  if (c.thumb) add(path.join('frames', c.thumb));
  return out;
}

/** Tras «Deshacer»: se quita el manifiesto del lote y sus carpetas, sólo si quedaron vacías (nunca archivos). */
function clearUndoneBatch(src: string): void {
  try {
    fs.rmSync(path.join(src, MANIFEST), { force: true });
  } catch {
    /* ignorar */
  }
  const prune = (d: string): void => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) if (e.isDirectory()) prune(path.join(d, e.name));
    try {
      fs.rmdirSync(d); // falla si no está vacía: se limpiará en el próximo inicio
    } catch {
      /* ignorar */
    }
  };
  prune(src);
}
