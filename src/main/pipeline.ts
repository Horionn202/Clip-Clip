import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Clip, EnginePlan, GpuInfo, Job, JobMetrics, MetricStage, Settings, TranscribeProgress } from '../shared/types';
import { MAX_CLIPS, WHISPER_MODEL_OPTIONS } from '../shared/types';
import { UserFacingError, assertClipInvariants, safeFileName } from '../shared/validation';
import { resultSummary } from '../shared/selection';
import { missingDepMessage, runDiagnostics, type ResolvedTools } from './deps';
import { buildAss, centerCrop, parseWhisperJson, renderArgs, type Word } from './media';
import { chatJson, unloadModel } from './ollama';
import { CancelledError, runProcess } from './proc';
import { event, log, urlHost } from './logger';
import type { JobRunner } from './queue';
import { friendlyYtDlpError } from './ytdlp';
import { readSourceInfo } from './source';
import { analyzeClips } from './analysis';
import {
  availability,
  computeProgress,
  fallbackPlans,
  fasterArgs,
  formatProgress,
  isGpuFailure,
  isModelCached,
  isModelDownloadLine,
  openaiArgs,
  openaiCommand,
  parseOpenaiSegmentEnd,
  selectEngine,
  type ProgressState,
  type SelectOptions,
} from './transcribe';

export interface PipelineContext {
  jobsDir: string;
  settings: () => Settings;
  tools: () => ResolvedTools;
  /** Diagnóstico GPU/CUDA (ejecuta probe.py). */
  gpuInfo: () => Promise<GpuInfo>;
  fasterScript: string;
}

export function jobDir(jobsDir: string, id: string): string {
  return path.join(jobsDir, id);
}

function check(signal: AbortSignal): void {
  if (signal.aborted) throw new CancelledError();
}

function freeDiskMB(dir: string): number {
  try {
    const s = fs.statfsSync(dir);
    return (s.bavail * s.bsize) / (1024 * 1024);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function modelSize(model: string): string {
  return WHISPER_MODEL_OPTIONS.find((m) => m.name === model)?.sizeLabel ?? '';
}

export function createPipeline(ctx: PipelineContext): JobRunner {
  return async (job, signal, update) => {
    const s = ctx.settings();
    const dir = jobDir(ctx.jobsDir, job.id);
    fs.mkdirSync(path.join(dir, 'clips'), { recursive: true });
    const t0 = Date.now();
    const metrics: JobMetrics = { stagesMs: {}, renderMsPerClip: [], ollamaModel: s.ollamaModel };
    let stageStart = Date.now();
    let curStage: MetricStage | null = null;
    const enter = (stage: MetricStage, message: string) => {
      if (curStage) metrics.stagesMs[curStage] = Date.now() - stageStart;
      curStage = stage;
      stageStart = Date.now();
      update({ status: stage, progress: 0, message, metrics: { ...metrics }, detail: undefined });
    };
    const flushMetrics = () => {
      if (curStage) metrics.stagesMs[curStage] = Date.now() - stageStart;
      metrics.totalMs = Date.now() - t0;
      update({ metrics: { ...metrics } });
    };
    event('job_start', { job: job.id, host: urlHost(job.url), preset: job.preset, target: job.maxClips });

    try {
      // 1. Validación
      enter('validating', 'Comprobando dependencias…');
      const tools = ctx.tools();
      // El diagnóstico de Python/Torch decide qué motor hay (p. ej. faster-whisper sin whisper.exe).
      const gpu = await ctx.gpuInfo();
      const diag = await runDiagnostics(tools, s, undefined, gpu);
      const missing = missingDepMessage(diag);
      if (missing) throw new UserFacingError(missing);
      check(signal);
      if (freeDiskMB(dir) < s.minFreeDiskMB) {
        throw new UserFacingError(`No hay espacio suficiente en disco (se requieren al menos ${s.minFreeDiskMB} MB libres).`);
      }
      update({ message: 'Consultando información del vídeo…', progress: 0.3 });
      const info = await readSourceInfo(tools.ytDlp!, job.url, s, signal, () => {
        log.warn(`[${job.id}] YouTube pidió verificación anti-bot; reintentando con cliente alternativo`);
        update({ message: 'YouTube pidió verificación; reintentando con un método alternativo…' });
      });
      update({ sourceTitle: info.title, sourceDuration: info.duration, progress: 0.6, message: 'Comprobando motor de transcripción…' });

      // Plan de transcripción (antes de descargar nada pesado).
      const selOpts: SelectOptions = {
        choice: s.transcriptionEngine,
        model: s.whisperModel,
        precision: s.whisperPrecision,
        vramMB: gpu.vramMB,
        avail: availability(gpu, !!tools.whisper),
      };
      const plan = selectEngine(selOpts);
      if (!plan) throw new UserFacingError('No hay ningún motor de transcripción disponible. Revisa Configuración → Diagnóstico.');
      if (!isModelCached(plan.engine, plan.model, gpu) && !job.allowModelDownload) {
        throw new UserFacingError(
          `El modelo de Whisper «${plan.model}» (${modelSize(plan.model)}) no está descargado. Marca «Permitir descargar el modelo» en Inicio o elige un modelo ya descargado en Configuración.`,
        );
      }
      update({ engine: plan });
      for (const w of plan.warnings) log.warn(`[${job.id}] ${w}`);
      check(signal);

      // 2. Descarga
      enter('downloading', 'Descargando vídeo…');
      const dl = await runProcess(
        tools.ytDlp!,
        [
          '--no-playlist',
          '--newline',
          '--no-warnings',
          '--no-part',
          '--restrict-filenames',
          '-f',
          'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b',
          '--merge-output-format',
          'mp4',
          '--max-filesize',
          `${s.maxDownloadMB}M`,
          '--ffmpeg-location',
          path.dirname(tools.ffmpeg!),
          ...info.clientArgs,
          '-o',
          path.join(dir, 'source.%(ext)s'),
          '--',
          job.url,
        ],
        {
          signal,
          timeoutMs: 3 * 60 * 60 * 1000,
          onStdout: (l) => {
            const m = l.match(/\[download\]\s+([\d.]+)%/);
            if (m) update({ progress: Math.min(1, parseFloat(m[1]) / 100) });
          },
        },
      );
      if (dl.code !== 0) throw new UserFacingError(`La descarga falló. ${friendlyYtDlpError(dl.stderr)}`, dl.stderr);
      if (info.clientArgs.length) log.warn(`[${job.id}] descargado con cliente alternativo (la calidad puede ser menor, p. ej. 360p)`);
      const source = fs.readdirSync(dir).find((f) => /^source\.(mp4|mkv|webm|mov)$/i.test(f));
      if (!source) throw new UserFacingError('No se encontró el vídeo descargado (puede haber superado el tamaño máximo).');
      const sourcePath = path.join(dir, source);
      check(signal);

      const probe = await runProcess(
        tools.ffprobe!,
        ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', sourcePath],
        { signal, timeoutMs: 60_000 },
      );
      const pj = JSON.parse(probe.stdout || '{}') as { streams?: { width: number; height: number }[]; format?: { duration?: string } };
      const width = pj.streams?.[0]?.width ?? 0;
      const height = pj.streams?.[0]?.height ?? 0;
      const duration = parseFloat(pj.format?.duration ?? '') || info.duration;
      if (!width || !height) throw new UserFacingError('El archivo descargado no contiene vídeo.');
      metrics.sourceDuration = duration;
      update({ sourceDuration: duration });

      // 3. Audio
      enter('extractingAudio', 'Extrayendo audio…');
      const audioPath = path.join(dir, 'audio.wav');
      const ea = await runProcess(tools.ffmpeg!, ['-hide_banner', '-y', '-i', sourcePath, '-vn', '-ac', '1', '-ar', '16000', audioPath], {
        signal,
        timeoutMs: 60 * 60 * 1000,
      });
      if (ea.code !== 0) throw new UserFacingError('No se pudo extraer el audio.', ea.stderr);
      check(signal);

      // 4. Transcripción (con alternativa segura si la GPU falla)
      if (plan.device === 'cuda' && (await unloadModel(s.ollamaHost, s.ollamaModel))) {
        log.info(`[${job.id}] modelo de Ollama liberado de la VRAM antes de transcribir en GPU`);
      }
      enter('transcribing', `Transcribiendo con ${plan.device === 'cuda' ? 'GPU' : 'CPU'} (${plan.model})…`);
      const attempts: EnginePlan[] = [plan, ...fallbackPlans(plan, selOpts)];
      let usedPlan: EnginePlan | null = null;
      let tFile = '';
      let lastErr = '';
      for (const p of attempts) {
        if (p !== plan && !isModelCached(p.engine, p.model, gpu) && !job.allowModelDownload) continue;
        if (p !== plan) {
          log.warn(`[${job.id}] fallo en GPU; reintentando con ${p.engine} ${p.model}`);
          event('transcribe_fallback', { job: job.id, from: plan.engine, to: p.engine, model: p.model });
        }
        update({ engine: p });
        const r = await transcribe(ctx, tools, p, audioPath, dir, s.whisperLanguage, duration, !!job.allowModelDownload, !isModelCached(p.engine, p.model, gpu), signal, (d) =>
          update({ detail: d, progress: d.audioTotalSec ? Math.min(1, d.audioDoneSec / d.audioTotalSec) : 0, message: formatProgress(d) }),
          gpu.whisperInstalled,
        );
        if (r.ok) {
          usedPlan = p;
          tFile = r.outFile;
          metrics.transcribeSpeed = r.speed;
          if (r.downloadMs) metrics.modelDownloadMs = r.downloadMs;
          break;
        }
        lastErr = r.stderr;
        if (p.device !== 'cuda' || !isGpuFailure(r.stderr)) break;
      }
      if (!usedPlan) throw new UserFacingError('La transcripción local falló. Revisa Configuración → Diagnóstico.', lastErr);
      metrics.engine = usedPlan.engine;
      metrics.device = usedPlan.device;
      metrics.whisperModel = usedPlan.model;
      if (!fs.existsSync(tFile)) throw new UserFacingError('Whisper no generó la transcripción.');
      const { words, segments } = parseWhisperJson(fs.readFileSync(tFile, 'utf8'));
      fs.renameSync(tFile, path.join(dir, 'transcript.json'));
      if (segments.length === 0) throw new UserFacingError('No se detectó voz en el vídeo; no es posible proponer clips.');
      event('transcribed', { job: job.id, engine: usedPlan.engine, device: usedPlan.device, model: usedPlan.model, speed: metrics.transcribeSpeed, audioSec: Math.round(duration) });
      check(signal);

      // 5–6. Análisis por rondas + validación
      enter('analyzing', `Analizando con ${s.ollamaModel}…`);
      const { clips: chosen, report } = await analyzeClips({
        segments,
        words,
        duration,
        preset: job.preset,
        userTarget: Math.min(job.maxClips, MAX_CLIPS),
        chat: (system, user, maxItems) =>
          chatJson(s.ollamaHost, s.ollamaModel, system, user, signal, { maxItems, numPredict: Math.min(4096, 300 + maxItems * 220) }),
        checkCancelled: () => check(signal),
        onProgress: (p, message) => update({ progress: p, message }),
        log: (m, extra) => log.info(`[${job.id}] análisis: ${m}`, extra),
      });
      update({ analysis: report });
      event('analysis', { job: job.id, ...report });
      if (chosen.length === 0) {
        throw new UserFacingError(
          `0/${report.effectiveTarget} clips: la IA no propuso ningún momento que cumpla los criterios. Prueba otro preset u otro modelo de Ollama.`,
        );
      }
      const clips: Clip[] = chosen.map((c, i) => ({
        id: randomUUID(),
        index: i + 1,
        start: c.start,
        end: c.end,
        title: c.title,
        hook: c.hook,
        reason: c.reason,
        score: c.score,
      }));
      update({ clips, message: `${clips.length}/${report.effectiveTarget} clips seleccionados` });
      check(signal);

      // 7. Render
      assertClipInvariants(clips, { preset: job.preset, maxClips: job.maxClips, sourceDuration: duration });
      enter('rendering', 'Renderizando clips…');
      const crop = centerCrop(s.cropOffsetX).compute(width, height);
      const clipsDir = path.join(dir, 'clips');
      for (const [i, clip] of clips.entries()) {
        check(signal);
        const tc = Date.now();
        const base = `${String(clip.index).padStart(2, '0')}_${safeFileName(clip.title)}`;
        const assName = `${String(clip.index).padStart(2, '0')}.ass`;
        fs.writeFileSync(path.join(clipsDir, assName), buildAss(words as Word[], clip.start, clip.end, s.subtitleFontSize), 'utf8');
        const out = `${base}.mp4`;
        update({ message: `Renderizando clip ${i + 1} de ${clips.length}…` });
        const total = clip.end - clip.start;
        const r = await runProcess(
          tools.ffmpeg!,
          renderArgs({ source: sourcePath, start: clip.start, end: clip.end, crop, assFile: assName, output: out }),
          {
            cwd: clipsDir,
            signal,
            timeoutMs: 60 * 60 * 1000,
            onStdout: (l) => {
              const m = l.match(/^out_time_us=(\d+)/);
              if (m) update({ progress: (i + Math.min(1, parseInt(m[1]) / 1e6 / total)) / clips.length });
            },
          },
        );
        if (r.code !== 0) throw new UserFacingError(`No se pudo renderizar el clip ${clip.index}.`, r.stderr);
        clip.file = out;
        metrics.renderMsPerClip.push(Date.now() - tc);
        update({ clips: [...clips], metrics: { ...metrics } });
      }

      // 8. Limpieza configurada (sólo archivos creados por la app dentro de la carpeta del trabajo)
      if (s.deleteTempAfterCompletion) {
        safeUnlink(audioPath);
        for (const f of fs.readdirSync(clipsDir)) if (f.endsWith('.ass')) safeUnlink(path.join(clipsDir, f));
      }
      if (s.deleteSourceAfterCompletion) safeUnlink(sourcePath);

      metrics.clipsFinal = clips.length;
      flushMetrics();
      const summary = resultSummary(clips.length, report.effectiveTarget, report.partialReason);
      update({ resultSummary: summary, message: summary });
      event('job_done', { job: job.id, summary, metrics });
    } catch (e) {
      flushMetrics();
      event('job_end', { job: job.id, error: e instanceof Error ? e.name : 'error', message: e instanceof UserFacingError ? e.message : undefined, metrics });
      throw e;
    }
  };
}

interface TranscribeResult {
  ok: boolean;
  stderr: string;
  outFile: string;
  speed?: number;
  downloadMs?: number;
}

/** Ejecuta un plan de transcripción emitiendo progreso real por fases. */
async function transcribe(
  ctx: PipelineContext,
  tools: ResolvedTools,
  plan: EnginePlan,
  audioPath: string,
  dir: string,
  language: string,
  duration: number,
  allowDownload: boolean,
  needsDownload: boolean,
  signal: AbortSignal,
  onProgress: (p: TranscribeProgress) => void,
  pythonHasWhisper: boolean,
): Promise<TranscribeResult> {
  const startedAt = Date.now();
  const st: ProgressState = { phase: needsDownload ? 'downloadingModel' : 'loadingModel', audioDone: 0, firstSegmentAt: null };
  let downloadEndedAt: number | null = null;
  const emit = () => onProgress(computeProgress(st, duration, startedAt, Date.now(), plan.device));
  const onSegment = (end: number) => {
    if (st.phase !== 'transcribing') {
      if (st.phase === 'downloadingModel') downloadEndedAt = Date.now();
      st.phase = 'transcribing';
      st.firstSegmentAt = Date.now();
    }
    st.audioDone = Math.min(duration, Math.max(st.audioDone, end));
  };
  const timer = setInterval(emit, 1000);
  emit();
  const env = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' };
  try {
    if (plan.engine === 'faster-whisper-cuda') {
      if (!tools.python) return { ok: false, stderr: 'python no encontrado', outFile: '' };
      const outFile = path.join(dir, 'audio.json');
      const r = await runProcess(tools.python, fasterArgs(ctx.fasterScript, plan, audioPath, outFile, language, allowDownload), {
        signal,
        timeoutMs: 6 * 60 * 60 * 1000,
        env,
        onStdout: (l) => {
          try {
            const ev = JSON.parse(l) as { event?: string; end?: number };
            if (ev.event === 'loaded') {
              if (st.phase === 'downloadingModel') downloadEndedAt = Date.now();
              st.phase = 'loadingModel';
            } else if (ev.event === 'segment' && typeof ev.end === 'number') onSegment(ev.end);
          } catch {
            /* línea no JSON */
          }
        },
        onStderr: (l) => {
          if (isModelDownloadLine(l) && st.phase !== 'transcribing') st.phase = 'downloadingModel';
        },
      });
      return finish(r.code === 0, r.stderr, outFile);
    }
    const outFile = path.join(dir, 'audio.json');
    // Se ejecuta en el mismo intérprete que se diagnosticó (python -m whisper); whisper.exe sólo como respaldo.
    const cmd = openaiCommand(tools, pythonHasWhisper);
    if (!cmd) return { ok: false, stderr: 'openai-whisper no encontrado', outFile: '' };
    const r = await runProcess(cmd.exe, [...cmd.prefix, ...openaiArgs(plan, audioPath, dir, language)], {
      signal,
      timeoutMs: 6 * 60 * 60 * 1000,
      env,
      onStdout: (l) => {
        const end = parseOpenaiSegmentEnd(l);
        if (end !== null) onSegment(end);
      },
      onStderr: (l) => {
        if (isModelDownloadLine(l) && st.phase !== 'transcribing') st.phase = 'downloadingModel';
        else if (st.phase === 'downloadingModel' && /Detecting language|Detected language/i.test(l)) st.phase = 'loadingModel';
      },
    });
    return finish(r.code === 0, r.stderr, outFile);
  } finally {
    clearInterval(timer);
    emit();
  }

  function finish(ok: boolean, stderr: string, outFile: string): TranscribeResult {
    const elapsed = (Date.now() - startedAt) / 1000;
    const work = downloadEndedAt ? (Date.now() - downloadEndedAt) / 1000 : elapsed;
    return {
      ok,
      stderr,
      outFile,
      speed: ok && work > 0 ? Math.round((duration / work) * 100) / 100 : undefined,
      downloadMs: downloadEndedAt ? downloadEndedAt - startedAt : undefined,
    };
  }
}

function safeUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* ignorar */
  }
}
