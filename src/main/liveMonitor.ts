// Monitor de directos: graba el directo hacia adelante en segmentos y procesa cada uno como un trabajo normal
// (con solape), de uno en uno. Estado persistente en data/monitors.json; temporales en live/<id>/.
// Límites de consumo: 1 grabación (descarga) por monitor y 1 bloque en proceso a la vez por monitor; la cola de
// trabajos de la app ya serializa transcripción y render (maxConcurrentJobs).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Job } from '../shared/types';
import {
  LIVE_DEFAULTS,
  blockHash,
  blockWindow,
  completeSegments,
  dedupeClips,
  isActive,
  isNotLiveError,
  liveCheckUrl,
  parseLiveStatus,
  recoverMonitor,
  segmentIndex,
  validateLiveSettings,
  type AbsClip,
  type LiveMonitor,
  type LiveSettings,
} from '../shared/live';
import { UserFacingError } from '../shared/validation';
import { runProcess, type RunResult } from './proc';
import { isInside } from './paths';

export interface LiveDeps {
  dataDir: string;
  liveDir: string;
  ytDlp: () => string | null;
  ffmpeg: () => string | null;
  ffprobe: () => string | null;
  /** Encola un bloque como trabajo (con vídeo local, sin yt-dlp). */
  enqueueBlock: (m: LiveMonitor, file: string, block: number, offsetSec: number) => Promise<Job>;
  getJob: (id: string) => Job | undefined;
  /** Quita del trabajo los clips duplicados por el solape (y su MP4 interno). */
  removeClips: (jobId: string, clipIds: string[]) => void;
  onChange: (m: LiveMonitor) => void;
  log: (msg: string, extra?: unknown) => void;
  run?: (cmd: string, args: string[], opts: { signal?: AbortSignal; timeoutMs?: number; cwd?: string }) => Promise<RunResult>;
  now?: () => number;
}

interface Runtime {
  recorder?: AbortController;
  recorderRunning: boolean;
  poll?: NodeJS.Timeout;
  tick?: NodeJS.Timeout;
  busy: boolean;
  /** Se incrementa al pausar/detener: una grabación que estaba arrancando lo comprueba y no empieza. */
  gen: number;
  /** Clips ya generados (tiempos absolutos de la grabación) para deduplicar. */
  absClips: AbsClip[];
}

const TERMINAL = ['completed', 'failed', 'cancelled'];

export class LiveManager {
  private file: string;
  private monitors = new Map<string, LiveMonitor>();
  private rt = new Map<string, Runtime>();
  private ack: boolean;

  constructor(private d: LiveDeps) {
    this.file = path.join(d.dataDir, 'monitors.json');
    let saved: { ack?: boolean; monitors?: LiveMonitor[] } = {};
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      saved = {};
    }
    this.ack = saved.ack === true;
    const now = new Date().toISOString();
    // Tras un cierre: los monitores activos quedan en pausa (reanudables) y se registra el hueco.
    for (const m of saved.monitors ?? []) this.monitors.set(m.id, recoverMonitor(m, now));
    this.flush();
  }

  private run(cmd: string, args: string[], opts: { signal?: AbortSignal; timeoutMs?: number; cwd?: string }): Promise<RunResult> {
    return (this.d.run ?? runProcess)(cmd, args, opts);
  }
  private flush(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ack: this.ack, monitors: [...this.monitors.values()] }, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
  private set(id: string, patch: Partial<LiveMonitor>): LiveMonitor {
    const m = { ...this.monitors.get(id)!, ...patch, updatedAt: new Date().toISOString() };
    this.monitors.set(id, m);
    this.flush();
    this.d.onChange(m);
    return m;
  }
  private dirOf(id: string): string {
    const dir = path.join(this.d.liveDir, id);
    if (!isInside(this.d.liveDir, dir)) throw new Error('ruta fuera de la carpeta de directos');
    return dir;
  }
  private runtime(id: string): Runtime {
    let r = this.rt.get(id);
    if (!r) {
      r = { recorderRunning: false, busy: false, absClips: this.historyOf(id), gen: 0 };
      this.rt.set(id, r);
    }
    return r;
  }

  /** Clips ya generados por el monitor (tiempos absolutos), reconstruidos desde los trabajos de sus bloques (p. ej. tras reabrir la app). */
  private historyOf(id: string): AbsClip[] {
    const m = this.monitors.get(id);
    if (!m) return [];
    return m.blocks
      .filter((b) => b.status === 'procesado' && b.jobId)
      .flatMap((b) => {
        const job = this.d.getJob(b.jobId!);
        const offset = job?.live?.offsetSec ?? b.startSec;
        return (job?.clips ?? []).map((c) => ({ start: offset + c.start, end: offset + c.end, title: c.title }));
      });
  }

  list(): { ack: boolean; monitors: LiveMonitor[] } {
    return { ack: this.ack, monitors: [...this.monitors.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
  }

  create(url: string, settings: Partial<LiveSettings>, acknowledged: boolean): LiveMonitor {
    if (!this.ack && !acknowledged) throw new UserFacingError('Confirma que el directo es tuyo o que tienes permiso para usarlo.');
    this.ack = true;
    const checkUrl = liveCheckUrl(url);
    if ([...this.monitors.values()].some((m) => m.url === checkUrl && isActive(m.status))) throw new UserFacingError('Ya hay un monitor activo para ese directo.');
    const now = new Date().toISOString();
    const m: LiveMonitor = {
      id: randomUUID(),
      url: checkUrl,
      status: 'verificando',
      settings: validateLiveSettings({ ...LIVE_DEFAULTS, ...settings }),
      createdAt: now,
      updatedAt: now,
      recordedSec: 0,
      lastProcessedSec: 0,
      nextSegment: 0,
      blocks: [],
      clipsGenerated: 0,
      duplicatesSkipped: 0,
      tempBytes: 0,
      freedBytes: 0,
      gaps: [],
    };
    this.monitors.set(m.id, m);
    this.flush();
    this.d.onChange(m);
    void this.check(m.id);
    return m;
  }

  pause(id: string): LiveMonitor {
    const m = this.must(id);
    if (!isActive(m.status)) throw new UserFacingError('El monitor no está activo.');
    this.stopRuntime(id, false);
    return this.set(id, { status: 'pausado', gaps: [...m.gaps, { at: new Date().toISOString(), reason: 'Pausado por el usuario.' }], notice: 'Pausado. Al reanudar se sigue desde el momento actual del directo.' });
  }

  resume(id: string): LiveMonitor {
    const m = this.must(id);
    if (m.status !== 'pausado' && m.status !== 'error') throw new UserFacingError('Sólo se puede reanudar un monitor pausado o con error.');
    const next = this.set(id, { status: 'verificando', notice: undefined, error: undefined });
    void this.check(id);
    this.ensureTick(id);
    return next;
  }

  stop(id: string): LiveMonitor {
    const m = this.must(id);
    // Si hay un bloque en cola o en proceso, el ciclo sigue vivo hasta que termine para cerrarlo y limpiar su archivo.
    const pending = m.blocks.some((b) => b.status === 'procesando');
    this.stopRuntime(id, !pending);
    this.cleanupSegments(id, true);
    if (pending) this.ensureTick(id);
    return this.set(id, { status: m.status === 'finalizado' ? 'finalizado' : 'detenido', finishedAt: m.finishedAt ?? new Date().toISOString() });
  }

  /** Borra el registro y los temporales del monitor (nunca los trabajos ni los clips generados). */
  remove(id: string): void {
    const m = this.must(id);
    if (isActive(m.status)) throw new UserFacingError('Detén el monitor antes de quitarlo.');
    // Un bloque en cola o en proceso aún necesita su archivo (el trabajo lo enlaza al empezar).
    if (m.blocks.some((b) => b.status === 'procesando' && b.jobId && !TERMINAL.includes(this.d.getJob(b.jobId)?.status ?? 'completed'))) {
      throw new UserFacingError('Hay un bloque de este directo pendiente de procesar; espera a que termine para quitarlo.');
    }
    this.stopRuntime(id, true);
    fs.rmSync(this.dirOf(id), { recursive: true, force: true });
    this.monitors.delete(id);
    this.flush();
  }

  shutdown(): void {
    for (const id of this.rt.keys()) this.stopRuntime(id, true);
  }

  private must(id: string): LiveMonitor {
    const m = this.monitors.get(id);
    if (!m) throw new UserFacingError('El monitor no existe.');
    return m;
  }

  private stopRuntime(id: string, all: boolean): void {
    const r = this.rt.get(id);
    if (!r) return;
    r.gen++;
    r.recorder?.abort();
    r.recorder = undefined;
    if (r.poll) clearTimeout(r.poll);
    r.poll = undefined;
    if (all && r.tick) {
      clearInterval(r.tick);
      r.tick = undefined;
    }
  }

  private ensureTick(id: string): void {
    const r = this.runtime(id);
    if (!r.tick) r.tick = setInterval(() => void this.tick(id).catch((e) => this.d.log('directo: error en ciclo', { id, error: String(e) })), 5000);
  }

  /** Consulta si hay directo; si no, espera y vuelve a mirar cada pollSec. */
  async check(id: string): Promise<void> {
    const m = this.monitors.get(id);
    const yt = this.d.ytDlp();
    if (!m || !yt) {
      if (m) this.set(id, { status: 'error', error: 'Falta yt-dlp. Revisa Configuración → Diagnóstico.' });
      return;
    }
    if (m.status !== 'verificando' && m.status !== 'esperando') return;
    // Una consulta de una sesión anterior (antes de pausar/reanudar) no debe pisar el resultado de la actual.
    const gen = this.runtime(id).gen;
    this.set(id, { status: 'verificando' });
    let r: RunResult;
    try {
      r = await this.run(yt, ['-J', '--no-playlist', '--no-warnings', '--', m.url], { timeoutMs: 90_000 });
    } catch (e) {
      // yt-dlp no arrancó o superó el tiempo: error visible y reanudable (no se queda «Verificando» para siempre).
      if (gen !== this.runtime(id).gen) return;
      const c = this.monitors.get(id);
      if (c && (c.status === 'verificando' || c.status === 'esperando')) this.set(id, { status: 'error', error: `No se pudo consultar el directo (${(e as Error).message}). Pulsa «Reanudar» para reintentar.` });
      return;
    }
    const cur = this.monitors.get(id);
    if (gen !== this.runtime(id).gen || !cur || (cur.status !== 'verificando' && cur.status !== 'esperando')) return;
    const st = r.code === 0 ? parseLiveStatus(r.stdout) : { state: isNotLiveError(r.stderr) ? ('not-live' as const) : ('error' as const), title: undefined };
    if (st.state === 'error') {
      this.set(id, { status: 'error', error: `No se pudo consultar el directo: ${r.stderr.split('\n').filter(Boolean).slice(-1)[0] ?? 'error desconocido'}` });
      return;
    }
    if (st.state === 'live') {
      this.set(id, { status: 'en-directo', title: st.title ?? cur.title, liveDetectedAt: cur.liveDetectedAt ?? new Date().toISOString(), notice: cur.blocks.length ? cur.notice : 'Se procesa desde ahora: lo emitido antes de empezar a vigilar no se descarga.' });
      this.ensureTick(id);
      void this.startRecorder(id);
      return;
    }
    if (st.state === 'ended' && cur.liveDetectedAt) {
      this.set(id, { status: 'finalizando' });
      this.ensureTick(id);
      return;
    }
    this.set(id, { status: 'esperando', title: st.title ?? cur.title, notice: st.state === 'upcoming' ? 'El directo está programado: se empezará en cuanto comience.' : 'No hay directo activo ahora. Se vuelve a comprobar periódicamente.' });
    const rt = this.runtime(id);
    if (rt.poll) clearTimeout(rt.poll);
    rt.poll = setTimeout(() => void this.check(id), cur.settings.pollSec * 1000);
  }

  /** Graba el HLS en segmentos de blockSec. Al terminar (fin del directo o caída) decide si reconectar o finalizar. */
  private async startRecorder(id: string): Promise<void> {
    const m = this.monitors.get(id);
    const yt = this.d.ytDlp();
    const ff = this.d.ffmpeg();
    if (!m) return;
    if (!yt || !ff) {
      this.set(id, { status: 'error', error: `Falta ${!ff ? 'FFmpeg' : 'yt-dlp'} para grabar el directo. Revisa Configuración → Diagnóstico y pulsa «Reanudar».` });
      return;
    }
    const rt = this.runtime(id);
    if (rt.recorderRunning || !isActive(m.status)) return;
    const gen = rt.gen;
    rt.recorderRunning = true; // reservado desde ya: evita dos grabaciones a la vez
    const dir = this.dirOf(id);
    fs.mkdirSync(dir, { recursive: true });
    let g: RunResult;
    try {
      g = await this.run(yt, ['-g', '-f', 'b[height<=720]/b', '--no-playlist', '--no-warnings', '--', m.url], { timeoutMs: 90_000 });
    } catch (e) {
      // yt-dlp no arrancó o superó el tiempo: se libera la reserva y queda en error reanudable.
      rt.recorderRunning = false;
      if (gen === rt.gen) this.set(id, { status: 'error', error: `No se pudo consultar el flujo del directo (${(e as Error).message}). Pulsa «Reanudar» para reintentar.` });
      return;
    }
    const stream = g.stdout.split(/\r?\n/).find((l) => /^https:\/\//.test(l.trim()))?.trim();
    // Pausado o detenido mientras se consultaba el flujo: no se empieza a grabar.
    const live = this.monitors.get(id);
    if (gen !== rt.gen || !live || !isActive(live.status)) {
      rt.recorderRunning = false;
      // Se pausó y se reanudó mientras tanto: la reanudación no pudo arrancar (la reserva estaba ocupada); se arranca ahora.
      if (live && (live.status === 'en-directo' || live.status === 'procesando')) void this.startRecorder(id);
      return;
    }
    if (g.code !== 0 || !stream) {
      rt.recorderRunning = false;
      this.set(id, { status: 'error', error: 'No se pudo obtener el flujo del directo (puede haber terminado o no permitir la descarga).' });
      return;
    }
    // Nunca se reutiliza un nombre de segmento: se continúa tras lo ya grabado o procesado.
    const start = nextSegmentIndex(live, fs.readdirSync(dir));
    if (start !== live.nextSegment) this.set(id, { nextSegment: start });
    const ctrl = new AbortController();
    rt.recorder = ctrl;
    this.d.log('directo: grabación iniciada', { id, segmento: start });
    const res = await this.run(
      ff,
      ['-hide_banner', '-loglevel', 'error', '-i', stream, '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-f', 'segment', '-segment_time', String(m.settings.blockSec), '-reset_timestamps', '1', '-segment_start_number', String(start), '-segment_format', 'mpegts', 'seg_%05d.ts'],
      { cwd: dir, signal: ctrl.signal, timeoutMs: 12 * 60 * 60 * 1000 },
    ).catch((e) => ({ code: -1, stdout: '', stderr: String(e) }) as RunResult);
    rt.recorderRunning = false;
    rt.recorder = undefined;
    const cur = this.monitors.get(id);
    // Pausado o detenido: se guarda el siguiente índice para que al reanudar no se pisen segmentos.
    if (cur && fs.existsSync(dir)) {
      const next = nextSegmentIndex(cur, fs.readdirSync(dir));
      if (next !== cur.nextSegment) this.set(id, { nextSegment: next });
    }
    if (!cur || !isActive(cur.status)) return;
    // Se pausó y reanudó mientras FFmpeg terminaba: la reanudación no pudo arrancar (reserva ocupada); se arranca ahora.
    if (gen !== rt.gen) {
      if (cur.status === 'en-directo' || cur.status === 'procesando') void this.startRecorder(id);
      return;
    }
    // ¿Sigue en directo? Entonces fue una caída (o el enlace HLS caducó): se reconecta y se anota el hueco.
    let st: string;
    try {
      const again = await this.run(yt, ['-J', '--no-playlist', '--no-warnings', '--', cur.url], { timeoutMs: 90_000 });
      // Sólo se da por terminado si yt-dlp lo confirma; un fallo de red se trata como «sigue en directo» y se reconecta.
      st = again.code === 0 ? parseLiveStatus(again.stdout).state : isNotLiveError(again.stderr) ? 'not-live' : 'live';
    } catch (e) {
      // No se pudo comprobar: se reintenta la grabación (si sigue sin poder, acabará en error reanudable).
      st = 'live';
      this.d.log('directo: no se pudo comprobar el estado tras la grabación', { id, error: (e as Error).message });
    }
    // Pausado o detenido mientras se comprobaba: no se toca el estado.
    const after = this.monitors.get(id);
    if (gen !== rt.gen || !after || !isActive(after.status)) return;
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const maxSeg = Math.max(cur.nextSegment - 1, ...files.map(segmentIndex).filter((n): n is number => n !== null));
    if (st === 'live') {
      this.set(id, { nextSegment: maxSeg + 1, gaps: [...cur.gaps, { at: new Date().toISOString(), reason: `Reconexión de la grabación (${res.stderr.split('\n').filter(Boolean).slice(-1)[0] ?? 'el flujo se cortó'}).` }] });
      setTimeout(() => void this.startRecorder(id), 3000);
    } else {
      // Fin del directo: ventana corta de seguridad y se procesa lo pendiente.
      this.set(id, { status: 'finalizando', nextSegment: maxSeg + 1, notice: 'El directo terminó. Procesando el último segmento…' });
    }
  }

  private probeDuration = async (file: string): Promise<number> => {
    const fp = this.d.ffprobe();
    if (!fp) return 0;
    const r = await this.run(fp, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeoutMs: 60_000 });
    return parseFloat(r.stdout) || 0;
  };

  /** Ciclo: termina el bloque en curso y, si no hay ninguno, prepara y encola el siguiente segmento completo. */
  async tick(id: string): Promise<void> {
    const rt = this.runtime(id);
    if (rt.busy) return;
    rt.busy = true;
    try {
      let m = this.monitors.get(id);
      if (!m) return;
      const dir = this.dirOf(id);
      // 1. Bloque en proceso: ¿terminó su trabajo?
      const running = m.blocks.find((b) => b.status === 'procesando');
      if (running) {
        const job = running.jobId ? this.d.getJob(running.jobId) : undefined;
        if (job && !TERMINAL.includes(job.status)) return;
        this.finishBlock(id, running.index, job);
        m = this.monitors.get(id)!;
        if (m.status === 'detenido' || m.status === 'finalizado') {
          this.cleanupSegments(id, true);
          this.stopRuntime(id, true);
          return;
        }
      }
      if (m.status === 'pausado' || m.status === 'detenido' || m.status === 'error' || m.status === 'finalizado') return;
      // 2. Siguiente segmento completo.
      const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      const done = new Set(m.blocks.map((b) => b.index));
      const ready = completeSegments(files, rt.recorderRunning, done);
      m = this.set(id, { tempBytes: dirBytes(dir) });
      if (!ready.length) {
        if (m.status === 'finalizando' && !rt.recorderRunning) this.finalize(id);
        return;
      }
      await this.startBlock(id, ready[0], files);
    } finally {
      rt.busy = false;
    }
  }

  private async startBlock(id: string, index: number, files: string[]): Promise<void> {
    const m = this.monitors.get(id)!;
    const dir = this.dirOf(id);
    const ff = this.d.ffmpeg();
    const segName = files.find((f) => segmentIndex(f) === index)!;
    const segPath = path.join(dir, segName);
    const dur = await this.probeDuration(segPath);
    const bytes = fs.statSync(segPath).size;
    const startSec = m.recordedSec;
    const prev = files.find((f) => segmentIndex(f) === index - 1);
    const win = blockWindow(index, startSec, dur, m.settings.overlapSec, !!prev);
    const hash = blockHash(index, bytes, dur);
    // Un segmento demasiado corto (p. ej. el último trozo) se registra pero no se procesa.
    if (dur < m.settings.preset + 2 || !ff) {
      this.set(id, { recordedSec: startSec + dur, blocks: [...m.blocks, { index, startSec, endSec: startSec + dur, hash, status: 'omitido', clips: 0, error: dur < m.settings.preset + 2 ? 'Segmento demasiado corto para un clip.' : 'Falta FFmpeg.' }] });
      return;
    }
    // Bloque = últimos segundos del segmento anterior + este segmento (concat sin recodificar).
    const blockFile = path.join(dir, `block_${String(index).padStart(5, '0')}.mp4`);
    const list = path.join(dir, `block_${index}.txt`);
    const lines = [];
    if (prev && win.overlap > 0) {
      const prevDur = await this.probeDuration(path.join(dir, prev));
      lines.push(`file '${prev}'`, `inpoint ${Math.max(0, prevDur - win.overlap).toFixed(2)}`);
    }
    lines.push(`file '${segName}'`);
    fs.writeFileSync(list, lines.join('\n'), 'utf8');
    const r = await this.run(ff, ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', path.basename(list), '-c', 'copy', '-movflags', '+faststart', path.basename(blockFile)], { cwd: dir, timeoutMs: 10 * 60_000 });
    fs.rmSync(list, { force: true });
    if (r.code !== 0 || !fs.existsSync(blockFile)) {
      this.set(id, { recordedSec: startSec + dur, blocks: [...m.blocks, { index, startSec, endSec: startSec + dur, hash, status: 'error', clips: 0, error: 'No se pudo preparar el bloque.' }] });
      return;
    }
    // Pausado o detenido mientras se preparaba el bloque: no se encola (el segmento se procesará al reanudar).
    const cur = this.monitors.get(id);
    if (!cur || cur.status === 'pausado' || cur.status === 'detenido' || cur.status === 'error' || cur.blocks.some((b) => b.index === index)) {
      fs.rmSync(blockFile, { force: true });
      return;
    }
    try {
      const job = await this.d.enqueueBlock(cur, blockFile, index, win.from);
      const now = this.monitors.get(id)!;
      this.set(id, { status: now.status === 'en-directo' ? 'procesando' : now.status, recordedSec: startSec + dur, blocks: [...now.blocks, { index, startSec, endSec: startSec + dur, hash, status: 'procesando', jobId: job.id, clips: 0 }] });
    } catch (e) {
      // La cola está llena o hay una tarea pesada: se reintenta en el siguiente ciclo (no se pierde el segmento).
      fs.rmSync(blockFile, { force: true });
      this.d.log('directo: bloque aplazado', { id, index, error: (e as Error).message });
    }
  }

  private finishBlock(id: string, index: number, job: Job | undefined): void {
    const m = this.monitors.get(id)!;
    const rt = this.runtime(id);
    const b = m.blocks.find((x) => x.index === index)!;
    let kept = 0;
    let dups = 0;
    if (job?.status === 'completed') {
      const offset = job.live?.offsetSec ?? b.startSec;
      const abs = job.clips.map((c) => ({ id: c.id, start: offset + c.start, end: offset + c.end, title: c.title }));
      const { keep, duplicates } = dedupeClips(abs, rt.absClips);
      if (duplicates.length) this.d.removeClips(job.id, duplicates.map((d) => d.id));
      rt.absClips.push(...keep);
      kept = keep.length;
      dups = duplicates.length;
    }
    const blocks = m.blocks.map((x) => (x.index === index ? { ...x, status: job?.status === 'completed' ? ('procesado' as const) : ('error' as const), clips: kept, error: job?.status === 'completed' ? undefined : job?.error ?? 'El trabajo del bloque no terminó.' } : x));
    this.set(id, {
      blocks,
      status: m.status === 'procesando' ? 'en-directo' : m.status,
      clipsGenerated: m.clipsGenerated + kept,
      duplicatesSkipped: m.duplicatesSkipped + dups,
      lastProcessedSec: Math.max(m.lastProcessedSec, b.endSec),
    });
    this.d.log('directo: bloque procesado', { id, index, clips: kept, duplicados: dups });
    this.cleanupSegments(id, false, index);
  }

  /** Borra temporales ya procesados: el bloque y los segmentos anteriores al último (que hace falta para el solape). */
  private cleanupSegments(id: string, all: boolean, lastDone?: number): void {
    const m = this.monitors.get(id);
    if (!m) return;
    const dir = this.dirOf(id);
    if (!fs.existsSync(dir)) return;
    let freed = 0;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      const seg = segmentIndex(f);
      const isBlock = /^block_\d{5}\.mp4$/.test(f);
      const processed = seg !== null && m.blocks.some((b) => b.index === seg && b.status !== 'en-cola' && b.status !== 'procesando');
      const removable = isBlock ? all || (lastDone !== undefined && f === `block_${String(lastDone).padStart(5, '0')}.mp4`) : seg !== null && (all || (processed && lastDone !== undefined && seg < lastDone));
      if (!removable || (m.settings.keepSegments && !isBlock)) continue;
      // Un bloque cuyo trabajo sigue en cola o en proceso aún se necesita (el trabajo lo enlaza al empezar).
      if (isBlock) {
        const b = m.blocks.find((x) => f === `block_${String(x.index).padStart(5, '0')}.mp4`);
        const job = b?.jobId ? this.d.getJob(b.jobId) : undefined;
        if (job && !TERMINAL.includes(job.status)) continue;
      }
      try {
        freed += fs.statSync(full).size;
        fs.rmSync(full, { force: true });
      } catch {
        /* se reintenta en el siguiente ciclo */
      }
    }
    if (freed) this.set(id, { freedBytes: m.freedBytes + freed, tempBytes: dirBytes(dir) });
  }

  private finalize(id: string): void {
    this.stopRuntime(id, true);
    this.cleanupSegments(id, true);
    const m = this.monitors.get(id)!;
    this.set(id, { status: 'finalizado', finishedAt: new Date().toISOString(), notice: `Directo terminado: ${m.blocks.filter((b) => b.status === 'procesado').length} bloques procesados y ${m.clipsGenerated} clips generados.` });
    this.d.log('directo: finalizado', { id, bloques: m.blocks.length, clips: m.clipsGenerated, liberado: m.freedBytes });
  }
}

/** Siguiente índice de segmento: después de lo guardado, de lo que hay en disco y de los bloques ya registrados. */
export function nextSegmentIndex(m: Pick<LiveMonitor, 'nextSegment' | 'blocks'>, files: string[]): number {
  const onDisk = files.map(segmentIndex).filter((n): n is number => n !== null);
  return Math.max(m.nextSegment, ...onDisk.map((n) => n + 1), ...m.blocks.map((b) => b.index + 1));
}

function dirBytes(dir: string): number {
  try {
    return fs.readdirSync(dir).reduce((a, f) => a + (fs.statSync(path.join(dir, f)).size || 0), 0);
  } catch {
    return 0;
  }
}
