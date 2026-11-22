import { useState } from 'react';
import type { Job } from '../../shared/types';
import { REUSE_LABELS, fmtMs, pipelineCards, type PipelineCard, type RetryOption } from '../../shared/jobView';
import { Modal } from './Modal';
import validateSource from '../assets/workflow-icons/validate-source.png';
import downloadVideo from '../assets/workflow-icons/download-video.png';
import extractAudio from '../assets/workflow-icons/extract-audio.png';
import transcribe from '../assets/workflow-icons/transcribe.png';
import analyzeAi from '../assets/workflow-icons/analyze-ai.png';
import selectMoments from '../assets/workflow-icons/select-moments.png';
import renderClips from '../assets/workflow-icons/render-clips.png';
import preparePublish from '../assets/workflow-icons/prepare-publish.png';
import completed from '../assets/workflow-icons/completed.png';

/** Icono PNG de cada tarjeta (por `PipelineCard.key`); Vite los incluye en el build. */
const ICONS: Record<string, string> = {
  validating: validateSource,
  downloading: downloadVideo,
  extractingAudio: extractAudio,
  transcribing: transcribe,
  analyzing: analyzeAi,
  selecting: selectMoments,
  rendering: renderClips,
  publishing: preparePublish,
  done: completed,
};

/** Oculta la carpeta personal del usuario en los logs mostrados (C:\Users\nombre → %USERPROFILE%). */
export function redactPaths(s: string): string {
  return s.replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s]+/gi, '%USERPROFILE%');
}

const STATE_LABEL: Record<PipelineCard['state'], string> = { pendiente: 'Pendiente', activo: 'En curso', completado: 'Completado', error: 'Error', cancelado: 'Cancelado' };

/**
 * Progreso del trabajo como tarjetas grandes (una por paso). Pendiente = gris discreto, activo = Turquesa Surf,
 * completado = verde, error = rojo (sólo el paso que falló), cancelado = ámbar.
 */
export function PipelineCards({ job, now, onRetryFrom, retry, details }: { job: Job; now: number; onRetryFrom?: (stage: NonNullable<PipelineCard['stage']>) => void; retry?: Record<string, RetryOption>; details?: React.ReactNode }) {
  const [open, setOpen] = useState<PipelineCard | null>(null);
  const cards = pipelineCards(job, now);
  return (
    <>
      <ol className="pipe-cards" aria-label="Progreso del trabajo">
        {cards.map((c) => (
          <li key={c.key} className={`pipe-card ${c.state}`} aria-current={c.state === 'activo' ? 'step' : undefined}>
            <div className="pipe-head">
              <span className="pipe-icon">
                {ICONS[c.key] && <img className="pipe-icon-image" src={ICONS[c.key]} alt={`Etapa: ${c.label}`} width={46} height={46} draggable={false} />}
              </span>
              <b className="grow pipe-title">{c.label}</b>
              <span className="pipe-state">{STATE_LABEL[c.state]}</span>
            </div>
            {c.percent !== undefined && (
              <div className="progress small-bar" role="progressbar" aria-valuenow={c.percent} aria-valuemin={0} aria-valuemax={100} aria-label={`Progreso: ${c.label}`}>
                <div style={{ width: `${c.percent}%` }} />
              </div>
            )}
            <div className="pipe-meta small">
              {c.percent !== undefined && <span>{c.percent} %</span>}
              {c.elapsedMs !== undefined && <span className="pipe-time" title="Tiempo transcurrido">{fmtMs(c.elapsedMs)}<span className="sr-only"> transcurridos</span></span>}
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
                {c.state === 'error' && onRetryFrom && (() => {
                  const o = retry?.[c.stage!];
                  if (!o) return null;
                  return o.ok ? (
                    <button className="link" onClick={() => onRetryFrom(c.stage!)} title={o.reuse.length ? `Reutiliza: ${o.reuse.map((r) => REUSE_LABELS[r]).join(', ')}` : 'Empieza desde cero'}>
                      Reintentar desde este paso{o.reuse.length ? ` (reutiliza ${o.reuse.map((r) => REUSE_LABELS[r]).join(', ')})` : ''}
                    </button>
                  ) : (
                    <span className="small muted">{o.reason}</span>
                  );
                })()}
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
            {open.state === 'error' && job.error && <pre className="log-box">{redactPaths(job.error)}</pre>}
            {open.state !== 'error' && job.message && <p className="small muted">{job.message}</p>}
            {details}
          </>
        )}
      </Modal>
    </>
  );
}
