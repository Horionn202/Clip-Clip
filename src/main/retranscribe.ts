// «Reprocesar sólo transcripción»: vuelve a transcribir un trabajo terminado sin descargar ni analizar de nuevo.
// Reutiliza audio.wav (o lo extrae del vídeo original). La transcripción anterior se conserva como
// transcript.prev.json y sólo se sustituye cuando la nueva es válida. Los clips quedan «con cambios sin renderizar».
import fs from 'node:fs';
import path from 'node:path';
import type { GpuInfo, Job, Settings } from '../shared/types';
import { UserFacingError } from '../shared/validation';
import type { ResolvedTools } from './deps';
import { parseWhisperJson } from './media';
import { runProcess } from './proc';
import { jobDir, transcribe, whisperLang, type PipelineContext } from './pipeline';
import { availability, fallbackPlans, isGpuFailure, isModelCached, selectEngine } from './transcribe';
import { differsFromRendered } from '../shared/clipEdit';

export interface RetranscribeResult {
  job: Job;
  model: string;
  device: 'cpu' | 'cuda';
  language: string;
  words: number;
}

export async function retranscribeJob(job: Job, ctx: PipelineContext, s: Settings, tools: ResolvedTools, gpu: GpuInfo, signal: AbortSignal, onMsg: (m: string) => void): Promise<RetranscribeResult> {
  const dir = jobDir(ctx.jobsDir, job.id);
  let audio = path.join(dir, 'audio.wav');
  if (!fs.existsSync(audio)) {
    const src = fs.readdirSync(dir).find((f) => /^source\.(mp4|mkv|webm|mov)$/i.test(f));
    if (!src) throw new UserFacingError('No queda ni el audio ni el vídeo original de este trabajo (se liberó espacio): no se puede volver a transcribir.');
    if (!tools.ffmpeg) throw new UserFacingError('Falta FFmpeg.');
    onMsg('Extrayendo audio del vídeo original…');
    audio = path.join(dir, 'audio.retranscribe.wav');
    const ea = await (ctx.run ?? runProcess)(tools.ffmpeg, ['-hide_banner', '-y', '-i', path.join(dir, src), '-vn', '-ac', '1', '-ar', '16000', audio], { signal, timeoutMs: 60 * 60 * 1000 });
    if (ea.code !== 0) throw new UserFacingError('No se pudo extraer el audio.', ea.stderr);
  }
  const selOpts = { choice: s.transcriptionEngine, model: s.whisperModel, precision: s.whisperPrecision, vramMB: gpu.vramMB, gpuName: gpu.nvidiaGpu, avail: availability(gpu, !!tools.whisper) };
  const plan = selectEngine(selOpts);
  if (!plan) throw new UserFacingError('No hay ningún motor de transcripción disponible.');
  if (!isModelCached(plan.engine, plan.model, gpu)) throw new UserFacingError(`El modelo «${plan.model}» no está descargado. Descárgalo primero (Configuración → Modelos).`);
  const tmpDir = path.join(dir, 'retranscribe');
  fs.mkdirSync(tmpDir, { recursive: true });
  const lang = whisperLang(s.whisperLanguage);
  let ok: { file: string; device: 'cpu' | 'cuda'; model: string } | null = null;
  let lastErr = '';
  for (const p of [plan, ...fallbackPlans(plan, selOpts)].filter((p) => isModelCached(p.engine, p.model, gpu))) {
    onMsg(`Transcribiendo con ${p.device === 'cuda' ? 'GPU' : 'CPU'} (${p.model})…`);
    const r = await transcribe(ctx, tools, p, audio, tmpDir, lang, job.sourceDuration ?? 0, false, false, signal, () => undefined, gpu.whisperInstalled);
    if (r.ok) {
      ok = { file: r.outFile, device: p.device, model: p.model };
      break;
    }
    lastErr = r.stderr;
    if (p.device !== 'cuda' || !isGpuFailure(r.stderr)) break;
  }
  try {
    if (!ok) throw new UserFacingError('La transcripción falló; se conserva la anterior.', lastErr);
    const raw = fs.readFileSync(ok.file, 'utf8');
    const { words, segments } = parseWhisperJson(raw);
    if (!segments.length) throw new UserFacingError('La nueva transcripción no contiene voz; se conserva la anterior.');
    const cur = path.join(dir, 'transcript.json');
    // La anterior se guarda (y una original del primer proceso nunca se pisa).
    if (fs.existsSync(cur)) {
      const orig = path.join(dir, 'transcript.orig.json');
      if (!fs.existsSync(orig)) fs.copyFileSync(cur, orig);
      fs.copyFileSync(cur, path.join(dir, 'transcript.prev.json'));
    }
    fs.renameSync(ok.file, cur);
    // Subtítulos automáticos nuevos: los clips con MP4 quedan pendientes de renderizar (los cues editados a mano se respetan).
    const clips = job.clips.map((c) => (c.file && !c.subtitleCues ? { ...c, dirty: true, rendered: c.rendered ? { ...c.rendered, cues: 'retranscribed' } : c.rendered } : c));
    for (const c of clips) if (c.rendered && c.dirty && !differsFromRendered(c, c.rendered)) c.dirty = false;
    const detected = (JSON.parse(raw) as { language?: string }).language;
    const metrics = { ...(job.metrics ?? { stagesMs: {}, renderMsPerClip: [] }), whisperModel: ok.model, device: ok.device, languageRequested: lang || 'auto', languageDetected: detected };
    return { job: { ...job, clips, metrics }, model: ok.model, device: ok.device, language: detected ?? lang, words: words.length };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (audio.endsWith('audio.retranscribe.wav')) fs.rmSync(audio, { force: true });
  }
}
