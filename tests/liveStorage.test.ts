// Almacenamiento de los directos: retención de segmentos, límites de disco y limpieza al terminar, detener o tras un
// cierre inesperado. Nunca se borra lo que necesita un bloque activo ni nada fuera de la carpeta del monitor.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LIVE_BYTES_PER_SEC, estimateLiveBytes, planSegmentCleanup, storageLevel, validateLiveSettings, type LiveBlock, type SegFile } from '../src/shared/live';
import { LiveManager, type LiveDeps } from '../src/main/liveMonitor';
import type { Job } from '../src/shared/types';

const SEG = estimateLiveBytes(60); // un segmento de 60 s ≈ 26 MB
const seg = (i: number, bytes = SEG): SegFile => ({ name: `seg_${String(i).padStart(5, '0')}.ts`, bytes });
const done = (n: number, status: LiveBlock['status'] = 'procesado') => Array.from({ length: n }, (_, i) => ({ index: i, status }));
const sum = (files: SegFile[], drop: string[]) => files.filter((f) => !drop.includes(f.name)).reduce((a, f) => a + f.bytes, 0);
const base = { blockSec: 60, capBytes: 2 * 1024 ** 3, final: false, busyBlocks: new Set<number>() };

describe('retención de segmentos (puro)', () => {
  it('por defecto no se conservan segmentos y un monitor antiguo con keepSegments pasa a un tope de 2 GB', () => {
    expect(validateLiveSettings({}).retention).toBe('none');
    expect(validateLiveSettings({ keepSegments: true }).retention).toBe('cap');
    expect(validateLiveSettings({ keepSegments: true }).retentionCapMB).toBe(2048);
  });

  it('retention none: se borra todo lo procesado salvo el último (solape del siguiente bloque)', () => {
    const files = Array.from({ length: 10 }, (_, i) => seg(i));
    const drop = planSegmentCleanup(files, done(10), { ...base, retention: 'none' });
    expect(drop).toHaveLength(9);
    expect(drop).not.toContain('seg_00009.ts');
  });

  it('nunca borra un segmento pendiente, en proceso o en error (para reintentar)', () => {
    const files = [seg(0), seg(1), seg(2), seg(3), seg(4)];
    const blocks = [
      { index: 0, status: 'procesado' as const },
      { index: 1, status: 'error' as const },
      { index: 2, status: 'procesado' as const },
      { index: 3, status: 'procesando' as const },
    ];
    const drop = planSegmentCleanup(files, blocks, { ...base, retention: 'none' });
    expect(drop).toEqual(['seg_00000.ts']); // 1 error, 2 último procesado (solape), 3 en proceso, 4 pendiente
  });

  it('el vídeo de un bloque cuyo trabajo sigue activo no se borra; el de uno terminado sí', () => {
    const files = [{ name: 'block_00003.mp4', bytes: 10 }, { name: 'block_00002.mp4', bytes: 10 }, { name: 'block_2.txt', bytes: 1 }];
    const drop = planSegmentCleanup(files, done(4), { ...base, retention: 'all', busyBlocks: new Set([3]) });
    expect(drop.sort()).toEqual(['block_00002.mp4', 'block_2.txt']);
  });

  it('últimos 10 y 30 minutos: se conserva sólo esa ventana (lo más antiguo se borra primero)', () => {
    const files = Array.from({ length: 60 }, (_, i) => seg(i));
    const d10 = planSegmentCleanup(files, done(60), { ...base, retention: 'last10' });
    const d30 = planSegmentCleanup(files, done(60), { ...base, retention: 'last30' });
    // 10 min = 10 bloques de 60 s, más el último procesado (protegido por el solape).
    expect(60 - d10.length).toBe(11);
    expect(60 - d30.length).toBe(31);
    expect(d10[0]).toBe('seg_00000.ts');
    expect(d10).not.toContain('seg_00058.ts');
  });

  it('directo de 3 horas con tope de 2 GB: nunca se conserva más de 2 GB de lo procesado', () => {
    const files = Array.from({ length: 180 }, (_, i) => seg(i)); // ≈ 4,7 GB grabados
    expect(files.reduce((a, f) => a + f.bytes, 0)).toBeGreaterThan(4 * 1024 ** 3);
    const drop = planSegmentCleanup(files, done(180), { ...base, retention: 'cap' });
    const kept = sum(files, drop);
    expect(kept).toBeLessThanOrEqual(2 * 1024 ** 3);
    expect(kept).toBeGreaterThan(2 * 1024 ** 3 - 2 * SEG); // aprovecha el tope (sin borrar de más)
    // Se conservan los más recientes.
    expect(drop).toContain('seg_00000.ts');
    expect(drop).not.toContain('seg_00179.ts');
  });

  it('al terminar/detener (final): sin retención se borra todo lo que no use un trabajo activo', () => {
    const files = [seg(0), seg(1), seg(2), { name: 'block_00002.mp4', bytes: 5 }, { name: 'x.tmp', bytes: 1 }];
    const drop = planSegmentCleanup(files, [...done(2), { index: 2, status: 'procesando' }], { ...base, retention: 'none', final: true, busyBlocks: new Set([2]) });
    expect(drop.sort()).toEqual(['seg_00000.ts', 'seg_00001.ts', 'x.tmp']);
  });

  it('cálculo exacto de bytes y niveles de aviso (75 %, 90 %, lleno)', () => {
    const files = [seg(0, 1000), seg(1, 2000), seg(2, 3000)];
    const drop = planSegmentCleanup(files, done(3), { ...base, retention: 'none' });
    expect(sum(files, drop)).toBe(3000);
    expect(storageLevel(74, 100)).toBe('ok');
    expect(storageLevel(75, 100)).toBe('warn');
    expect(storageLevel(90, 100)).toBe('high');
    expect(storageLevel(100, 100)).toBe('full');
    expect(estimateLiveBytes(3600)).toBe(3600 * LIVE_BYTES_PER_SEC);
  });
});

describe('LiveManager: limpieza en disco', () => {
  let root = '';
  const jobs = new Map<string, Job>();
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-livest-'));
    jobs.clear();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const deps = (extra: Partial<LiveDeps> = {}): LiveDeps => ({
    dataDir: path.join(root, 'data'),
    liveDir: path.join(root, 'live'),
    ytDlp: () => null,
    ffmpeg: () => null,
    ffprobe: () => null,
    getJob: (id) => jobs.get(id),
    removeClips: () => undefined,
    onChange: () => undefined,
    log: () => undefined,
    enqueueBlock: async () => {
      throw new Error('no se usa');
    },
    ...extra,
  });
  /** Escribe un monitor guardado con sus segmentos en disco (como tras horas de directo). */
  const seed = (status: string, retention: string, blocks: { index: number; status: string; jobId?: string }[], segs: number, extraFiles: string[] = []) => {
    const id = 'mon-00000001';
    const dir = path.join(root, 'live', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    for (let i = 0; i < segs; i++) fs.writeFileSync(path.join(dir, `seg_${String(i).padStart(5, '0')}.ts`), Buffer.alloc(1000));
    for (const f of extraFiles) fs.writeFileSync(path.join(dir, f), Buffer.alloc(500));
    const m = {
      id,
      url: 'https://www.youtube.com/@canal',
      status,
      settings: { blockSec: 60, overlapSec: 4, preset: 15, maxClipsPerBlock: 2, pollSec: 120, retention },
      createdAt: '',
      updatedAt: '',
      recordedSec: 0,
      lastProcessedSec: 0,
      nextSegment: segs,
      blocks: blocks.map((b) => ({ startSec: 0, endSec: 60, hash: 'h', clips: 1, ...b })),
      clipsGenerated: 145,
      duplicatesSkipped: 0,
      tempBytes: 0,
      freedBytes: 0,
      gaps: [],
    };
    fs.writeFileSync(path.join(root, 'data', 'monitors.json'), JSON.stringify({ ack: true, monitors: [m] }));
    return { id, dir };
  };

  it('caso real: monitor detenido con keepSegments antiguo → al arrancar se limpia y se conservan los 145 clips', () => {
    // 2.37 GB en el caso real; aquí 40 segmentos de 1000 B con el ajuste antiguo «conservar segmentos».
    const { id, dir } = seed('detenido', undefined as unknown as string, done(40), 40);
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'data', 'monitors.json'), 'utf8'));
    raw.monitors[0].settings.keepSegments = true;
    fs.writeFileSync(path.join(root, 'data', 'monitors.json'), JSON.stringify(raw));
    const lm = new LiveManager(deps());
    // Tope de 2 GB: estos 40 KB caben; con «Liberar temporales ahora» se borra todo lo que no haga falta.
    expect(lm.list().monitors[0].settings.retention).toBe('cap');
    const freed = lm.freeTemps(id);
    expect(freed).toBe(40 * 1000);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(lm.list().monitors[0].clipsGenerated).toBe(145);
  });

  it('cierre inesperado: un directo terminado sin retención se limpia al arrancar; las carpetas huérfanas también', () => {
    const { dir } = seed('finalizado', 'none', done(5), 5, ['block_00004.mp4', 'block_4.txt']);
    const orphan = path.join(root, 'live', 'huerfano-0001');
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, 'seg_00000.ts'), 'x');
    new LiveManager(deps());
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it('bloque con trabajo activo: su vídeo y su segmento se conservan; el resto se limpia', () => {
    jobs.set('job-active1', { id: 'job-active1', status: 'transcribing', clips: [] } as unknown as Job);
    const { id, dir } = seed('detenido', 'none', [...done(3), { index: 3, status: 'procesando', jobId: 'job-active1' }], 4, ['block_00003.mp4']);
    const lm = new LiveManager(deps());
    lm.freeTemps(id);
    expect(fs.readdirSync(dir).sort()).toEqual(['block_00003.mp4', 'seg_00003.ts']);
  });

  it('trabajo fallido o cancelado: su bloque ya no se necesita y se limpia', () => {
    jobs.set('job-failed1', { id: 'job-failed1', status: 'failed', clips: [] } as unknown as Job);
    jobs.set('job-cancel1', { id: 'job-cancel1', status: 'cancelled', clips: [] } as unknown as Job);
    const { id, dir } = seed('finalizado', 'none', [{ index: 0, status: 'error', jobId: 'job-failed1' }, { index: 1, status: 'error', jobId: 'job-cancel1' }], 2, ['block_00000.mp4', 'block_00001.mp4']);
    const lm = new LiveManager(deps({ autoClean: () => false }));
    expect(fs.readdirSync(dir).length).toBe(4); // sin limpieza automática no se toca nada…
    lm.freeTemps(id); // …hasta que el usuario lo pide
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('quitar el monitor: informa de lo liberado y de los clips que se conservan (nunca toca los trabajos)', () => {
    const jobDir = path.join(root, 'jobs', 'job-kept001');
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobDir, 'clip.mp4'), 'clip');
    const { id, dir } = seed('detenido', 'all', done(3), 3);
    const lm = new LiveManager(deps({ autoClean: () => false }));
    expect(lm.remove(id)).toEqual({ freedBytes: 3000, clips: 145 });
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(path.join(jobDir, 'clip.mp4'))).toBe(true);
  });

  it('revisión Codex: el disco se vigila aunque un bloque siga procesándose (pausa segura al llegar al límite)', async () => {
    jobs.set('job-slow001', { id: 'job-slow001', status: 'transcribing', clips: [] } as unknown as Job);
    const { id } = seed('en-directo', 'none', [...done(2), { index: 2, status: 'procesando', jobId: 'job-slow001' }], 6);
    // Tope de 3000 B: 6 segmentos de 1000 B (los pendientes no se pueden borrar) → se pausa.
    const lm = new LiveManager(deps({ limits: () => ({ tempLimitBytes: 3000, minFreeBytes: 0 }), freeDiskBytes: () => 10 ** 12 }));
    // recoverMonitor deja en pausa los monitores activos al arrancar: se simula que sigue en directo.
    (lm as unknown as { monitors: Map<string, { status: string }> }).monitors.get(id)!.status = 'en-directo';
    await lm.tick(id);
    const m = lm.list().monitors[0];
    expect(m.status).toBe('pausado');
    expect(m.error).toMatch(/límite de temporales/);
    expect(m.storage?.level).toBe('full');
    lm.shutdown();
  });

  it('revisión Codex: con «Conservar todo», el límite pausa sin borrar la grabación', async () => {
    const { id, dir } = seed('en-directo', 'all', done(5), 6);
    const lm = new LiveManager(deps({ limits: () => ({ tempLimitBytes: 3000, minFreeBytes: 0 }), freeDiskBytes: () => 10 ** 12 }));
    (lm as unknown as { monitors: Map<string, { status: string }> }).monitors.get(id)!.status = 'en-directo';
    await lm.tick(id);
    expect(lm.list().monitors[0].status).toBe('pausado');
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))).toHaveLength(6);
    lm.shutdown();
  });

  it('poco espacio libre en el disco: pausa segura con error accionable', async () => {
    const { id } = seed('en-directo', 'none', done(1), 2);
    const lm = new LiveManager(deps({ limits: () => ({ tempLimitBytes: 10 ** 12, minFreeBytes: 10 * 1024 ** 3 }), freeDiskBytes: () => 1024 ** 3 }));
    (lm as unknown as { monitors: Map<string, { status: string }> }).monitors.get(id)!.status = 'en-directo';
    await lm.tick(id);
    const m = lm.list().monitors[0];
    expect(m.status).toBe('pausado');
    expect(m.error).toMatch(/poco espacio libre/);
    lm.shutdown();
  });

  it('revisión Codex: «Liberar temporales» durante la preparación de un bloque no borra sus archivos', async () => {
    const { id, dir } = seed('en-directo', 'none', done(2), 4);
    let during: string[] = [];
    let lm!: LiveManager;
    lm = new LiveManager(
      deps({
        ffmpeg: () => 'ffmpeg',
        ffprobe: () => 'ffprobe',
        run: async (cmd, args, opts) => {
          if (cmd === 'ffprobe') return { code: 0, stdout: '60\n', stderr: '' };
          if (cmd === 'ffmpeg' && args.includes('concat')) {
            fs.writeFileSync(path.join(opts.cwd!, args[args.length - 1]), 'bloque a medio escribir');
            lm.freeTemps(id); // el usuario pulsa «Liberar temporales ahora» mientras FFmpeg trabaja
            during = fs.readdirSync(dir);
            return { code: 0, stdout: '', stderr: '' };
          }
          return { code: 0, stdout: '', stderr: '' };
        },
        enqueueBlock: async (m, file, block) => {
          expect(fs.existsSync(file)).toBe(true); // el bloque sigue ahí al encolarlo
          const j = { id: `job-prep${block}`, status: 'queued', clips: [] } as unknown as Job;
          jobs.set(j.id, j);
          return j;
        },
      }),
    );
    (lm as unknown as { monitors: Map<string, { status: string }> }).monitors.get(id)!.status = 'en-directo';
    await (lm as unknown as { startBlock: (id: string, i: number, f: string[]) => Promise<void> }).startBlock(id, 2, fs.readdirSync(dir));
    expect(during).toContain('block_00002.mp4');
    expect(during).toContain('seg_00002.ts');
    expect(lm.list().monitors[0].blocks.find((b) => b.index === 2)?.status).toBe('procesando');
    lm.shutdown();
  });

  it('revisión Codex: el disco se vigila aunque el ciclo esté ocupado preparando un bloque', async () => {
    const { id } = seed('en-directo', 'none', done(2), 4);
    let limit = 10 ** 12;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const lm = new LiveManager(
      deps({
        ffmpeg: () => 'ffmpeg',
        ffprobe: () => 'ffprobe',
        limits: () => ({ tempLimitBytes: limit, minFreeBytes: 0 }),
        freeDiskBytes: () => 10 ** 12,
        run: async (cmd, args, opts) => {
          if (cmd === 'ffprobe') return { code: 0, stdout: '60', stderr: '' };
          if (cmd === 'ffmpeg' && args.includes('concat')) {
            await held; // FFmpeg atascado en el concat
            fs.writeFileSync(path.join(opts.cwd!, args[args.length - 1]), 'x');
          }
          return { code: 0, stdout: '', stderr: '' };
        },
      }),
    );
    const mon = (lm as unknown as { monitors: Map<string, { status: string }> }).monitors.get(id)!;
    mon.status = 'en-directo';
    // Primer ciclo con un tope alto: empieza a preparar el bloque 2 y se queda esperando el concat.
    const first = lm.tick(id);
    await new Promise((r) => setTimeout(r, 20));
    expect(lm.list().monitors[0].status).toBe('en-directo');
    limit = 3000;
    // La grabación sigue creciendo (4 segmentos de 1000 B > tope de 3000 B) y llega otro ciclo.
    await lm.tick(id);
    expect(lm.list().monitors[0].status).toBe('pausado');
    release();
    await first;
    lm.shutdown();
  });

  it('nunca borra fuera de la carpeta del monitor', () => {
    const { id } = seed('detenido', 'none', done(2), 2);
    const outside = path.join(root, 'live', 'seg_00000.ts');
    fs.writeFileSync(outside, 'no tocar');
    new LiveManager(deps()).freeTemps(id);
    expect(fs.existsSync(outside)).toBe(true);
  });
});
