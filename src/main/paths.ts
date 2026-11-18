import path from 'node:path';
import { UserFacingError } from '../shared/validation';

/** true si `target` está dentro de `root` (o es `root`), resolviendo `..` y mayúsculas en Windows. */
export function isInside(root: string, target: string): boolean {
  const r = path.resolve(root);
  const t = path.resolve(target);
  const rel = path.relative(r, t);
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Resuelve `rel` dentro de `root` o lanza si escapa. */
export function resolveInside(root: string, rel: string): string {
  if (typeof rel !== 'string' || rel.includes('\0')) throw new UserFacingError('Ruta no válida.');
  const full = path.resolve(root, rel);
  if (!isInside(root, full)) throw new UserFacingError('Ruta fuera de la carpeta permitida.');
  return full;
}

const ID_RE = /^[a-z0-9-]{8,64}$/;
export function assertId(id: unknown): string {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new UserFacingError('Identificador no válido.');
  return id;
}

/** Valida una ruta de ejecutable configurada por el usuario. '' = autodetectar. */
export function validateExecutablePath(p: unknown): string {
  if (typeof p !== 'string') throw new UserFacingError('Ruta de ejecutable no válida.');
  const t = p.trim();
  if (t === '') return '';
  if (t.length > 1024 || t.includes('\0')) throw new UserFacingError('Ruta de ejecutable no válida.');
  if (!path.isAbsolute(t)) throw new UserFacingError('La ruta del ejecutable debe ser absoluta.');
  if (process.platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(t)) {
    throw new UserFacingError('El ejecutable debe tener extensión .exe.');
  }
  return path.normalize(t);
}

export interface AppPaths {
  userData: string;
  jobsDir: string;
  dataDir: string;
  logsDir: string;
}

export function buildAppPaths(userData: string): AppPaths {
  return {
    userData,
    jobsDir: path.join(userData, 'jobs'),
    dataDir: path.join(userData, 'data'),
    logsDir: path.join(userData, 'logs'),
  };
}
