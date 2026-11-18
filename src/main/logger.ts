import fs from 'node:fs';
import path from 'node:path';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
let logFile: string | null = null;

/** Redacta posibles secretos (tokens en query strings, cookies) antes de escribir en disco. */
export function redact(s: string): string {
  return s
    .replace(/([?&](?:token|key|sig|signature|auth|access_token|session)[^=]*=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/(cookie:\s*)[^\n]+/gi, '$1[REDACTED]')
    .replace(/(authorization:\s*)[^\n]+/gi, '$1[REDACTED]');
}

export function initLogger(logsDir: string): void {
  fs.mkdirSync(logsDir, { recursive: true });
  logFile = path.join(logsDir, 'app.log');
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_LOG_BYTES) {
      fs.renameSync(logFile, path.join(logsDir, 'app.old.log'));
    }
  } catch {
    /* ignorar */
  }
}

function write(level: string, msg: string, extra?: unknown): void {
  const detail = extra instanceof Error ? `${extra.message}\n${extra.stack ?? ''}` : extra !== undefined ? JSON.stringify(extra) : '';
  const line = redact(`${new Date().toISOString()} [${level}] ${msg}${detail ? ' ' + detail : ''}`) + '\n';
  if (process.env.NODE_ENV !== 'test') process.stdout.write(line);
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line);
    } catch {
      /* ignorar */
    }
  }
}

/** Sólo el dominio de una URL (nunca ruta, query ni tokens) para logs. */
export function urlHost(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return 'url-invalida';
  }
}

/** Evento estructurado JSONL en logs/events.jsonl (sin URL completa, cookies ni rutas de usuario). */
export function event(type: string, data: Record<string, unknown>): void {
  if (!logFile) return;
  const file = path.join(path.dirname(logFile), 'events.jsonl');
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, file.replace(/\.jsonl$/, '.old.jsonl'));
    fs.appendFileSync(file, redact(JSON.stringify({ ts: new Date().toISOString(), type, ...data })) + '\n');
  } catch {
    /* ignorar */
  }
}

export const log = {
  info: (m: string, e?: unknown) => write('INFO', m, e),
  warn: (m: string, e?: unknown) => write('WARN', m, e),
  error: (m: string, e?: unknown) => write('ERROR', m, e),
};
