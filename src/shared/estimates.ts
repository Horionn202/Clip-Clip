// Estimaciones previas al trabajo (aproximadas, nunca garantías). Puro: lo usan renderer y tests.
import type { EnginePlan, Job } from './types';

/** Umbral a partir del cual se pide confirmación explícita (vídeo largo). */
export const LONG_VIDEO_SEC = 20 * 60;

/** «98 min 1 s», «45 s», «7 min». Siempre en minutos para no confundir con la duración de los clips. */
export function humanDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

export function humanBytes(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(b / 1024 ** 2))} MB`;
}

/**
 * Velocidad de transcripción aproximada (× tiempo real). Valores orientativos; los de GPU FP32 y CPU
 * small/tiny se midieron en una GTX 1660 SUPER y su CPU. Se prefieren métricas reales de trabajos previos.
 */
const SPEED: Record<string, Record<string, number>> = {
  cpu: { tiny: 1.6, base: 0.8, small: 0.33, medium: 0.12, turbo: 0.15, large: 0.06 },
  cuda: { tiny: 8, base: 6, small: 3, medium: 2.5, turbo: 4, large: 1.2 },
};

export function estimateSpeed(plan: Pick<EnginePlan, 'engine' | 'device' | 'model' | 'fp16'>, history: Job[] = []): { speed: number; measured: boolean } {
  const past = history
    .filter((j) => j.status === 'completed' && j.metrics?.engine === plan.engine && j.metrics.whisperModel === plan.model && j.metrics.transcribeSpeed)
    .map((j) => j.metrics!.transcribeSpeed!);
  if (past.length) return { speed: past.reduce((a, b) => a + b, 0) / past.length, measured: true };
  let s = SPEED[plan.device]?.[plan.model] ?? 0.5;
  if (plan.device === 'cuda' && plan.fp16) s *= 1.5;
  if (plan.engine === 'faster-whisper-cuda') s *= 2;
  return { speed: s, measured: false };
}

export interface JobEstimate {
  transcribeSec: number;
  speedMeasured: boolean;
  /** Vídeo descargado + audio WAV 16 kHz mono + margen para clips. */
  diskBytes: number;
}

export function estimateJob(durationSec: number, filesizeBytes: number | undefined, plan: EnginePlan | null, history: Job[] = []): JobEstimate {
  const wav = durationSec * 16000 * 2;
  // Sin tamaño conocido: ≈ 2,8 Mbit/s (vídeo 1080p típico).
  const video = filesizeBytes && filesizeBytes > 0 ? filesizeBytes : durationSec * 350_000;
  const clips = 200 * 1024 ** 2;
  const sp = plan ? estimateSpeed(plan, history) : { speed: 0.5, measured: false };
  return { transcribeSec: durationSec / sp.speed, speedMeasured: sp.measured, diskBytes: video + wav + clips };
}

/** Etiqueta clara del motor activo, p. ej. «GPU activa · modelo medium · CUDA (FP32)». */
export function engineLabel(plan: Pick<EnginePlan, 'device' | 'model' | 'fp16' | 'computeType'>): string {
  if (plan.device === 'cuda') return `GPU activa · modelo ${plan.model} · CUDA (${plan.computeType ?? (plan.fp16 ? 'FP16' : 'FP32')})`;
  return `CPU · modelo ${plan.model}`;
}
