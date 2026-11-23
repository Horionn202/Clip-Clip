// Interpretación de errores de yt-dlp (la lógica pura está en shared/sourceErrors) y versión instalada.
import fs from 'node:fs';
import { classifySourceError, friendlySourceError } from '../shared/sourceErrors';
import { runProcess } from './proc';

export { FALLBACK_CLIENT_ARGS, isBotCheck } from '../shared/sourceErrors';

/** Mensaje claro y sin comandos a partir del stderr de yt-dlp. */
export function friendlyYtDlpError(stderr: string, version?: string, attempts = 1): string {
  return friendlySourceError(stderr, version, attempts);
}
export { classifySourceError };

const versions = new Map<string, { mtime: number; version: string | undefined }>();

/** Versión de yt-dlp (`--version`), cacheada mientras el ejecutable no cambie. undefined si no responde. */
export async function ytDlpVersion(ytDlp: string, run = runProcess): Promise<string | undefined> {
  let mtime = 0;
  try {
    mtime = fs.statSync(ytDlp).mtimeMs;
  } catch {
    /* ruta del PATH sin stat: se consulta igual */
  }
  const hit = versions.get(ytDlp);
  if (hit && hit.mtime === mtime && hit.version) return hit.version;
  const r = await run(ytDlp, ['--version'], { timeoutMs: 20_000 }).catch(() => null);
  const version = r && r.code === 0 ? r.stdout.trim().split(/\s+/)[0] || undefined : undefined;
  versions.set(ytDlp, { mtime, version });
  return version;
}
