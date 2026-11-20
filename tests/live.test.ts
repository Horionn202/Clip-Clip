import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blockWindow, completeSegments, dedupeClips, isNotLiveError, liveCheckUrl, monitorSummary, parseLiveStatus, recoverMonitor, validateLiveSettings, type LiveMonitor } from '../src/shared/live';
import { LiveManager, nextSegmentIndex, type LiveDeps } from '../src/main/liveMonitor';
import type { Job } from '../src/shared/types';

describe('lógica del monitor', () => {
  it('canal → pestaña /live; sólo YouTube', () => {
    expect(liveCheckUrl('https://www.youtube.com/@micanal')).toBe('https://www.youtube.com/@micanal/live');
    expect(liveCheckUrl('https://youtube.com/channel/UC123/')).toBe('https://www.youtube.com/channel/UC123/live');
    expect(liveCheckUrl('https://www.youtube.com/watch?v=abc')).toBe('https://www.youtube.com/watch?v=abc');
    expect(() => liveCheckUrl('https://twitch.tv/x')).toThrow();
  });
  it('estado del directo desde yt-dlp', () => {
    expect(parseLiveStatus('{"live_status":"is_live","title":"T"}')).toMatchObject({ state: 'live', title: 'T' });
    expect(parseLiveStatus('{"live_status":"is_upcoming"}').state).toBe('upcoming');
    expect(parseLiveStatus('{"live_status":"was_live"}').state).toBe('ended');
    expect(parseLiveStatus('basura').state).toBe('not-live');
    expect(isNotLiveError('ERROR: [youtube] xyz: This channel is not currently live')).toBe(true);
  });
  it('un segmento sólo está completo cuando existe el siguiente o terminó la grabación; nunca se reprocesa', () => {
    const files = ['seg_00000.ts', 'seg_00001.ts', 'seg_00002.ts', 'otro.txt'];
    expect(completeSegments(files, true, new Set())).toEqual([0, 1]);
    expect(completeSegments(files, true, new Set([0]))).toEqual([1]);
    expect(completeSegments(files, false, new Set([0, 1]))).toEqual([2]);
  });
  it('ventana con solape técnico sin pasar del inicio', () => {
    expect(blockWindow(0, 0, 60, 4, false)).toEqual({ from: 0, to: 60, overlap: 0 });
    expect(blockWindow(1, 60, 60, 4, true)).toEqual({ from: 56, to: 120, overlap: 4 });
  });
  it('deduplica los clips repetidos por el solape', () => {
    const prev = [{ start: 40, end: 55, title: 'El gol' }];
    const { keep, duplicates } = dedupeClips(
      [
        { start: 42, end: 57, title: 'Otro título' },
        { start: 70, end: 85, title: 'El gol!' },
        { start: 90, end: 105, title: 'Nuevo' },
      ],
      prev,
    );
    expect(keep.map((c) => c.title)).toEqual(['Nuevo']);
    expect(duplicates).toHaveLength(2);
  });
  it('tras cerrar la app un monitor activo queda pausado con hueco registrado', () => {
    const m = { status: 'en-directo', gaps: [] } as unknown as LiveMonitor;
    const r = recoverMonitor(m, '2026-11-19T10:00:00Z');
    expect(r.status).toBe('pausado');
    expect(r.gaps).toHaveLength(1);
    expect(recoverMonitor({ ...m, status: 'finalizado' } as LiveMonitor, 'x').status).toBe('finalizado');
  });
  it('ajustes acotados (solape 3–5 s, bloque ≥ clip + 10 s)', () => {
    expect(validateLiveSettings({ overlapSec: 10, blockSec: 5, preset: 30 })).toMatchObject({ overlapSec: 5, blockSec: 40, preset: 30 });
  });
  it('retraso respecto al vivo', () => {
    const m = { status: 'finalizado', recordedSec: 300, lastProcessedSec: 240, blocks: [] } as unknown as LiveMonitor;
    expect(monitorSummary(m, 0)).toMatchObject({ lagSec: 60, processedSec: 240 });
  });
});

describe('LiveManager (procesos simulados)', () => {
  let root: string;
  let jobs: Map<string, Job>;
  let removed: string[];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-live-'));
    jobs = new Map();
    removed = [];
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  // 'live-then-ended': la primera consulta ve el directo y las siguientes que ya terminó.
  const deps = (mode: 'live' | 'not-live' | 'ended' | 'live-then-ended', extra: Partial<LiveDeps> = {}): LiveDeps => {
    let calls = 0;
    return {
    dataDir: path.join(root, 'data'),
    liveDir: path.join(root, 'live'),
    ytDlp: () => 'yt-dlp',
    ffmpeg: () => 'ffmpeg',
    ffprobe: () => 'ffprobe',
    getJob: (id) => jobs.get(id),
    removeClips: (_j, ids) => removed.push(...ids),
    onChange: () => undefined,
    log: () => undefined,
    enqueueBlock: async (m, file, block, offsetSec) => {
      const j = { id: `job-${block}`, status: 'queued', clips: [], live: { monitorId: m.id, block, offsetSec }, localSource: file } as unknown as Job;
      jobs.set(j.id, j);
      return j;
    },
    run: async (cmd, args, opts) => {
      const live = mode === 'live-then-ended' ? (calls++ === 0 ? 'live' : 'ended') : mode;
      if (cmd === 'yt-dlp' && args[0] === '-J') return live === 'not-live' ? { code: 1, stdout: '', stderr: 'ERROR: This channel is not currently live' } : { code: 0, stdout: JSON.stringify({ live_status: live === 'live' ? 'is_live' : 'was_live', title: 'Mi directo' }), stderr: '' };
      if (cmd === 'yt-dlp' && args[0] === '-g') return { code: 0, stdout: 'https://manifest.example/x.m3u8\n', stderr: '' };
      if (cmd === 'ffprobe') return { code: 0, stdout: '60.0\n', stderr: '' };
      if (cmd === 'ffmpeg' && args.includes('concat')) {
        fs.writeFileSync(path.join(opts.cwd!, args[args.length - 1]), 'block');
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' }; // grabación: termina enseguida
    },
    ...extra,
    };
  };

  it('exige el aviso de uso autorizado la primera vez', () => {
    const lm = new LiveManager(deps('not-live'));
    expect(() => lm.create('https://www.youtube.com/@c', {}, false)).toThrow(/permiso/);
    lm.shutdown();
  });

  it('sin directo: queda esperando y vuelve a comprobar', async () => {
    const lm = new LiveManager(deps('not-live'));
    const m = lm.create('https://www.youtube.com/@c', { pollSec: 1800 }, true);
    await lm.check(m.id);
    expect(lm.list().monitors[0].status).toBe('esperando');
    lm.shutdown();
  });

  it('procesa cada segmento una sola vez, deduplica, limpia temporales y finaliza', async () => {
    const lm = new LiveManager(deps('live-then-ended'));
    const m = lm.create('https://www.youtube.com/watch?v=x', {}, true);
    // Simula dos segmentos ya grabados (la grabación terminó: ambos completos).
    const dir = path.join(root, 'live', m.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'seg_00000.ts'), 'a'.repeat(100));
    fs.writeFileSync(path.join(dir, 'seg_00001.ts'), 'b'.repeat(100));
    // Espera a que la grabación simulada termine y se detecte el fin del directo.
    for (let i = 0; i < 50 && lm.list().monitors[0].status !== 'finalizando'; i++) await new Promise((r) => setTimeout(r, 10));
    expect(lm.list().monitors[0].status).toBe('finalizando');
    await lm.tick(m.id); // encola el bloque 0
    expect(lm.list().monitors[0].blocks.map((b) => b.index)).toEqual([0]);
    await lm.tick(m.id); // el trabajo aún no terminó: no encola otro
    expect(lm.list().monitors[0].blocks).toHaveLength(1);
    jobs.set('job-0', { ...jobs.get('job-0')!, status: 'completed', clips: [{ id: 'c1', start: 44, end: 59.5, title: 'A' }] } as Job);
    await lm.tick(m.id); // cierra el bloque 0 y encola el 1 (con solape del 0)
    let cur = lm.list().monitors[0];
    expect(cur.blocks.map((b) => [b.index, b.status])).toEqual([
      [0, 'procesado'],
      [1, 'procesando'],
    ]);
    expect(jobs.get('job-1')!.live!.offsetSec).toBe(56);
    // El bloque 1 repite el clip del final del 0 (por el solape) y aporta uno nuevo.
    jobs.set('job-1', { ...jobs.get('job-1')!, status: 'completed', clips: [{ id: 'd1', start: 0, end: 15, title: 'Repetido' }, { id: 'd2', start: 30, end: 45, title: 'B' }] } as Job);
    await lm.tick(m.id);
    await lm.tick(m.id);
    cur = lm.list().monitors[0];
    expect(cur.clipsGenerated).toBe(2);
    expect(cur.duplicatesSkipped).toBe(1);
    expect(removed).toEqual(['d1']);
    expect(cur.status).toBe('finalizado');
    expect(fs.existsSync(path.join(dir, 'seg_00000.ts'))).toBe(false);
    expect(cur.freedBytes).toBeGreaterThan(0);
    lm.shutdown();
  });

  it('reanudable: el estado persiste y vuelve como pausado', () => {
    const lm = new LiveManager(deps('not-live'));
    const m = lm.create('https://www.youtube.com/@c', { pollSec: 1800 }, true);
    lm.shutdown();
    const again = new LiveManager(deps('not-live'));
    expect(again.list().monitors.find((x) => x.id === m.id)?.status).toBe('pausado');
    expect(again.list().ack).toBe(true);
    again.shutdown();
  });

  it('al reanudar no reutiliza índices de segmento', () => {
    expect(nextSegmentIndex({ nextSegment: 0, blocks: [{ index: 3 } as never] }, ['seg_00004.ts'])).toBe(5);
    expect(nextSegmentIndex({ nextSegment: 7, blocks: [] }, [])).toBe(7);
  });

  it('pausar mientras se consulta el flujo no arranca la grabación', async () => {
    let release: () => void = () => undefined;
    const started: string[] = [];
    const d = deps('live');
    const base = d.run!;
    d.run = async (cmd, args, opts) => {
      if (cmd === 'yt-dlp' && args[0] === '-g') await new Promise<void>((r) => (release = r));
      if (cmd === 'ffmpeg' && args.includes('segment')) started.push('rec');
      return base(cmd, args, opts);
    };
    const lm = new LiveManager(d);
    const m = lm.create('https://www.youtube.com/watch?v=x', {}, true);
    for (let i = 0; i < 50 && lm.list().monitors[0].status !== 'en-directo'; i++) await new Promise((r) => setTimeout(r, 5));
    lm.stop(m.id);
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toEqual([]);
    expect(lm.list().monitors[0].status).toBe('detenido');
    lm.shutdown();
  });

  it('detener no borra el bloque de un trabajo aún en cola', async () => {
    const lm = new LiveManager(deps('live-then-ended'));
    const m = lm.create('https://www.youtube.com/watch?v=x', {}, true);
    const dir = path.join(root, 'live', m.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'seg_00000.ts'), 'a');
    fs.writeFileSync(path.join(dir, 'seg_00001.ts'), 'b');
    for (let i = 0; i < 50 && lm.list().monitors[0].status !== 'finalizando'; i++) await new Promise((r) => setTimeout(r, 10));
    await lm.tick(m.id);
    const block = path.join(dir, 'block_00000.mp4');
    expect(fs.existsSync(block)).toBe(true);
    lm.stop(m.id);
    expect(fs.existsSync(block)).toBe(true);
    jobs.set('job-0', { ...jobs.get('job-0')!, status: 'completed', clips: [] } as unknown as Job);
    await lm.tick(m.id);
    expect(fs.existsSync(block)).toBe(false);
    lm.shutdown();
  });

  it('si yt-dlp falla al pedir el flujo, queda en error reanudable', async () => {
    const d = deps('live');
    const base = d.run!;
    d.run = async (cmd, args, opts) => {
      if (cmd === 'yt-dlp' && args[0] === '-g') throw new Error('timeout');
      return base(cmd, args, opts);
    };
    const lm = new LiveManager(d);
    lm.create('https://www.youtube.com/watch?v=x', {}, true);
    for (let i = 0; i < 50 && lm.list().monitors[0].status !== 'error'; i++) await new Promise((r) => setTimeout(r, 5));
    expect(lm.list().monitors[0]).toMatchObject({ status: 'error' });
    lm.shutdown();
  });
});
