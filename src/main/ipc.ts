import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import type { ClipPatch, GpuInfo, Job, Settings } from '../shared/types';
import { MAX_CLIPS } from '../shared/types';
import { UserFacingError } from '../shared/validation';
import { clipPatchSchema, previewRangeSchema, createJobSchema, idSchema, layoutIdSchema, modelNameSchema, normRectSchema, probeUrlSchema, renameClipSchema, rendererSettingsPatchSchema } from './ipcSchemas';
import { readSourceInfo } from './source';
import { isInside } from './paths';
import { log } from './logger';
import { runDiagnostics, type ResolvedTools } from './deps';
import { benchmarkModel, listModels, pullModel, unloadModel } from './ollama';
import { renderClip, renderPreview, type RenderEnv } from './clipRender';
import { applyClipPatch, renderedState } from '../shared/clipEdit';
import { NEEDS_CAM } from '../shared/layouts';
import { parseWhisperJson, type Word } from './media';
import { event } from './logger';

const TERMINAL = ['completed', 'cancelled', 'failed'];
/** Trabajos con un re-render individual en curso (uno por trabajo a la vez). */
const rerendering = new Set<string>();

/** Entorno de render de un trabajo terminado: exige el vídeo original, la transcripción y las dimensiones. */
function renderEnvFor(ctx: IpcContext, job: Job): RenderEnv {
  const dir = jobDir(ctx.jobsDir, job.id);
  const source = fs.readdirSync(dir).find((f) => /^source[.](mp4|mkv|webm|mov)$/i.test(f));
  if (!source) throw new UserFacingError('El vídeo original ya no está (se borró en la limpieza): no se puede volver a renderizar. Desactiva «Borrar el vídeo original» para próximos trabajos.');
  if (!job.sourceVideo) throw new UserFacingError('Este trabajo se creó con una versión anterior y no admite re-render.');
  const tFile = path.join(dir, 'transcript.json');
  if (!fs.existsSync(tFile)) throw new UserFacingError('Falta la transcripción del trabajo: no se pueden generar los subtítulos.');
  const ffmpeg = ctx.tools().ffmpeg;
  if (!ffmpeg) throw new UserFacingError('Falta FFmpeg. Revisa Configuración → Diagnóstico.');
  const { words } = parseWhisperJson(fs.readFileSync(tFile, 'utf8'));
  const s = ctx.settings.get();
  return {
    ffmpeg,
    clipsDir: path.join(dir, 'clips'),
    sourcePath: path.join(dir, source),
    srcW: job.sourceVideo.width,
    srcH: job.sourceVideo.height,
    words: words as Word[],
    settings: { cropOffsetX: s.cropOffsetX, subtitleFontSize: s.subtitleFontSize },
  };
}
import { CancelledError } from './proc';

let pullCtrl: AbortController | null = null;
let benchCtrl: AbortController | null = null;
let benchRun: Promise<void> | null = null;
let benchModel: string | null = null;
import type { JobQueue } from './queue';
import type { JobStore, SettingsStore } from './store';
import { jobDir } from './pipeline';

export interface IpcContext {
  jobsDir: string;
  isTrustedSender: (url: string) => boolean;
  settings: SettingsStore;
  jobs: JobStore;
  queue: JobQueue;
  tools: () => ResolvedTools;
  gpuInfo: (refresh?: boolean) => Promise<GpuInfo>;
  onSettingsChanged: () => void;
}

const MAX_ACTIVE_JOBS = 10;

/** Convierte errores en mensajes amigables; el detalle técnico sólo va al log. */
function wrap<A extends unknown[], R>(ctx: IpcContext, channel: string, fn: (...args: A) => Promise<R> | R) {
  return async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<R> => {
    const url = event.senderFrame?.url ?? '';
    if (!ctx.isTrustedSender(url)) {
      log.warn(`IPC rechazado desde origen no confiable en ${channel}`);
      throw new Error('Origen no autorizado');
    }
    try {
      return await fn(...(args as A));
    } catch (e) {
      if (e instanceof UserFacingError) throw new Error(e.message);
      if (e && typeof e === 'object' && 'issues' in e) {
        const issues = (e as { issues: { message: string }[] }).issues;
        throw new Error(issues.map((i) => i.message).join(' '));
      }
      log.error(`IPC ${channel} falló`, e);
      throw new Error('Ocurrió un error inesperado. Consulta los logs.');
    }
  };
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

export function emitJob(job: Job): void {
  broadcast('job:update', job);
}

function requireJob(ctx: IpcContext, id: unknown): Job {
  const job = ctx.jobs.get(idSchema.parse(id));
  if (!job) throw new UserFacingError('El trabajo no existe.');
  return job;
}

function uniquePath(dir: string, file: string): string {
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  let p = path.join(dir, file);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

function exportOne(ctx: IpcContext, job: Job, clipId: string): string {
  const clip = job.clips.find((c) => c.id === clipId);
  if (!clip?.file) throw new UserFacingError('El clip no está renderizado.');
  if (clip.dirty) throw new UserFacingError(`El clip ${clip.index} tiene cambios sin renderizar: vuelve a renderizarlo antes de exportarlo.`);
  const clipsDir = path.join(jobDir(ctx.jobsDir, job.id), 'clips');
  const src = path.join(clipsDir, clip.file);
  if (!isInside(clipsDir, src) || !fs.existsSync(src)) throw new UserFacingError('No se encuentra el archivo del clip.');
  const exportDir = ctx.settings.get().exportDir;
  fs.mkdirSync(exportDir, { recursive: true });
  const dest = uniquePath(exportDir, clip.file);
  fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL); // nunca sobrescribe archivos del usuario
  clip.exportedPath = dest;
  ctx.jobs.put(job);
  return dest;
}

export function registerIpc(ctx: IpcContext): void {
  const h = <A extends unknown[], R>(ch: string, fn: (...a: A) => Promise<R> | R) => ipcMain.handle(ch, wrap(ctx, ch, fn));

  h('deps:check', async () => {
    const gpu = await ctx.gpuInfo(true);
    const d = await runDiagnostics(ctx.tools(), ctx.settings.get(), undefined, gpu);
    return { ...d, gpu };
  });
  h('source:probe', async (url: unknown) => {
    const u = probeUrlSchema.parse(url);
    const yt = ctx.tools().ytDlp;
    if (!yt) throw new UserFacingError('Falta yt-dlp. Revisa Configuración → Diagnóstico.');
    const s = ctx.settings.get();
    const info = await readSourceInfo(yt, u, s);
    // preset no se conoce aquí: el renderer calcula el máximo factible con la duración.
    return { title: info.title, duration: info.duration, feasibleMax: 0, filesizeBytes: info.filesize };
  });
  h('settings:get', () => ctx.settings.get());
  h('settings:update', (patch: unknown) => {
    const valid = rendererSettingsPatchSchema.parse(patch) as Partial<Settings>;
    const s = ctx.settings.update(valid);
    ctx.onSettingsChanged();
    return s;
  });
  h('settings:chooseExportDir', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const opts = { title: 'Carpeta de exportación', defaultPath: ctx.settings.get().exportDir, properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths[0]) return null;
    ctx.settings.update({ exportDir: r.filePaths[0] });
    return r.filePaths[0];
  });
  h('ollama:list', () => listModels(ctx.settings.get().ollamaHost).catch(() => [] as string[]));
  h('ollama:pull', async (name: unknown) => {
    const model = modelNameSchema.parse(name);
    if (pullCtrl) throw new UserFacingError('Ya hay una descarga de modelo en curso.');
    pullCtrl = new AbortController();
    try {
      await pullModel(ctx.settings.get().ollamaHost, model, (p) => broadcast('ollama:pullProgress', p), pullCtrl.signal);
      broadcast('ollama:pullProgress', { model, status: 'success', done: true });
    } catch (e) {
      if (pullCtrl?.signal.aborted) {
        broadcast('ollama:pullProgress', { model, status: 'cancelled', done: true, error: 'Descarga cancelada. Ollama conserva lo descargado y la reanuda si vuelves a intentarlo.' });
        return;
      }
      const msg = e instanceof UserFacingError ? e.message : 'No se pudo descargar el modelo. ¿Está Ollama abierto?';
      log.error('pull falló', e);
      broadcast('ollama:pullProgress', { model, status: 'error', done: true, error: msg });
      throw new UserFacingError(msg);
    } finally {
      pullCtrl = null;
    }
  });
  h('ollama:pullCancel', () => {
    pullCtrl?.abort();
  });
  h('ollama:benchmark', async (name: unknown) => {
    const model = modelNameSchema.parse(name);
    // No compite con un trabajo en curso por la GPU: se espera a que termine.
    if (ctx.queue.activeCount > 0) throw new UserFacingError('Hay un trabajo en curso; ejecuta el benchmark cuando termine.');
    if (benchCtrl) throw new UserFacingError('Ya hay un benchmark en curso.');
    benchCtrl = new AbortController();
    benchModel = model;
    const run = benchmarkModel(ctx.settings.get().ollamaHost, model, benchCtrl.signal);
    benchRun = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      const r = await run;
      ctx.settings.update({ benchmarks: { ...(ctx.settings.get().benchmarks ?? {}), [model]: r } });
      return r;
    } catch (e) {
      if (e instanceof CancelledError) throw new UserFacingError('Benchmark cancelado: se ha iniciado un trabajo.');
      throw e;
    } finally {
      benchCtrl = null;
      benchRun = null;
      benchModel = null;
    }
  });

  h('jobs:create', async (req: unknown) => {
    const r = createJobSchema.parse(req);
    // Un trabajo tiene prioridad: se cancela el benchmark y se espera a que suelte la GPU antes de encolar.
    if (benchCtrl) {
      const benched = benchModel;
      benchCtrl.abort();
      await benchRun;
      // Al cancelar a mitad, Ollama puede seguir teniendo el modelo en VRAM: se libera explícitamente.
      if (benched) await unloadModel(ctx.settings.get().ollamaHost, benched);
    }
    if (ctx.queue.activeCount >= MAX_ACTIVE_JOBS) throw new UserFacingError('Hay demasiados trabajos en cola. Espera a que terminen.');
    const now = new Date().toISOString();
    const job: Job = {
      id: randomUUID(),
      url: r.url,
      preset: r.preset,
      maxClips: Math.min(r.maxClips, MAX_CLIPS),
      allowModelDownload: r.allowModelDownload === true,
      status: 'queued',
      progress: 0,
      message: 'En cola',
      clips: [],
      createdAt: now,
      updatedAt: now,
    };
    ctx.jobs.put(job);
    ctx.queue.enqueue(job.id);
    emitJob(job);
    return job;
  });
  h('jobs:list', () => ctx.jobs.list());
  h('jobs:cancel', (id: unknown) => {
    const job = requireJob(ctx, id);
    ctx.queue.cancel(job.id);
  });
  h('jobs:delete', async (id: unknown) => {
    const job = requireJob(ctx, id);
    if (!['completed', 'cancelled', 'failed'].includes(job.status)) throw new UserFacingError('Cancela el trabajo antes de borrarlo.');
    const win = BrowserWindow.getFocusedWindow();
    const opts = {
      type: 'warning' as const,
      buttons: ['Cancelar', 'Borrar'],
      defaultId: 0,
      cancelId: 0,
      title: 'Borrar trabajo',
      message: '¿Borrar este trabajo del historial?',
      detail: 'Se eliminarán el vídeo descargado, la transcripción y los clips de la carpeta interna de la app. Los clips ya exportados no se tocarán.',
    };
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    if (r.response !== 1) return false;
    const dir = jobDir(ctx.jobsDir, job.id);
    if (isInside(ctx.jobsDir, dir) && dir !== path.resolve(ctx.jobsDir)) fs.rmSync(dir, { recursive: true, force: true });
    ctx.jobs.delete(job.id);
    return true;
  });
  h('clips:rename', (...args: unknown[]) => {
    const [jobId, clipId, title] = renameClipSchema.parse(args);
    const job = requireJob(ctx, jobId);
    const clip = job.clips.find((c) => c.id === clipId);
    if (!clip) throw new UserFacingError('El clip no existe.');
    clip.title = title.replace(/[\u0000-\u001f]/g, ' ');
    ctx.jobs.put(job);
    emitJob(job);
    return job;
  });
  h('clips:update', (jobId: unknown, clipId: unknown, patch: unknown) => {
    const job = requireJob(ctx, jobId);
    const id = idSchema.parse(clipId);
    const p = clipPatchSchema.parse(patch) as ClipPatch;
    if (!TERMINAL.includes(job.status)) throw new UserFacingError('Espera a que el trabajo termine para editar sus clips.');
    // Mientras se re-renderiza un clip del trabajo no se aceptan cambios (evita perder el resultado del render).
    if (rerendering.has(job.id)) throw new UserFacingError('Se está volviendo a renderizar un clip de este trabajo; espera a que termine.');
    const next = applyClipPatch(id, p, { clips: job.clips, preset: job.preset, sourceDuration: job.sourceDuration ?? 0 });
    // Un cambio que exige re-render sólo se guarda si se puede renderizar (vídeo original, transcripción…);
    // así nunca queda un clip marcado como pendiente sin forma de resolverlo. Los cambios de título/hook siempre se permiten.
    const prev = job.clips.find((c) => c.id === id);
    if (next.dirty && !prev?.dirty) renderEnvFor(ctx, job);
    job.clips = job.clips.map((c) => (c.id === id ? next : c));
    ctx.jobs.put(job);
    emitJob(job);
    return job;
  });
  h('clips:rerender', async (jobId: unknown, clipId: unknown) => {
    const job = requireJob(ctx, jobId);
    const id = idSchema.parse(clipId);
    const clip = job.clips.find((c) => c.id === id);
    if (!clip) throw new UserFacingError('El clip no existe.');
    if (job.status !== 'completed') throw new UserFacingError('Sólo se pueden re-renderizar clips de trabajos completados.');
    if (rerendering.has(job.id)) throw new UserFacingError('Ya se está re-renderizando un clip de este trabajo.');
    const env = renderEnvFor(ctx, job);
    rerendering.add(job.id);
    try {
      const file = await renderClip({ ...clip }, env);
      // Se aplica sobre el clip vigente del trabajo guardado (no sobre una copia antigua).
      const current = ctx.jobs.get(job.id) ?? job;
      const target = current.clips.find((c) => c.id === id);
      if (!target) throw new UserFacingError('El clip ya no existe.');
      target.file = file;
      target.dirty = false;
      target.rendered = renderedState({ ...clip });
      target.exportedPath = undefined; // la exportación anterior ya no corresponde al clip actual
      ctx.jobs.put(current);
      emitJob(current);
      event('clip_rerender', { job: current.id, clip: target.index, layout: target.layout });
      return current;
    } finally {
      rerendering.delete(job.id);
    }
  });
  h('clips:preview', async (jobId: unknown, clipId: unknown, layout: unknown, camRect: unknown, range: unknown) => {
    const job = requireJob(ctx, jobId);
    const id = idSchema.parse(clipId);
    const clip = job.clips.find((c) => c.id === id);
    if (!clip) throw new UserFacingError('El clip no existe.');
    const l = layoutIdSchema.parse(layout);
    const cam = camRect == null ? undefined : normRectSchema.parse(camRect);
    if (NEEDS_CAM.includes(l) && !cam) throw new UserFacingError('Este layout necesita la posición de la facecam.');
    // Rango en edición (sin guardar): se valida igual que al guardar para previsualizar lo que se renderizará.
    const r = range == null ? null : previewRangeSchema.parse(range);
    const draft = r ? applyClipPatch(id, { start: r.start, end: r.end }, { clips: job.clips, preset: job.preset, sourceDuration: job.sourceDuration ?? 0 }) : clip;
    const env = renderEnvFor(ctx, job);
    const name = `${String(clip.index).padStart(2, '0')}_preview_${l}.jpg`;
    return renderPreview(env, { ...clip, start: draft.start, end: draft.end, layout: l, camRect: cam }, path.join(jobDir(ctx.jobsDir, job.id), 'frames'), name);
  });
  h('clips:export', (jobId: unknown, clipId: unknown) => {
    const job = requireJob(ctx, jobId);
    const p = exportOne(ctx, job, idSchema.parse(clipId));
    emitJob(job);
    return p;
  });
  h('clips:exportAll', (jobId: unknown) => {
    const job = requireJob(ctx, jobId);
    let n = 0;
    // Los clips con cambios sin renderizar no se exportan (serían una versión antigua).
    for (const c of job.clips) if (c.file && !c.dirty) (exportOne(ctx, job, c.id), n++);
    emitJob(job);
    return n;
  });
  h('shell:openJobFolder', async (jobId: unknown) => {
    const job = requireJob(ctx, jobId);
    const dir = path.join(jobDir(ctx.jobsDir, job.id), 'clips');
    if (!isInside(ctx.jobsDir, dir) || !fs.existsSync(dir)) throw new UserFacingError('La carpeta no existe.');
    await shell.openPath(dir);
  });
  h('shell:openExportFolder', async () => {
    const dir = ctx.settings.get().exportDir;
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
  });
}
