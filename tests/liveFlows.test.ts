// Integración del monitor de directos con yt-dlp/FFmpeg/ffprobe falsos (sin red ni procesos reales).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LiveManager, backoff, blockFitsClip, type LiveDeps } from '../src/main/liveMonitor';
import { parseLiveStatus } from '../src/shared/live';
import type { Job } from '../src/shared/types';
import type { RunResult } from '../src/main/proc';

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const until = async (cond: () => boolean, ms = 1000) => {
  const t = Date.now();
  while (!cond() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 5));
};

interface World {
  live: 'live' | 'upcoming' | 'ended' | 'not-live';
  recorder: 'hold' | 'drop' | 'exit';
  recorderStarts: number[];
  concatFails: boolean;
  durations: Record<string, number>;
  jobs: Map<string, Job>;
  jobDirs: string;
  aborted: number;
}

let root: string;
let w: World;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-liveflow-'));
  w = { live: 'live', recorder: 'hold', recorderStarts: [], concatFails: false, durations: {}, jobs: new Map(), jobDirs: path.join(root, 'jobs'), aborted: 0 };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function deps(extra: Partial<LiveDeps> = {}): LiveDeps {
  return {
    dataDir: path.join(root, 'data'),
    liveDir: path.join(root, 'live'),
    ytDlp: () => 'yt-dlp',
    ffmpeg: () => 'ffmpeg',
    ffprobe: () => 'ffprobe',
    getJob: (id) => w.jobs.get(id),
    removeClips: () => undefined,
    onChange: () => undefined,
    log: () => undefined,
    backoffMs: () => 1,
    // Como en la app: el vídeo se enlaza en la carpeta del trabajo antes de volver.
    enqueueBlock: async (m, file, block, offsetSec) => {
      const dir = path.join(w.jobDirs, `job-${block}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(file, path.join(dir, 'source.mp4'));
      const j = { id: `job-${block}`, status: 'queued', clips: [], live: { monitorId: m.id, block, offsetSec }, localSource: file } as unknown as Job;
      w.jobs.set(j.id, j);
      return j;
    },
    run: async (cmd, args, opts) => {
      if (cmd === 'yt-dlp' && args[0] === '-J') {
        if (w.live === 'not-live') return { code: 1, stdout: '', stderr: 'ERROR: This channel is not currently live' };
        return ok(JSON.stringify({ live_status: { live: 'is_live', upcoming: 'is_upcoming', ended: 'was_live' }[w.live], title: 'Mi directo' }));
      }
      if (cmd === 'yt-dlp' && args[0] === '-g') return ok('https://manifest.example/x.m3u8\n');
      if (cmd === 'ffprobe') {
        const f = path.basename(args[args.length - 1]);
        return ok(`${w.durations[f] ?? 60}\n`);
      }
      if (cmd === 'ffmpeg' && args.includes('concat')) {
        if (w.concatFails) return { code: 1, stdout: '', stderr: 'concat: error de prueba' };
        fs.writeFileSync(path.join(opts.cwd!, args[args.length - 1]), 'block');
        return ok();
      }
      if (cmd === 'ffmpeg' && args.includes('segment')) {
        w.recorderStarts.push(Number(args[args.indexOf('-segment_start_number') + 1]));
        if (w.recorder === 'drop') return { code: 1, stdout: '', stderr: 'Connection reset by peer' };
        if (w.recorder === 'exit') return ok();
        // «hold»: graba hasta que se aborta (pausa/detener/cerrar).
        await new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => (w.aborted++, resolve())));
        return { code: 255, stdout: '', stderr: 'aborted' };
      }
      return ok();
    },
    ...extra,
  };
}
const seg = (m: { id: string }, i: number, bytes = 10) => {
  const dir = path.join(root, 'live', m.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `seg_${String(i).padStart(5, '0')}.ts`), 'x'.repeat(bytes));
};
const dirOf = (m: { id: string }) => path.join(root, 'live', m.id);

describe('estado del directo y DVR', () => {
  it('activo, programado, terminado y no activo; la app no afirma nada sobre DVR', () => {
    expect(parseLiveStatus('{"live_status":"is_live","is_live":true}')).toEqual({ state: 'live', title: undefined });
    expect(parseLiveStatus('{"live_status":"is_upcoming"}').state).toBe('upcoming');
    expect(parseLiveStatus('{"live_status":"was_live"}').state).toBe('ended');
    expect(parseLiveStatus('{"live_status":"not_live"}').state).toBe('not-live');
    // Aunque yt-dlp traiga metadatos parecidos a DVR, no se exponen: no son fiables.
    expect(parseLiveStatus('{"live_status":"is_live","is_live":true,"was_live":false,"live_from_start":true}')).not.toHaveProperty('dvr');
  });
});

describe('flujos del monitor', () => {
  it('directo que comienza: de «esperando» a grabar desde el segmento 0', async () => {
    w.live = 'not-live';
    const lm = new LiveManager(deps());
    const m = lm.create('https://www.youtube.com/@c', { pollSec: 1800 }, true);
    await until(() => lm.list().monitors[0].status === 'esperando');
    w.live = 'live';
    await lm.check(m.id);
    await until(() => w.recorderStarts.length === 1);
    expect(lm.list().monitors[0].status).toBe('en-directo');
    expect(w.recorderStarts).toEqual([0]);
    expect(lm.list().monitors[0].notice).toMatch(/hacia adelante/);
    lm.shutdown();
    expect(w.aborted).toBe(1); // cerrar la app aborta FFmpeg (sin procesos huérfanos)
  });

  it('el flujo se corta: anota hueco, reconecta con espera y no entra en bucle infinito', async () => {
    w.recorder = 'drop';
    const lm = new LiveManager(deps());
    lm.create('https://www.youtube.com/watch?v=x', {}, true);
    await until(() => lm.list().monitors[0].status === 'error', 2000);
    const m = lm.list().monitors[0];
    expect(m.status).toBe('error');
    expect(m.error).toMatch(/se cortó 6 veces/);
    expect(w.recorderStarts.length).toBe(6);
    expect(m.gaps.filter((g) => /Reconexión/.test(g.reason)).length).toBeGreaterThanOrEqual(5);
    expect(backoff(1)).toBe(3000);
    expect(backoff(10)).toBe(120_000);
    lm.shutdown();
  });

  it('pausa y reanudar: aborta la grabación y continúa sin sobrescribir segmentos', async () => {
    const lm = new LiveManager(deps());
    const m = lm.create('https://www.youtube.com/watch?v=x', {}, true);
    await until(() => w.recorderStarts.length === 1);
    seg(m, 0);
    seg(m, 1);
    lm.pause(m.id);
    await until(() => w.aborted === 1);
    expect(lm.list().monitors[0].gaps.some((g) => /Pausado/.test(g.reason))).toBe(true);
    lm.resume(m.id);
    await until(() => w.recorderStarts.length === 2);
    expect(w.recorderStarts).toEqual([0, 2]);
    lm.shutdown();
  });

  it('cierre y reapertura: queda en pausa y al reanudar procesa lo ya grabado', async () => {
    const lm = new LiveManager(deps());
    const m = lm.create('https://www.youtube.com/watch?v=x', {}, true);
    await until(() => w.recorderStarts.length === 1);
    seg(m, 0);
    seg(m, 1);
    lm.shutdown();
    const again = new LiveManager(deps());
    expect(again.list().monitors[0].status).toBe('pausado');
    again.resume(m.id);
    await until(() => w.recorderStarts.length === 2);
    expect(w.recorderStarts[1]).toBe(2);
    await again.tick(m.id);
    expect(again.list().monitors[0].blocks.map((b) => b.index)).toEqual([0]);
    again.shutdown();
  });

  it('último segmento corto: se omite con motivo claro y luego «Finalizado»', async () => {
    w.recorder = 'exit';
    w.live = 'live';
    const d = deps();
    let calls = 0;
    const base = d.run!;
    d.run = async (cmd, args, opts) => (cmd === 'yt-dlp' && args[0] === '-J' && calls++ > 0 ? ok('{"live_status":"was_live"}') : base(cmd, args, opts));
    const lm = new LiveManager(d);
    const m = lm.create('https://www.youtube.com/watch?v=x', { preset: 30 }, true);
    await until(() => lm.list().monitors[0].status === 'finalizando');
    seg(m, 0);
    seg(m, 1);
    w.durations['seg_00001.ts'] = 20;
    await lm.tick(m.id);
    w.jobs.set('job-0', { ...w.jobs.get('job-0')!, status: 'completed', clips: [] } as unknown as Job);
    await lm.tick(m.id);
    await lm.tick(m.id);
    const cur = lm.list().monitors[0];
    const last = cur.blocks.find((b) => b.index === 1)!;
    // 20 s + 4 s de solape < 31 s: no cabe un clip de 30 s.
    expect(last.status).toBe('omitido');
    expect(last.error).toMatch(/dura 24 s y no cabe un clip de 30 s/);
    expect(cur.status).toBe('finalizado');
    expect(blockFitsClip(31, 30)).toBe(true);
    lm.shutdown();
  });

  it('fallo al crear el bloque: queda en error, conserva el segmento y «Reintentar bloque» lo recupera', async () => {
    const lm = new LiveManager(deps());
    const m = lm.create('https://www.youtube.com/watch?v=x', {}, true);
    await until(() => w.recorderStarts.length === 1);
    seg(m, 0);
    seg(m, 1);
    w.concatFails = true;
    await lm.tick(m.id);
    let b = lm.list().monitors[0].blocks[0];
    expect(b).toMatchObject({ index: 0, status: 'error' });
    expect(b.error).toMatch(/No se pudo preparar el bloque/);
    expect(fs.existsSync(path.join(dirOf(m), 'seg_00000.ts'))).toBe(true);
    // Nunca se reprocesa solo, ni se pierde: el siguiente ciclo pasa al segmento siguiente.
    w.concatFails = false;
    await lm.retryBlock(m.id, 0);
    b = lm.list().monitors[0].blocks.find((x) => x.index === 0)!;
    expect(b.status).toBe('procesando');
    expect(lm.list().monitors[0].recordedSec).toBe(60); // el reintento no vuelve a sumar tiempo
    lm.shutdown();
  });

  it('trabajo de bloque fallido: visible, reintentable y, al detener, anotado como hueco', async () => {
    const lm = new LiveManager(deps());
    const m = lm.create('https://www.youtube.com/watch?v=x', {}, true);
    await until(() => w.recorderStarts.length === 1);
    seg(m, 0);
    seg(m, 1);
    await lm.tick(m.id);
    w.jobs.set('job-0', { ...w.jobs.get('job-0')!, status: 'failed', error: 'Ollama no respondió' } as unknown as Job);
    await lm.tick(m.id);
    const b = lm.list().monitors[0].blocks.find((x) => x.index === 0)!;
    expect(b).toMatchObject({ status: 'error', error: 'Ollama no respondió' });
    expect(fs.existsSync(path.join(dirOf(m), 'seg_00000.ts'))).toBe(true);
    lm.stop(m.id);
    const cur = lm.list().monitors[0];
    expect(cur.gaps.some((g) => /Bloque 1 sin procesar: Ollama/.test(g.reason))).toBe(true);
    lm.shutdown();
  });

  it('el vídeo queda en la carpeta del trabajo antes de que el monitor borre su temporal', async () => {
    const lm = new LiveManager(deps());
    const m = lm.create('https://www.youtube.com/watch?v=x', {}, true);
    await until(() => w.recorderStarts.length === 1);
    seg(m, 0);
    seg(m, 1);
    seg(m, 2);
    await lm.tick(m.id);
    w.jobs.set('job-0', { ...w.jobs.get('job-0')!, status: 'completed', clips: [] } as unknown as Job);
    await lm.tick(m.id); // cierra el 0 (borra su bloque) y prepara el 1
    expect(fs.existsSync(path.join(dirOf(m), 'block_00000.mp4'))).toBe(false);
    expect(fs.existsSync(path.join(w.jobDirs, 'job-0', 'source.mp4'))).toBe(true);
    // Un bloque ya procesado no se vuelve a procesar.
    await lm.tick(m.id);
    expect(lm.list().monitors[0].blocks.filter((b) => b.index === 0)).toHaveLength(1);
    lm.shutdown();
  });

  it('falta FFprobe o el modelo de Whisper: error claro antes de grabar', async () => {
    const a = new LiveManager(deps({ ffprobe: () => null }));
    a.create('https://www.youtube.com/watch?v=x', {}, true);
    await until(() => a.list().monitors[0].status === 'error');
    expect(a.list().monitors[0].error).toMatch(/FFprobe/);
    a.shutdown();
    fs.rmSync(path.join(root, 'data'), { recursive: true, force: true });
    const b = new LiveManager(deps({ preflight: async () => 'El modelo de Whisper «small» no está descargado.' }));
    b.create('https://www.youtube.com/watch?v=y', {}, true);
    await until(() => b.list().monitors[0].status === 'error');
    expect(b.list().monitors[0].error).toMatch(/no está descargado/);
    expect(w.recorderStarts).toEqual([]);
    b.shutdown();
  });

  it('un fallo de ffprobe no se confunde con un segmento corto', async () => {
    const d = deps();
    const base = d.run!;
    d.run = async (cmd, args, opts) => (cmd === 'ffprobe' ? { code: 1, stdout: '', stderr: 'Invalid data' } : base(cmd, args, opts));
    const lm = new LiveManager(d);
    const m = lm.create('https://www.youtube.com/watch?v=x', {}, true);
    await until(() => w.recorderStarts.length === 1);
    seg(m, 0);
    seg(m, 1);
    await lm.tick(m.id);
    expect(lm.list().monitors[0].blocks[0]).toMatchObject({ status: 'error' });
    expect(lm.list().monitors[0].blocks[0].error).toMatch(/No se pudo medir/);
    lm.shutdown();
  });
});
