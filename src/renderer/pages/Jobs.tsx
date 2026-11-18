import { useState } from 'react';
import { JOB_STATUSES, STATUS_LABELS, TERMINAL_STATUSES, type Job } from '../../shared/types';
import { api, errMsg } from '../api';
import { JobReport } from './Performance';

const STAGES = JOB_STATUSES.filter((s) => !['queued', 'completed', 'cancelled', 'failed'].includes(s));

function StageBar({ job }: { job: Job }) {
  const idx = STAGES.indexOf(job.status as (typeof STAGES)[number]);
  return (
    <ol className="stages">
      {STAGES.map((s, i) => (
        <li key={s} className={i < idx || job.status === 'completed' ? 'done' : i === idx ? 'current' : ''}>
          {STATUS_LABELS[s]}
        </li>
      ))}
    </ol>
  );
}

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

export function JobsPage(props: { jobs: Job[]; onOpen: (id: string) => void; onDeleted: (id: string) => void }) {
  const [err, setErr] = useState('');
  const active = props.jobs.filter((j) => !TERMINAL_STATUSES.includes(j.status));
  const history = props.jobs.filter((j) => TERMINAL_STATUSES.includes(j.status));

  const act = async (fn: () => Promise<unknown>) => {
    setErr('');
    try {
      await fn();
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  return (
    <section className="page">
      <h1>Trabajos</h1>
      {err && <div className="banner error">{err}</div>}
      <h2>En curso</h2>
      {active.length === 0 && <div className="empty">No hay trabajos en curso. Crea uno desde Inicio.</div>}
      {active.map((j) => (
        <div className="card" key={j.id}>
          <div className="row">
            <div className="grow">
              <div className="title">
                <DeviceBadge job={j} /> {j.sourceTitle || j.url}
              </div>
              <div className="muted small">
                {STATUS_LABELS[j.status]} · {j.message}
              </div>
              <div className="muted small">
                Meta: {j.maxClips} clips de {j.preset} s
                {j.analysis && ` · máximo factible ${j.analysis.feasibleMax} · meta efectiva ${j.analysis.effectiveTarget}`}
              </div>
            </div>
            <button className="danger" onClick={() => act(() => api().cancelJob(j.id))}>
              Cancelar
            </button>
          </div>
          <StageBar job={j} />
          <div className="progress">
            <div style={{ width: `${Math.round(j.progress * 100)}%` }} />
          </div>
        </div>
      ))}

      <h2>Historial</h2>
      {history.length === 0 && <div className="empty">Aún no hay trabajos terminados.</div>}
      <table className="table">
        <tbody>
          {history.map((j) => (
            <tr key={j.id}>
              <td>
                <span className={`badge ${j.status}`}>{STATUS_LABELS[j.status]}</span>
              </td>
              <td className="grow">
                <div className="title">
                  <DeviceBadge job={j} /> <ResultBadge job={j} /> {j.sourceTitle || j.url}
                </div>
                <div className="muted small">
                  {new Date(j.createdAt).toLocaleString('es-ES')} · {j.preset} s · meta {j.maxClips}
                  {j.analysis && ` · factible ${j.analysis.feasibleMax} · ${j.analysis.candidates} candidatos, ${j.analysis.rejected} descartados`}
                  {j.metrics?.totalMs !== undefined && ` · ${Math.round(j.metrics.totalMs / 1000)} s en total`}
                </div>
                {j.status === 'completed' && j.resultSummary && <div className="small">{j.resultSummary}</div>}
                {j.status === 'failed' && j.error && <div className="error small">{j.error}</div>}
                <details>
                  <summary className="small">Ver informe del trabajo</summary>
                  <JobReport job={j} />
                </details>
              </td>
              <td className="actions">
                {j.status === 'completed' && <button onClick={() => props.onOpen(j.id)}>Ver clips</button>}
                <button
                  className="ghost"
                  onClick={() =>
                    act(async () => {
                      if (await api().deleteJob(j.id)) props.onDeleted(j.id);
                    })
                  }
                >
                  Borrar
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
