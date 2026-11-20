import { useEffect, useState } from 'react';
import type { Clip, Job } from '../../shared/types';
import { formatTime } from '../../shared/validation';
import { LAYOUT_LABELS } from '../../shared/layouts';
import { EditClipModal } from './ClipEditor';
import { readyCount } from '../../shared/clipEdit';
import { api, errMsg } from '../api';
import { PublishBadges, PublishModal, usePublish } from './Publish';
import { PublishedExportAction } from './PublishedExport';
import { ConfirmModal, Modal } from '../components/Modal';
import type { ClipPublish } from '../../shared/publish';

/** Confirmación de exportación (un clip o todos): muestra qué se exporta y a dónde. */
function ExportConfirm({ open, onClose, what, onConfirm }: { open: boolean; onClose: () => void; what: string; onConfirm: () => Promise<void> }) {
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) void api().getSettings().then((s) => setDir(s.exportDir)).catch(() => undefined);
  }, [open]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title="Confirmar exportación"
      footer={
        <>
          <button className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
                onClose();
              }
            }}
          >
            {busy ? 'Exportando…' : 'Exportar'}
          </button>
        </>
      }
    >
      <p>
        Se exportará <b>{what}</b> a la carpeta de exportación{dir ? ':' : '.'}
      </p>
      {dir && <p className="small muted path">{dir}</p>}
      <p className="small muted">Si ya existe un export de un clip, se sustituye por la versión actual.</p>
    </Modal>
  );
}

function ClipCard({ job, clip, pub, onPub, onError, onInfo }: { job: Job; clip: Clip; pub?: ClipPublish; onPub: (d: Record<string, ClipPublish>) => void; onError: (m: string) => void; onInfo: (m: string) => void }) {
  const [modal, setModal] = useState<'' | 'edit' | 'publish' | 'export'>('');
  const close = () => setModal('');

  // Clip archivado (interno borrado al liberar espacio): se reproduce su export verificado.
  const videoSrc = clip.archived
    ? clip.exportedPath
      ? `clip://export/${job.id}/${clip.id}`
      : null
    : clip.file
      ? `clip://job/${job.id}/${encodeURIComponent(clip.file)}?v=${encodeURIComponent(job.updatedAt)}`
      : null;
  return (
    <article className="clip" aria-label={`Clip ${clip.index}`}>
      {videoSrc ? <video src={videoSrc} controls preload="metadata" /> : <div className="video-ph">{clip.exportDeletedAfterPublish ? 'Export eliminado tras publicación' : 'Sin renderizar'}</div>}
      <div className="row">
        <b className="grow clip-title">{clip.title}</b>
        {clip.dirty && <span className="badge partial">Cambios sin renderizar</span>}
        {clip.archived && <span className="badge">Archivado · se muestra el export</span>}
        {clip.exportDeletedAfterPublish && <span className="badge">Export eliminado tras publicación</span>}
        {clip.composition?.needsReview && <span className="badge partial">Revisar composición</span>}
      </div>
      <PublishBadges pub={pub} />
      {clip.hook && <p className="hook">«{clip.hook}»</p>}
      <div className="muted small">
        {formatTime(clip.start)} → {formatTime(clip.end)} · {(clip.end - clip.start).toFixed(1)} s · {LAYOUT_LABELS[clip.layout ?? 'gameplay_full']}
      </div>
      {clip.layoutSuggestion && clip.layoutSuggestion !== (clip.layout ?? 'gameplay_full') && <div className="small muted">Hay una sugerencia de plantilla: ábrela en «Editar clip».</div>}
      <div className="row">
        <button disabled={!clip.file || clip.dirty} title={clip.dirty ? 'Vuelve a renderizar el clip antes de exportarlo' : undefined} aria-haspopup="dialog" onClick={() => setModal('export')}>
          Exportar
        </button>
        <button className="ghost" aria-haspopup="dialog" onClick={() => setModal('edit')}>
          Editar clip
        </button>
        <button className="ghost" aria-haspopup="dialog" onClick={() => setModal('publish')}>
          Preparar publicación
        </button>
        {clip.exportedPath && <span className="small ok">✓ exportado</span>}
      </div>
      <PublishedExportAction job={job} clip={clip} pub={pub} onError={onError} onInfo={onInfo} />

      <PublishModal open={modal === 'publish'} onClose={close} job={job} clip={clip} pub={pub} onData={onPub} onInfo={onInfo} />
      <EditClipModal open={modal === 'edit'} onClose={close} job={job} clip={clip} onError={onError} onInfo={onInfo} />
      <ExportConfirm
        open={modal === 'export'}
        onClose={close}
        what={`el clip ${clip.index} («${clip.title}»)`}
        onConfirm={async () => {
          try {
            onInfo(`Exportado a ${await api().exportClip(job.id, clip.id)}`);
          } catch (e) {
            onError(errMsg(e));
          }
        }}
      />
    </article>
  );
}

export function ResultsPage(props: { jobs: Job[]; selected: string | null; onSelect: (id: string) => void }) {
  const done = props.jobs.filter((j) => j.status === 'completed');
  const job = done.find((j) => j.id === props.selected) ?? done[0];
  const [msg, setMsg] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const [pub, setPub] = usePublish(job?.id);
  const [exportAllOpen, setExportAllOpen] = useState(false);
  const [retrOpen, setRetrOpen] = useState(false);
  const [retrBusy, setRetrBusy] = useState(false);

  if (!job)
    return (
      <section className="page">
        <h1>Resultados</h1>
        <div className="empty">Todavía no hay clips. Cuando un trabajo termine, aparecerán aquí.</div>
      </section>
    );
  const { ready, total } = readyCount(job.clips);

  return (
    <section className="page">
      <div className="row">
        <h1 className="grow">Resultados</h1>
        <select aria-label="Trabajo" value={job.id} onChange={(e) => props.onSelect(e.target.value)}>
          {done.map((j) => (
            <option key={j.id} value={j.id}>
              {(j.sourceTitle || j.url).slice(0, 60)}
            </option>
          ))}
        </select>
      </div>
      <p className="ready-count" role="status">
        <b>
          {ready}/{total} clips listos
        </b>
        {ready < total && ' · hay clips con cambios sin renderizar'}
      </p>
      <div className="row toolbar">
        <button onClick={() => api().openJobFolder(job.id).catch((e) => setMsg({ kind: 'error', text: errMsg(e) }))}>Abrir carpeta de resultados</button>
        <button aria-haspopup="dialog" onClick={() => setExportAllOpen(true)}>
          Exportar todos
        </button>
        <ExportConfirm
          open={exportAllOpen}
          onClose={() => setExportAllOpen(false)}
          what={`los ${job.clips.length} clips de este trabajo`}
          onConfirm={async () => {
            try {
              const n = await api().exportAll(job.id);
              setMsg({ kind: 'info', text: `${n} clips exportados.` });
            } catch (e) {
              setMsg({ kind: 'error', text: errMsg(e) });
            }
          }}
        />
        <button className="ghost" onClick={() => api().openExportFolder()}>
          Abrir carpeta de exportación
        </button>
        <button className="ghost" aria-haspopup="dialog" onClick={() => setRetrOpen(true)}>
          Reprocesar sólo transcripción
        </button>
        <ConfirmModal
          open={retrOpen}
          title="Reprocesar sólo transcripción"
          confirmLabel={retrBusy ? 'Transcribiendo…' : 'Volver a transcribir'}
          busy={retrBusy}
          onClose={() => !retrBusy && setRetrOpen(false)}
          onConfirm={async () => {
            setRetrBusy(true);
            try {
              const j = await api().retranscribeJob(job.id);
              setMsg({ kind: 'info', text: j.message });
            } catch (e) {
              setMsg({ kind: 'error', text: errMsg(e) });
            } finally {
              setRetrBusy(false);
              setRetrOpen(false);
            }
          }}
        >
          <p>Vuelve a transcribir el audio de este trabajo con el modelo e idioma de Configuración, sin descargar ni analizar de nuevo. La transcripción anterior se conserva.</p>
          <p className="small muted">Los subtítulos editados a mano no se tocan. Después, vuelve a renderizar los clips para aplicar los subtítulos nuevos.</p>
        </ConfirmModal>
      </div>
      {job.resultSummary && (
        <div className={`banner ${job.analysis && job.analysis.obtained < job.analysis.effectiveTarget ? 'warn' : 'info'}`}>{job.resultSummary}</div>
      )}
      {msg && (
        <div className={`banner ${msg.kind === 'error' ? 'error' : 'info'}`} role="alert">
          {msg.text}
        </div>
      )}
      <div className="gallery">
        {job.clips.map((c) => (
          <ClipCard key={c.id} job={job} clip={c} pub={pub[c.id]} onPub={(d) => setPub(job.id, d)} onError={(t) => setMsg({ kind: 'error', text: t })} onInfo={(t) => setMsg({ kind: 'info', text: t })} />
        ))}
      </div>
    </section>
  );
}
