import fs from 'node:fs';
import { z } from 'zod';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import type { ClipPatch, GpuInfo, GpuSetupInfo, Job, Settings } from '../shared/types';
import { MAX_CLIPS } from '../shared/types';
import { UserFacingError, validateVideoUrl } from '../shared/validation';
import { compositionSchema, platformSchema, publishMetaSchema, publishStatusSchema, publishUrlSchema } from './ipcSchemas';
import { cleanupOptionsSchema, clipPatchSchema, previewRangeSchema, createJobSchema, idSchema, layoutIdSchema, modelNameSchema, normRectSchema, probeUrlSchema, renameClipSchema, rendererSettingsPatchSchema } from './ipcSchemas';
import { readSourceInfo } from './source';
import { isInside } from './paths';
import { log } from './logger';
import { runDiagnostics, type ResolvedTools } from './deps';
import { benchmarkModel, chatJson, listModels, pullModel, unloadModel } from './ollama';
import { PublishStore } from './publishStore';
import { retranscribeJob } from './retranscribe';
import { LiveManager } from './liveMonitor';
import { retryOptions } from '../shared/jobView';
import { availability, isModelCached, selectEngine } from './transcribe';
import { compositionErrors, compositionOf } from '../shared/composition';
import { readState, runLegacyMigration, scanLegacy, writeState, type LegacyPaths } from './legacy';
import { deletePublishedExports, findPublishedExports, markExportDeleted, recoverableBytes } from './publishedExports';
import { listConnections } from './publishers';
import { PLATFORMS, PLATFORM_LABELS, applyMeta, applyStatus, copyPart, restoreVersion, type Platform } from '../shared/publish';
import { TONES, buildEditorialContext, editorialSchema, generateEditorial } from '../shared/editorial';
import { renderClip, renderPreview, type RenderEnv } from './clipRender';
import { applyClipPatch, renderedState } from '../shared/clipEdit';
import { FREE_SPACE_DEFAULTS, humanSize, type CleanupOptions, type CleanupResult, type PlannedFile } from '../shared/storage';
import { executeCleanup, planCleanup, refreshJobFlags, verifyExport } from './storageManager';
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
import { CancelledError, runProcess } from './proc';
import { runSetup, venvPython, windowsSpeech } from './gpuSetupRunner';
import { accelStatus, planSetup, type SetupState } from '../shared/gpuSetup';

let pullCtrl: AbortController | null = null;
let benchCtrl: AbortController | null = null;
let benchRun: Promise<void> | null = null;
let benchModel: string | null = null;
let setupCtrl: AbortController | null = null;
let setupState: SetupState | null = null;
import type { JobQueue } from './queue';
import type { JobStore, SettingsStore } from './store';
import { jobDir, type PipelineContext } from './pipeline';

export interface IpcContext {
  jobsDir: string;
  isTrustedSender: (url: string) => boolean;
  settings: SettingsStore;
  jobs: JobStore;
  queue: JobQueue;
  tools: () => ResolvedTools;
  gpuInfo: (refresh?: boolean) => Promise<GpuInfo>;
  onSettingsChanged: () => void;
  /** Carpeta de datos de la app (userData): aquí vive el entorno Python aislado. */
  userDataDir: string;
  logsDir: string;
  probeScript: string;
  takeStartupNotice: () => { kind: 'info' | 'error'; text: string } | null;
  publish: PublishStore;
  pipelineCtx: PipelineContext;
  legacy: LegacyPaths;
  installDir: string;
  appVersion: string;
  reloadStores: () => void;
  /** Registra una tarea de cierre (p. ej. detener grabaciones de directos). */
  onShutdown?: (fn: () => void) => void;
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

/** Palabras de la transcripción del trabajo (vacío si ya no existe). */
function transcriptWords(ctx: IpcContext, jobId: string): Word[] {
  try {
    return parseWhisperJson(fs.readFileSync(path.join(jobDir(ctx.jobsDir, jobId), 'transcript.json'), 'utf8')).words as Word[];
  } catch {
    return [];
  }
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
  if (clip.archived) throw new UserFacingError('Este clip está archivado: ya está exportado en ' + (clip.exportedPath ?? 'tu carpeta de exportación') + '.');
  if (clip.dirty) throw new UserFacingError(`El clip ${clip.index} tiene cambios sin renderizar: vuelve a renderizarlo antes de exportarlo.`);
  const clipsDir = path.join(jobDir(ctx.jobsDir, job.id), 'clips');
  const src = path.join(clipsDir, clip.file);
  if (!isInside(clipsDir, src) || !fs.existsSync(src)) throw new UserFacingError('No se encuentra el archivo del clip.');
  const exportDir = ctx.settings.get().exportDir;
  fs.mkdirSync(exportDir, { recursive: true });
  const dest = uniquePath(exportDir, clip.file);
  fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL); // nunca sobrescribe archivos del usuario
  clip.exportedPath = dest;
  clip.exportVerified = verifyExport(ctx.jobsDir, job.id, clip);
  ctx.jobs.put(job);
  return dest;
}

let cleaning = false;

function freeDiskBytes(dir: string): number | undefined {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return undefined;
  }
}

/**
 * Re-planifica en el proceso principal (nunca se fía de una lista de archivos del renderer), envía a la
 * Papelera de reciclaje y, si la Papelera falla, pide una confirmación reforzada antes de borrar definitivamente.
 */
async function cleanWith(ctx: IpcContext, o: CleanupOptions, jobId?: string, interactive = true): Promise<CleanupResult> {
  // Un trabajo con un re-render en curso sigue «completed»: se trata como activo para no tocar sus archivos.
  const jobs = ctx.jobs.list().map((j) => (rerendering.has(j.id) ? { ...j, status: 'rendering' as const } : j));
  const plan = planCleanup(jobs, ctx.jobsDir, o, {}, jobId);
  const trashFailed: PlannedFile[] = [];
  const first = await executeCleanup(plan.files, jobs, ctx.jobsDir, {
    usedTrash: true,
    remove: async (full) => {
      try {
        await shell.trashItem(full);
      } catch (e) {
        trashFailed.push(plan.files.find((f) => path.resolve(ctx.jobsDir, f.jobId, f.rel) === path.resolve(full))!);
        throw new Error(`papelera: ${(e as Error).message}`);
      }
    },
    log: (m, x) => log.info(m, x),
  });
  let result = first;
  if (trashFailed.length && interactive) {
    const bytes = trashFailed.reduce((a, f) => a + f.bytes, 0);
    const win = BrowserWindow.getFocusedWindow();
    const opts = {
      type: 'warning' as const,
      buttons: ['Cancelar', 'Borrar definitivamente'],
      defaultId: 0,
      cancelId: 0,
      title: 'No se pudo usar la Papelera',
      message: `${trashFailed.length} archivos (${humanSize(bytes)}) no se pudieron enviar a la Papelera de reciclaje.`,
      detail: 'Si continúas se borrarán definitivamente y no podrás recuperarlos. Tus clips exportados no se tocan.',
    };
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    if (r.response === 1) {
      const second = await executeCleanup(trashFailed, jobs, ctx.jobsDir, { usedTrash: false, remove: async (full) => fs.rmSync(full), log: (m, x) => log.info(m, x) });
      result = {
        freedBytes: first.freedBytes + second.freedBytes,
        deleted: first.deleted + second.deleted,
        errors: [...first.errors.filter((e) => !e.message.startsWith('papelera:')), ...second.errors],
        jobs: [...new Set([...first.jobs, ...second.jobs])],
        usedTrash: true,
      };
    }
  }
  // Indicadores del trabajo (metadatos, títulos y registro se conservan).
  const freedByJob = new Map<string, number>();
  for (const f of plan.files) if (!result.errors.some((e) => e.jobId === f.jobId && e.rel === f.rel)) freedByJob.set(f.jobId, (freedByJob.get(f.jobId) ?? 0) + f.bytes);
  for (const id of result.jobs) {
    const j = ctx.jobs.get(id);
    if (!j) continue;
    const next = refreshJobFlags(j, ctx.jobsDir, freedByJob.get(id) ?? 0);
    Object.assign(j, next);
    ctx.jobs.put(j);
    emitJob(j);
  }
  event('storage_cleanup', { jobs: result.jobs.length, deleted: result.deleted, freedBytes: result.freedBytes, errors: result.errors.length, trash: result.usedTrash, options: o });
  for (const e of result.errors.slice(0, 50)) log.error(`Limpieza: ${e.jobId}/${e.rel}: ${e.message}`);
  return result;
}

/** Políticas «hasta exportar» / «tras exportar»: se aplican cuando TODOS los clips del trabajo tienen export verificado. */
async function applyExportPolicies(ctx: IpcContext, job: Job): Promise<void> {
  const s = ctx.settings.get();
  const withFiles = job.clips.filter((c) => c.file);
  if (!withFiles.length || !withFiles.every((c) => verifyExport(ctx.jobsDir, job.id, c))) return;
  const o: CleanupOptions = { source: s.keepSource === 'hasta-exportar', audio: s.keepTemp === 'tras-exportar', frames: s.keepTemp === 'tras-exportar', temp: s.keepTemp === 'tras-exportar', transcript: false, internalClips: false };
  if (!o.source && !o.audio) return;
  await cleanWith(ctx, o, job.id, false);
}

/** Limpieza automática por antigüedad (desactivada por defecto). Sólo trabajos completados y según las políticas. */
export async function autoCleanup(ctx: IpcContext): Promise<void> {
  const s = ctx.settings.get();
  if (!s.autoCleanupDays) return;
  const limit = Date.now() - s.autoCleanupDays * 86400_000;
  for (const j of ctx.jobs.list()) {
    if (j.status !== 'completed' || Date.parse(j.updatedAt) >= limit || rerendering.has(j.id)) continue;
    // «hasta exportar» / «tras exportar» exigen que todos los clips tengan export verificado; «confirmar» nunca borra sin el usuario.
    const withFiles = j.clips.filter((c) => c.file);
    const exported = withFiles.length > 0 && withFiles.every((c) => verifyExport(ctx.jobsDir, j.id, c));
    const temps = s.keepTemp === 'tras-completar' || (s.keepTemp === 'tras-exportar' && exported);
    const o: CleanupOptions = { source: s.keepSource === 'hasta-exportar' && exported, audio: temps, frames: temps, temp: temps, transcript: !s.keepTranscript && exported, internalClips: true };
    // La elegibilidad sale de lo que queda en disco, no de los indicadores: así se reintentan fallos anteriores.
    if (!planCleanup([j], ctx.jobsDir, o, {}, j.id).files.length) continue;
    await cleanWith(ctx, o, j.id, false);
  }
}


export function registerIpc(ctx: IpcContext): void {
  const h = <A extends unknown[], R>(ch: string, fn: (...a: A) => Promise<R> | R) => ipcMain.handle(ch, wrap(ctx, ch, fn));

  // ---- Almacenamiento: «Liberar espacio» y «Limpiar temporales» ----
  h('storage:analyze', (opts: unknown, jobId: unknown) => {
    const o = cleanupOptionsSchema.parse(opts ?? FREE_SPACE_DEFAULTS) as CleanupOptions;
    const id = jobId == null ? undefined : idSchema.parse(jobId);
    const r = planCleanup(ctx.jobs.list(), ctx.jobsDir, o, {}, id);
    return { ...r, freeDiskBytes: freeDiskBytes(ctx.jobsDir) };
  });
  h('storage:clean', async (opts: unknown, jobId: unknown) => {
    const o = cleanupOptionsSchema.parse(opts) as CleanupOptions;
    const id = jobId == null ? undefined : idSchema.parse(jobId);
    if (cleaning) throw new UserFacingError('Ya hay una limpieza en curso.');
    cleaning = true;
    try {
      return await cleanWith(ctx, o, id);
    } finally {
      cleaning = false;
    }
  });

  h('app:startupNotice', () => ctx.takeStartupNotice());
  h('app:version', () => ({ version: ctx.appVersion, name: 'Clip Clip' }));

  // ---- Datos de la versión anterior («ClipsVirales»): sólo con la elección del usuario en el modal ----
  let migratingLegacy = false;
  h('legacy:scan', () => scanLegacy(ctx.legacy, ctx.userDataDir));
  h('legacy:dismiss', () => {
    writeState(ctx.userDataDir, { ...readState(ctx.userDataDir), dismissed: true });
    event('legacy_dismiss', {});
  });
  h('legacy:migrate', async (mode: unknown) => {
    const m = z.enum(['keep', 'free']).parse(mode);
    if (migratingLegacy) throw new UserFacingError('Ya hay una migración en curso.');
    if (ctx.queue.activeCount > 0) throw new UserFacingError('Espera a que terminen los trabajos en curso antes de migrar.');
    migratingLegacy = true;
    try {
      ctx.jobs.flush();
      const s = ctx.settings.get();
      const res = await runLegacyMigration(m, ctx.legacy, {
        userData: ctx.userDataDir,
        installDir: ctx.installDir,
        exportDir: s.exportDir,
        inUse: [s.pythonPath, s.whisperPath, s.gpuVerifiedPython ?? '', s.ffmpegPath, s.ffprobePath, s.ytDlpPath].filter(Boolean),
      }, { trash: (p) => shell.trashItem(p), afterMigrate: () => ctx.reloadStores(), log: (msg, x) => (log.info(msg, x), event('legacy', { msg, ...(x as object) })) });
      writeState(ctx.userDataDir, { ...readState(ctx.userDataDir), lastResult: res, dismissed: true });
      return res;
    } finally {
      migratingLegacy = false;
    }
  });
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
    if (isInside(ctx.jobsDir, r.filePaths[0]) || isInside(r.filePaths[0], ctx.jobsDir)) throw new UserFacingError('La carpeta de exportación no puede estar dentro de los datos internos de la app.');
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
    if (ctx.queue.activeCount > 0 || retranscribing) throw new UserFacingError('Hay un trabajo o una transcripción en curso; ejecuta el benchmark cuando termine.');
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

  // ---- Aceleración GPU guiada (entorno aislado en userData) ----
  const venvDir = () => path.join(ctx.userDataDir, 'python-env');
  const freeGB = () => {
    try {
      const st = fs.statfsSync(ctx.userDataDir);
      return (st.bavail * st.bsize) / 1024 ** 3;
    } catch {
      return 0;
    }
  };
  const setupInfo = async (): Promise<GpuSetupInfo> => {
    const gpu = await ctx.gpuInfo(true);
    const s = ctx.settings.get();
    const appPy = venvPython(venvDir());
    const usingAppEnv = !!gpu.pythonPath && path.resolve(gpu.pythonPath) === path.resolve(appPy);
    const plan = planSetup({
      nvidiaGpu: gpu.nvidiaGpu,
      python: gpu.pythonPath,
      pythonVersion: gpu.python,
      venvDir: venvDir(),
      freeGB: freeGB(),
      tinyCached: gpu.cachedModels.openai.includes('tiny.pt'),
    });
    const status = accelStatus({
      nvidiaGpu: gpu.nvidiaGpu,
      cudaAvailable: gpu.cudaAvailable,
      verifiedPython: s.gpuVerifiedPython ?? null,
      currentPython: gpu.pythonPath,
      running: !!setupCtrl,
      // Una cancelación no es un fallo: no invalida una verificación anterior.
      lastError: setupState && !setupState.ok && !setupState.running && !setupState.cancelled ? setupState.error : undefined,
    });
    return { plan, state: setupState, status, verifiedPython: s.gpuVerifiedPython ?? null, currentPython: gpu.pythonPath, usingAppEnv, engine: s.transcriptionEngine };
  };
  h('gpu:setupInfo', () => setupInfo());
  h('gpu:setupStart', async (mode: unknown) => {
    const m = mode === 'verify' ? 'verify' : 'install';
    if (setupCtrl) throw new UserFacingError('Ya hay una instalación o verificación en curso.');
    if (ctx.queue.activeCount > 0 || retranscribing) throw new UserFacingError('Hay un trabajo o una transcripción en curso; espera a que termine para usar la GPU.');
    // El bloqueo se reserva antes de cualquier await: dos peticiones simultáneas no pueden arrancar a la vez.
    const ctrl = new AbortController();
    setupCtrl = ctrl;
    let info: GpuSetupInfo;
    let gpu: GpuInfo;
    try {
      info = await setupInfo();
      if (m === 'install' && !info.plan.compatible) throw new UserFacingError(info.plan.reason ?? 'Este equipo no es compatible.');
      if (!info.currentPython) throw new UserFacingError('No se encontró Python.');
      gpu = await ctx.gpuInfo();
      if (ctrl.signal.aborted) throw new UserFacingError('Cancelado.');
    } catch (e) {
      if (setupCtrl === ctrl) setupCtrl = null;
      throw e;
    }
    const workDir = path.join(ctx.userDataDir, 'gpu-setup');
    // En segundo plano: el progreso llega por «gpu:setupProgress».
    void runSetup(
      m,
      {
        run: runProcess,
        python: info.currentPython,
        venvDir: venvDir(),
        probeScript: ctx.probeScript,
        workDir,
        logFile: path.join(ctx.logsDir, 'gpu-setup.log'),
        gpuName: gpu.nvidiaGpu,
        onState: (st) => {
          setupState = st;
          // El estado final se emite en «finally», cuando los ajustes (Python verificado) ya están guardados.
          if (st.running) broadcast('gpu:setupProgress', st);
        },
        makeSpeech: windowsSpeech(workDir),
      },
      ctrl.signal,
    )
      .then((st) => {
        if (st.ok) {
          const py = m === 'install' ? venvPython(venvDir()) : info.currentPython!;
          ctx.settings.update({ pythonPath: py, gpuVerifiedPython: py, transcriptionEngine: 'auto' });
          ctx.onSettingsChanged();
        } else if (!st.cancelled) {
          // La última prueba real manda: si falla, la verificación anterior deja de valer.
          ctx.settings.update({ gpuVerifiedPython: undefined });
          ctx.onSettingsChanged();
        }
        event('gpu_setup', { mode: m, ok: st.ok, cancelled: st.cancelled, error: st.error });
      })
      .catch((e) => log.error('gpu setup', e))
      .finally(() => {
        if (setupCtrl === ctrl) setupCtrl = null;
        if (setupState) broadcast('gpu:setupProgress', setupState);
      });
  });
  h('gpu:setupCancel', () => {
    setupCtrl?.abort();
  });
  // Volver a CPU sin romper nada.
  h('gpu:useCpu', () => {
    ctx.settings.update({ transcriptionEngine: 'openai-whisper-cpu' });
    ctx.onSettingsChanged();
  });
  h('gpu:useSystemPython', () => {
    ctx.settings.update({ pythonPath: '', gpuVerifiedPython: undefined });
    ctx.onSettingsChanged();
  });

  h('jobs:create', async (req: unknown) => enqueueJob(createJobSchema.parse(req)));
  // Reintentar = trabajo nuevo con la misma URL, duración y meta (el original se conserva en el historial).
  let retranscribing = false;
  let retranscribeCtrl: AbortController | null = null;
  // Al cerrar la app se aborta la retranscripción (sin procesos de Whisper huérfanos).
  ctx.onShutdown?.(() => retranscribeCtrl?.abort());
  h('jobs:retranscribe', async (id: unknown) => {
    const job = requireJob(ctx, id);
    if (job.status !== 'completed') throw new UserFacingError('Sólo se puede volver a transcribir un trabajo completado.');
    // Una sola inferencia pesada a la vez (GPUs de 6 GB): ni con trabajos en curso ni con otra retranscripción.
    if (retranscribing || ctx.queue.activeCount > 0) throw new UserFacingError('Hay otra transcripción o trabajo en curso; espera a que termine.');
    if (rerendering.has(job.id)) throw new UserFacingError('Se está renderizando un clip de este trabajo; espera a que termine.');
    if (cleaning) throw new UserFacingError('Hay una limpieza de almacenamiento en curso; espera a que termine.');
    if (setupCtrl) throw new UserFacingError('Se está instalando o verificando la aceleración GPU. Espera a que termine.');
    if (generating) throw new UserFacingError('Se están generando textos de publicación con la IA; espera a que termine.');
    retranscribing = true;
    // Como al encolar un trabajo: el benchmark se cancela y se espera a que suelte la GPU.
    if (benchCtrl) {
      const benched = benchModel;
      benchCtrl.abort();
      await benchRun;
      if (benched) await unloadModel(ctx.settings.get().ollamaHost, benched);
    }
    // Mientras tanto el trabajo cuenta como ocupado: «Liberar espacio» no toca su vídeo ni su audio y no se edita.
    rerendering.add(job.id);
    try {
      const r = await retranscribeJob(job, ctx.pipelineCtx, ctx.settings.get(), ctx.tools(), await ctx.gpuInfo(true), (retranscribeCtrl = new AbortController()).signal, (m) => emitJob({ ...job, message: m }));
      const cur = ctx.jobs.get(job.id) ?? job;
      const next = { ...cur, clips: r.job.clips, metrics: r.job.metrics, message: `Transcripción rehecha (${r.model}, ${r.device === 'cuda' ? 'GPU' : 'CPU'}, idioma ${r.language || 'auto'}). Vuelve a renderizar los clips para aplicar los subtítulos.` };
      ctx.jobs.put(next);
      emitJob(next);
      event('retranscribe', { job: job.id, model: r.model, device: r.device, words: r.words });
      return next;
    } finally {
      retranscribing = false;
      retranscribeCtrl = null;
      rerendering.delete(job.id);
    }
  });
  // ---- Directos: monitor persistente; cada bloque es un trabajo normal con vídeo local ----
  const live = new LiveManager({
    dataDir: path.join(ctx.userDataDir, 'data'),
    liveDir: path.join(ctx.userDataDir, 'live'),
    ytDlp: () => ctx.tools().ytDlp,
    ffmpeg: () => ctx.tools().ffmpeg,
    ffprobe: () => ctx.tools().ffprobe,
    enqueueBlock: (m, file, block, offsetSec) =>
      enqueueJob(
        { url: m.url, preset: m.settings.preset, maxClips: m.settings.maxClipsPerBlock, allowModelDownload: false },
        { localSource: file, live: { monitorId: m.id, block, offsetSec }, sourceTitle: `${m.title ?? 'Directo'} · bloque ${block + 1}` },
        // El trabajo es dueño de su vídeo desde que se encola: el monitor ya puede borrar su bloque sin romper reintentos.
        (dir) => {
          const dst = path.join(dir, `source${path.extname(file) || '.mp4'}`);
          try {
            fs.linkSync(file, dst);
          } catch {
            fs.copyFileSync(file, dst);
          }
        },
      ),
    getJob: (id) => ctx.jobs.get(id),
    removeClips: (jobId, ids) => {
      const job = ctx.jobs.get(jobId);
      if (!job) return;
      const dir = path.join(jobDir(ctx.jobsDir, jobId), 'clips');
      for (const c of job.clips.filter((x) => ids.includes(x.id))) if (c.file && !c.exportedPath) fs.rmSync(path.join(dir, c.file), { force: true });
      const next = { ...job, clips: job.clips.filter((c) => !ids.includes(c.id) || !!c.exportedPath) };
      ctx.jobs.put(next);
      emitJob(next);
    },
    onChange: (m) => broadcast('live:update', m),
    // Antes de grabar: debe haber motor de transcripción y su modelo descargado (los bloques no descargan modelos).
    preflight: async () => {
      const s = ctx.settings.get();
      const gpu = await ctx.gpuInfo(false);
      const plan = selectEngine({ choice: s.transcriptionEngine, model: s.whisperModel, precision: s.whisperPrecision, vramMB: gpu.vramMB, gpuName: gpu.nvidiaGpu, avail: availability(gpu, !!ctx.tools().whisper) });
      if (!plan) return 'No hay ningún motor de transcripción disponible para procesar el directo.';
      if (!isModelCached(plan.engine, plan.model, gpu)) return `El modelo de Whisper «${plan.model}» no está descargado y los bloques del directo no lo descargan. Descárgalo en Configuración → Modelos.`;
      return null;
    },
    log: (msg, x) => (log.info(msg, x), event('live', { msg, ...(x as object) })),
  });
  ctx.onShutdown?.(() => live.shutdown());
  h('live:list', () => live.list());
  h('live:create', (url: unknown, settings: unknown, ack: unknown) => {
    const u = validateVideoUrl(url);
    const st = z.object({ blockSec: z.number().optional(), overlapSec: z.number().optional(), preset: z.number().optional(), maxClipsPerBlock: z.number().optional(), pollSec: z.number().optional(), keepSegments: z.boolean().optional() }).strict().parse(settings ?? {});
    try {
      return live.create(u, st as never, ack === true);
    } catch (e) {
      throw e instanceof UserFacingError ? e : new UserFacingError((e as Error).message);
    }
  });
  h('live:pause', (id: unknown) => live.pause(idSchema.parse(id)));
  h('live:resume', (id: unknown) => live.resume(idSchema.parse(id)));
  h('live:stop', (id: unknown) => live.stop(idSchema.parse(id)));
  h('live:remove', (id: unknown) => live.remove(idSchema.parse(id)));
  h('live:retryBlock', (id: unknown, index: unknown) => live.retryBlock(idSchema.parse(id), z.number().int().min(0).max(1_000_000).parse(index)));

  // Reintentar desde un paso: el trabajo nuevo reutiliza (enlace duro o copia) lo ya producido antes de ese paso.
  h('jobs:retryFrom', async (id: unknown, stage: unknown) => {
    const prev = requireJob(ctx, id);
    if (!TERMINAL.includes(prev.status)) throw new UserFacingError('El trabajo sigue en curso.');
    return retryFromStage(prev, z.enum(['validating', 'downloading', 'extractingAudio', 'transcribing', 'analyzing', 'rendering']).parse(stage));
  });
  async function retryFromStage(prev: Job, st: import('../shared/types').MetricStage): Promise<Job> {
    const src = jobDir(ctx.jobsDir, prev.id);
    const files = fs.existsSync(src) ? fs.readdirSync(src) : [];
    const opt = retryOptions(prev, files)[st];
    if (!opt?.ok) throw new UserFacingError(opt?.reason ?? 'No se puede reintentar desde ese paso.');
    const reuse = opt.reuse;
    const fileOf: Record<string, string | undefined> = { source: files.find((f) => /^source\.(mp4|mkv|webm|mov)$/i.test(f)), audio: 'audio.wav', transcript: 'transcript.json' };
    const keepClips = reuse.includes('clips');
    return enqueueJob(
      { url: prev.url, preset: prev.preset, maxClips: prev.maxClips, allowModelDownload: prev.allowModelDownload },
      {
        reuse,
        resumedFrom: prev.id,
        ...(keepClips ? { clips: prev.clips.map((c) => ({ id: c.id, index: c.index, start: c.start, end: c.end, title: c.title, hook: c.hook, reason: c.reason, score: c.score })), analysis: prev.analysis } : {}),
        sourceTitle: prev.sourceTitle,
        sourceDuration: prev.sourceDuration,
        localSource: prev.localSource,
        live: prev.live,
      },
      (dir) => {
        for (const k of reuse) {
          const f = fileOf[k];
          if (!f) continue;
          try {
            fs.linkSync(path.join(src, f), path.join(dir, f));
          } catch {
            fs.copyFileSync(path.join(src, f), path.join(dir, f));
          }
        }
      },
    );
  }
  h('jobs:retryOptions', (id: unknown) => {
    const job = requireJob(ctx, id);
    const dir = jobDir(ctx.jobsDir, job.id);
    return retryOptions(job, fs.existsSync(dir) ? fs.readdirSync(dir) : []);
  });
  h('jobs:retry', async (id: unknown) => {
    const prev = requireJob(ctx, id);
    if (!TERMINAL.includes(prev.status)) throw new UserFacingError('El trabajo sigue en curso.');
    // Un bloque de directo se reintenta con su vídeo grabado (no con la URL del directo).
    if (prev.localSource) return retryFromStage(prev, 'validating');
    return enqueueJob({ url: prev.url, preset: prev.preset, maxClips: prev.maxClips, allowModelDownload: prev.allowModelDownload });
  });
  async function enqueueJob(r: { url: string; preset: Job['preset']; maxClips: number; allowModelDownload?: boolean }, extra: Partial<Job> = {}, prepare?: (dir: string) => void): Promise<Job> {
    // Mientras se instala o verifica la GPU no se encolan trabajos (tampoco reintentos): competirían por la VRAM y el entorno puede estar cambiando.
    // Durante la migración de ClipsVirales se recarga el historial: un trabajo nuevo se perdería o quedaría como fallido.
    // Una sola inferencia pesada a la vez: mientras se retranscribe no se encolan trabajos (los bloques de directo se reintentan solos).
    if (retranscribing) throw new UserFacingError('Se está volviendo a transcribir un trabajo; espera a que termine.');
    if (migratingLegacy) throw new UserFacingError('Se están migrando los datos de ClipsVirales. Espera a que termine para crear trabajos.');
    if (setupCtrl) throw new UserFacingError('Se está instalando o verificando la aceleración GPU. Espera a que termine o cancélala en Configuración → Aceleración.');
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
      ...extra,
    };
    if (prepare) {
      const d = jobDir(ctx.jobsDir, job.id);
      fs.mkdirSync(d, { recursive: true });
      prepare(d);
    }
    ctx.jobs.put(job);
    ctx.queue.enqueue(job.id);
    emitJob(job);
    return job;
  }
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
    ctx.publish.deleteJob(job.id);
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
    if (cleaning) throw new UserFacingError('Hay una limpieza de almacenamiento en curso; espera a que termine.');
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
      target.archived = false; // vuelve a haber clip interno
      target.exportVerified = false;
      ctx.jobs.put(current);
      emitJob(current);
      event('clip_rerender', { job: current.id, clip: target.index, layout: target.layout });
      return current;
    } finally {
      rerendering.delete(job.id);
    }
  });
  h('clips:preview', async (jobId: unknown, clipId: unknown, layout: unknown, camRect: unknown, range: unknown, composition: unknown) => {
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
    const comp = composition == null ? undefined : compositionSchema.parse(composition);
    const errs = comp ? compositionErrors(compositionOf({ ...clip, composition: comp })) : [];
    if (errs.length) throw new UserFacingError(errs[0]);
    const view = comp ? { ...clip, composition: { ...clip.composition, ...comp, manualOverride: true }, layout: comp.template, camRect: comp.facecamRect } : { ...clip, composition: undefined, layout: l, camRect: cam };
    return renderPreview(env, { ...view, start: draft.start, end: draft.end }, path.join(jobDir(ctx.jobsDir, job.id), 'frames'), name);
  });
  h('clips:words', (jobId: unknown, clipId: unknown, range: unknown) => {
    const job = requireJob(ctx, jobId);
    const id = idSchema.parse(clipId);
    const clip = job.clips.find((c) => c.id === id);
    if (!clip) throw new UserFacingError('El clip no existe.');
    // Tramo en edición (sin guardar): las palabras deben cubrirlo entero.
    const r = range == null ? { start: clip.start, end: clip.end } : previewRangeSchema.parse(range);
    return transcriptWords(ctx, job.id).filter((w) => w.end > r.start - 1 && w.start < r.end + 1);
  });
  h('clips:export', async (jobId: unknown, clipId: unknown) => {
    const job = requireJob(ctx, jobId);
    const p = exportOne(ctx, job, idSchema.parse(clipId));
    emitJob(job);
    await applyExportPolicies(ctx, job).catch((e) => log.error('políticas tras exportar', e));
    return p;
  });
  h('clips:exportAll', async (jobId: unknown) => {
    const job = requireJob(ctx, jobId);
    let n = 0;
    // Los clips con cambios sin renderizar no se exportan (serían una versión antigua).
    for (const c of job.clips) if (c.file && !c.dirty && !c.archived) (exportOne(ctx, job, c.id), n++);
    emitJob(job);
    await applyExportPolicies(ctx, job).catch((e) => log.error('políticas tras exportar', e));
    return n;
  });
  h('shell:openJobFolder', async (jobId: unknown) => {
    const job = requireJob(ctx, jobId);
    const dir = path.join(jobDir(ctx.jobsDir, job.id), 'clips');
    if (!isInside(ctx.jobsDir, dir) || !fs.existsSync(dir)) throw new UserFacingError('La carpeta no existe.');
    await shell.openPath(dir);
  });
  // ---- Publicar (todo local; sin subida real) ----
  const pubClip = (jobId: unknown, clipId: unknown) => {
    const job = requireJob(ctx, jobId);
    const id = idSchema.parse(clipId);
    const clip = job.clips.find((c) => c.id === id);
    if (!clip) throw new UserFacingError('El clip no existe.');
    return { job, clip };
  };
  let generating = false;
  // Cualquier cambio se difunde: una página de Resultados re-montada recibe los textos generados mientras no estaba.
  ctx.publish.onChange = (jobId, data) => broadcast('publish:update', { jobId, data });
  h('publish:get', (jobId: unknown) => ctx.publish.forJob(requireJob(ctx, jobId).id));
  h('publish:connections', () => listConnections());
  h('publish:generate', async (jobId: unknown, clipId: unknown, options: unknown) => {
    const { job, clip } = pubClip(jobId, clipId);
    const o = z.object({ tone: z.enum(TONES as [string, ...string[]]).optional(), niche: z.string().max(40).optional() }).strict().optional().parse(options) ?? {};
    if (generating) throw new UserFacingError('Ya se están generando metadatos; espera a que termine.');
    // Una sola inferencia pesada a la vez: no se carga Ollama mientras Whisper retranscribe en la GPU.
    if (retranscribing) throw new UserFacingError('Se está volviendo a transcribir un trabajo; espera a que termine para generar textos.');
    generating = true;
    try {
      const s = ctx.settings.get();
      const words = transcriptWords(ctx, job.id).filter((w) => w.end > clip.start && w.start < clip.end);
      // Contexto editorial limpio: sin URL, rutas, nombres de archivo, IDs ni metadata técnica (ni siquiera el título del vídeo de origen).
      const ectx = buildEditorialContext(clip, words.map((w) => w.text).join(' '), { tone: o.tone as never, niche: o.niche, language: s.whisperLanguage && s.whisperLanguage !== 'auto' ? s.whisperLanguage : undefined });
      const ask = (system: string, user: string) => chatJson(s.ollamaHost, s.ollamaModel, system, user, new AbortController().signal, { schema: editorialSchema(), numPredict: 1400, temperature: 0.5, timeoutMs: 3 * 60 * 1000 });
      const out = await generateEditorial(ectx, ask);
      // El trabajo o el clip pudieron borrarse mientras Ollama respondía: no se recrean sus datos.
      if (!ctx.jobs.get(job.id)?.clips.some((c) => c.id === clip.id)) throw new UserFacingError('El trabajo o el clip se eliminó mientras se generaban los textos.');
      const latest = ctx.jobs.get(job.id)!.clips.find((c) => c.id === clip.id)!;
      if (latest.start !== clip.start || latest.end !== clip.end) throw new UserFacingError('El tramo del clip cambió mientras se generaban los textos. Vuelve a generarlos.');
      const now = new Date().toISOString();
      ctx.publish.putEditorial(job.id, clip.id, { tone: o.tone, niche: o.niche });
      if (!out.ok) {
        // Nunca se guarda basura: el editor queda como estaba y se pide edición manual.
        event('publish_generate', { job: job.id, clip: clip.index, ok: false, reason: out.reason, attempts: out.attempts, model: s.ollamaModel });
        return { ok: false, reason: out.reason, issues: out.issues, data: ctx.publish.forJob(job.id) };
      }
      const { variants, platforms } = out.result;
      const title = variants[0]?.title ?? '';
      for (const p of PLATFORMS) {
        const d = platforms[p];
        if (!d) continue;
        const meta = { title: p === 'shorts' ? title : '', description: d.description, hashtags: d.hashtags, cta: d.cta };
        ctx.publish.put(job.id, clip.id, p, applyMeta(ctx.publish.get(job.id, clip.id, p), meta, 'ia', now, s.ollamaModel));
      }
      ctx.publish.putEditorial(job.id, clip.id, { variants, model: s.ollamaModel, generatedAt: now });
      event('publish_generate', { job: job.id, clip: clip.index, ok: true, attempts: out.attempts, repaired: out.repaired, model: s.ollamaModel });
      return { ok: true, repaired: out.repaired, data: ctx.publish.forJob(job.id) };
    } finally {
      generating = false;
    }
  });
  h('publish:save', (jobId: unknown, clipId: unknown, platform: unknown, meta: unknown) => {
    const { job, clip } = pubClip(jobId, clipId);
    const p = platformSchema.parse(platform) as Platform;
    const m = publishMetaSchema.parse(meta);
    ctx.publish.put(job.id, clip.id, p, applyMeta(ctx.publish.get(job.id, clip.id, p), m, 'manual', new Date().toISOString()));
    return ctx.publish.forJob(job.id);
  });
  h('publish:restore', (jobId: unknown, clipId: unknown, platform: unknown, index: unknown) => {
    const { job, clip } = pubClip(jobId, clipId);
    const p = platformSchema.parse(platform) as Platform;
    const e = ctx.publish.get(job.id, clip.id, p);
    if (!e) throw new UserFacingError('No hay versiones para esta plataforma.');
    try {
      ctx.publish.put(job.id, clip.id, p, restoreVersion(e, z.number().int().min(0).max(100).parse(index), new Date().toISOString()));
    } catch (err) {
      throw new UserFacingError((err as Error).message);
    }
    return ctx.publish.forJob(job.id);
  });
  h('publish:setStatus', async (jobId: unknown, clipId: unknown, platform: unknown, status: unknown, url: unknown) => {
    const { job, clip } = pubClip(jobId, clipId);
    const p = platformSchema.parse(platform) as Platform;
    const st = publishStatusSchema.parse(status);
    const link = publishUrlSchema.parse(url) ?? undefined;
    const e = ctx.publish.get(job.id, clip.id, p);
    if (!e) throw new UserFacingError('Primero genera o escribe el texto para esta plataforma.');
    let confirmedByUser = false;
    if (st === 'publicado') {
      // Confirmación nativa en el proceso principal: el renderer no puede marcar «publicado» por su cuenta.
      const win = BrowserWindow.getFocusedWindow();
      const opts = {
        type: 'question' as const,
        buttons: ['Cancelar', 'Sí, ya lo publiqué'],
        defaultId: 0,
        cancelId: 0,
        title: 'Marcar como publicado',
        message: `¿Ya publicaste «${clip.title}» en ${PLATFORM_LABELS[p]}?`,
        detail: `Clip Clip no sube vídeos: sólo guarda que tú lo publicaste manualmente.${ctx.settings.get().deleteExportsAfterPublish && clip.exportedPath ? '\n\nTienes activada la opción «Eliminar exports después de marcarlos como publicados»: el MP4 exportado de este clip irá a la Papelera de reciclaje.' : ''}`,
      };
      const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
      if (r.response !== 1) return ctx.publish.forJob(job.id);
      confirmedByUser = true;
    }
    try {
      // Se re-lee tras el diálogo: si el texto cambió mientras tanto (p. ej. terminó una generación), no se marca el texto viejo.
      const cur = ctx.publish.get(job.id, clip.id, p) ?? e;
      if (cur.updatedAt !== e.updatedAt && JSON.stringify(cur.meta) !== JSON.stringify(e.meta)) throw new UserFacingError('El texto cambió mientras confirmabas. Revísalo y vuelve a marcarlo.');
      ctx.publish.put(job.id, clip.id, p, applyStatus(cur, st, new Date().toISOString(), { confirmedByUser, url: link }));
    } catch (err) {
      throw new UserFacingError((err as Error).message);
    }
    event('publish_status', { job: job.id, clip: clip.index, platform: p, status: st });
    // Opción explícita del usuario (desactivada por defecto): el export publicado va a la Papelera.
    if (st === 'publicado' && confirmedByUser && ctx.settings.get().deleteExportsAfterPublish) {
      const r = await trashPublished([{ jobId: job.id, clipId: clip.id, path: clip.exportedPath }]);
      if (r.errors.length && clip.exportedPath) log.warn('export publicado no eliminado', r.errors);
    }
    return ctx.publish.forJob(job.id);
  });
  // ---- Exports ya publicados (sólo con confirmación; a la Papelera; se conserva la metadata) ----
  const publishedNow = (platforms?: Platform[]) => findPublishedExports(ctx.jobs.list(), (id) => ctx.publish.forJob(id), ctx.settings.get().exportDir, ctx.jobsDir, platforms);
  const trashPublished = async (items: { jobId: string; clipId: string; path?: string }[]) => {
    const r = await deletePublishedExports(items, () => publishedNow(), (p) => shell.trashItem(p), (m, x) => event('exports_published_clean', { msg: m, ...(x as object) }));
    const now = new Date().toISOString();
    for (const d of r.deleted) {
      const job = ctx.jobs.get(d.jobId);
      if (!job) continue;
      const updated = { ...job, clips: job.clips.map((c) =>
          // Sólo si el clip sigue apuntando al archivo eliminado: un re-export durante el lote se conserva.
          c.id === d.clipId && c.exportedPath && path.resolve(c.exportedPath).toLowerCase() === d.path.toLowerCase() ? markExportDeleted(c, now) : c,
        ), updatedAt: now };
      ctx.jobs.put(updated);
      emitJob(updated);
    }
    return r;
  };
  h('exports:listPublished', (platforms: unknown, jobId: unknown, clipId: unknown) => {
    const plats = z.array(platformSchema).max(3).optional().parse(platforms ?? undefined) as Platform[] | undefined;
    const jid = jobId == null ? undefined : idSchema.parse(jobId);
    const cid = clipId == null ? undefined : idSchema.parse(clipId);
    const items = publishedNow(plats).filter((x) => (!jid || x.jobId === jid) && (!cid || x.clipId === cid));
    return { items, totalBytes: recoverableBytes(items) };
  });
  h('exports:deletePublished', async (items: unknown) => {
    const list = z.array(z.object({ jobId: idSchema, clipId: idSchema }).strict()).min(1).max(500).parse(items);
    // Confirmación nativa en el proceso principal (además de la del modal): el renderer no puede borrar por su cuenta.
    const sel = publishedNow().filter((x) => list.some((i) => i.jobId === x.jobId && i.clipId === x.clipId));
    if (!sel.length) throw new UserFacingError('Ninguno de esos exports cumple las condiciones (publicado y dentro de la carpeta de exportación).');
    const win = BrowserWindow.getFocusedWindow();
    const opts = {
      type: 'warning' as const,
      buttons: ['Cancelar', 'Enviar a la Papelera'],
      defaultId: 0,
      cancelId: 0,
      title: 'Eliminar exports publicados',
      message: `¿Enviar ${sel.length} export${sel.length === 1 ? '' : 's'} publicado${sel.length === 1 ? '' : 's'} (${humanSize(recoverableBytes(sel))}) a la Papelera de reciclaje?`,
      detail: 'Se conservan los títulos, textos, hashtags e historial de cada clip.',
    };
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    if (r.response !== 1) return { deleted: 0, freedBytes: 0, errors: [] };
    const res = await trashPublished(sel);
    return { deleted: res.deleted.length, freedBytes: res.freedBytes, errors: res.errors };
  });
  h('publish:copy', (jobId: unknown, clipId: unknown, platform: unknown, part: unknown) => {
    const { job, clip } = pubClip(jobId, clipId);
    const p = platformSchema.parse(platform) as Platform;
    const e = ctx.publish.get(job.id, clip.id, p);
    if (!e) throw new UserFacingError('No hay texto para copiar.');
    const text = copyPart(p, e.meta, z.enum(['all', 'title', 'description', 'hashtags']).parse(part ?? 'all'));
    if (!text) throw new UserFacingError('Ese campo está vacío.');
    clipboard.writeText(text);
    return true;
  });
  h('publish:revealVideo', (jobId: unknown, clipId: unknown) => {
    const { job, clip } = pubClip(jobId, clipId);
    if (clip.dirty) throw new UserFacingError('Este clip tiene cambios sin renderizar: vuelve a renderizarlo (y exportarlo) antes de publicarlo.');
    // Se prefiere el export (es el archivo que se sube); si no, el clip interno.
    const internal = clip.file ? path.join(jobDir(ctx.jobsDir, job.id), 'clips', clip.file) : '';
    const target = clip.exportedPath && fs.existsSync(clip.exportedPath) ? clip.exportedPath : internal && fs.existsSync(internal) ? internal : '';
    if (!target) throw new UserFacingError('No se encuentra el vídeo de este clip. Expórtalo primero.');
    shell.showItemInFolder(target);
    return true;
  });

  h('shell:openExportFolder', async () => {
    const dir = ctx.settings.get().exportDir;
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
  });

  // Limpieza automática por antigüedad (sólo si el usuario la activó), poco después de arrancar.
  setTimeout(() => void autoCleanup(ctx).catch((e) => log.error('limpieza automática', e)), 30_000);
}
