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

export const log = {
  info: (m: string, e?: unknown) => write('INFO', m, e),
  warn: (m: string, e?: unknown) => write('WARN', m, e),
  error: (m: string, e?: unknown) => write('ERROR', m, e),
};
