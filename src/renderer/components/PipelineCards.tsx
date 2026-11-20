import { useState } from 'react';
import type { Job } from '../../shared/types';
import { fmtMs, pipelineCards, type PipelineCard } from '../../shared/jobView';
import { Modal } from './Modal';

const STATE_LABEL: Record<PipelineCard['state'], string> = { pendiente: 'Pendiente', activo: 'En curso', completado: 'Completado', error: 'Error', cancelado: 'Cancelado' };

/**
 * Progreso del trabajo como tarjetas grandes (una por paso). Pendiente = gris discreto, activo = azul/violeta,
 * completado = verde, error = rojo (sólo el paso que falló), cancelado = ámbar.
 */
export function PipelineCards({ job, now, onRetryFrom, details }: { job: Job; now: number; onRetryFrom?: (stage: NonNullable<PipelineCard['stage']>) => void; details?: React.ReactNode }) {
  const [open, setOpen] = useState<PipelineCard | null>(null);
  const cards = pipelineCards(job, now);
  return (
    <>
      <ol className="pipe-cards" aria-label="Progreso del trabajo">
        {cards.map((c) => (
          <li key={c.key} className={`pipe-card ${c.state}`} aria-current={c.state === 'activo' ? 'step' : undefined}>
            <div className="pipe-head">
              <span className="pipe-icon" aria-hidden="true">
                {c.icon}
              </span>
              <b className="grow">{c.label}</b>
              <span className="pipe-state">{STATE_LABEL[c.state]}</span>
            </div>
            {c.percent !== undefined && (
              <div className="progress small-bar" role="progressbar" aria-valuenow={c.percent} aria-valuemin={0} aria-valuemax={100} aria-label={`Progreso: ${c.label}`}>
                <div style={{ width: `${c.percent}%` }} />
              </div>
            )}
            <div className="pipe-meta small">
              {c.percent !== undefined && <span>{c.percent} %</span>}
              {c.elapsedMs !== undefined && <span>⏱ {fmtMs(c.elapsedMs)}</span>}
              {c.etaMs !== undefined && <span>quedan ≈ {fmtMs(c.etaMs)}</span>}
            </div>
            {c.facts.map((f) => (
              <div key={f} className="pipe-fact small">
                {f}
              </div>
            ))}
            {c.message && <p className="pipe-msg small">{c.message}</p>}
            {(c.state === 'activo' || c.state === 'error' || c.state === 'completado') && c.stage && (
              <div className="row small">
                <button className="link" aria-haspopup="dialog" onClick={() => setOpen(c)}>
                  {c.state === 'error' ? 'Ver error' : 'Ver detalles'}
                </button>
                {c.state === 'error' && onRetryFrom && (
                  <button className="link" onClick={() => onRetryFrom(c.stage!)}>
                    Reintentar desde este paso
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
      <Modal open={!!open} onClose={() => setOpen(null)} title={open ? `${open.label}: detalles técnicos` : ''} size="md">
        {open && (
          <>
            <p className="small">
              Estado: <b>{STATE_LABEL[open.state]}</b>
              {open.elapsedMs !== undefined ? ` · ${fmtMs(open.elapsedMs)}` : ''}
            </p>
            {open.state === 'error' && job.error && <pre className="log-box">{job.error}</pre>}
            {open.state !== 'error' && job.message && <p className="small muted">{job.message}</p>}
            {details}
          </>
        )}
      </Modal>
    </>
  );
}
