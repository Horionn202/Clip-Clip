import { Fragment, useEffect, useState } from 'react';
import { clipLengthLabel, type Clip, type ClipEditorial, type Job } from '../../shared/types';
import { EVENT_INFO, isVerifiedHighlight } from '../../shared/highlights';
import { SEGMENT_FILTERS, filterSegments, segmentLabel, type SegmentFilter } from '../../shared/fullSplit';
import { MOMENT_LABELS } from '../../shared/editorialBrief';
import { formatTime } from '../../shared/validation';
import { LAYOUT_LABELS } from '../../shared/layouts';
import { EditClipModal } from './ClipEditor';
import { readyCount } from '../../shared/clipEdit';
import { api, errMsg } from '../api';
import { PublishBadges, PublishModal, usePublish } from './Publish';
import { PublishedExportAction } from './PublishedExport';
import { ConfirmModal, Modal } from '../components/Modal';
import type { ClipPublish } from '../../shared/publish';
import { Button, EmptyState, Menu, PageHeader, StatusPill, type ToastData } from '../components/ui';
import type { ClipPlan } from '../../shared/bulk';
import { humanSize } from '../../shared/storage';
import { releaseMedia } from '../releaseMedia';
import { selectionState, setMany, toggle } from '../../shared/bulk';
import { jobLabel } from './Jobs';

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

/** Destacado verificado con su prueba, u «Otro momento» sin nada que parezca una recomendación. */
function ClipWhy({ e, segment = false }: { e: ClipEditorial; segment?: boolean }) {
  const v = e.verification;
  if (!v || !isVerifiedHighlight(e))
    return (
      <div className="clip-why small">
        <div className="clip-why-row">
          <span className="clip-other">{segment ? "Otro segmento" : "Otro momento"}</span>
          {e.auto && <span className="muted">Elegido por la app</span>}
        </div>
        <p className="muted clip-why-text">Sin verificar. Puedes revisarlo y subirlo si te gusta.</p>
        {e.notVerified && <p className="muted clip-why-text">No se destacó: {e.notVerified}</p>}
      </div>
    );
  return (
    <div className="clip-why small">
      <div className="clip-why-row">
        <span className="clip-featured" title={`Verificado con ${v.model}`}>
          <span aria-hidden="true">★</span> Destacado verificado · {v.confidence}%
        </span>
        <span className="clip-why-tag">{EVENT_INFO[v.eventType].label}</span>
      </div>
      <p className="clip-why-text">{e.why}</p>
      <p className="muted clip-why-text clip-evidence">
        Evidencia: ‘{v.quote}’ · {formatTime(v.evidenceStart)}
      </p>
    </div>
  );
}

function ClipCard({ job, clip, pub, onPub, onError, onInfo, selecting, selected, onToggle, segment }: { segment?: { n: number; of: number }; job: Job; clip: Clip; pub?: ClipPublish; onPub: (d: Record<string, ClipPublish>) => void; onError: (m: string) => void; onInfo: (m: string) => void; selecting: boolean; selected: boolean; onToggle: () => void }) {
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
    <article className={`clip ${selected ? 'selected' : ''}`} aria-label={`Clip ${clip.index}: ${clip.title}`}>
      {selecting && (
        <label className="select-box clip-select">
          <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Seleccionar el clip ${clip.index}`} />
        </label>
      )}
      {videoSrc ? <video src={videoSrc} controls preload="metadata" /> : <div className="video-ph">{clip.exportDeletedAfterPublish ? 'Exportado eliminado tras publicar' : 'Sin renderizar'}</div>}
      <div>
        {segment && (
          <div className="small segment-label">
            <b>{segmentLabel(segment.n, segment.of)}</b> · {formatTime(clip.start)} – {formatTime(clip.end)}
            {clip.editorial && (
              <>
                {' '}· {clip.editorial.score}/100{clip.editorial.momentType ? ` · ${MOMENT_LABELS[clip.editorial.momentType]}` : ''}
              </>
            )}
          </div>
        )}
        <div className="clip-title">{clip.title}</div>
        <div className="muted small">
          {clipLengthLabel(clip.end - clip.start)} · {formatTime(clip.start)} → {formatTime(clip.end)} · {LAYOUT_LABELS[clip.layout ?? 'gameplay_full']}
        </div>
      </div>
      <div className="row" style={{ gap: 'var(--s-2)' }}>
        {clip.exportedPath && <StatusPill tone="ok">Exportado</StatusPill>}
        {clip.dirty && <StatusPill tone="warn">Pendiente de render</StatusPill>}
        {clip.archived && <StatusPill>Archivado</StatusPill>}
        {clip.composition?.needsReview && <StatusPill tone="warn">Revisar cámara</StatusPill>}
        <PublishBadges pub={pub} />
      </div>
      {clip.hook && <p className="hook small muted">«{clip.hook}»</p>}
      {clip.editorial && <ClipWhy e={clip.editorial} segment={!!segment} />}
      <div className="clip-actions">
        <Button variant="primary" icon="download" disabled={!clip.file || clip.dirty} title={clip.dirty ? 'Vuelve a renderizar el clip antes de exportarlo' : undefined} aria-haspopup="dialog" onClick={() => setModal('export')}>
          Exportar
        </Button>
        <Button icon="edit" aria-haspopup="dialog" onClick={() => setModal('edit')}>
          Editar clip
        </Button>
        <Button icon="publish" aria-haspopup="dialog" onClick={() => setModal('publish')}>
          Publicar
        </Button>
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

/** Confirmación de borrado de clips: cuántos, cuánto se recupera y qué pasa con los exportados. */
function ClipDeleteModal(props: { jobId: string; ids: string[]; onClose: () => void; onDone: (r: { batchId: string; clips: number; bytes: number; wholeJob: boolean; undoUntil: string }) => void; onLocked: (msg: string, retry: () => Promise<boolean>) => void; onError: (msg: string) => void }) {
  const open = props.ids.length > 0;
  const [delExports, setDelExports] = useState(false);
  const [plan, setPlan] = useState<ClipPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (open) setDelExports(false);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    setPlan(null);
    setErr('');
    void api()
      .clipsDeletePlan(props.jobId, props.ids, { deleteExports: delExports })
      .then(setPlan)
      .catch((e) => setErr(errMsg(e)));
  }, [open, props.jobId, props.ids, delExports]);
  /**
   * `retrying`: llamada desde el aviso «Cerrar vista previa y reintentar», con el modal ya cerrado; los errores
   * van a un aviso visible y el resultado le dice al aviso si debe cerrarse (true) o seguir con su botón (false).
   */
  const run = async (retrying = false): Promise<boolean> => {
    const fail = (m: string, isLocked: boolean): false => {
      if (retrying) props.onError(isLocked ? `Sigue bloqueado. ${m}` : m);
      else if (isLocked) props.onLocked(m, () => run(true));
      else setErr(m);
      return false;
    };
    setBusy(true);
    setErr('');
    // Los reproductores de la página tienen los MP4 abiertos: se liberan antes de mover nada.
    const restore = releaseMedia();
    try {
      const r = await api().clipsDelete(props.jobId, props.ids, { deleteExports: delExports });
      // Trabajo completo que no se pudo mover (bloqueado): no es un éxito; se ofrece reintentar.
      if (r.wholeJob && r.deletedIds.length === 0) {
        const m = r.errors[0] ?? 'No se pudo eliminar el trabajo.';
        // Bloqueado: en el reintento el aviso sigue con su botón; otro error lo cierra (ya se ha mostrado).
        return fail(m, r.locked.length > 0) || (retrying && !r.locked.length);
      }
      props.onDone({ batchId: r.batchId, clips: r.clips, bytes: r.freedBytes, wholeJob: r.wholeJob, undoUntil: r.undoUntil });
      return true;
    } catch (e) {
      const m = errMsg(e);
      const isLocked = /vista previa/.test(m);
      return fail(m, isLocked) || (retrying && !isLocked);
    } finally {
      setBusy(false);
      // Los reproductores que siguen (fallo o clips no borrados) vuelven a tener su vídeo.
      setTimeout(restore, 0);
    }
  };
  const hasExports = !!plan && plan.exportCount + plan.keptExports > 0;
  return (
    <Modal
      open={open}
      onClose={() => !busy && props.onClose()}
      size="sm"
      title={plan?.wholeJob ? 'Eliminar todos los clips de este trabajo' : 'Eliminar clips seleccionados'}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant={delExports ? 'danger-solid' : 'danger'} icon="trash" loading={busy} disabled={!plan} onClick={() => void run()}>
            Enviar a la Papelera
          </Button>
        </>
      }
    >
      {err && (
        <div className="banner error small" role="alert">
          {err}
        </div>
      )}
      {!plan && !err && <p className="small muted">Calculando…</p>}
      {plan && (
        <>
          <ul className="summary-list">
            <li>
              <span>Clips</span>
              <b>{plan.clips}</b>
            </li>
            <li>
              <span>Espacio recuperable</span>
              <b>{humanSize(plan.bytes + plan.exportBytes)}</b>
            </li>
            <li>
              <span>MP4 exportados</span>
              <b>{delExports ? `${plan.exportCount} a la Papelera (${humanSize(plan.exportBytes)})` : `${plan.keptExports} se conservan`}</b>
            </li>
          </ul>
          {hasExports && (
            <fieldset className="cleanup-options">
              <legend className="small">Archivos exportados de estos clips</legend>
              <label className="check">
                <input type="radio" name="clipexp" checked={!delExports} onChange={() => setDelExports(false)} />
                <span>Conservar los archivos exportados</span>
              </label>
              <label className="check">
                <input type="radio" name="clipexp" checked={delExports} onChange={() => setDelExports(true)} />
                <span>Enviar también los archivos exportados a la Papelera</span>
              </label>
            </fieldset>
          )}
          {plan.wholeJob && (
            <div className="banner warn small" role="status">
              Son todos los clips del trabajo: se eliminará el <b>trabajo completo</b> (vídeo original, transcripción e historial), para no dejar un registro vacío.
            </div>
          )}
          <p className="small muted">Todo va a la Papelera de reciclaje y tendrás unos segundos para deshacerlo. El espacio se libera definitivamente al vaciar la Papelera de Windows.</p>
        </>
      )}
    </Modal>
  );
}

export function ResultsPage(props: { jobs: Job[]; selected: string | null; onSelect: (id: string) => void; toast?: (t: Omit<ToastData, 'id'>) => void; onJobsChanged?: () => void }) {
  const done = props.jobs.filter((j) => j.status === 'completed');
  const job = done.find((j) => j.id === props.selected) ?? done[0];
  const [msg, setMsg] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const [pub, setPub] = usePublish(job?.id);
  const [exportAllOpen, setExportAllOpen] = useState(false);
  const [retrOpen, setRetrOpen] = useState(false);
  const [retrPrecise, setRetrPrecise] = useState(false);
  const [retrBusy, setRetrBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [segFilter, setSegFilter] = useState<SegmentFilter>('todos');
  /** Exportar a «Destacados»: ids y espacio que ocuparán las copias (nunca dentro de la app). */
  const [hlExport, setHlExport] = useState<{ ids: string[]; files: number; bytes: number; freeBytes?: number; dir: string } | null>(null);
  const askExportHighlights = async (ids: string[]) => {
    try {
      if (!ids.length) return setMsg({ kind: 'error', text: 'No hay destacados renderizados para exportar.' });
      setHlExport({ ids, ...(await api().exportPlan(job!.id, ids)) });
    } catch (e) {
      setMsg({ kind: 'error', text: errMsg(e) });
    }
  };
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [delIds, setDelIds] = useState<string[]>([]);
  useEffect(() => setSel(new Set()), [job?.id]);

  if (!job)
    return (
      <section className="page">
        <PageHeader title="Resultados" />
        <EmptyState icon="results" title="Todavía no hay clips.">
          Cuando un trabajo termine, sus clips aparecerán aquí.
        </EmptyState>
      </section>
    );
  const { ready, total } = readyCount(job.clips);
  // Destacados verificados primero (por confianza); después el resto en el orden del vídeo.
  const isStar = (c: Clip) => isVerifiedHighlight(c.editorial);
  const featured = job.clips.filter(isStar).sort((a, b) => b.editorial!.verification!.confidence - a.editorial!.verification!.confidence);
  const hasFeatured = featured.length > 0;
  // «Dividir video completo»: pestañas por tipo de segmento (los destacados son los mismos clips, no copias).
  const isSplit = job.creationMode === 'full-split';
  const segOrder = new Map([...job.clips].sort((x, y) => x.start - y.start).map((c, i) => [c.id, i + 1]));
  const ordered = isSplit ? filterSegments(job.clips, segFilter, isStar) : hasFeatured ? [...featured, ...job.clips.filter((c) => !isStar(c))] : job.clips;
  const counts = isSplit ? Object.fromEntries(SEGMENT_FILTERS.map((f) => [f.id, filterSegments(job.clips, f.id, isStar).length])) : {};
  // Trabajos de versiones anteriores: su resumen hablaba de destacados que nunca se verificaron.
  const a = job.analysis;
  const unverifiedLegacy = a?.minScore !== undefined && !a.verification && (a.featured ?? 0) > 0;
  const summary = unverifiedLegacy ? `${job.clips.length} clips generados. Trabajo anterior al verificador: sus destacados no están verificados.` : job.resultSummary;
  const exportable = job.clips.filter((c) => c.file && !c.dirty).map((c) => c.id);
  const selState = selectionState(sel, job.clips.map((c) => c.id));

  return (
    <section className="page">
      <PageHeader
        title="Resultados"
        subtitle={
          <span role="status">
            <b>
              {ready}/{total} clips listos
            </b>
            {ready < total && ' · hay clips con cambios sin renderizar'}
          </span>
        }
        actions={
          <>
            <select aria-label="Trabajo" value={job.id} onChange={(e) => props.onSelect(e.target.value)} style={{ maxWidth: 320 }}>
              {done.map((j) => (
                <option key={j.id} value={j.id}>
                  {jobLabel(j).slice(0, 70)}
                </option>
              ))}
            </select>
            <Button variant="ghost" aria-pressed={selecting} onClick={() => (setSelecting((v) => !v), setSel(new Set()))}>
              {selecting ? 'Terminar selección' : 'Seleccionar'}
            </Button>
            {isSplit && (
              <Button variant="primary" icon="download" aria-haspopup="dialog" disabled={!featured.some((c) => exportable.includes(c.id))} onClick={() => void askExportHighlights(featured.filter((c) => exportable.includes(c.id)).map((c) => c.id))}>
                Exportar destacados
              </Button>
            )}
            <Button icon="download" aria-haspopup="dialog" onClick={() => setExportAllOpen(true)}>
              Exportar todos
            </Button>
            <Menu
              label="Más"
              items={[
                { label: 'Abrir carpeta de resultados', onSelect: () => void api().openJobFolder(job.id).catch((e) => setMsg({ kind: 'error', text: errMsg(e) })) },
                { label: 'Abrir carpeta de exportación', onSelect: () => void api().openExportFolder() },
                { label: 'Reprocesar transcripción…', onSelect: () => setRetrOpen(true) },
                { label: 'Eliminar todos los clips de este trabajo…', danger: true, onSelect: () => setDelIds(job.clips.map((c) => c.id)) },
              ]}
            />
          </>
        }
      />
      {selecting && sel.size > 0 && (
        <div className="bulk-bar" role="toolbar" aria-label="Acciones con los clips seleccionados">
          <span className="bulk-count" aria-live="polite">
            {sel.size} clip{sel.size === 1 ? '' : 's'} seleccionado{sel.size === 1 ? '' : 's'}
          </span>
          <Button
            variant="primary"
            icon="download"
            loading={bulkBusy}
            onClick={async () => {
              setBulkBusy(true);
              let n = 0;
              let fail = '';
              for (const id of sel) {
                if (!exportable.includes(id)) continue;
                try {
                  await api().exportClip(job.id, id);
                  n++;
                } catch (e) {
                  fail = errMsg(e);
                }
              }
              setBulkBusy(false);
              setSel(new Set());
              setMsg(fail ? { kind: 'error', text: `${n} exportados; error: ${fail}` } : { kind: 'info', text: `${n} clip${n === 1 ? '' : 's'} exportado${n === 1 ? '' : 's'}.` });
            }}
          >
            Exportar seleccionados
          </Button>
          {isSplit && (
            <Button icon="download" aria-haspopup="dialog" onClick={() => void askExportHighlights([...sel].filter((id) => exportable.includes(id)))}>
              Exportar a «Destacados»
            </Button>
          )}
          <Button variant="danger" icon="trash" aria-haspopup="dialog" onClick={() => setDelIds([...sel])}>
            Eliminar seleccionados…
          </Button>
          <Button variant="ghost" onClick={() => setSel(new Set())}>
            Deseleccionar
          </Button>
        </div>
      )}
      {selecting && (
        <div className="list-toolbar">
          <label className="check">
            <input
              type="checkbox"
              checked={selState === 'all'}
              ref={(el) => {
                if (el) el.indeterminate = selState === 'some';
              }}
              onChange={(e) => setSel((x) => setMany(x, job.clips.map((c) => c.id), e.target.checked))}
            />
            <span>Seleccionar todos los clips ({job.clips.length})</span>
          </label>
          <span className="small muted">Si eliges todos los clips, se elimina el trabajo completo.</span>
        </div>
      )}
      <div style={{ display: 'contents' }}>
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
        <ConfirmModal
          open={retrOpen}
          title="Reprocesar sólo transcripción"
          confirmLabel={retrBusy ? 'Transcribiendo…' : 'Volver a transcribir'}
          busy={retrBusy}
          onClose={() => !retrBusy && setRetrOpen(false)}
          onConfirm={async () => {
            setRetrBusy(true);
            try {
              const j = await api().retranscribeJob(job.id, { precise: retrPrecise });
              setMsg({ kind: 'info', text: j.message });
            } catch (e) {
              setMsg({ kind: 'error', text: errMsg(e) });
            } finally {
              setRetrBusy(false);
              setRetrOpen(false);
            }
          }}
        >
          <p>Vuelve a transcribir el audio de este trabajo con el modelo e idioma de Configuración, sin descargar ni analizar de nuevo. La transcripción anterior (y la original) se conservan.</p>
          {job.metrics?.whisperModel && (
            <p className="small">
              Actual: modelo <b>{job.metrics.whisperModel}</b> · idioma {job.metrics.languageRequested === 'auto' || !job.metrics.languageRequested ? 'automático' : job.metrics.languageRequested}
              {job.metrics.languageDetected ? ` (detectado: ${job.metrics.languageDetected})` : ''} · {job.metrics.device === 'cuda' ? 'GPU' : 'CPU'} ·{' '}
              {job.metrics.wordTimestamps === false ? 'sin tiempos por palabra (no hay karaoke)' : 'con tiempos por palabra'}
              {job.metrics.preciseTranscription ? ' · modo preciso' : ''}
            </p>
          )}
          <label className="check">
            <input type="checkbox" checked={retrPrecise} onChange={(e) => setRetrPrecise(e.target.checked)} />
            <span>Reprocesar transcripción en modo preciso (más lento: búsqueda más amplia y filtrado de silencios)</span>
          </label>
          <p className="small muted">Ninguna transcripción es perfecta: si una palabra sale mal, corrígela en el editor del clip (pestaña Subtítulos).</p>
          <p className="small muted">Los subtítulos editados a mano no se tocan. Después, vuelve a renderizar los clips para aplicar los subtítulos nuevos.</p>
        </ConfirmModal>
      </div>
      {job.resultSummary && (
        // Menos clips que el máximo con el filtro de calidad no es un fallo: aviso informativo, no de error.
        <div className={`banner ${job.analysis && job.analysis.obtained < job.analysis.effectiveTarget && job.analysis.minScore === undefined ? 'warn' : 'info'}`}>{summary}</div>
      )}
      {job.analysis?.brief && (
        <p className="small muted">
          Tema detectado: <b>{job.analysis.brief.mainTopic}</b>
          {job.analysis.brief.source === 'local' ? ' (deducido del título)' : ''}
        </p>
      )}
      {msg && (
        <div className={`banner ${msg.kind === 'error' ? 'error' : 'info'}`} role="alert">
          {msg.text}
        </div>
      )}
      {isSplit && (
        <div className="seg segment-tabs" role="tablist" aria-label="Filtrar segmentos">
          {SEGMENT_FILTERS.map((f) => (
            <button key={f.id} role="tab" aria-selected={segFilter === f.id} className={segFilter === f.id ? 'on' : ''} onClick={() => setSegFilter(f.id)}>
              {f.label} ({counts[f.id] ?? 0})
            </button>
          ))}
        </div>
      )}
      {hlExport && (
        <ConfirmModal
          open
          title="Exportar destacados"
          confirmLabel={`Exportar ${hlExport.files} clip${hlExport.files === 1 ? '' : 's'}`}
          onClose={() => setHlExport(null)}
          onConfirm={async () => {
            const p = hlExport;
            setHlExport(null);
            try {
              const r = await api().exportClipsTo(job.id, p.ids, 'Destacados');
              setMsg({ kind: 'info', text: `${r.count} clip${r.count === 1 ? '' : 's'} exportado${r.count === 1 ? '' : 's'} a ${r.dir}` });
            } catch (e) {
              setMsg({ kind: 'error', text: errMsg(e) });
            }
          }}
        >
          <p>
            Se copiarán {hlExport.files} clip{hlExport.files === 1 ? '' : 's'} a <code>{hlExport.dir}</code>.
          </p>
          <p className="small">
            Ocuparán <b>{humanSize(hlExport.bytes)}</b> más en esa carpeta{hlExport.freeBytes !== undefined ? ` (libres: ${humanSize(hlExport.freeBytes)})` : ''}. Dentro de la app no se duplica nada: un destacado es el mismo clip.
          </p>
        </ConfirmModal>
      )}
      <div className="gallery">
        {isSplit && ordered.length === 0 && <p className="muted small">No hay segmentos en esta pestaña.</p>}
        {ordered.map((c, i) => (
          <Fragment key={c.id}>
            {!isSplit && hasFeatured && i === 0 && <h3 className="gallery-h">★ Destacados verificados</h3>}
            {!isSplit && hasFeatured && i === featured.length && <h3 className="gallery-h">Otros momentos</h3>}
          <ClipCard segment={isSplit ? { n: segOrder.get(c.id) ?? 0, of: job.clips.length } : undefined} job={job} clip={c} selecting={selecting} selected={sel.has(c.id)} onToggle={() => setSel((x) => toggle(x, c.id))} pub={pub[c.id]} onPub={(d) => setPub(job.id, d)} onError={(t) => setMsg({ kind: 'error', text: t })} onInfo={(t) => setMsg({ kind: 'info', text: t })} />
          </Fragment>
        ))}
      </div>
      <ClipDeleteModal
        jobId={job.id}
        ids={delIds}
        onClose={() => setDelIds([])}
        onLocked={(m, retry) => {
          setDelIds([]);
          // El aviso espera al reintento: sólo se cierra si terminó (con éxito o con un error ya mostrado).
          props.toast?.({ kind: 'error', text: m, ttl: 0, action: { label: 'Cerrar vista previa y reintentar', run: retry } });
        }}
        onError={(m) => props.toast?.({ kind: 'error', text: m })}
        onDone={(r) => {
          setDelIds([]);
          setSel(new Set());
          if (r.wholeJob) props.onJobsChanged?.();
          const undoToast = (text: string, until: string): void =>
            props.toast?.({
              text,
              expiresAt: Date.parse(until),
              action: {
                label: 'Deshacer',
                run: () =>
                  api()
                    .bulkUndo(r.batchId)
                    .then(({ pending, undoUntil: again, message }) => {
                      props.onJobsChanged?.();
                      // Con pendientes, el plazo se renovó: un aviso nuevo con su botón sustituye a éste.
                      if (pending && again) undoToast(message ?? 'Vuelve a pulsar «Deshacer».', again);
                      return true;
                    })
                    .catch((e) => (props.toast?.({ kind: 'error', text: errMsg(e) }), false)),
              },
            });
          undoToast(`${r.clips} clip${r.clips === 1 ? '' : 's'} enviado${r.clips === 1 ? '' : 's'} a la Papelera · ${humanSize(r.bytes)} recuperables${r.wholeJob ? ' (trabajo completo)' : ''}. El espacio se liberará definitivamente cuando vacíes la Papelera de Windows.`, r.undoUntil);
        }}
      />
    </section>
  );
}
