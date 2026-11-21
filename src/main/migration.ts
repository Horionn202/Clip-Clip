// Migración de datos de la versión anterior («ClipsVirales») a Clip Clip, en el primer inicio.
// Reglas: nunca borra el origen, nunca sobrescribe datos del nuevo directorio, registra lo hecho y,
// si falla, conserva ambos directorios (se reintenta en el siguiente inicio sin repetir lo ya migrado).
import fs from 'node:fs';
import path from 'node:path';

export const LEGACY_DIR_NAME = 'ClipsVirales';
export const MARKER = path.join('data', 'migration-clipsvirales.json');

/** Carpetas que se migran. El entorno Python de la app (python-env, varios GB) no se toca: se sigue usando desde su ruta. */
export const MIGRATED_DIRS = ['data', 'jobs', 'logs'];
/** Archivos grandes que se enlazan en vez de copiarse. */
export const LINKABLE = /\.(mp4|mkv|webm|mov|wav)$/i;

export interface MigrationReport {
  status: 'none' | 'already' | 'migrated' | 'partial' | 'failed';
  from: string;
  to: string;
  linked: number;
  copied: number;
  skippedExisting: number;
  mergedJobs: number;
  errors: string[];
  at: string;
}

interface JobLike {
  id: string;
}

/**
 * Lista los archivos de una carpeta. Una carpeta inexistente se ignora (es opcional); cualquier otro error
 * de lectura (p. ej. acceso denegado) se registra en `errors` para que la migración no se dé por terminada.
 */
export function walk(dir: string, errors: string[], rel = '', readdir: (p: string) => fs.Dirent[] = (p) => fs.readdirSync(p, { withFileTypes: true })): string[] {
  let out: string[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = readdir(path.join(dir, rel));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`${rel || path.basename(dir)}: no se pudo leer la carpeta (${(e as Error).message})`.slice(0, 300));
    return out;
  }
  for (const e of entries) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out = out.concat(walk(dir, errors, r, readdir));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/** Une historiales por id; si un trabajo existe en ambos, gana el del directorio nuevo. */
export function mergeJobs(newer: JobLike[], legacy: JobLike[]): { jobs: JobLike[]; added: number } {
  const ids = new Set(newer.map((j) => j.id));
  const extra = legacy.filter((j) => j && typeof j.id === 'string' && !ids.has(j.id));
  return { jobs: [...newer, ...extra], added: extra.length };
}

export interface MigrationFs {
  link: (src: string, dst: string) => void;
  copy: (src: string, dst: string) => void;
}

const realFs: MigrationFs = {
  link: (s, d) => fs.linkSync(s, d),
  copy: (s, d) => fs.copyFileSync(s, d, fs.constants.COPYFILE_EXCL),
};

export interface MigrateOptions {
  /** Reparación: se ejecuta aunque exista el marcador (la existencia del marcador ya no significa «terminado»). */
  repair?: boolean;
  /** Sólo estas rutas relativas (p. ej. los archivos que faltan). Nunca se sobrescribe nada que ya exista. */
  only?: ReadonlySet<string>;
  /** Al fusionar historial y publicación: sólo estas entradas antiguas (la reparación nunca resucita lo borrado a propósito). */
  keepEntry?: (id: string) => boolean;
}

export function migrateLegacyData(oldDir: string, newDir: string, io: MigrationFs = realFs, opts: MigrateOptions = {}): MigrationReport {
  const report: MigrationReport = { status: 'none', from: oldDir, to: newDir, linked: 0, copied: 0, skippedExisting: 0, mergedJobs: 0, errors: [], at: new Date().toISOString() };
  if (path.resolve(oldDir) === path.resolve(newDir) || !fs.existsSync(oldDir)) return report;
  if (!opts.repair && fs.existsSync(path.join(newDir, MARKER))) return { ...report, status: 'already' };

  for (const top of MIGRATED_DIRS) {
    const enumErrors: string[] = [];
    const files = walk(path.join(oldDir, top), enumErrors);
    report.errors.push(...enumErrors.map((e) => `${top}/${e}`));
    for (const rel of files) {
      const relPath = path.join(top, rel);
      if (opts.only && !opts.only.has(relPath)) continue;
      const src = path.join(oldDir, relPath);
      const dst = path.join(newDir, relPath);
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        if (relPath === path.join('data', 'jobs.json') && fs.existsSync(dst)) {
          // Historial en ambos sitios: se fusiona (sin perder trabajos de ninguno).
          const a = JSON.parse(fs.readFileSync(dst, 'utf8')) as JobLike[];
          const b = JSON.parse(fs.readFileSync(src, 'utf8')) as JobLike[];
          const legacy = (Array.isArray(b) ? b : []).filter((j) => !opts.keepEntry || (j && opts.keepEntry(j.id)));
          const { jobs, added } = mergeJobs(Array.isArray(a) ? a : [], legacy);
          if (added > 0) {
            const tmp = `${dst}.migr.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2), 'utf8');
            fs.renameSync(tmp, dst);
          }
          report.mergedJobs += added;
          continue;
        }
        if (relPath === path.join('data', 'publish.json') && fs.existsSync(dst)) {
          // Metadatos de publicación en ambos sitios: se fusionan por trabajo (gana el directorio nuevo).
          const a = JSON.parse(fs.readFileSync(dst, 'utf8')) as Record<string, unknown>;
          const b = JSON.parse(fs.readFileSync(src, 'utf8')) as Record<string, unknown>;
          const extra = Object.keys(b ?? {}).filter((k) => !(k in (a ?? {})) && (!opts.keepEntry || opts.keepEntry(k)));
          if (extra.length) {
            const tmp = `${dst}.migr.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ ...Object.fromEntries(extra.map((k) => [k, b[k]])), ...a }, null, 2), 'utf8');
            fs.renameSync(tmp, dst);
          }
          continue;
        }
        if (fs.existsSync(dst)) {
          report.skippedExisting++;
          continue;
        }
        // Reparación sin historial o publicación en Clip Clip: se crean sólo con las entradas que faltan.
        if (opts.keepEntry && (relPath === path.join('data', 'jobs.json') || relPath === path.join('data', 'publish.json'))) {
          const b = JSON.parse(fs.readFileSync(src, 'utf8')) as unknown;
          const out = Array.isArray(b) ? b.filter((j: JobLike) => j && opts.keepEntry!(j.id)) : Object.fromEntries(Object.entries((b ?? {}) as Record<string, unknown>).filter(([k]) => opts.keepEntry!(k)));
          fs.writeFileSync(dst, JSON.stringify(out, null, 2), 'utf8');
          if (Array.isArray(out)) report.mergedJobs += out.length;
          else report.copied++;
          continue;
        }
        // Vídeos y audio de los trabajos: enlace duro (mismo contenido sin ocupar más disco). La app nunca los
        // modifica en sitio (los sustituye con un rename), así el original no cambia. Lo demás se copia.
        let linked = false;
        if (top === 'jobs' && LINKABLE.test(rel)) {
          try {
            io.link(src, dst);
            linked = true;
          } catch {
            linked = false;
          }
        }
        if (linked) report.linked++;
        else {
          io.copy(src, dst);
          report.copied++;
        }
      } catch (e) {
        report.errors.push(`${relPath}: ${(e as Error).message}`.slice(0, 300));
      }
    }
  }

  const moved = report.linked + report.copied + report.mergedJobs;
  report.status = report.errors.length === 0 ? (moved > 0 || report.skippedExisting > 0 ? 'migrated' : 'none') : moved > 0 ? 'partial' : 'failed';
  // Sólo se marca como hecha si no hubo errores: así un fallo se reintenta en el siguiente inicio.
  if (report.errors.length === 0 && !opts.repair) {
    try {
      fs.mkdirSync(path.join(newDir, 'data'), { recursive: true });
      let migratedJobIds: string[] = [];
      try {
        const old = JSON.parse(fs.readFileSync(path.join(oldDir, 'data', 'jobs.json'), 'utf8')) as JobLike[];
        migratedJobIds = Array.isArray(old) ? old.filter((j) => j && typeof j.id === 'string').map((j) => j.id) : [];
      } catch {
        /* sin historial antiguo */
      }
      fs.writeFileSync(path.join(newDir, MARKER), JSON.stringify({ ...report, state: 'completed', migratedJobIds }, null, 2), 'utf8');
    } catch (e) {
      report.errors.push(`marcador: ${(e as Error).message}`);
      report.status = 'partial';
    }
  }
  return report;
}

/** Mensaje breve para el usuario (o null si no hay nada que contar). */
export function migrationNotice(r: MigrationReport): { kind: 'info' | 'error'; text: string } | null {
  if (r.status === 'migrated' && r.linked + r.copied + r.mergedJobs > 0) {
    return { kind: 'info', text: 'Se trasladaron tus ajustes, historial y clips de ClipsVirales a Clip Clip. La carpeta anterior se conserva.' };
  }
  if (r.status === 'partial' || r.status === 'failed') {
    return {
      kind: 'error',
      text: `No se pudieron trasladar todos los datos de ClipsVirales (${r.errors.length} archivos). Se conservan ambas carpetas y se reintentará al abrir la app. Detalle en Configuración → Diagnóstico y en logs/app.log.`,
    };
  }
  return null;
}
