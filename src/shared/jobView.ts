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

/**
 * ETA que se muestra para la etapa actual. En la transcripción se usa la del transcriptor, que sólo existe con
 * muestra real (≥ 20 s de audio y ≥ 10 s desde el primer segmento) y no cuenta la descarga/carga del modelo.
 */
export function currentEta(job: Job, elapsedMs: number | undefined): number | null {
  if (job.status === 'transcribing') return job.detail?.etaSec !== undefined ? Math.round(job.detail.etaSec * 1000) : null;
  return elapsedMs !== undefined ? stageEta(job.progress, elapsedMs) : null;
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

// ---------- Tarjetas grandes del pipeline ----------

export type CardState = 'pendiente' | 'activo' | 'completado' | 'error' | 'cancelado';

export interface PipelineCard {
  key: string;
  /** Etapa real del pipeline (para «Reintentar desde este paso»); ausente en las tarjetas finales. */
  stage?: MetricStage;
  icon: string;
  label: string;
  state: CardState;
  /** 0–100 sólo si el proceso lo informa. */
  percent?: number;
  elapsedMs?: number;
  etaMs?: number;
  message?: string;
  /** Datos concretos: tamaño/velocidad, minutos procesados y modelo, candidatos/objetivo… */
  facts: string[];
}

const CARD_DEFS: { key: string; stage?: MetricStage; icon: string; label: string }[] = [
  { key: 'validating', stage: 'validating', icon: '🔎', label: 'Validando fuente' },
  { key: 'downloading', stage: 'downloading', icon: '⬇️', label: 'Descargando vídeo' },
  { key: 'extractingAudio', stage: 'extractingAudio', icon: '🎵', label: 'Extrayendo audio' },
  { key: 'transcribing', stage: 'transcribing', icon: '📝', label: 'Transcribiendo' },
  { key: 'analyzing', stage: 'analyzing', icon: '🧠', label: 'Analizando con IA' },
  { key: 'selecting', stage: 'analyzing', icon: '🎯', label: 'Seleccionando momentos' },
  { key: 'rendering', stage: 'rendering', icon: '🎬', label: 'Renderizando clips' },
  { key: 'publishing', icon: '📣', label: 'Preparando publicación' },
  { key: 'done', icon: '✅', label: 'Finalizado' },
];

/** Etapa en la que estaba el trabajo (también si falló o se canceló). Trabajos antiguos: la última con tiempo medido. */
export function lastStage(job: Job): MetricStage | undefined {
  if (ORDER.includes(job.status as MetricStage)) return job.status as MetricStage;
  if (job.stage) return job.stage;
  const measured = ORDER.filter((s) => job.metrics?.stagesMs[s] !== undefined);
  return measured[measured.length - 1];
}

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

export function pipelineCards(job: Job, now: number): PipelineCard[] {
  const done = job.status === 'completed';
  const failed = job.status === 'failed';
  const cancelled = job.status === 'cancelled';
  const stage = lastStage(job);
  const curIdx = stage ? ORDER.indexOf(stage) : -1;
  const selecting = stage === 'analyzing' && /ronda [2-9]|seleccionad/i.test(job.message);
  const elapsedNow = job.stageStartedAt ? now - Date.parse(job.stageStartedAt) : undefined;
  return CARD_DEFS.map((d) => {
    const card: PipelineCard = { key: d.key, stage: d.stage, icon: d.icon, label: d.label, state: 'pendiente', facts: [] };
    const i = d.stage ? ORDER.indexOf(d.stage) : ORDER.length;
    // Analizar/seleccionar comparten etapa: «seleccionar» empieza cuando el análisis entra en sus rondas finales.
    const sub = d.key === 'selecting' ? (selecting ? 0 : -1) : d.key === 'analyzing' && selecting ? 1 : 0;
    if (done) card.state = 'completado';
    else if (d.key === 'publishing' || d.key === 'done') card.state = cancelled ? 'cancelado' : 'pendiente';
    else if (i < curIdx || sub === 1) card.state = 'completado';
    else if (i === curIdx && sub === 0) card.state = failed ? 'error' : cancelled ? 'cancelado' : 'activo';
    else card.state = cancelled ? 'cancelado' : 'pendiente';

    const measured = d.stage && d.key !== 'selecting' ? job.metrics?.stagesMs[d.stage] : undefined;
    if (card.state === 'activo') {
      card.elapsedMs = elapsedNow;
      card.message = job.message;
      if (job.progress > 0 && job.progress <= 1) card.percent = Math.round(job.progress * 100);
      const eta = currentEta(job, elapsedNow);
      if (eta !== null) card.etaMs = eta;
    } else if (card.state === 'completado' && measured !== undefined) card.elapsedMs = measured;
    else if (card.state === 'error') card.message = simpleCause(job.error);

    const m = job.metrics;
    if (d.key === 'downloading' && card.state === 'activo') {
      const sz = job.message.match(/de ([\d.]+\s*\w+)(?: a ([\d.]+\s*\w+\/s))?/);
      if (sz) card.facts.push(`Tamaño ${sz[1]}`, ...(sz[2] ? [`Velocidad ${sz[2]}`] : []));
    }
    if (d.key === 'transcribing') {
      if (card.state === 'activo' && job.detail?.audioTotalSec) card.facts.push(`${mmss(job.detail.audioDoneSec)} de ${mmss(job.detail.audioTotalSec)} de audio`);
      const plan = job.engine;
      if (plan && card.state !== 'pendiente') card.facts.push(`${plan.model} · ${plan.device === 'cuda' ? 'GPU' : 'CPU'}`);
      if (m?.transcribeSpeed && card.state === 'completado') card.facts.push(`${m.transcribeSpeed.toFixed(1)}× tiempo real`);
      if (m?.languageRequested && card.state === 'completado') card.facts.push(`Idioma ${m.languageRequested === 'auto' ? `auto (${m.languageDetected ?? '?'})` : m.languageRequested}`);
    }
    if ((d.key === 'analyzing' || d.key === 'selecting') && job.analysis) card.facts.push(`${job.analysis.obtained} de ${job.analysis.effectiveTarget} clips objetivo`);
    if (d.key === 'rendering' && card.state === 'activo') {
      const c = renderCounter(job);
      if (c) card.facts.push(c);
    }
    if (d.key === 'rendering' && card.state === 'completado' && job.clips.length) card.facts.push(`${job.clips.filter((c) => c.file).length} clips`);
    return card;
  });
}
