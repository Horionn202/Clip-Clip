// Limpieza de exports ya publicados. Sólo con confirmación del usuario (o con la opción explícita activada).
// Reglas: sólo MP4 exportados dentro de la carpeta de exportación; nunca de clips pendientes, borradores ni
// no publicados; siempre a la Papelera de reciclaje; se conserva toda la metadata (título, textos, historial).
import fs from 'node:fs';
import path from 'node:path';
import type { Clip, Job } from '../shared/types';
import { PLATFORMS, type ClipPublish, type Platform } from '../shared/publish';
import { isInside } from './paths';

export interface PublishedExport {
  jobId: string;
  clipId: string;
  title: string;
  path: string;
  name: string;
  bytes: number;
  platforms: Platform[];
}

/** Estados que significan «pendiente de publicar» (incluido borrador): si alguna plataforma está así, el clip no se limpia. */
const PENDING = new Set(['borrador', 'listo', 'programado']);

/** Plataformas en las que el clip está publicado (de entre las elegidas), o [] si no cumple las reglas. */
export function publishedPlatforms(pub: ClipPublish | undefined, platforms: Platform[] = PLATFORMS): Platform[] {
  if (!pub) return [];
  if (PLATFORMS.some((p) => pub[p] && PENDING.has(pub[p]!.status))) return [];
  return platforms.filter((p) => pub[p]?.status === 'publicado');
}

export interface ExportFs {
  size: (p: string) => number | null;
}
const realFs: ExportFs = {
  size: (p) => {
    try {
      const st = fs.statSync(p);
      return st.isFile() ? st.size : null;
    } catch {
      return null;
    }
  },
};

/** Motivo por el que el export de un clip no se puede borrar (o null si se puede). */
export function exportBlocker(job: Job, clip: Clip, exportDir: string, jobsDir: string): string | null {
  if (job.status !== 'completed') return 'el trabajo no está completado';
  if (!clip.exportedPath) return 'no tiene export';
  const p = path.resolve(clip.exportedPath);
  if (!/\.mp4$/i.test(p)) return 'no es un MP4 exportado';
  if (!isInside(exportDir, p) || path.resolve(exportDir) === p) return 'está fuera de la carpeta de exportación';
  if (isInside(jobsDir, p)) return 'está dentro de la carpeta de trabajos';
  return null;
}

export function findPublishedExports(jobs: Job[], pubFor: (jobId: string) => Record<string, ClipPublish>, exportDir: string, jobsDir: string, platforms: Platform[] = PLATFORMS, io: ExportFs = realFs): PublishedExport[] {
  const out: PublishedExport[] = [];
  for (const job of jobs) {
    const pub = pubFor(job.id);
    for (const clip of job.clips) {
      const plats = publishedPlatforms(pub[clip.id], platforms);
      if (!plats.length || exportBlocker(job, clip, exportDir, jobsDir)) continue;
      const bytes = io.size(clip.exportedPath!);
      if (bytes === null) continue;
      out.push({ jobId: job.id, clipId: clip.id, title: clip.title, path: path.resolve(clip.exportedPath!), name: path.basename(clip.exportedPath!), bytes, platforms: plats });
    }
  }
  return out;
}

export const recoverableBytes = (list: PublishedExport[]) => list.reduce((a, x) => a + x.bytes, 0);

export interface DeleteResult {
  deleted: { jobId: string; clipId: string; bytes: number }[];
  errors: { clipId: string; message: string }[];
  freedBytes: number;
}

/**
 * Envía a la Papelera los exports indicados. Cada uno se re-valida justo antes (estado, ruta y existencia).
 * Si la Papelera falla, el archivo se conserva (no hay borrado irreversible).
 */
export async function deletePublishedExports(
  items: { jobId: string; clipId: string }[],
  current: () => PublishedExport[],
  trash: (p: string) => Promise<void>,
  log: (msg: string, extra?: unknown) => void,
): Promise<DeleteResult> {
  const res: DeleteResult = { deleted: [], errors: [], freedBytes: 0 };
  const allowed = new Map(current().map((x) => [`${x.jobId}/${x.clipId}`, x]));
  for (const it of items) {
    const x = allowed.get(`${it.jobId}/${it.clipId}`);
    if (!x) {
      res.errors.push({ clipId: it.clipId, message: 'ya no cumple las condiciones (no publicado, pendiente o fuera de la carpeta de exportación)' });
      log('exports publicados: omitido', { job: it.jobId, clip: it.clipId });
      continue;
    }
    try {
      await trash(x.path);
      res.deleted.push({ jobId: x.jobId, clipId: x.clipId, bytes: x.bytes });
      res.freedBytes += x.bytes;
      log('exports publicados: enviado a la Papelera', { job: x.jobId, clip: x.clipId, archivo: x.name, bytes: x.bytes });
    } catch (e) {
      res.errors.push({ clipId: x.clipId, message: `no se pudo enviar a la Papelera: ${(e as Error).message}`.slice(0, 200) });
      log('exports publicados: error', { job: x.jobId, clip: x.clipId, error: (e as Error).message });
    }
  }
  return res;
}

/** Marca el clip (conserva título, textos e historial; sólo deja de apuntar al MP4 eliminado). */
export function markExportDeleted(clip: Clip, now: string): Clip {
  return { ...clip, exportedPath: undefined, exportVerified: false, exportDeletedAfterPublish: now };
}
