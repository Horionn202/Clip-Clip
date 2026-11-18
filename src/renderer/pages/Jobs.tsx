import { useEffect, useState } from 'react';
import { STATUS_LABELS, type Job } from '../../shared/types';
import { JOB_FILTERS, countByFilter, currentEta, filterJobs, fmtMs, renderCounter, simpleCause, stageTimeline, type JobFilter } from '../../shared/jobView';
import { humanDuration } from '../../shared/estimates';
import { api, errMsg } from '../api';
import { JobReport } from './Performance';

export function DeviceBadge({ job }: { job: Job }) {
  const dev = job.metrics?.device ?? job.engine?.device;
  if (!dev) return null;
  return <span className={`badge dev-${dev}`}>{dev === 'cuda' ? 'GPU' : 'CPU'}</span>;
}

/** «obtenidos/meta»; parcial si quedó por debajo de la meta efectiva. */
export function ResultBadge({ job }: { job: Job }) {
  const a = job.analysis;
  if (!a || job.status !== 'completed') return null;
  const got = job.clips.filter((c) => c.file).length;
  const partial = got < a.effectiveTarget;
  return (
    <span className={`badge ${partial ? 'partial' : 'completed'}`}>
      {got}/{a.effectiveTarget} clips{partial ? ' · parcial' : ''}
    </span>
  );
}

function Thumb({ job }: { job: Job }) {
  const t = job.clips.find((c) => c.thumb)?.thumb;
  return t ? <img className="job-thumb" src={`clip://frame/${job.id}/${t}`} alt="" /> : <div className="job-thumb ph" aria-hidden="true">🎬</div>;
}

/** Tick de 1 s sólo mientras haya trabajos activos (para tiempos y ETA en vivo). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function ActiveCard({ job, now, onError }: { job: Job; now: number; onError: (m: string) => void }) {
  const stages = stageTimeline(job, now);
  const elapsed = job.stageStartedAt ? now - Date.parse(job.stageStartedAt) : undefined;
  const eta = currentEta(job, elapsed);
  const pct = Math.round(job.progress * 100);
  const counter = renderCounter(job);
  return (
    <article className="card job-card" aria-label={`Trabajo en curso: ${job.sourceTitle || job.url}`}>
      <div className="row">
        <Thumb job={job} />
        <div className="grow">
          <div className="title">
            <DeviceBadge job={job} /> {job.sourceTitle || job.url}
          </div>
          <div className="muted small">
            {job.sourceDuration ? `Vídeo de ${humanDuration(job.sourceDuration)} · ` : ''}clips de {job.preset} s · meta {job.maxClips}
          </div>
          <div className="stage-now" role="status" aria-live="polite">
            <b>{STATUS_LABELS[job.status]}</b>
            {counter && ` · ${counter}`}
            {job.progress > 0 && ` · ${pct} %`}
            {elapsed !== undefined && ` · ${fmtMs(elapsed)}`}
            {eta !== null && ` · quedan ≈ ${fmtMs(eta)}`}
          </div>
        </div>
        <button
          className="danger"
          onClick={() => {
            if (window.confirm('¿Cancelar este trabajo? Lo procesado hasta ahora no se usará.')) api().cancelJob(job.id).catch((e) => onError(errMsg(e)));
          }}
        >
          Cancelar
        </button>
      </div>
      <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Progreso de la etapa">
        <div style={{ width: `${pct}%` }} />
      </div>
      <ol className="timeline">
        {stages.map((s) => (
          <li key={s.key} className={`tl-${s.state}`}>
            <span aria-hidden="true">{s.state === 'hecho' ? '✓' : s.state === 'en-curso' ? '◐' : '○'}</span> {s.label}
            {s.elapsedMs !== undefined && s.state !== 'pendiente' && <span className="muted"> · {fmtMs(s.elapsedMs)}</span>}
          </li>
        ))}
      </ol>
      <details>
        <summary className="small">Detalle técnico</summary>
        <p className="small muted">{job.message}</p>
        <JobReport job={job} />
      </details>
    </article>
  );
}

function HistoryCard(props: { job: Job; onOpen: (id: string) => void; onDeleted: (id: string) => void; onRetry: () => void; goDiagnostics: () => void; onError: (m: string) => void }) {
  const j = props.job;
  const got = j.clips.filter((c) => c.file).length;
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      props.onError(errMsg(e));
    }
  };
  return (
    <article className="card job-card" aria-label={`${STATUS_LABELS[j.status]}: ${j.sourceTitle || j.url}`}>
      <div className="row">
        <Thumb job={j} />
        <div className="grow">
          <div className="title">
            <span className={`badge ${j.status}`}>{STATUS_LABELS[j.status]}</span> <DeviceBadge job={j} /> <ResultBadge job={j} /> {j.sourceTitle || j.url}
          </div>
          <div className="muted small">
            {new Date(j.createdAt).toLocaleString('es-ES')}
            {j.sourceDuration ? ` · vídeo de ${humanDuration(j.sourceDuration)}` : ''} · clips de {j.preset} s · {got}/{j.analysis?.effectiveTarget ?? j.maxClips} clips
            {j.metrics?.totalMs !== undefined && ` · ${fmtMs(j.metrics.totalMs)} en total`}
          </div>
          {j.status === 'completed' && j.resultSummary && <div className="small">{j.resultSummary}</div>}
          {j.status === 'failed' && (
            <div className="small error">
              {simpleCause(j.error)}{' '}
              <button className="link" onClick={props.goDiagnostics}>
                Ver diagnóstico
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="row actions-row">
        {j.status === 'completed' && (
          <button className="primary" onClick={() => props.onOpen(j.id)}>
            Abrir resultados
          </button>
        )}
        {j.status === 'completed' && <button onClick={() => act(() => api().openJobFolder(j.id))}>Abrir carpeta</button>}
        {(j.status === 'failed' || j.status === 'cancelled') && (
          <button className="primary" onClick={() => act(async () => (await api().retryJob(j.id), props.onRetry()))}>
            Reintentar
          </button>
        )}
        <button
          className="ghost"
          onClick={() =>
            act(async () => {
              if (await api().deleteJob(j.id)) props.onDeleted(j.id);
            })
          }
        >
          Eliminar
        </button>
      </div>
      <details>
        <summary className="small">Ver informe del trabajo</summary>
        {j.status === 'failed' && j.error && <p className="small muted">{j.error}</p>}
        <JobReport job={j} />
      </details>
    </article>
  );
}

export function JobsPage(props: { jobs: Job[]; onOpen: (id: string) => void; onDeleted: (id: string) => void; goDiagnostics: () => void }) {
  const [err, setErr] = useState('');
  const counts = countByFilter(props.jobs);
  const [filter, setFilter] = useState<JobFilter>(counts.activos > 0 ? 'activos' : 'completados');
  const active = filterJobs(props.jobs, 'activos');
  const now = useNow(active.length > 0);
  const shown = filterJobs(props.jobs, filter);

  return (
    <section className="page">
      <h1>Trabajos</h1>
      {err && (
        <div className="banner error" role="alert">
          {err}
        </div>
      )}
      <div className="tabs" role="tablist" aria-label="Filtrar trabajos">
        {JOB_FILTERS.map((f) => (
          <button key={f.id} role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>
            {f.label} <span className="count">{counts[f.id]}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 && (
        <div className="empty">
          {filter === 'activos' ? 'No hay trabajos en curso. Crea uno desde Inicio.' : `No hay trabajos ${JOB_FILTERS.find((f) => f.id === filter)!.label.toLowerCase()}.`}
        </div>
      )}
      {filter === 'activos'
        ? shown.map((j) => <ActiveCard key={j.id} job={j} now={now} onError={setErr} />)
        : shown.map((j) => (
            <HistoryCard
              key={j.id}
              job={j}
              onOpen={props.onOpen}
              onDeleted={props.onDeleted}
              onRetry={() => setFilter('activos')}
              goDiagnostics={props.goDiagnostics}
              onError={setErr}
            />
          ))}
      {filter !== 'activos' && active.length > 0 && (
        <p className="small muted">
          Hay {active.length} trabajo{active.length === 1 ? '' : 's'} en curso.{' '}
          <button className="link" onClick={() => setFilter('activos')}>
            Ver activos
          </button>
        </p>
      )}
      <p className="small muted">Los trabajos terminados se guardan en tu equipo hasta que los elimines.</p>
    </section>
  );
}
