import { describe, it, expect } from 'vitest';
import { JobQueue, type JobRunner } from '../src/main/queue';
import { CancelledError, runProcess } from '../src/main/proc';
import { UserFacingError } from '../src/shared/validation';
import type { Job } from '../src/shared/types';

function setup(runner: JobRunner, concurrency = 1) {
  const store = new Map<string, Job>();
  const q = new JobQueue({ get: (id) => store.get(id), put: (j) => store.set(j.id, j), emit: () => undefined, runner, concurrency: () => concurrency });
  const add = (id: string) => {
    store.set(id, { id, url: 'https://x.com', preset: 30, maxClips: 1, status: 'queued', progress: 0, message: '', clips: [], createdAt: '', updatedAt: '' });
    q.enqueue(id);
  };
  return { q, store, add };
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const waitForAbort: JobRunner = (_job, signal, update) =>
  new Promise((_res, rej) => {
    update({ status: 'downloading' });
    signal.addEventListener('abort', () => rej(new CancelledError()));
  });

describe('cancelación de trabajos', () => {
  it('cancela un trabajo en ejecución', async () => {
    const { q, store, add } = setup(waitForAbort);
    add('job-aaaa1');
    await tick();
    expect(store.get('job-aaaa1')!.status).toBe('downloading');
    q.cancel('job-aaaa1');
    await tick();
    expect(store.get('job-aaaa1')!.status).toBe('cancelled');
  });
  it('cancela un trabajo en cola sin ejecutarlo y arranca el siguiente', async () => {
    const started: string[] = [];
    const { q, store, add } = setup((job, signal, update) => {
      started.push(job.id);
      return waitForAbort(job, signal, update);
    });
    add('job-aaaa1');
    add('job-bbbb2');
    add('job-cccc3');
    await tick();
    q.cancel('job-bbbb2');
    expect(store.get('job-bbbb2')!.status).toBe('cancelled');
    q.cancel('job-aaaa1');
    await tick();
    expect(started).toEqual(['job-aaaa1', 'job-cccc3']);
    q.cancelAll();
    await tick();
    expect(store.get('job-cccc3')!.status).toBe('cancelled');
  });
  it('un trabajo cancelado no vuelve a otro estado', async () => {
    const { q, store, add } = setup(async (_j, signal, update) => {
      await new Promise((r) => setTimeout(r, 20));
      update({ status: 'rendering' }); // llega tarde
      if (signal.aborted) throw new CancelledError();
    });
    add('job-aaaa1');
    await tick(1);
    q.cancel('job-aaaa1');
    await tick(40);
    expect(store.get('job-aaaa1')!.status).toBe('cancelled');
  });
  it('errores de usuario se muestran tal cual; errores internos se ocultan', async () => {
    const { store, add } = setup(async (j) => {
      if (j.id === 'job-aaaa1') throw new UserFacingError('Falta FFmpeg.');
      throw new Error('ENOENT C:\\secret\\path');
    }, 2);
    add('job-aaaa1');
    add('job-bbbb2');
    await tick();
    expect(store.get('job-aaaa1')!.error).toBe('Falta FFmpeg.');
    expect(store.get('job-bbbb2')!.status).toBe('failed');
    expect(store.get('job-bbbb2')!.error).not.toMatch(/secret/);
  });
  it('runProcess mata el proceso al abortar', async () => {
    const ctrl = new AbortController();
    const p = runProcess(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 200);
    await expect(p).rejects.toBeInstanceOf(CancelledError);
  });
  it('runProcess no usa shell: los metacaracteres llegan literales', async () => {
    const r = await runProcess(process.execPath, ['-e', 'console.log(process.argv[1])', '& echo hacked']);
    expect(r.stdout.trim()).toBe('& echo hacked');
  });
});
