// Vista de trabajos: filtros, línea de etapas con tiempos/ETA y causas de error en lenguaje simple. Puro.
import type { Job, JobStatus, MetricStage } from './types';
import { TERMINAL_STATUSES } from './types';

export type JobFilter = 'activos' | 'completados' | 'fallidos' | 'cancelados';
export const JOB_FILTERS: { id: JobFilter; label: string }[] = [
  { id: 'activos', label: 'Activos' },
  { id: 'completados', label: 'Completados' },
  { id: 'fallidos', label: 'Fallidos' },
  { id: 'cancelados', label: 'Cancelados' },
];

export function filterJobs(jobs: Job[], f: JobFilter): Job[] {
  const match: Record<JobFilter, (s: JobStatus) => boolean> = {
    activos: (s) => !TERMINAL_STATUSES.includes(s),
    completados: (s) => s === 'completed',
    fallidos: (s) => s === 'failed',
    cancelados: (s) => s === 'cancelled',
  };
  return jobs.filter((j) => match[f](j.status));
}

export function countByFilter(jobs: Job[]): Record<JobFilter, number> {
  return {
    activos: filterJobs(jobs, 'activos').length,
    completados: filterJobs(jobs, 'completados').length,
    fallidos: filterJobs(jobs, 'fallidos').length,
    cancelados: filterJobs(jobs, 'cancelados').length,
  };
}

/** Etapas visibles para el usuario (más finas que los estados internos). */
export interface StageView {
  key: string;
  label: string;
  state: 'hecho' | 'en-curso' | 'pendiente';
  elapsedMs?: number;
}

const ORDER: MetricStage[] = ['validating', 'downloading', 'extractingAudio', 'transcribing', 'analyzing', 'rendering'];

/** Línea de etapas: validando · obteniendo metadata · descargando · extrayendo audio · (descargando/cargando modelo) · transcribiendo · analizando · seleccionando · renderizando · exportando. */
export function stageTimeline(job: Job, now: number): StageView[] {
  const cur = job.status;
  const curIdx = ORDER.indexOf(cur as MetricStage);
  const done = job.status === 'completed';
  const stateOf = (s: MetricStage): StageView['state'] => {
    const i = ORDER.indexOf(s);
    if (done || (curIdx >= 0 && i < curIdx)) return 'hecho';
    if (i === curIdx) return 'en-curso';
    return 'pendiente';
  };
  const ms = (s: MetricStage) => {
    if (stateOf(s) === 'en-curso' && job.stageStartedAt) return now - Date.parse(job.stageStartedAt);
    return job.metrics?.stagesMs[s];
  };
  const out: StageView[] = [];
  const add = (key: string, label: string, s: MetricStage, state = stateOf(s), elapsed = ms(s)) => out.push({ key, label, state, elapsedMs: elapsed });

  // validación = validar + obtener metadata (subfase según el mensaje)
  const meta = cur === 'validating' && /información del vídeo|verificación|motor/i.test(job.message);
  add('validating', 'Validando', 'validating', cur === 'validating' && meta ? 'hecho' : stateOf('validating'), cur === 'validating' && meta ? undefined : ms('validating'));
  add('metadata', 'Obteniendo metadata', 'validating', cur === 'validating' ? (meta ? 'en-curso' : 'pendiente') : stateOf('validating'), cur === 'validating' && meta ? ms('validating') : undefined);
  add('downloading', 'Descargando vídeo', 'downloading');
  add('extractingAudio', 'Extrayendo audio', 'extractingAudio');
  // transcripción: subfases reales de la etapa
  const tr = stateOf('transcribing');
  const phase = cur === 'transcribing' ? job.detail?.phase : undefined;
  const dlModel = !!job.metrics?.modelDownloadMs || phase === 'downloadingModel';
  if (dlModel) {
    out.push({
      key: 'model-download',
      label: 'Descargando modelo de Whisper',
      state: tr === 'hecho' || phase === 'loadingModel' || phase === 'transcribing' ? 'hecho' : tr === 'en-curso' ? 'en-curso' : 'pendiente',
      elapsedMs: job.metrics?.modelDownloadMs,
    });
  }
  out.push({ key: 'model-load', label: 'Cargando modelo', state: tr === 'hecho' || phase === 'transcribing' ? 'hecho' : phase === 'loadingModel' ? 'en-curso' : tr === 'en-curso' && !dlModel ? 'en-curso' : 'pendiente' });
  out.push({ key: 'transcribing', label: 'Transcribiendo', state: tr === 'hecho' ? 'hecho' : phase === 'transcribing' ? 'en-curso' : 'pendiente', elapsedMs: ms('transcribing') });
  // análisis = analizar (IA) + seleccionar (validación/rondas)
  const an = stateOf('analyzing');
  const selecting = cur === 'analyzing' && /ronda [2-9]|seleccionados/i.test(job.message);
  out.push({ key: 'analyzing', label: 'Analizando con IA', state: an === 'en-curso' && selecting ? 'hecho' : an, elapsedMs: ms('analyzing') });
  out.push({ key: 'selecting', label: 'Seleccionando clips', state: an === 'hecho' ? 'hecho' : selecting ? 'en-curso' : 'pendiente' });
  add('rendering', 'Renderizando', 'rendering');
  out.push({ key: 'exporting', label: 'Listo para exportar', state: done ? 'hecho' : 'pendiente' });
  return out;
}

/** ETA de la etapa actual a partir del progreso medible; sólo con muestra suficiente (≥ 5 % y ≥ 10 s). */
export function stageEta(progress: number, elapsedMs: number): number | null {
  if (!(progress >= 0.05 && progress < 1) || elapsedMs < 10_000) return null;
  return Math.round((elapsedMs / progress) * (1 - progress));
}

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60 ? `${s % 60} s` : ''}`.trim();
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** «clip 7 de 20» a partir del mensaje de render, si lo hay. */
export function renderCounter(job: Job): string | null {
  const m = job.status === 'rendering' ? job.message.match(/clip (\d+) de (\d+)/i) : null;
  return m ? `clip ${m[1]} de ${m[2]}` : null;
}

/** Causa simple de un fallo (sin tecnicismos) para la tarjeta; el detalle completo va al diagnóstico. */
export function simpleCause(error: string | undefined): string {
  const e = error ?? '';
  if (/dependencias|Diagnóstico/i.test(e) && /Faltan/i.test(e)) return 'Falta un programa necesario.';
  if (/Whisper|transcripci/i.test(e)) return 'La transcripción no se completó.';
  if (/descarga|yt-dlp|bot|privado|disponible en tu país|no existe/i.test(e)) return 'No se pudo descargar el vídeo.';
  if (/IA|Ollama|modelo/i.test(e)) return 'La IA local no respondió como se esperaba.';
  if (/espacio/i.test(e)) return 'No hay espacio suficiente en disco.';
  if (/interrumpi/i.test(e)) return 'La app se cerró mientras trabajaba.';
  return 'El trabajo no pudo terminar.';
}
