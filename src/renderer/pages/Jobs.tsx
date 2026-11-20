import { useEffect, useState } from 'react';
import { STATUS_LABELS, type Job } from '../../shared/types';
import { JOB_FILTERS, countByFilter, currentEta, filterJobs, fmtMs, renderCounter, simpleCause, stageTimeline, type JobFilter } from '../../shared/jobView';
import { humanDuration } from '../../shared/estimates';
import { api, errMsg } from '../api';
import { JobReport } from './Performance';
import { FreeSpaceDialog } from './Storage';
import { ConfirmModal, Modal } from '../components/Modal';
import { PipelineCards } from '../components/PipelineCards';
import type { RetryOption } from '../../shared/jobView';
import { TEMP_ONLY, humanSize } from '../../shared/storage';

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
  const [modal, setModal] = useState<'' | 'cancel' | 'detail'>('');
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
        <button className="danger" aria-haspopup="dialog" onClick={() => setModal('cancel')}>
          Cancelar
        </button>
        <ConfirmModal
          open={modal === 'cancel'}
          title="Cancelar trabajo"
          confirmLabel="Cancelar trabajo"
          danger
          onClose={() => setModal('')}
          onConfirm={() => {
            setModal('');
            api().cancelJob(job.id).catch((e) => onError(errMsg(e)));
          }}
        >
          <p>¿Cancelar este trabajo? Lo procesado hasta ahora no se usará.</p>
        </ConfirmModal>
      </div>
      <PipelineCards job={job} now={now} details={<JobReport job={job} />} />
      <button className="link small" aria-haspopup="dialog" onClick={() => setModal('detail')}>
        Ver detalle técnico
      </button>
      <Modal open={modal === 'detail'} onClose={() => setModal('')} title="Detalle técnico" size="md">
        <p className="small muted">{job.message}</p>
        <JobReport job={job} />
      </Modal>
    </article>
  );
}

function HistoryCard(props: { job: Job; onOpen: (id: string) => void; onDeleted: (id: string) => void; onRetry: () => void; goDiagnostics: () => void; onError: (m: string) => void }) {
  const j = props.job;
  const got = j.clips.filter((c) => c.file).length;
  const [modal, setModal] = useState<'' | 'temp' | 'report'>('');
  const [retry, setRetry] = useState<Record<string, RetryOption> | undefined>();
  useEffect(() => {
    if (j.status === 'failed' || j.status === 'cancelled') void api().retryOptions(j.id).then(setRetry).catch(() => setRetry(undefined));
  }, [j.id, j.status]);
  const [temp, setTemp] = useState(0);
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
            <span className={`badge ${j.status}`}>{STATUS_LABELS[j.status]}</span> <DeviceBadge job={j} /> <ResultBadge job={j} />{' '}
            {j.archivedExportsOnly && <span className="badge">Archivado: sólo exports</span>} {j.sourceTitle || j.url}
          </div>
          <div className="muted small">
            {new Date(j.createdAt).toLocaleString('es-ES')}
            {j.sourceDuration ? ` · vídeo de ${humanDuration(j.sourceDuration)}` : ''} · clips de {j.preset} s · {got}/{j.analysis?.effectiveTarget ?? j.maxClips} clips
            {j.metrics?.totalMs !== undefined && ` · ${fmtMs(j.metrics.totalMs)} en total`}
            {j.bytesFreed ? ` · ${humanSize(j.bytesFreed)} liberados${j.lastCleanupAt ? ` el ${new Date(j.lastCleanupAt).toLocaleDateString('es-ES')}` : ''}` : ''}
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
        <button
          className="ghost"
          aria-haspopup="dialog"
          onClick={() =>
            act(async () => {
              const r = await api().analyzeStorage(TEMP_ONLY, j.id);
              if (r.recoverableBytes === 0) return props.onError('Este trabajo no tiene temporales que limpiar.');
              setTemp(r.recoverableBytes);
              setModal('temp');
            })
          }
        >
          Limpiar temporales
        </button>
        <ConfirmModal
          open={modal === 'temp'}
          title="Limpiar temporales"
          confirmLabel={`Liberar ${humanSize(temp)}`}
          onClose={() => setModal('')}
          onConfirm={() =>
            act(async () => {
              setModal('');
              const res = await api().cleanStorage(TEMP_ONLY, j.id);
              props.onError(res.errors.length ? `Se liberaron ${humanSize(res.freedBytes)}; ${res.errors.length} archivo(s) no se pudieron borrar.` : '');
            })
          }
        >
          <p>
            Se liberarán <b>{humanSize(temp)}</b> (audio, subtítulos y fotogramas) y van a la Papelera de reciclaje. No se tocan el vídeo original, los clips ni los exports.
          </p>
        </ConfirmModal>
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
      {(j.status === 'failed' || j.status === 'cancelled') && (
        <PipelineCards job={j} now={Date.now()} retry={retry} details={<JobReport job={j} />} onRetryFrom={(stage) => act(async () => (await api().retryJobFrom(j.id, stage), props.onRetry()))} />
      )}
      <button className="link small" aria-haspopup="dialog" onClick={() => setModal('report')}>
        {j.status === 'failed' ? 'Ver errores y diagnóstico' : 'Ver informe del trabajo'}
      </button>
      <Modal open={modal === 'report'} onClose={() => setModal('')} title={j.status === 'failed' ? 'Errores y diagnóstico' : 'Informe del trabajo'} size="md">
        {j.status === 'failed' && j.error && <p className="small muted">{j.error}</p>}
        <JobReport job={j} />
      </Modal>
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
  const [freeOpen, setFreeOpen] = useState(false);
  const [disk, setDisk] = useState<{ free?: number; recoverable: number; min: number } | null>(null);

  // Aviso de poco espacio: se compara el libre con el mínimo de Configuración y se sugiere limpiar.
  useEffect(() => {
    void Promise.all([api().analyzeStorage(), api().getSettings()])
      .then(([r, s]) => setDisk({ free: r.freeDiskBytes, recoverable: r.recoverableBytes, min: s.minFreeDiskMB * 1024 * 1024 }))
      .catch(() => undefined);
  }, [props.jobs.length, freeOpen]);
  const lowDisk = disk?.free !== undefined && disk.free < disk.min;

  return (
    <section className="page">
      <div className="row">
        <h1 className="grow">Trabajos</h1>
        <button onClick={() => setFreeOpen(true)}>Liberar espacio{disk && disk.recoverable > 0 ? ` (${humanSize(disk.recoverable)})` : ''}</button>
      </div>
      {lowDisk && (
        <div className="banner warn" role="alert">
          Queda poco espacio en disco ({humanSize(disk!.free!)} libres; mínimo configurado {humanSize(disk!.min)}).{' '}
          {disk!.recoverable > 0 && (
            <button className="link" onClick={() => setFreeOpen(true)}>
              Liberar {humanSize(disk!.recoverable)}
            </button>
          )}
        </div>
      )}
      <FreeSpaceDialog open={freeOpen} onClose={() => setFreeOpen(false)} />
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
