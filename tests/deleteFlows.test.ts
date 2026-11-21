// Flujo único de borrado: trabajos y clips con «Deshacer», reintentos ante bloqueos de Windows y Papelera.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BulkDeleter, LockedError, moveWithRetry } from '../src/main/bulkDelete';
import type { Clip, Job } from '../src/shared/types';

let root = '';
let jobsDir = '';
let exportDir = '';
let pendingDir = '';
let store: Map<string, Job>;
let trashed: string[];
let timers: (() => void)[];

const clip = (id: string, index: number, exportedPath?: string): Clip => ({ id, index, start: 0, end: 15, title: `Clip ${index}`, hook: '', reason: '', score: 1, file: `0${index}_c.mp4`, thumb: `0${index}.jpg`, exportedPath });
const job = (id: string, status: Job['status'], clips: Clip[]): Job => ({ id, url: 'u', preset: 15, maxClips: 3, status, progress: 1, message: '', clips, createdAt: '', updatedAt: '', sourceTitle: `Vídeo ${id}` }) as Job;
const w = (p: string, bytes: number) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, Buffer.alloc(bytes)));
function seedJob(id: string, status: Job['status'] = 'completed', exported = false): Job {
  const dir = path.join(jobsDir, id);
  w(path.join(dir, 'source.mp4'), 1000);
  const clips = [1, 2].map((i) => {
    w(path.join(dir, 'clips', `0${i}_c.mp4`), 100);
    w(path.join(dir, 'clips', `0${i}.ass`), 5);
    w(path.join(dir, 'frames', `0${i}.jpg`), 10);
    const exp = exported ? path.join(exportDir, `${id}_${i}.mp4`) : undefined;
    if (exp) w(exp, 100);
    return clip(`${id}-c${i}`, i, exp);
  });
  const j = job(id, status, clips);
  store.set(id, j);
  return j;
}
const deleter = (extra: Partial<ConstructorParameters<typeof BulkDeleter>[0]> = {}) =>
  new BulkDeleter({
    jobsDir,
    pendingDir,
    getJobs: () => [...store.values()],
    putJob: (j) => store.set(j.id, j),
    removeJob: (id) => store.delete(id),
    forgetPublish: () => undefined,
    trash: async (p) => {
      trashed.push(p);
      fs.rmSync(p, { recursive: true, force: true }); // simula la Papelera
    },
    busy: () => new Set(),
    setTimer: (fn) => (timers.push(fn), timers.length),
    clearTimer: () => undefined,
    retryWaits: [1, 1, 1],
    ...extra,
  });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-delflow-'));
  jobsDir = path.join(root, 'jobs');
  exportDir = path.join(root, 'exports');
  pendingDir = path.join(root, 'pending-delete');
  fs.mkdirSync(exportDir, { recursive: true });
  store = new Map();
  trashed = [];
  timers = [];
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('borrado de trabajos (una sola ruta)', () => {
  it('trabajo individual sin exports: aparta, quita del historial y al vencer el plazo va a la Papelera', async () => {
    seedJob('job-000001');
    const d = deleter();
    const r = await d.delete(['job-000001'], { deleteExports: false });
    expect(r.deletedIds).toEqual(['job-000001']);
    expect(store.has('job-000001')).toBe(false);
    expect(fs.existsSync(path.join(jobsDir, 'job-000001'))).toBe(false);
    await d.finalize(r.batchId);
    expect(trashed.some((p) => p.startsWith(pendingDir))).toBe(true);
  });

  it('trabajo individual con exports: «Eliminar por completo» manda también los MP4 exportados a la Papelera', async () => {
    seedJob('job-000001', 'completed', true);
    const d = deleter();
    const r = await d.delete(['job-000001'], { deleteExports: true });
    expect(r.exportsDeleted).toBe(2);
    await d.finalize(r.batchId);
    expect(trashed.filter((p) => p.startsWith(exportDir))).toHaveLength(2);
    expect(fs.readdirSync(exportDir)).toEqual([]);
  });

  it('varios trabajos seleccionados', async () => {
    for (const id of ['job-000001', 'job-000002', 'job-000003']) seedJob(id);
    const r = await deleter().delete(['job-000001', 'job-000002', 'job-000003'], { deleteExports: false });
    expect(r.deletedIds).toHaveLength(3);
    expect(store.size).toBe(0);
  });

  it('un trabajo activo no se puede borrar', async () => {
    seedJob('job-000001', 'rendering');
    await expect(deleter().delete(['job-000001'], { deleteExports: false })).rejects.toThrow(/en curso/);
    expect(store.has('job-000001')).toBe(true);
  });

  it('EPERM/ENOTEMPTY pasajeros: se reintenta con espera y se completa', async () => {
    seedJob('job-000001');
    const orig = fs.renameSync;
    let fails = 2;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((a: fs.PathLike, b: fs.PathLike) => {
      if (fails-- > 0) throw Object.assign(new Error(fails ? 'EPERM' : 'ENOTEMPTY'), { code: fails ? 'EPERM' : 'ENOTEMPTY' });
      return orig(a, b);
    }) as typeof fs.renameSync;
    try {
      const r = await deleter().delete(['job-000001'], { deleteExports: false });
      expect(r.deletedIds).toEqual(['job-000001']);
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
    }
  });

  it('bloqueo persistente: el trabajo se conserva intacto, mensaje útil e id en «locked» para reintentar', async () => {
    seedJob('job-000001');
    const orig = fs.renameSync;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = (() => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    }) as typeof fs.renameSync;
    try {
      const r = await deleter().delete(['job-000001'], { deleteExports: false });
      expect(r.deletedIds).toEqual([]);
      expect(r.locked).toEqual(['job-000001']);
      expect(r.errors[0]).toMatch(/cierra la vista previa y reintenta/);
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
    }
    expect(store.has('job-000001')).toBe(true); // nunca se quita del historial sin haber movido la carpeta
    expect(fs.existsSync(path.join(jobsDir, 'job-000001', 'source.mp4'))).toBe(true);
  });

  it('moveWithRetry: error no relacionado con bloqueos se lanza enseguida', async () => {
    await expect(moveWithRetry(path.join(root, 'no-existe'), path.join(root, 'x'), 'algo', [1])).rejects.toThrow(/ENOENT/);
    await expect(moveWithRetry(path.join(root, 'no-existe'), path.join(root, 'x'), 'algo', [1])).rejects.not.toBeInstanceOf(LockedError);
  });

  it('«Deshacer» antes de que venza el plazo restaura historial y carpeta; no llega nada a la Papelera', async () => {
    seedJob('job-000001', 'completed', true);
    const d = deleter();
    const r = await d.delete(['job-000001'], { deleteExports: true });
    await d.undo(r.batchId);
    expect(store.has('job-000001')).toBe(true);
    expect(fs.existsSync(path.join(jobsDir, 'job-000001', 'clips', '01_c.mp4'))).toBe(true);
    expect(trashed).toEqual([]);
    await d.finalize(r.batchId); // ya no existe el lote: no hace nada
    expect(fs.readdirSync(exportDir)).toHaveLength(2);
  });
});

describe('borrado de clips desde Resultados', () => {
  it('un clip: sólo sus archivos (MP4, subtítulos y miniatura) se apartan; el trabajo sigue con el otro', async () => {
    seedJob('job-000001');
    const d = deleter();
    const plan = d.planClips('job-000001', ['job-000001-c1'], { deleteExports: false });
    expect(plan).toMatchObject({ clips: 1, wholeJob: false, bytes: 115 });
    const r = await d.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false });
    expect(r.wholeJob).toBe(false);
    expect(store.get('job-000001')!.clips.map((c) => c.id)).toEqual(['job-000001-c2']);
    expect(fs.existsSync(path.join(jobsDir, 'job-000001', 'clips', '01_c.mp4'))).toBe(false);
    expect(fs.existsSync(path.join(jobsDir, 'job-000001', 'clips', '02_c.mp4'))).toBe(true);
    expect(fs.existsSync(path.join(jobsDir, 'job-000001', 'source.mp4'))).toBe(true);
    // «Deshacer»: el clip y sus archivos vuelven.
    await d.undo(r.batchId);
    expect(store.get('job-000001')!.clips).toHaveLength(2);
    expect(fs.existsSync(path.join(jobsDir, 'job-000001', 'clips', '01_c.mp4'))).toBe(true);
  });

  it('un clip exportado con «Enviar también los exportados»: su MP4 exportado va a la Papelera al vencer el plazo', async () => {
    seedJob('job-000001', 'completed', true);
    const d = deleter();
    expect(d.planClips('job-000001', ['job-000001-c1'], { deleteExports: true })).toMatchObject({ exportCount: 1, exportBytes: 100 });
    expect(d.planClips('job-000001', ['job-000001-c1'], { deleteExports: false })).toMatchObject({ exportCount: 0, keptExports: 1 });
    const r = await d.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: true });
    await d.finalize(r.batchId);
    expect(trashed).toContain(path.join(exportDir, 'job-000001_1.mp4'));
    expect(fs.existsSync(path.join(exportDir, 'job-000001_2.mp4'))).toBe(true);
  });

  it('revisión Codex: deshacer un borrado de clips no resucita otro clip borrado después', async () => {
    const j = seedJob('job-000001');
    // Tercer clip para poder borrar dos sin llegar al trabajo completo.
    w(path.join(jobsDir, 'job-000001', 'clips', '03_c.mp4'), 100);
    store.set('job-000001', { ...j, clips: [...j.clips, clip('job-000001-c3', 3)] });
    const d = deleter();
    const a = await d.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false });
    await d.deleteClips('job-000001', ['job-000001-c2'], { deleteExports: false });
    await d.undo(a.batchId);
    expect(store.get('job-000001')!.clips.map((c) => c.id)).toEqual(['job-000001-c1', 'job-000001-c3']);
  });

  it('revisión Codex: un borrado de clips deshecho no deja manifiesto que borre exportados al reiniciar', async () => {
    seedJob('job-000001', 'completed', true);
    const d = deleter();
    const a = await d.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: true });
    await d.undo(a.batchId);
    expect(fs.existsSync(path.join(pendingDir, a.batchId))).toBe(false);
    // Después se borra el mismo clip CONSERVANDO los exportados y la app se reinicia antes del plazo.
    await d.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false });
    await deleter().sweepLeftovers();
    expect(fs.existsSync(path.join(exportDir, 'job-000001_1.mp4'))).toBe(true);
  });

  it('revisión Codex: ninguna variable local se llama «exports» (en CommonJS taparía el módulo)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'bulkDelete.ts'), 'utf8');
    expect(src).not.toMatch(/(const|let|var)\s+exports\b/);
    expect(src).not.toMatch(/\(\s*[^)]*\bexports\s*:\s*string\[\]/);
  });

  it('revisión Codex: si la vuelta atrás falla, el próximo arranque devuelve el archivo (no a la Papelera)', async () => {
    seedJob('job-000001');
    const orig = fs.renameSync;
    let block = true;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((a: fs.PathLike, b: fs.PathLike) => {
      // El .ass queda bloqueado y además el MP4 ya movido no puede volver.
      if (block && (String(a).endsWith('01.ass') || (String(a).startsWith(pendingDir) && String(a).endsWith('01_c.mp4')))) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return orig(a, b);
    }) as typeof fs.renameSync;
    try {
      await expect(deleter().deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false })).rejects.toThrow(/vista previa/);
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
      block = false;
    }
    expect(fs.existsSync(path.join(jobsDir, 'job-000001', 'clips', '01_c.mp4'))).toBe(false); // quedó apartado
    await deleter().sweepLeftovers();
    expect(fs.existsSync(path.join(jobsDir, 'job-000001', 'clips', '01_c.mp4'))).toBe(true); // y vuelve al arrancar
    expect(trashed).toEqual([]);
  });

  it('revisión Codex: «Deshacer» suspende el plazo mientras reintenta (no se finaliza a mitad)', async () => {
    seedJob('job-000001');
    const d = deleter();
    const r = await d.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false });
    const orig = fs.renameSync;
    let fails = 2;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((a: fs.PathLike, b: fs.PathLike) => {
      if (!String(a).includes('manifest') && fails-- > 0) {
        // Mientras «Deshacer» espera, vence el plazo original.
        timers[0]?.();
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      }
      return orig(a, b);
    }) as typeof fs.renameSync;
    try {
      await d.undo(r.batchId);
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
    }
    expect(trashed).toEqual([]);
    expect(store.get('job-000001')!.clips).toHaveLength(2);
    expect(fs.existsSync(path.join(jobsDir, 'job-000001', 'clips', '01_c.mp4'))).toBe(true);
  });

  it('revisión Codex: si la app se cierra a mitad de apartar los archivos de un clip, el arranque los devuelve', async () => {
    seedJob('job-000001');
    const orig = fs.renameSync;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((a: fs.PathLike, b: fs.PathLike) => {
      if (String(a).endsWith('01.ass')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return orig(a, b);
    }) as typeof fs.renameSync;
    // Reintentos que no terminan nunca: simula que la app se cierra mientras espera.
    const never = deleter({ retryWaits: [60_000] });
    void never.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 30));
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
    expect(fs.existsSync(path.join(jobsDir, 'job-000001', 'clips', '01_c.mp4'))).toBe(false); // ya apartado
    expect(store.get('job-000001')!.clips).toHaveLength(2); // el historial no cambió
    await deleter().sweepLeftovers(); // «siguiente arranque»
    expect(fs.existsSync(path.join(jobsDir, 'job-000001', 'clips', '01_c.mp4'))).toBe(true);
    expect(trashed).toEqual([]);
  });

  it('revisión Codex: un borrado de clips que reintenta respeta un «Deshacer» hecho mientras tanto', async () => {
    const j = seedJob('job-000001');
    w(path.join(jobsDir, 'job-000001', 'clips', '03_c.mp4'), 100);
    store.set('job-000001', { ...j, clips: [...j.clips, clip('job-000001-c3', 3)] });
    const d = deleter();
    const a = await d.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false });
    const orig = fs.renameSync;
    let undone: Promise<unknown> | null = null;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((x: fs.PathLike, y: fs.PathLike) => {
      if (!undone && String(x).endsWith('02_c.mp4')) {
        (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
        undone = d.undo(a.batchId);
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      }
      return orig(x, y);
    }) as typeof fs.renameSync;
    try {
      await d.deleteClips('job-000001', ['job-000001-c2'], { deleteExports: false });
      await undone;
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
    }
    expect(store.get('job-000001')!.clips.map((c) => c.id)).toEqual(['job-000001-c1', 'job-000001-c3']);
  });

  it('revisión Codex: el historial se guarda en disco antes de confirmar el borrado de clips', async () => {
    seedJob('job-000001');
    const order: string[] = [];
    const d = deleter({ flushJobs: () => order.push('flush') });
    const origW = fs.writeFileSync;
    (fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = ((f: fs.PathOrFileDescriptor, ...r: unknown[]) => {
      if (String(f).endsWith('manifest.json')) order.push('manifest');
      return (origW as (...a: unknown[]) => void)(f, ...r);
    }) as typeof fs.writeFileSync;
    try {
      await d.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false });
    } finally {
      (fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = origW;
    }
    expect(order).toEqual(['manifest', 'flush', 'manifest']);
  });

  it('revisión Codex: borrar el trabajo completo mientras reintenta y un «Deshacer» de clips a la vez acaban con todo recuperado', async () => {
    seedJob('job-000001');
    const d = deleter();
    const a = await d.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false });
    const orig = fs.renameSync;
    let undone: Promise<unknown> | null = null;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((x: fs.PathLike, y: fs.PathLike) => {
      if (!undone && String(x) === path.join(jobsDir, 'job-000001')) {
        (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
        undone = d.undo(a.batchId);
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      }
      return orig(x, y);
    }) as typeof fs.renameSync;
    let b;
    try {
      b = await d.delete(['job-000001'], { deleteExports: false });
      // Con la cola por trabajo, «Deshacer» espera al borrado completo y pide recuperar antes ése.
      await expect(undone).rejects.toThrow(/trabajo completo/);
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
    }
    await d.undo(b.batchId);
    await d.undo(a.batchId);
    expect(store.get('job-000001')!.clips.map((c) => c.id)).toEqual(['job-000001-c1', 'job-000001-c2']);
  });

  it('revisión Codex: si no se puede guardar el historial, el clip y sus archivos vuelven a su sitio', async () => {
    seedJob('job-000001');
    const d = deleter({ flushJobs: () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } });
    await expect(d.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false })).rejects.toThrow(/ENOSPC/);
    expect(store.get('job-000001')!.clips).toHaveLength(2);
    expect(fs.existsSync(path.join(jobsDir, 'job-000001', 'clips', '01_c.mp4'))).toBe(true);
    await deleter().sweepLeftovers();
    expect(trashed).toEqual([]);
  });

  it('revisión Codex: si no se puede escribir la intención de restaurar, no se mueve ningún archivo', async () => {
    seedJob('job-000001');
    const origW = fs.writeFileSync;
    (fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = ((f: fs.PathOrFileDescriptor, ...r: unknown[]) => {
      if (String(f).endsWith('manifest.json')) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      return (origW as (...a: unknown[]) => void)(f, ...r);
    }) as typeof fs.writeFileSync;
    try {
      await expect(deleter().deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false })).rejects.toThrow(/disco lleno/);
    } finally {
      (fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = origW;
    }
    expect(fs.existsSync(path.join(jobsDir, 'job-000001', 'clips', '01_c.mp4'))).toBe(true);
    expect(store.get('job-000001')!.clips).toHaveLength(2);
  });

  it('revisión Codex: un «Deshacer» de clips incompleto devuelve un plazo nuevo (para renovar el aviso)', async () => {
    seedJob('job-000001');
    const d = deleter({ retryWaits: [] });
    const r = await d.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false });
    const orig = fs.renameSync;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = (() => {
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    }) as typeof fs.renameSync;
    let u;
    try {
      u = await d.undo(r.batchId);
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
    }
    expect(u.pending).toBeGreaterThan(0);
    expect(Date.parse(u.undoUntil!)).toBeGreaterThan(Date.now());
    expect(await d.undo(r.batchId)).toEqual({ restored: 1, pending: 0 });
  });

  it('revisión Codex: «Deshacer» guarda el historial en disco antes de quitar el lote', async () => {
    seedJob('job-000001');
    let fail = false;
    let flushes = 0;
    const d = deleter({ flushJobs: () => { if (fail) throw new Error('EIO'); flushes++; } });
    const r = await d.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false });
    fail = true;
    const u = await d.undo(r.batchId);
    expect(u.pending).toBeGreaterThan(0);
    expect(u.undoUntil).toBeTruthy();
    expect(fs.existsSync(path.join(pendingDir, r.batchId, 'manifest.json'))).toBe(true); // sigue siendo recuperable
    fail = false;
    const before = flushes;
    expect(await d.undo(r.batchId)).toEqual({ restored: 1, pending: 0 });
    expect(flushes).toBe(before + 1);
    expect(store.get('job-000001')!.clips).toHaveLength(2);
  });

  it('revisión Codex: un «Deshacer» de clips a medias se termina al arrancar (archivos e historial)', async () => {
    seedJob('job-000001');
    const d = deleter({ retryWaits: [] });
    const r = await d.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false });
    const orig = fs.renameSync;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((x: fs.PathLike, y: fs.PathLike) => {
      if (String(x).endsWith('01.ass')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return orig(x, y);
    }) as typeof fs.renameSync;
    try {
      expect((await d.undo(r.batchId)).pending).toBeGreaterThan(0);
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
    }
    // La app se cierra aquí; al arrancar se termina la recuperación.
    await deleter().sweepLeftovers();
    expect(fs.existsSync(path.join(jobsDir, 'job-000001', 'clips', '01_c.mp4'))).toBe(true);
    expect(fs.existsSync(path.join(jobsDir, 'job-000001', 'clips', '01.ass'))).toBe(true);
    expect(store.get('job-000001')!.clips.map((c) => c.id)).toEqual(['job-000001-c1', 'job-000001-c2']);
    expect(trashed).toEqual([]);
  });

  it('revisión Codex: si falla el manifiesto confirmado, el borrado de clips se deshace', async () => {
    seedJob('job-000001');
    const origW = fs.writeFileSync;
    let n = 0;
    (fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = ((f: fs.PathOrFileDescriptor, ...r: unknown[]) => {
      if (String(f).endsWith('manifest.json') && ++n === 2) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      return (origW as (...a: unknown[]) => void)(f, ...r);
    }) as typeof fs.writeFileSync;
    try {
      await expect(deleter().deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false })).rejects.toThrow(/disco lleno/);
    } finally {
      (fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = origW;
    }
    expect(store.get('job-000001')!.clips).toHaveLength(2);
    expect(fs.existsSync(path.join(jobsDir, 'job-000001', 'clips', '01_c.mp4'))).toBe(true);
  });

  it('revisión Codex: deshacer un clip de un trabajo eliminado entero después pide deshacer antes ese borrado', async () => {
    seedJob('job-000001');
    const d = deleter();
    const a = await d.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false });
    const b = await d.deleteClips('job-000001', ['job-000001-c2'], { deleteExports: false });
    expect(b.wholeJob).toBe(true);
    await expect(d.undo(a.batchId)).rejects.toThrow(/trabajo completo/);
    await d.undo(b.batchId);
    expect(await d.undo(a.batchId)).toEqual({ restored: 1, pending: 0 });
    expect(store.get('job-000001')!.clips.map((c) => c.id)).toEqual(['job-000001-c1', 'job-000001-c2']);
    expect(fs.existsSync(path.join(jobsDir, 'job-000001', 'clips', '01_c.mp4'))).toBe(true);
  });

  it('revisión Codex: dos borrados solapados de los últimos clips eliminan el trabajo completo', async () => {
    seedJob('job-000001');
    const orig = fs.renameSync;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let blocked = true;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((x: fs.PathLike, y: fs.PathLike) => {
      if (blocked && String(x).endsWith('01_c.mp4')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return orig(x, y);
    }) as typeof fs.renameSync;
    const slow = deleter({ retryWaits: [5, 5, 5, 5, 5, 5, 5, 5] });
    try {
      const a = slow.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false });
      const b = slow.deleteClips('job-000001', ['job-000001-c2'], { deleteExports: false });
      setTimeout(() => ((blocked = false), release()), 15);
      await gate;
      const [ra, rb] = await Promise.all([a, b]);
      expect(ra.wholeJob).toBe(false);
      expect(rb.wholeJob).toBe(true);
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
    }
    expect(store.get('job-000001')).toBeUndefined();
  });

  it('revisión Codex: el arranque devuelve al historial un clip sin archivos que mover', async () => {
    const j = seedJob('job-000001');
    store.set('job-000001', { ...j, clips: j.clips.filter((c) => c.id !== 'job-000001-c1') });
    const dir = path.join(pendingDir, 'b0000000-0000-4000-8000-000000000001');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ exports: [], restore: [], restoreClips: { jobId: 'job-000001', clips: [j.clips[0]] } }));
    await deleter().sweepLeftovers();
    expect(store.get('job-000001')!.clips.map((c) => c.id)).toEqual(['job-000001-c1', 'job-000001-c2']);
    expect(fs.existsSync(dir)).toBe(false);
    expect(trashed).toEqual([]);
  });

  it('revisión Codex: un clip sin archivos cuenta como pendiente si falla la preparación de «Deshacer»', async () => {
    seedJob('job-000001');
    // Clip archivado: sin archivos internos.
    for (const f of ['clips/01_c.mp4', 'clips/01.ass', 'frames/01.jpg']) fs.rmSync(path.join(jobsDir, 'job-000001', f), { force: true });
    const d = deleter();
    const r = await d.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false });
    const origW = fs.writeFileSync;
    (fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = ((f: fs.PathOrFileDescriptor, ...x: unknown[]) => {
      if (String(f).endsWith('manifest.json')) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      return (origW as (...a: unknown[]) => void)(f, ...x);
    }) as typeof fs.writeFileSync;
    let u;
    try {
      u = await d.undo(r.batchId);
    } finally {
      (fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = origW;
    }
    expect(u.pending).toBe(1);
    expect(u.undoUntil).toBeTruthy();
  });

  it('revisión Codex: borrar el trabajo completo espera a un borrado de clips en curso', async () => {
    seedJob('job-000001');
    const orig = fs.renameSync;
    let blocked = true;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((x: fs.PathLike, y: fs.PathLike) => {
      if (blocked && String(x).endsWith('01.ass')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return orig(x, y);
    }) as typeof fs.renameSync;
    const d = deleter({ retryWaits: [5, 5, 5, 5, 5, 5, 5, 5] });
    let a, b;
    try {
      const pa = d.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false });
      const pb = d.delete(['job-000001'], { deleteExports: false });
      setTimeout(() => (blocked = false), 15);
      [a, b] = await Promise.all([pa, pb]);
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
    }
    expect(a.clips).toBe(1);
    expect(b.deletedIds).toEqual(['job-000001']);
    await d.undo(b.batchId);
    await d.undo(a.batchId);
    expect(store.get('job-000001')!.clips.map((c) => c.id)).toEqual(['job-000001-c1', 'job-000001-c2']);
    expect(fs.existsSync(path.join(jobsDir, 'job-000001', 'clips', '01_c.mp4'))).toBe(true);
  });

  it('revisión Codex: borrar el trabajo completo espera a un «Deshacer» de clips en curso', async () => {
    seedJob('job-000001');
    const d = deleter({ retryWaits: [5, 5, 5, 5, 5, 5, 5, 5] });
    const a = await d.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false });
    const orig = fs.renameSync;
    let blocked = true;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((x: fs.PathLike, y: fs.PathLike) => {
      if (blocked && String(x).startsWith(pendingDir) && String(x).endsWith('01.ass')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return orig(x, y);
    }) as typeof fs.renameSync;
    let b;
    try {
      const pu = d.undo(a.batchId);
      const pb = d.delete(['job-000001'], { deleteExports: false });
      setTimeout(() => (blocked = false), 15);
      await pu;
      b = await pb;
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
    }
    expect(b.deletedIds).toEqual(['job-000001']);
    await d.undo(b.batchId);
    expect(store.get('job-000001')!.clips.map((c) => c.id)).toEqual(['job-000001-c1', 'job-000001-c2']);
    expect(fs.existsSync(path.join(jobsDir, 'job-000001', 'clips', '01_c.mp4'))).toBe(true);
    expect(fs.existsSync(path.join(jobsDir, 'job-000001', 'clips', '01.ass'))).toBe(true);
  });

  it('revisión Codex: cierre entre guardar el historial y confirmar el borrado: el arranque devuelve archivos y clip', async () => {
    seedJob('job-000001');
    // Se captura el manifiesto de intención tal como queda en disco justo cuando se guarda el historial.
    let intent = '';
    let mf = '';
    const r = await deleter({
      flushJobs: () => {
        mf = path.join(pendingDir, fs.readdirSync(pendingDir)[0], 'manifest.json');
        intent = fs.readFileSync(mf, 'utf8');
      },
    }).deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false });
    expect(r.clips).toBe(1);
    // La app se cerró ahí: historial ya sin el clip, archivos apartados y sólo el manifiesto de intención.
    fs.writeFileSync(mf, intent);
    expect(store.get('job-000001')!.clips).toHaveLength(1);
    await deleter().sweepLeftovers();
    expect(store.get('job-000001')!.clips.map((c) => c.id)).toEqual(['job-000001-c1', 'job-000001-c2']);
    expect(fs.existsSync(path.join(jobsDir, 'job-000001', 'clips', '01_c.mp4'))).toBe(true);
    expect(trashed).toEqual([]);
  });

  it('revisión Codex: «Deshacer» en cola suspende el plazo del lote mientras espera', async () => {
    const j = seedJob('job-000001');
    w(path.join(jobsDir, 'job-000001', 'clips', '03_c.mp4'), 100);
    store.set('job-000001', { ...j, clips: [...j.clips, clip('job-000001-c3', 3)] });
    const d = deleter({ retryWaits: [5, 5, 5, 5, 5, 5, 5, 5] });
    const a = await d.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false });
    const orig = fs.renameSync;
    let blocked = true;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((x: fs.PathLike, y: fs.PathLike) => {
      if (blocked && String(x).endsWith('02_c.mp4')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return orig(x, y);
    }) as typeof fs.renameSync;
    try {
      const pb = d.deleteClips('job-000001', ['job-000001-c2'], { deleteExports: false });
      const pu = d.undo(a.batchId);
      timers[0]?.(); // vence el plazo original de A mientras su «Deshacer» espera en la cola
      blocked = false;
      await pb;
      expect(await pu).toEqual({ restored: 1, pending: 0 });
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
    }
    expect(store.get('job-000001')!.clips.map((c) => c.id)).toEqual(['job-000001-c1', 'job-000001-c3']);
  });

  it('revisión Codex: el trabajo queda reservado durante todo el borrado (renderizar debe esperar)', async () => {
    seedJob('job-000001');
    const orig = fs.renameSync;
    let blocked = true;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((x: fs.PathLike, y: fs.PathLike) => {
      if (blocked && String(x).endsWith('01.ass')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return orig(x, y);
    }) as typeof fs.renameSync;
    const d = deleter({ retryWaits: [5, 5, 5, 5, 5, 5, 5, 5] });
    try {
      const p = d.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false });
      expect(d.isDeleting('job-000001')).toBe(true);
      blocked = false;
      await p;
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(d.isDeleting('job-000001')).toBe(false);
    // Los manejadores de renderizar/transcribir comprueban esta reserva.
    const ipc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc.ts'), 'utf8');
    expect((ipc.match(/bulk\.isDeleting\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('revisión Codex: si tampoco se puede guardar el historial al deshacer, se conserva el manifiesto con los clips', async () => {
    seedJob('job-000001');
    const origW = fs.writeFileSync;
    let n = 0;
    let flushes = 0;
    let onDisk: Job | null = null;
    (fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = ((f: fs.PathOrFileDescriptor, ...x: unknown[]) => {
      if (String(f).endsWith('manifest.json') && ++n === 2) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      return (origW as (...a: unknown[]) => void)(f, ...x);
    }) as typeof fs.writeFileSync;
    try {
      const d = deleter({
        flushJobs: () => {
          if (++flushes === 2) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
          onDisk = structuredClone(store.get('job-000001')!);
        },
      });
      await expect(d.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false })).rejects.toThrow(/disco lleno/);
    } finally {
      (fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = origW;
    }
    // Reinicio con el historial que quedó en disco (sin el clip).
    store.set('job-000001', onDisk!);
    expect(store.get('job-000001')!.clips).toHaveLength(1);
    await deleter().sweepLeftovers();
    expect(store.get('job-000001')!.clips.map((c) => c.id)).toEqual(['job-000001-c1', 'job-000001-c2']);
    expect(fs.existsSync(path.join(jobsDir, 'job-000001', 'clips', '01_c.mp4'))).toBe(true);
  });

  it('revisión Codex: con una recuperación de clips a medias no se puede borrar el trabajo entero', async () => {
    seedJob('job-000001');
    const d = deleter({ retryWaits: [] });
    const a = await d.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false });
    const orig = fs.renameSync;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((x: fs.PathLike, y: fs.PathLike) => {
      if (String(x).startsWith(pendingDir) && String(x).endsWith('01.ass')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return orig(x, y);
    }) as typeof fs.renameSync;
    try {
      expect((await d.undo(a.batchId)).pending).toBeGreaterThan(0);
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
    }
    const r = await d.delete(['job-000001'], { deleteExports: false });
    expect(r.deletedIds).toEqual([]);
    expect(r.errors[0]).toMatch(/recuperación de clips a medias/);
    expect(await d.undo(a.batchId)).toEqual({ restored: 1, pending: 0 });
    expect(fs.existsSync(path.join(jobsDir, 'job-000001', 'clips', '01.ass'))).toBe(true);
  });

  it('revisión Codex: un manifiesto que no se pudo reescribir conserva el anterior; uno ilegible no se manda a la Papelera', async () => {
    seedJob('job-000001');
    await deleter().deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false });
    const dir = path.join(pendingDir, fs.readdirSync(pendingDir)[0]);
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'bulkDelete.ts'), 'utf8');
    expect(src).toContain('fs.renameSync(tmp, path.join(dir, MANIFEST))');
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{"exports":[');
    await deleter().sweepLeftovers();
    expect(trashed).toEqual([]);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('revisión Codex: un «Deshacer» de trabajos interrumpido se termina al arrancar (carpetas y registros)', async () => {
    seedJob('job-000001');
    seedJob('job-000002');
    const d = deleter({ retryWaits: [] });
    const r = await d.delete(['job-000001', 'job-000002'], { deleteExports: false });
    const orig = fs.renameSync;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((x: fs.PathLike, y: fs.PathLike) => {
      if (String(x) === path.join(pendingDir, r.batchId, 'job-000002')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return orig(x, y);
    }) as typeof fs.renameSync;
    try {
      expect((await d.undo(r.batchId)).pending).toBe(1);
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
    }
    // Cierre antes de guardar el historial: en disco no está ninguno de los dos.
    store.delete('job-000001');
    await deleter().sweepLeftovers();
    expect(store.has('job-000001')).toBe(true);
    expect(store.has('job-000002')).toBe(true);
    expect(fs.existsSync(path.join(jobsDir, 'job-000002'))).toBe(true);
    expect(trashed).toEqual([]);
  });

  it('revisión Codex: si el «Deshacer» de un trabajo no puede guardar el historial, el plazo no lo manda a la Papelera', async () => {
    seedJob('job-000001');
    let fail = true;
    const d = deleter({ flushJobs: () => { if (fail) throw new Error('ENOSPC'); } });
    const r = await d.delete(['job-000001'], { deleteExports: false });
    expect((await d.undo(r.batchId)).pending).toBe(1);
    for (const fn of [...timers]) fn(); // vence el plazo renovado
    await new Promise((x) => setTimeout(x, 10));
    expect(trashed).toEqual([]);
    fail = false;
    await d.undo(r.batchId).catch(() => undefined);
    expect(store.has('job-000001')).toBe(true);
    expect(fs.existsSync(path.join(pendingDir, r.batchId))).toBe(false);
  });

  it('revisión Codex: reintentar «Deshacer» de trabajos conserva la intención de todos hasta guardar', async () => {
    seedJob('job-000001');
    seedJob('job-000002');
    const d = deleter({ retryWaits: [] });
    const r = await d.delete(['job-000001', 'job-000002'], { deleteExports: false });
    const orig = fs.renameSync;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((x: fs.PathLike, y: fs.PathLike) => {
      if (String(x) === path.join(pendingDir, r.batchId, 'job-000002')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return orig(x, y);
    }) as typeof fs.renameSync;
    try {
      expect((await d.undo(r.batchId)).pending).toBe(1);
      expect((await d.undo(r.batchId)).pending).toBe(1); // segundo intento, sigue bloqueado
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
    }
    store.delete('job-000001'); // su registro no llegó a disco
    await deleter().sweepLeftovers();
    expect(store.has('job-000001')).toBe(true);
    expect(store.has('job-000002')).toBe(true);
  });

  it('revisión Codex: con una recuperación de clips a medias no se pueden volver a borrar clips del trabajo', async () => {
    const j = seedJob('job-000001');
    w(path.join(jobsDir, 'job-000001', 'clips', '03_c.mp4'), 100);
    store.set('job-000001', { ...j, clips: [...j.clips, clip('job-000001-c3', 3)] });
    let fail = false;
    const d = deleter({ flushJobs: () => { if (fail) throw new Error('ENOSPC'); } });
    const a = await d.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false });
    fail = true;
    expect((await d.undo(a.batchId)).pending).toBeGreaterThan(0);
    fail = false;
    await expect(d.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false })).rejects.toThrow(/recuperación a medias/);
    expect(await d.undo(a.batchId)).toEqual({ restored: 1, pending: 0 });
    expect((await d.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false })).clips).toBe(1);
  });

  it('revisión Codex: una recuperación de trabajos a medias protege también los ya devueltos', async () => {
    seedJob('job-000001');
    seedJob('job-000002');
    const d = deleter({ retryWaits: [] });
    const r = await d.delete(['job-000001', 'job-000002'], { deleteExports: false });
    const orig = fs.renameSync;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((x: fs.PathLike, y: fs.PathLike) => {
      if (String(x) === path.join(pendingDir, r.batchId, 'job-000002')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return orig(x, y);
    }) as typeof fs.renameSync;
    try {
      expect((await d.undo(r.batchId)).pending).toBe(1);
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
    }
    const again = await d.delete(['job-000001'], { deleteExports: false });
    expect(again.deletedIds).toEqual([]);
    expect(again.errors[0]).toMatch(/recuperación/);
  });

  it('revisión Codex: con una recuperación de clips a medias el trabajo sigue reservado (no se edita ni renderiza)', async () => {
    seedJob('job-000001');
    let fail = false;
    const d = deleter({ flushJobs: () => { if (fail) throw new Error('ENOSPC'); } });
    const a = await d.deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false });
    fail = true;
    expect((await d.undo(a.batchId)).pending).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(d.isDeleting('job-000001')).toBe(true);
    fail = false;
    await d.undo(a.batchId);
    await new Promise((r) => setTimeout(r, 0));
    expect(d.isDeleting('job-000001')).toBe(false);
  });

  it('revisión Codex: una recuperación del arranque sin terminar protege todos sus trabajos', async () => {
    seedJob('job-000001');
    seedJob('job-000002');
    const d = deleter({ retryWaits: [] });
    const r = await d.delete(['job-000001', 'job-000002'], { deleteExports: false });
    const orig = fs.renameSync;
    const lock = ((x: fs.PathLike, y: fs.PathLike) => {
      if (String(x) === path.join(pendingDir, r.batchId, 'job-000002')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return orig(x, y);
    }) as typeof fs.renameSync;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = lock;
    const boot = deleter({ retryWaits: [] });
    try {
      await d.undo(r.batchId);
      await boot.sweepLeftovers(); // «arranque» con B aún bloqueado
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
    }
    expect(boot.isDeleting('job-000001')).toBe(true);
    const again = await boot.delete(['job-000001'], { deleteExports: false });
    expect(again.deletedIds).toEqual([]);
  });

  it('revisión Codex: terminar una recuperación del arranque no desprotege otra del mismo trabajo', async () => {
    const j = seedJob('job-000001');
    const mk = (id: string, restore: unknown[], clips: Clip[]) => {
      const dir = path.join(pendingDir, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ exports: [], restore, restoreClips: { jobId: 'job-000001', clips } }));
      return dir;
    };
    // Lote 1: un archivo que no puede volver (fuera de la carpeta: se cuenta como pendiente al fallar).
    const d1 = mk('b0000000-0000-4000-8000-000000000001', [], [j.clips[0]]);
    const staged = path.join(d1, 'clips', '01.ass');
    w(staged, 5);
    fs.rmSync(path.join(jobsDir, 'job-000001', 'clips', '01.ass'));
    fs.writeFileSync(path.join(d1, 'manifest.json'), JSON.stringify({ exports: [], restore: [{ from: path.join(jobsDir, 'job-000001', 'clips', '01.ass'), to: staged }], restoreClips: { jobId: 'job-000001', clips: [j.clips[0]] } }));
    mk('b0000000-0000-4000-8000-000000000002', [], [j.clips[1]]);
    const orig = fs.renameSync;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((x: fs.PathLike, y: fs.PathLike) => {
      if (String(x) === staged) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return orig(x, y);
    }) as typeof fs.renameSync;
    const boot = deleter({ retryWaits: [] });
    try {
      await boot.sweepLeftovers();
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
    }
    expect(fs.existsSync(path.join(d1, 'manifest.json'))).toBe(true);
    expect(boot.isDeleting('job-000001')).toBe(true);
  });

  it('todos los clips del trabajo: se elimina el trabajo completo (sin registros vacíos)', async () => {
    seedJob('job-000001');
    const d = deleter();
    expect(d.planClips('job-000001', ['job-000001-c1', 'job-000001-c2'], { deleteExports: false }).wholeJob).toBe(true);
    const r = await d.deleteClips('job-000001', ['job-000001-c1', 'job-000001-c2'], { deleteExports: false });
    expect(r.wholeJob).toBe(true);
    expect(store.has('job-000001')).toBe(false);
  });

  it('clip bloqueado por un reproductor: lo ya movido vuelve y el trabajo queda como estaba', async () => {
    seedJob('job-000001');
    const orig = fs.renameSync;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((a: fs.PathLike, b: fs.PathLike) => {
      if (String(a).endsWith('01.ass')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return orig(a, b);
    }) as typeof fs.renameSync;
    try {
      await expect(deleter().deleteClips('job-000001', ['job-000001-c1'], { deleteExports: false })).rejects.toThrow(/cierra la vista previa/);
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
    }
    expect(store.get('job-000001')!.clips).toHaveLength(2);
    expect(fs.existsSync(path.join(jobsDir, 'job-000001', 'clips', '01_c.mp4'))).toBe(true);
  });
});

describe('ningún borrado de datos de usuario con fs.rmSync', () => {
  it('bulkDelete y la ruta de borrado de trabajos no usan fs.rmSync sobre carpetas de trabajo', () => {
    const bd = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'bulkDelete.ts'), 'utf8');
    // Sólo se permite borrar el manifiesto propio del lote.
    expect(bd.match(/fs\.rmSync\([^\r\n]*/g) ?? []).toEqual(['fs.rmSync(path.join(src, MANIFEST), { force: true });']);
    const ipc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc.ts'), 'utf8');
    const block = ipc.slice(ipc.indexOf("h('jobs:delete'"), ipc.indexOf("h('clips:rename'"));
    expect(block).not.toMatch(/rmSync|unlinkSync/);
  });
});
