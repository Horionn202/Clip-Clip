// Análisis y limpieza del almacenamiento de los trabajos. Sólo actúa dentro de jobs/<id>; nunca toca exports.
import fs from 'node:fs';
import path from 'node:path';
import type { Clip, Job } from '../shared/types';
import {
  CLEANABLE_STATUSES,
  classify,
  type CleanupOptions,
  type CleanupResult,
  type PlannedFile,
  type StorageCategory,
  type StorageReport,
} from '../shared/storage';
import { isInside } from './paths';

export interface JobFile {
  rel: string;
  bytes: number;
}

export function listJobFiles(dir: string, rel = ''): JobFile[] {
  let out: JobFile[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out = out.concat(listJobFiles(dir, r));
    else if (e.isFile()) {
      try {
        out.push({ rel: r, bytes: fs.statSync(path.join(dir, r)).size });
      } catch {
        /* ignorar */
      }
    }
  }
  return out;
}

export interface VerifyDeps {
  /** Duración real de un vídeo (ffprobe). Opcional: si falta, se verifica por tamaño. */
  probeDuration?: (file: string) => number | null;
}

/**
 * Un export está verificado si: existe, tiene tamaño > 0, está FUERA de la carpeta de trabajos, coincide en
 * tamaño con el clip interno (es una copia) cuando éste existe y, si hay ffprobe, dura lo que el clip (±1 s).
 */
export function verifyExport(jobsDir: string, jobId: string, clip: Clip, deps: VerifyDeps = {}): boolean {
  const exp = clip.exportedPath;
  // Cambios pendientes de render: el export ya no corresponde al clip y su origen hace falta para re-renderizar.
  if (clip.dirty) return false;
  if (!exp || !path.isAbsolute(exp)) return false;
  if (isInside(jobsDir, exp)) return false;
  let st: fs.Stats;
  try {
    st = fs.statSync(exp);
  } catch {
    return false;
  }
  if (!st.isFile() || st.size <= 0) return false;
  if (clip.file) {
    const internal = path.join(jobsDir, jobId, 'clips', clip.file);
    try {
      if (fs.statSync(internal).size !== st.size) return false;
    } catch {
      /* el interno ya no existe: basta con el export */
    }
  }
  if (deps.probeDuration) {
    const d = deps.probeDuration(exp);
    if (d === null || Math.abs(d - (clip.end - clip.start)) > 1) return false;
  }
  return true;
}

function emptyBy(): Record<StorageCategory, number> {
  return { source: 0, audio: 0, frames: 0, temp: 0, transcript: 0, internalClip: 0, other: 0 };
}

/** Analiza el uso y planifica qué se puede borrar con las opciones dadas. No borra nada. */
export function planCleanup(jobs: Job[], jobsDir: string, opts: CleanupOptions, deps: VerifyDeps = {}, onlyJobId?: string): StorageReport {
  const byCategory = emptyBy();
  const files: PlannedFile[] = [];
  const affected = new Set<string>();
  let totalBytes = 0;
  let exportsBytes = 0;
  let skippedActive = 0;
  for (const job of jobs) {
    if (onlyJobId && job.id !== onlyJobId) continue;
    const dir = path.join(jobsDir, job.id);
    const list = listJobFiles(dir);
    for (const f of list) {
      totalBytes += f.bytes;
      byCategory[classify(f.rel)] += f.bytes;
    }
    for (const c of job.clips) {
      if (c.exportedPath) {
        try {
          exportsBytes += fs.statSync(c.exportedPath).size;
        } catch {
          /* export movido o borrado por el usuario */
        }
      }
    }
    if (!CLEANABLE_STATUSES.includes(job.status)) {
      if (list.length) skippedActive++;
      continue;
    }
    // Clips internos borrables: sólo los que tienen export verificado.
    const verified = new Set(job.clips.filter((c) => c.file && verifyExport(jobsDir, job.id, c, deps)).map((c) => path.join('clips', c.file!)));
    // Fotogramas de referencia de los clips (miniaturas y editor de facecam): sólo se generan en el pipeline, se conservan.
    const thumbs = keptThumbs(job);
    const rendered = job.clips.filter((c) => c.file);
    const allExported = rendered.length > 0 && rendered.every((c) => verifyExport(jobsDir, job.id, c, deps));
    for (const f of list) {
      const cat = classify(f.rel);
      if (thumbs.has(f.rel.replace(/\\/g, '/'))) continue;
      const take =
        (cat === 'source' && opts.source && (!opts.sourceOnlyExported || allExported)) ||
        (cat === 'audio' && opts.audio) ||
        (cat === 'frames' && opts.frames) ||
        (cat === 'temp' && opts.temp) ||
        (cat === 'transcript' && opts.transcript) ||
        (cat === 'internalClip' && opts.internalClips && verified.has(f.rel));
      if (take) {
        files.push({ jobId: job.id, rel: f.rel, category: cat, bytes: f.bytes });
        affected.add(job.id);
      }
    }
  }
  return {
    totalBytes,
    byCategory,
    exportsBytes,
    recoverableBytes: files.reduce((a, f) => a + f.bytes, 0),
    jobsAffected: affected.size,
    files,
    skippedActive,
  };
}

export interface ExecuteDeps {
  /** Borra un archivo (Papelera de reciclaje si es posible). */
  remove: (full: string) => Promise<void>;
  usedTrash: boolean;
  log?: (msg: string, extra?: unknown) => void;
}

/** Ejecuta un plan. Cada ruta se re-valida dentro de jobs/<id>; un fallo no detiene el resto. */
export async function executeCleanup(files: PlannedFile[], jobs: Job[], jobsDir: string, deps: ExecuteDeps): Promise<CleanupResult> {
  const res: CleanupResult = { freedBytes: 0, deleted: 0, errors: [], jobs: [], usedTrash: deps.usedTrash };
  const active = new Set(jobs.filter((j) => !CLEANABLE_STATUSES.includes(j.status)).map((j) => j.id));
  const known = new Set(jobs.map((j) => j.id));
  const touched = new Set<string>();
  // Exports registrados de cualquier trabajo: nunca se borran, estén donde estén.
  const exportsSet = new Set(jobs.flatMap((j) => j.clips.map((c) => c.exportedPath)).filter((x): x is string => !!x).map((x) => path.resolve(x).toLowerCase()));
  for (const f of files) {
    const jobDir = path.join(jobsDir, f.jobId);
    const full = path.resolve(jobDir, f.rel);
    try {
      if (!known.has(f.jobId)) throw new Error('trabajo desconocido');
      if (active.has(f.jobId)) throw new Error('el trabajo está en curso');
      // Nunca fuera de la carpeta administrada del trabajo (ni la propia carpeta).
      if (!isInside(jobDir, full) || path.resolve(full) === path.resolve(jobDir) || !isInside(jobsDir, full)) throw new Error('ruta fuera de la carpeta administrada');
      if (exportsSet.has(full.toLowerCase())) throw new Error('es un clip exportado; se conserva');
      if (!fs.existsSync(full)) {
        touched.add(f.jobId);
        continue;
      }
      await deps.remove(full);
      res.freedBytes += f.bytes;
      res.deleted++;
      touched.add(f.jobId);
      deps.log?.('limpieza: eliminado', { job: f.jobId, archivo: f.rel, bytes: f.bytes });
    } catch (e) {
      res.errors.push({ jobId: f.jobId, rel: f.rel, message: (e as Error).message.slice(0, 200) });
      deps.log?.('limpieza: error', { job: f.jobId, archivo: f.rel, error: (e as Error).message });
    }
  }
  res.jobs = [...touched];
  return res;
}

/** Fotogramas de referencia de los clips (rutas relativas con «/»). */
function keptThumbs(job: Job): Set<string> {
  return new Set(job.clips.filter((c) => c.thumb).map((c) => `frames/${c.thumb}`));
}

/** Actualiza los indicadores del trabajo según lo que ya no existe en disco (no destructivo). */
export function refreshJobFlags(job: Job, jobsDir: string, freedBytes: number, deps: VerifyDeps = {}): Job {
  const dir = path.join(jobsDir, job.id);
  const thumbs = keptThumbs(job);
  const cats = new Set(listJobFiles(dir).filter((f) => !thumbs.has(f.rel.replace(/\\/g, '/'))).map((f) => classify(f.rel)));
  const files = new Set(listJobFiles(dir).map((f) => f.rel.replace(/\\/g, '/')));
  const clips = job.clips.map((c) => {
    const exportVerified = verifyExport(jobsDir, job.id, c, deps);
    const internalPresent = !!c.file && files.has(`clips/${c.file}`);
    // Archivado = no hay clip interno pero sí su export (para reproducirlo), aunque tenga ediciones pendientes.
    const exportExists = !!c.exportedPath && (exportVerified || c.archived === true) && fs.existsSync(c.exportedPath);
    return { ...c, exportVerified, archived: !!c.file && !internalPresent && exportExists };
  });
  const internalClipsCleaned = clips.some((c) => c.archived);
  return {
    ...job,
    clips,
    sourceCleaned: !cats.has('source'),
    tempCleaned: !cats.has('audio') && !cats.has('temp') && !cats.has('frames'),
    internalClipsCleaned,
    archivedExportsOnly: internalClipsCleaned && clips.filter((c) => c.file).every((c) => c.archived),
    lastCleanupAt: new Date().toISOString(),
    bytesFreed: (job.bytesFreed ?? 0) + freedBytes,
  };
}
