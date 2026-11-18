import { spawn, execFile } from 'node:child_process';

export class CancelledError extends Error {
  constructor() {
    super('Trabajo cancelado');
    this.name = 'CancelledError';
  }
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
  /** Bytes máximos que se retienen de stdout (el resto se descarta). */
  maxBuffer?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ya terminado */
    }
  }
}

/**
 * Ejecuta un proceso con argumentos estructurados (shell: false). Nunca interpola entrada del usuario
 * en una línea de comandos.
 */
export function runProcess(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new CancelledError());
    const maxBuffer = opts.maxBuffer ?? 8 * 1024 * 1024;
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ? { ...process.env, ...opts.env } : process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let cancelled = false;
    let timedOut = false;

    const lineSplitter = (cb?: (l: string) => void) => {
      let buf = '';
      return (chunk: Buffer, sink: 'out' | 'err') => {
        const s = chunk.toString('utf8');
        if (sink === 'out') {
          if (stdout.length < maxBuffer) stdout += s;
        } else if (stderr.length < 256 * 1024) stderr += s;
        if (!cb) return;
        buf += s;
        const parts = buf.split(/\r\n|\n|\r/);
        buf = parts.pop() ?? '';
        for (const p of parts) if (p) cb(p);
      };
    };
    const outH = lineSplitter(opts.onStdout);
    const errH = lineSplitter(opts.onStderr);
    child.stdout.on('data', (c: Buffer) => outH(c, 'out'));
    child.stderr.on('data', (c: Buffer) => errH(c, 'err'));

    const onAbort = () => {
      cancelled = true;
      killTree(child.pid);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child.pid);
        }, opts.timeoutMs)
      : undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) =>
      finish(() => {
        if (cancelled) return reject(new CancelledError());
        if (timedOut) return reject(new Error(`Tiempo de espera agotado ejecutando ${cmd}`));
        resolve({ code: code ?? -1, stdout, stderr });
      }),
    );
  });
}
