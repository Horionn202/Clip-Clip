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
      if (fails-- > 0) {
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

  it('revisión Codex: borrar el trabajo completo mientras reintenta respeta un «Deshacer» de clips hecho mientras tanto', async () => {
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
      await undone;
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
    }
    await d.undo(b.batchId);
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
