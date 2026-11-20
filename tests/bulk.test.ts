// Selección masiva, cálculo de espacio, validación de rutas y «Deshacer» del borrado masivo.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { needsTypedConfirm, pruneSelection, selectionState, setMany, toggle, typedConfirmOk } from '../src/shared/bulk';
import { BulkDeleter, deletableExport, planBulkDelete, safeJobDir } from '../src/main/bulkDelete';
import type { Clip, Job } from '../src/shared/types';

describe('selección masiva', () => {
  it('marcar, desmarcar, página y todo lo filtrado', () => {
    let s = toggle(new Set(), 'a');
    expect([...s]).toEqual(['a']);
    s = toggle(s, 'a');
    expect(s.size).toBe(0);
    s = setMany(s, ['a', 'b', 'c'], true);
    expect(selectionState(s, ['a', 'b'])).toBe('all');
    expect(selectionState(s, ['a', 'z'])).toBe('some');
    expect(selectionState(new Set(), ['a'])).toBe('none');
    expect([...setMany(s, ['a', 'b'], false)]).toEqual(['c']);
  });
  it('al cambiar de filtro se quitan los que ya no se ven', () => {
    expect([...pruneSelection(new Set(['a', 'b', 'x']), ['a', 'b', 'c'])]).toEqual(['a', 'b']);
  });
  it('confirmación escrita a partir de 10 trabajos o 50 clips', () => {
    expect(needsTypedConfirm(9, 49)).toBe(false);
    expect(needsTypedConfirm(10, 0)).toBe(true);
    expect(needsTypedConfirm(1, 50)).toBe(true);
    expect(typedConfirmOk(10, 0, 'borrar')).toBe(false);
    expect(typedConfirmOk(10, 0, ' BORRAR ')).toBe(true);
    expect(typedConfirmOk(2, 3, undefined)).toBe(true);
  });
});

describe('borrado masivo en disco', () => {
  let root = '';
  let jobsDir = '';
  let exportDir = '';
  let pendingDir = '';
  const clip = (id: string, exportedPath?: string): Clip => ({ id, index: 1, start: 0, end: 15, title: 't', hook: '', reason: '', score: 1, file: `${id}.mp4`, exportedPath });
  const job = (id: string, status: Job['status'], clips: Clip[] = []): Job =>
    ({ id, url: 'u', preset: 15, maxClips: 3, status, progress: 1, message: '', clips, createdAt: '', updatedAt: '', sourceTitle: `Vídeo ${id}` }) as Job;
  const mkJob = (id: string, bytes: number) => {
    fs.mkdirSync(path.join(jobsDir, id, 'clips'), { recursive: true });
    fs.writeFileSync(path.join(jobsDir, id, 'source.mp4'), Buffer.alloc(bytes));
  };
  const mkExport = (name: string, bytes: number) => {
    const p = path.join(exportDir, name);
    fs.writeFileSync(p, Buffer.alloc(bytes));
    return p;
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bulk-'));
    jobsDir = path.join(root, 'jobs');
    exportDir = path.join(root, 'exports');
    pendingDir = path.join(root, 'pending-delete');
    fs.mkdirSync(jobsDir);
    fs.mkdirSync(exportDir);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('rutas: sólo carpetas de trabajo válidas y sólo exports de vídeo fuera de la carpeta interna', () => {
    expect(() => safeJobDir(jobsDir, '../fuera1')).toThrow();
    expect(() => safeJobDir(jobsDir, '..')).toThrow();
    expect(safeJobDir(jobsDir, 'job-000001')).toBe(path.resolve(jobsDir, 'job-000001'));
    mkJob('job-000001', 10);
    expect(deletableExport(path.join(jobsDir, 'job-000001', 'source.mp4'), jobsDir)).toBe(false); // dentro de la carpeta interna
    expect(deletableExport(exportDir, jobsDir)).toBe(false); // una carpeta, nunca
    fs.writeFileSync(path.join(exportDir, 'notas.txt'), 'x');
    expect(deletableExport(path.join(exportDir, 'notas.txt'), jobsDir)).toBe(false); // no es un vídeo
    expect(deletableExport('relativo.mp4', jobsDir)).toBe(false);
    expect(deletableExport(mkExport('a.mp4', 5), jobsDir)).toBe(true);
  });

  it('plan: cuenta trabajos, clips y espacio; omite los activos u ocupados; conserva exports salvo que se pida', () => {
    mkJob('job-000001', 1000);
    mkJob('job-000002', 500);
    mkJob('job-000003', 10);
    const e1 = mkExport('e1.mp4', 300);
    const jobs = [job('job-000001', 'completed', [clip('c1', e1), clip('c2')]), job('job-000002', 'failed'), job('job-000003', 'transcribing'), job('job-000004', 'completed')];
    const keep = planBulkDelete(jobs, ['job-000001', 'job-000002', 'job-000003', 'job-000004'], { deleteExports: false }, { jobsDir, busy: new Set(['job-000004']) });
    expect(keep.jobs.map((j) => j.id)).toEqual(['job-000001', 'job-000002']);
    expect(keep.skipped.map((s) => s.id).sort()).toEqual(['job-000003', 'job-000004']);
    expect(keep.clipCount).toBe(2);
    expect(keep.internalBytes).toBe(1500);
    expect(keep.exportBytes).toBe(0);
    expect(keep.keptExports).toBe(1);
    const all = planBulkDelete(jobs, ['job-000001'], { deleteExports: true }, { jobsDir, busy: new Set() });
    expect(all.exportBytes).toBe(300);
    expect(all.exportCount).toBe(1);
  });

  it('un export que también usa otro trabajo NO elegido nunca se borra', () => {
    mkJob('job-000001', 1);
    mkJob('job-000002', 1);
    const e = mkExport('compartido.mp4', 50);
    const jobs = [job('job-000001', 'completed', [clip('c1', e)]), job('job-000002', 'completed', [clip('c2', e)])];
    const p = planBulkDelete(jobs, ['job-000001'], { deleteExports: true }, { jobsDir, busy: new Set() });
    expect(p.exportCount).toBe(0);
    expect(p.keptExports).toBe(1);
  });

  const deleter = (jobs: Job[], trashed: string[], timers: (() => void)[]) => {
    const store = new Map(jobs.map((j) => [j.id, j]));
    const d = new BulkDeleter({
      jobsDir,
      pendingDir,
      getJobs: () => [...store.values()],
      putJob: (j) => store.set(j.id, j),
      removeJob: (id) => store.delete(id),
      forgetPublish: () => undefined,
      trash: async (p) => {
        trashed.push(p);
        fs.rmSync(p, { recursive: true, force: true });
      },
      busy: () => new Set(),
      setTimer: (fn) => (timers.push(fn), timers.length),
      clearTimer: () => undefined,
    });
    return { d, store };
  };

  it('eliminar del historial: aparta, se puede deshacer y conserva los exports', async () => {
    mkJob('job-000001', 100);
    const e = mkExport('e.mp4', 40);
    const trashed: string[] = [];
    const timers: (() => void)[] = [];
    const { d, store } = deleter([job('job-000001', 'completed', [clip('c1', e)])], trashed, timers);
    const r = d.delete(['job-000001'], { deleteExports: false });
    expect(r).toMatchObject({ jobs: 1, clips: 1, freedBytes: 100, exportsDeleted: 0 });
    expect(store.size).toBe(0);
    expect(fs.existsSync(path.join(jobsDir, 'job-000001'))).toBe(false);
    expect(d.undo(r.batchId)).toBe(1);
    expect(store.has('job-000001')).toBe(true);
    expect(fs.existsSync(path.join(jobsDir, 'job-000001', 'source.mp4'))).toBe(true);
    expect(() => d.undo(r.batchId)).toThrow(/plazo/);
    expect(fs.existsSync(e)).toBe(true);
    expect(trashed).toEqual([]);
  });

  it('eliminar por completo: al vencer el plazo, carpeta y exports a la Papelera', async () => {
    mkJob('job-000001', 100);
    const e = mkExport('e.mp4', 40);
    const trashed: string[] = [];
    const timers: (() => void)[] = [];
    const { d } = deleter([job('job-000001', 'completed', [clip('c1', e)])], trashed, timers);
    const r = d.delete(['job-000001'], { deleteExports: true });
    expect(r).toMatchObject({ freedBytes: 140, exportsDeleted: 1 });
    expect(fs.existsSync(e)).toBe(true); // todavía se puede deshacer
    await d.finalize(r.batchId);
    expect(trashed).toContain(e);
    expect(trashed.some((p) => p.startsWith(pendingDir))).toBe(true);
    expect(fs.existsSync(e)).toBe(false);
    expect(() => d.undo(r.batchId)).toThrow();
  });

  it('revisión Codex: si la Papelera falla no se borra nada para siempre y se reintenta al iniciar', async () => {
    mkJob('job-000001', 100);
    const e = mkExport('e.mp4', 40);
    const timers: (() => void)[] = [];
    let fail = true;
    const trashed: string[] = [];
    const store = new Map([['job-000001', job('job-000001', 'completed', [clip('c1', e)])]]);
    const mk = () =>
      new BulkDeleter({
        jobsDir,
        pendingDir,
        getJobs: () => [...store.values()],
        putJob: (j) => store.set(j.id, j),
        removeJob: (id) => store.delete(id),
        forgetPublish: () => undefined,
        trash: async (x) => {
          if (fail) throw new Error('Papelera no disponible');
          trashed.push(x);
          fs.rmSync(x, { recursive: true, force: true });
        },
        busy: () => new Set(),
        setTimer: (fn) => (timers.push(fn), timers.length),
        clearTimer: () => undefined,
      });
    const d = mk();
    const r = d.delete(['job-000001'], { deleteExports: true });
    expect(r.deletedIds).toEqual(['job-000001']);
    await d.finalize(r.batchId);
    // Nada borrado de forma permanente: la carpeta apartada y el export siguen ahí.
    expect(fs.existsSync(path.join(pendingDir, r.batchId, 'job-000001', 'source.mp4'))).toBe(true);
    expect(fs.existsSync(e)).toBe(true);
    // Próximo inicio (otra instancia, p. ej. tras cerrar la app durante el plazo): se termina con el manifiesto.
    fail = false;
    await mk().sweepLeftovers();
    expect(trashed).toContain(e);
    expect(fs.existsSync(path.join(pendingDir, r.batchId))).toBe(false);
  });

  it('revisión Codex: cerrar la app durante el plazo no pierde los exports pendientes de borrar', async () => {
    mkJob('job-000001', 10);
    const e = mkExport('e.mp4', 5);
    const trashed: string[] = [];
    const { d } = deleter([job('job-000001', 'completed', [clip('c1', e)])], trashed, []);
    d.delete(['job-000001'], { deleteExports: true });
    // Sin finalize (cierre brusco): una instancia nueva lo termina desde el disco.
    const { d: next } = deleter([], trashed, []);
    await next.sweepLeftovers();
    expect(trashed).toContain(e);
  });

  it('revisión Codex: sólo se informan como borrados los trabajos que de verdad se apartaron', () => {
    mkJob('job-000001', 1);
    mkJob('job-000002', 1);
    // Un archivo con el nombre de la carpeta de destino hace fallar el traslado del segundo trabajo.
    const { d, store } = deleter([job('job-000001', 'completed'), job('job-000002', 'completed')], [], []);
    const orig = fs.renameSync;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((a: fs.PathLike, b: fs.PathLike) => {
      if (String(a).endsWith('job-000002')) throw new Error('EPERM');
      return orig(a, b);
    }) as typeof fs.renameSync;
    try {
      const r = d.delete(['job-000001', 'job-000002'], { deleteExports: false });
      expect(r.deletedIds).toEqual(['job-000001']);
      expect(r.errors.length).toBe(1);
      expect(store.has('job-000002')).toBe(true);
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
    }
  });

  it('revisión Codex: si «Deshacer» falla en un trabajo, ése sigue recuperable y se puede reintentar', () => {
    mkJob('job-000001', 1);
    mkJob('job-000002', 1);
    const { d, store } = deleter([job('job-000001', 'completed'), job('job-000002', 'completed')], [], []);
    const r = d.delete(['job-000001', 'job-000002'], { deleteExports: false });
    const orig = fs.renameSync;
    let block = true;
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((a: fs.PathLike, b: fs.PathLike) => {
      if (block && String(b).endsWith('job-000002')) throw new Error('EPERM');
      return orig(a, b);
    }) as typeof fs.renameSync;
    try {
      expect(d.undo(r.batchId)).toBe(1);
      expect(store.has('job-000001')).toBe(true);
      expect(store.has('job-000002')).toBe(false);
      block = false;
      // Mismo plazo: el segundo intento recupera el que faltaba.
      expect(d.undo(r.batchId)).toBe(1);
      expect(store.has('job-000002')).toBe(true);
      expect(fs.existsSync(path.join(jobsDir, 'job-000002', 'source.mp4'))).toBe(true);
    } finally {
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
    }
  });

  it('muchos trabajos exigen escribir BORRAR', () => {
    const jobs = Array.from({ length: 10 }, (_, i) => job(`job-00000${i}x`, 'completed'));
    for (const j of jobs) mkJob(j.id, 1);
    const { d } = deleter(jobs, [], []);
    expect(() => d.delete(jobs.map((j) => j.id), { deleteExports: false })).toThrow(/BORRAR/);
    expect(d.delete(jobs.map((j) => j.id), { deleteExports: false }, 'BORRAR').jobs).toBe(10);
  });

  it('nunca borra un trabajo en curso', () => {
    mkJob('job-000001', 1);
    const { d, store } = deleter([job('job-000001', 'rendering')], [], []);
    expect(() => d.delete(['job-000001'], { deleteExports: false })).toThrow(/en curso/);
    expect(store.size).toBe(1);
    expect(fs.existsSync(path.join(jobsDir, 'job-000001'))).toBe(true);
  });
});
