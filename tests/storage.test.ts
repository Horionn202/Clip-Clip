import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify, confirmText, FREE_SPACE_DEFAULTS, humanSize, TEMP_ONLY } from '../src/shared/storage';
import { executeCleanup, planCleanup, refreshJobFlags, verifyExport, type ExecuteDeps } from '../src/main/storageManager';
import type { Clip, Job, JobStatus } from '../src/shared/types';
import { defaultSettings, migrateSettings } from '../src/main/store';

let root: string;
let jobsDir: string;
let exportDir: string;
const w = (p: string, bytes: number) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
};
const clip = (i: number, extra: Partial<Clip> = {}): Clip => ({ id: `c${i}`, index: i, start: 0, end: 30, title: 't', hook: 'h', reason: 'r', score: 1, file: `0${i}_t.mp4`, ...extra });
const job = (id: string, status: JobStatus, clips: Clip[]): Job => ({ id, url: 'https://x.com', preset: 30, maxClips: 5, status, progress: 1, message: '', clips, createdAt: '', updatedAt: '' });
/** Trabajo en disco: original 1000, audio 300, frames 50, ass 5, transcripción 20, clips internos 100 c/u. */
function makeJob(id: string, n = 2) {
  const d = path.join(jobsDir, id);
  w(path.join(d, 'source.mp4'), 1000);
  w(path.join(d, 'audio.wav'), 300);
  w(path.join(d, 'frames/01.jpg'), 50);
  w(path.join(d, 'clips/01.ass'), 5);
  w(path.join(d, 'transcript.json'), 20);
  for (let i = 1; i <= n; i++) w(path.join(d, 'clips', `0${i}_t.mp4`), 100);
}
const realRemove: ExecuteDeps = { remove: async (p) => fs.rmSync(p), usedTrash: false };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-store-'));
  jobsDir = path.join(root, 'jobs');
  exportDir = path.join(root, 'Videos');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('clasificación de archivos', () => {
  it.each([
    ['source.mp4', 'source'],
    ['audio.wav', 'audio'],
    ['frames/01_preview.jpg', 'frames'],
    ['clips/01.ass', 'temp'],
    ['clips/01_x.mp4.part.mp4', 'temp'],
    ['clips/01_x.mp4', 'internalClip'],
    ['transcript.json', 'transcript'],
  ])('%s → %s', (rel, cat) => expect(classify(rel)).toBe(cat));
});

describe('análisis y espacio recuperable', () => {
  it('calcula total, categorías y recuperable; sin export verificado no toca clips internos', () => {
    makeJob('job-a');
    const r = planCleanup([job('job-a', 'completed', [clip(1), clip(2)])], jobsDir, FREE_SPACE_DEFAULTS);
    expect(r.totalBytes).toBe(1000 + 300 + 50 + 5 + 20 + 200);
    expect(r.byCategory).toMatchObject({ source: 1000, audio: 300, frames: 50, temp: 5, transcript: 20, internalClip: 200 });
    expect(r.recoverableBytes).toBe(1000 + 300 + 50 + 5); // transcripción opcional y sin clips internos
    expect(r.jobsAffected).toBe(1);
    expect(r.files.some((f) => f.category === 'internalClip')).toBe(false);
  });
  it('excluye trabajos en curso', () => {
    makeJob('job-a');
    makeJob('job-b');
    const r = planCleanup([job('job-a', 'transcribing', []), job('job-b', 'rendering', [])], jobsDir, FREE_SPACE_DEFAULTS);
    expect(r.files).toEqual([]);
    expect(r.skippedActive).toBe(2);
  });
  it('«Limpiar temporales» sólo incluye audio, fotogramas y temporales', () => {
    makeJob('job-a');
    const r = planCleanup([job('job-a', 'completed', [clip(1)])], jobsDir, TEMP_ONLY);
    expect(new Set(r.files.map((f) => f.category))).toEqual(new Set(['audio', 'frames', 'temp']));
  });
  it('transcripción sólo si se marca', () => {
    makeJob('job-a');
    expect(planCleanup([job('job-a', 'completed', [])], jobsDir, { ...FREE_SPACE_DEFAULTS, transcript: true }).files.some((f) => f.category === 'transcript')).toBe(true);
  });
  it('texto de confirmación claro', () => {
    expect(confirmText({ recoverableBytes: 3.7 * 1024 ** 3 })).toBe('Se liberarán 3,7 GB. Tus clips exportados se conservarán.');
    expect(humanSize(60 * 1024 ** 2)).toBe('60 MB');
  });
});

describe('verificación de exports', () => {
  it('verifica copia fuera de la carpeta de trabajos con el mismo tamaño', () => {
    makeJob('job-a');
    w(path.join(exportDir, '01_t.mp4'), 100);
    expect(verifyExport(jobsDir, 'job-a', clip(1, { exportedPath: path.join(exportDir, '01_t.mp4') }))).toBe(true);
  });
  it.each([
    ['inexistente', () => path.join(exportDir, 'nope.mp4')],
    ['vacío', () => (w(path.join(exportDir, 'vacio.mp4'), 0), path.join(exportDir, 'vacio.mp4'))],
    ['tamaño distinto', () => (w(path.join(exportDir, 'otro.mp4'), 99), path.join(exportDir, 'otro.mp4'))],
    ['dentro de la carpeta de trabajos', () => path.join(jobsDir, 'job-a', 'clips', '01_t.mp4')],
  ])('rechaza export %s', (_n, mk) => {
    makeJob('job-a');
    expect(verifyExport(jobsDir, 'job-a', clip(1, { exportedPath: mk() }))).toBe(false);
  });
  it('rechaza clips con cambios sin renderizar', () => {
    makeJob('job-a');
    w(path.join(exportDir, '01_t.mp4'), 100);
    expect(verifyExport(jobsDir, 'job-a', clip(1, { dirty: true, exportedPath: path.join(exportDir, '01_t.mp4') }))).toBe(false);
  });
  it('con ffprobe exige la duración del clip', () => {
    makeJob('job-a');
    w(path.join(exportDir, '01_t.mp4'), 100);
    const c = clip(1, { exportedPath: path.join(exportDir, '01_t.mp4') });
    expect(verifyExport(jobsDir, 'job-a', c, { probeDuration: () => 30.2 })).toBe(true);
    expect(verifyExport(jobsDir, 'job-a', c, { probeDuration: () => 12 })).toBe(false);
  });
  it('clips internos sólo con export verificado', () => {
    makeJob('job-a');
    w(path.join(exportDir, '01_t.mp4'), 100);
    const r = planCleanup([job('job-a', 'completed', [clip(1, { exportedPath: path.join(exportDir, '01_t.mp4') }), clip(2)])], jobsDir, FREE_SPACE_DEFAULTS);
    expect(r.files.filter((f) => f.category === 'internalClip').map((f) => f.rel.replace(/\\/g, '/'))).toEqual(['clips/01_t.mp4']);
  });
});

describe('ejecución de la limpieza', () => {
  it('borra lo planificado, nunca los exports, y marca el trabajo', async () => {
    makeJob('job-a', 1);
    w(path.join(exportDir, '01_t.mp4'), 100);
    const jobs = [job('job-a', 'completed', [clip(1, { exportedPath: path.join(exportDir, '01_t.mp4') })])];
    const plan = planCleanup(jobs, jobsDir, FREE_SPACE_DEFAULTS);
    const res = await executeCleanup(plan.files, jobs, jobsDir, realRemove);
    expect(res.errors).toEqual([]);
    expect(res.freedBytes).toBe(1000 + 300 + 50 + 5 + 100);
    expect(fs.existsSync(path.join(exportDir, '01_t.mp4'))).toBe(true);
    expect(fs.existsSync(path.join(jobsDir, 'job-a', 'transcript.json'))).toBe(true);
    const j = refreshJobFlags(jobs[0], jobsDir, res.freedBytes);
    expect(j).toMatchObject({ sourceCleaned: true, tempCleaned: true, internalClipsCleaned: true, archivedExportsOnly: true, bytesFreed: res.freedBytes });
    expect(j.clips[0]).toMatchObject({ archived: true, exportVerified: true, title: 't' });
  });
  it('rechaza rutas fuera de la carpeta administrada', async () => {
    makeJob('job-a');
    w(path.join(root, 'fuera.txt'), 10);
    const jobs = [job('job-a', 'completed', [])];
    const res = await executeCleanup([{ jobId: 'job-a', rel: '../../fuera.txt', category: 'temp', bytes: 10 }, { jobId: 'job-a', rel: '.', category: 'temp', bytes: 0 }], jobs, jobsDir, realRemove);
    expect(res.errors.map((e) => e.message)).toEqual(['ruta fuera de la carpeta administrada', 'ruta fuera de la carpeta administrada']);
    expect(fs.existsSync(path.join(root, 'fuera.txt'))).toBe(true);
  });
  it('no borra de trabajos activos aunque se lo pidan', async () => {
    makeJob('job-a');
    const res = await executeCleanup([{ jobId: 'job-a', rel: 'source.mp4', category: 'source', bytes: 1000 }], [job('job-a', 'downloading', [])], jobsDir, realRemove);
    expect(res.errors[0].message).toMatch(/en curso/);
    expect(fs.existsSync(path.join(jobsDir, 'job-a', 'source.mp4'))).toBe(true);
  });
  it('limpieza parcial: un fallo no detiene el resto y se resume', async () => {
    makeJob('job-a');
    const jobs = [job('job-a', 'completed', [])];
    const plan = planCleanup(jobs, jobsDir, TEMP_ONLY);
    const res = await executeCleanup(plan.files, jobs, jobsDir, {
      usedTrash: true,
      remove: async (p) => {
        if (p.endsWith('audio.wav')) throw new Error('EBUSY: archivo en uso');
        fs.rmSync(p);
      },
    });
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].message).toMatch(/EBUSY/);
    expect(res.deleted).toBe(2);
    expect(fs.existsSync(path.join(jobsDir, 'job-a', 'audio.wav'))).toBe(true);
  });
  it('trabajos antiguos sin indicadores: el análisis funciona y no se pierde nada', () => {
    makeJob('job-old');
    const legacy = { ...job('job-old', 'completed', [clip(1)]) } as Job; // sin sourceCleaned, exportVerified…
    const j = refreshJobFlags(legacy, jobsDir, 0);
    expect(j).toMatchObject({ sourceCleaned: false, tempCleaned: false, internalClipsCleaned: false, archivedExportsOnly: false, bytesFreed: 0 });
    expect(j.clips[0]).toMatchObject({ archived: false, exportVerified: false, file: '01_t.mp4' });
  });
});

describe('migración de ajustes de limpieza (no destructiva)', () => {
  const defaults = defaultSettings('C:/out');
  it('valores por defecto: no se borra nada sin confirmación', () => {
    expect(migrateSettings(defaults, {})).toMatchObject({ keepSource: 'confirmar', keepTemp: 'tras-completar', keepTranscript: true, autoCleanupDays: 0 });
  });
  it('traduce los ajustes antiguos', () => {
    expect(migrateSettings(defaults, { deleteTempAfterCompletion: false, deleteSourceAfterCompletion: true })).toMatchObject({ keepTemp: 'siempre', keepSource: 'hasta-exportar' });
  });
  it('no pisa una política nueva ya elegida', () => {
    expect(migrateSettings(defaults, { deleteSourceAfterCompletion: true, keepSource: 'siempre' }).keepSource).toBe('siempre');
  });
});
