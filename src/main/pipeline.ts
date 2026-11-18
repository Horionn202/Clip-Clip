import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Clip, Job, Settings } from '../shared/types';
import { MAX_CLIPS } from '../shared/types';
import { UserFacingError, assertClipInvariants, normalizeCandidates, parseModelResponse, safeFileName } from '../shared/validation';
import { missingDepMessage, runDiagnostics, type ResolvedTools } from './deps';
import { buildAss, centerCrop, parseWhisperJson, renderArgs, type Word } from './media';
import { chatJson } from './ollama';
import { CancelledError, runProcess } from './proc';
import { log } from './logger';
import type { JobRunner } from './queue';

export interface PipelineContext {
  jobsDir: string;
  settings: () => Settings;
  tools: () => ResolvedTools;
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

const BLOCKED_AVAILABILITY = new Set(['premium_only', 'subscriber_only', 'needs_auth']);

export function createPipeline(ctx: PipelineContext): JobRunner {
  return async (job, signal, update) => {
    const s = ctx.settings();
    const dir = jobDir(ctx.jobsDir, job.id);
    fs.mkdirSync(path.join(dir, 'clips'), { recursive: true });

    // 1. Validación
    update({ status: 'validating', progress: 0, message: 'Comprobando dependencias…' });
    const tools = ctx.tools();
    const diag = await runDiagnostics(tools, s);
    const missing = missingDepMessage(diag);
    if (missing) throw new UserFacingError(missing);
    check(signal);
    if (freeDiskMB(dir) < s.minFreeDiskMB) {
      throw new UserFacingError(`No hay espacio suficiente en disco (se requieren al menos ${s.minFreeDiskMB} MB libres).`);
    }
    update({ message: 'Consultando información del vídeo…', progress: 0.5 });
    const meta = await runProcess(tools.ytDlp!, ['--dump-single-json', '--no-playlist', '--no-warnings', '--', job.url], {
      signal,
      timeoutMs: 90_000,
    });
    if (meta.code !== 0) {
      throw new UserFacingError('No se pudo leer la información del vídeo. Comprueba que la URL es pública y accesible.', meta.stderr);
    }
    let info: { title?: string; duration?: number; is_live?: boolean; availability?: string; filesize_approx?: number; filesize?: number };
    try {
      info = JSON.parse(meta.stdout);
    } catch {
      throw new UserFacingError('yt-dlp devolvió información no válida.');
    }
    if (info.is_live) throw new UserFacingError('No se admiten emisiones en directo.');
    if (info.availability && BLOCKED_AVAILABILITY.has(info.availability)) {
      throw new UserFacingError('El vídeo requiere inicio de sesión o suscripción; la app sólo procesa contenido público y autorizado.');
    }
    if (!info.duration || info.duration <= 0) throw new UserFacingError('No se pudo determinar la duración del vídeo.');
    if (info.duration > s.maxSourceMinutes * 60) {
      throw new UserFacingError(`El vídeo dura más de ${s.maxSourceMinutes} minutos (límite configurable en Configuración).`);
    }
    const approx = info.filesize ?? info.filesize_approx;
    if (approx && approx / (1024 * 1024) > s.maxDownloadMB) {
      throw new UserFacingError(`El vídeo supera el tamaño máximo de descarga (${s.maxDownloadMB} MB).`);
    }
    update({ sourceTitle: (info.title ?? '').slice(0, 200), sourceDuration: info.duration });
    check(signal);

    // 2. Descarga
    update({ status: 'downloading', progress: 0, message: 'Descargando vídeo…' });
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
    if (dl.code !== 0) throw new UserFacingError('La descarga falló. Revisa la URL o tu conexión.', dl.stderr);
    const source = fs.readdirSync(dir).find((f) => /^source\.(mp4|mkv|webm|mov)$/i.test(f));
    if (!source) throw new UserFacingError('No se encontró el vídeo descargado (puede haber superado el tamaño máximo).');
    const sourcePath = path.join(dir, source);
    check(signal);

    // Metadatos reales del archivo
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
    update({ sourceDuration: duration });

    // 3. Audio
    update({ status: 'extractingAudio', progress: 0, message: 'Extrayendo audio…' });
    const audioPath = path.join(dir, 'audio.wav');
    const ea = await runProcess(tools.ffmpeg!, ['-hide_banner', '-y', '-i', sourcePath, '-vn', '-ac', '1', '-ar', '16000', audioPath], {
      signal,
      timeoutMs: 60 * 60 * 1000,
    });
    if (ea.code !== 0) throw new UserFacingError('No se pudo extraer el audio.', ea.stderr);
    check(signal);

    // 4. Transcripción
    update({ status: 'transcribing', progress: 0, message: `Transcribiendo con Whisper (${s.whisperModel})… la primera vez descarga el modelo.` });
    const wArgs = [audioPath, '--model', s.whisperModel, '--word_timestamps', 'True', '--output_format', 'json', '--output_dir', dir, '--fp16', 'False'];
    if (s.whisperLanguage) wArgs.push('--language', s.whisperLanguage);
    const tr = await runProcess(tools.whisper!, wArgs, {
      signal,
      timeoutMs: 6 * 60 * 60 * 1000,
      env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      onStdout: (l) => {
        const m = l.match(/-->\s*(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\]/);
        if (m) {
          const t = (m[1] ? parseInt(m[1]) * 3600 : 0) + parseInt(m[2]) * 60 + parseFloat(m[3]);
          update({ progress: Math.min(1, t / duration) });
        }
      },
    });
    if (tr.code !== 0) throw new UserFacingError('La transcripción local falló. Revisa la instalación de Whisper.', tr.stderr);
    const tFile = path.join(dir, 'audio.json');
    if (!fs.existsSync(tFile)) throw new UserFacingError('Whisper no generó la transcripción.');
    const { words, segments } = parseWhisperJson(fs.readFileSync(tFile, 'utf8'));
    fs.renameSync(tFile, path.join(dir, 'transcript.json'));
    if (segments.length === 0) throw new UserFacingError('No se detectó voz en el vídeo; no es posible proponer clips.');
    check(signal);

    // 5–6. Análisis + normalización
    update({ status: 'analyzing', progress: 0, message: `Analizando con ${s.ollamaModel}…` });
    const candidates = await analyze(s, segments, job, duration, signal, (p) => update({ progress: p }));
    const { clips: norm, warnings } = normalizeCandidates(candidates, {
      preset: job.preset,
      maxClips: Math.min(job.maxClips, MAX_CLIPS),
      sourceDuration: duration,
      wordBoundaries: words,
    });
    for (const w of warnings) log.warn(`[${job.id}] ${w}`);
    if (norm.length === 0) {
      throw new UserFacingError('La IA no propuso ningún clip válido para esta duración. Prueba otro preset u otro modelo.');
    }
    const clips: Clip[] = norm.map((c, i) => ({ id: randomUUID(), index: i + 1, ...c }));
    update({ clips, message: `${clips.length} clips seleccionados` });
    check(signal);

    // 7. Render
    assertClipInvariants(clips, { preset: job.preset, maxClips: job.maxClips, sourceDuration: duration });
    update({ status: 'rendering', progress: 0, message: 'Renderizando clips…' });
    const crop = centerCrop(s.cropOffsetX).compute(width, height);
    const clipsDir = path.join(dir, 'clips');
    for (const [i, clip] of clips.entries()) {
      check(signal);
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
      update({ clips: [...clips] });
    }

    // 8. Limpieza configurada (sólo archivos creados por la app dentro de la carpeta del trabajo)
    if (s.deleteTempAfterCompletion) {
      safeUnlink(audioPath);
      for (const f of fs.readdirSync(clipsDir)) if (f.endsWith('.ass')) safeUnlink(path.join(clipsDir, f));
    }
    if (s.deleteSourceAfterCompletion) safeUnlink(sourcePath);
  };
}

function safeUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* ignorar */
  }
}

const SYSTEM_PROMPT = `Eres un editor experto en vídeos cortos virales (TikTok, Reels, Shorts).
Recibirás una transcripción con marcas de tiempo en segundos. Elige los fragmentos más atractivos y autocontenidos.
Responde SÓLO con JSON con esta forma exacta:
{"clips":[{"start":12.3,"end":42.1,"title":"título corto y llamativo","hook":"frase gancho de apertura","reason":"por qué funciona","score":0-100}]}
Reglas: start y end en segundos dentro de la transcripción; los clips no se solapan; empieza y termina en frases completas; títulos en el idioma del vídeo.`;

async function analyze(
  s: Settings,
  segments: Word[],
  job: Job,
  duration: number,
  signal: AbortSignal,
  progress: (p: number) => void,
): Promise<unknown[]> {
  const lines = segments.map((g) => `[${g.start.toFixed(1)}-${g.end.toFixed(1)}] ${g.text.replace(/\s+/g, ' ')}`);
  const chunks: string[] = [];
  let cur = '';
  for (const l of lines) {
    if (cur.length + l.length > 12000 && cur) {
      chunks.push(cur);
      cur = '';
    }
    cur += l + '\n';
  }
  if (cur) chunks.push(cur);

  const per = Math.min(MAX_CLIPS, Math.max(1, Math.ceil((job.maxClips * 1.5) / chunks.length)));
  const all: unknown[] = [];
  let failures = 0;
  for (const [i, chunk] of chunks.entries()) {
    check(signal);
    const user = `Duración total del vídeo: ${duration.toFixed(1)} s. Cada clip debe durar unos ${job.preset} segundos (nunca más).
Propón como máximo ${per} clips de este fragmento.

TRANSCRIPCIÓN:
${chunk}`;
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      const raw = await chatJson(s.ollamaHost, s.ollamaModel, SYSTEM_PROMPT, user, signal);
      try {
        all.push(...parseModelResponse(raw).slice(0, MAX_CLIPS));
        ok = true;
      } catch (e) {
        log.warn(`[${job.id}] respuesta inválida de Ollama (intento ${attempt + 1})`, e instanceof UserFacingError ? e.technical : e);
      }
    }
    if (!ok) failures++;
    progress((i + 1) / chunks.length);
  }
  if (failures === chunks.length) {
    throw new UserFacingError('El modelo de IA devolvió respuestas no válidas. Prueba con otro modelo en Configuración.');
  }
  return all;
}
