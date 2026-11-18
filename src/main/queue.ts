import type { Job } from '../shared/types';
import { TERMINAL_STATUSES } from '../shared/types';
import { UserFacingError } from '../shared/validation';
import { CancelledError } from './proc';

export type JobRunner = (job: Job, signal: AbortSignal, update: (patch: Partial<Job>) => void) => Promise<void>;

export interface QueueDeps {
  get: (id: string) => Job | undefined;
  put: (job: Job) => void;
  emit: (job: Job) => void;
  runner: JobRunner;
  concurrency: () => number;
  logError?: (msg: string, err: unknown) => void;
}

/** Cola FIFO con concurrencia limitada y cancelación por AbortController. */
export class JobQueue {
  private pending: string[] = [];
  private running = new Map<string, AbortController>();
  constructor(private deps: QueueDeps) {}

  enqueue(id: string): void {
    this.pending.push(id);
    this.pump();
  }

  get activeCount(): number {
    return this.running.size + this.pending.length;
  }

  cancel(id: string): boolean {
    const idx = this.pending.indexOf(id);
    if (idx >= 0) {
      this.pending.splice(idx, 1);
      this.patch(id, { status: 'cancelled', message: 'Cancelado por el usuario' });
      return true;
    }
    const ctrl = this.running.get(id);
    if (ctrl) {
      ctrl.abort();
      return true;
    }
    return false;
  }

  cancelAll(): void {
    for (const id of [...this.pending]) this.cancel(id);
    for (const c of this.running.values()) c.abort();
  }

  private patch(id: string, p: Partial<Job>): void {
    const job = this.deps.get(id);
    if (!job) return;
    if (TERMINAL_STATUSES.includes(job.status) && p.status && p.status !== job.status) return; // estados finales inmutables
    Object.assign(job, p);
    this.deps.put(job);
    this.deps.emit(job);
  }

  private pump(): void {
    while (this.running.size < Math.max(1, this.deps.concurrency()) && this.pending.length) {
      const id = this.pending.shift()!;
      const job = this.deps.get(id);
      if (!job) continue;
      const ctrl = new AbortController();
      this.running.set(id, ctrl);
      void this.run(job, ctrl);
    }
  }

  private async run(job: Job, ctrl: AbortController): Promise<void> {
    try {
      await this.deps.runner(job, ctrl.signal, (p) => {
        if (!ctrl.signal.aborted) this.patch(job.id, p);
      });
      if (ctrl.signal.aborted) throw new CancelledError();
      this.patch(job.id, { status: 'completed', progress: 1, message: 'Listo' });
    } catch (err) {
      if (ctrl.signal.aborted || err instanceof CancelledError) {
        this.patch(job.id, { status: 'cancelled', message: 'Cancelado por el usuario' });
      } else {
        this.deps.logError?.(`Trabajo ${job.id} falló`, err);
        const msg = err instanceof UserFacingError ? err.message : 'Ocurrió un error inesperado. Consulta los logs para más detalle.';
        this.patch(job.id, { status: 'failed', error: msg, message: msg });
      }
    } finally {
      this.running.delete(job.id);
      this.pump();
    }
  }
}
