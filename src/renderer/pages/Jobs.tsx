import { useEffect, useMemo, useState } from 'react';
import { STATUS_LABELS, type Job } from '../../shared/types';
import { JOB_FILTERS, countByFilter, currentEta, filterJobs, fmtMs, renderCounter, simpleCause, type JobFilter, type RetryOption } from '../../shared/jobView';
import { humanDuration } from '../../shared/estimates';
import { TEMP_ONLY, humanSize } from '../../shared/storage';
import { TYPED_CONFIRM, pruneSelection, selectionState, setMany, toggle, type BulkPlan } from '../../shared/bulk';
import { api, errMsg } from '../api';
import { releaseMedia } from '../releaseMedia';
import { JobReport } from './Performance';
import { FreeSpaceDialog } from './Storage';
import { ConfirmModal, Modal } from '../components/Modal';
import { PipelineCards } from '../components/PipelineCards';
import { SourceErrorModal } from '../components/SourceErrorModal';
import { describeSourceError } from '../../shared/sourceErrors';
import { prefillFromJob, type HomePrefill } from '../../shared/homePrefill';
import { Button, EmptyState, Icon, Menu, PageHeader, StatusPill, type ToastData, type Tone } from '../components/ui';

const PAGE_SIZE = 20;

/** Título legible: el del vídeo; si no lo hay, el nombre del archivo o el dominio (nunca la URL entera). */
export function jobLabel(j: Pick<Job, 'sourceTitle' | 'url'>): string {
  if (j.sourceTitle) return j.sourceTitle;
  return sourceLabel(j.url) || 'Trabajo sin título';
}
export function sourceLabel(url: string): string {
  if (url.startsWith('local:')) return url.slice(6).split(/[\\/]/).pop() ?? '';
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.length > 1 ? u.pathname : ''}`;
  } catch {
    return url;
  }
}

const STATUS_TONE = (s: Job['status']): Tone => (s === 'completed' ? 'ok' : s === 'failed' ? 'err' : s === 'cancelled' ? 'warn' : s === 'queued' ? 'neutral' : 'active');

export function DeviceBadge({ job }: { job: Job }) {
  const dev = job.metrics?.device ?? job.engine?.device;
  if (!dev) return null;
  return <StatusPill tone={dev === 'cuda' ? 'ok' : 'warn'}>{dev === 'cuda' ? 'GPU' : 'CPU'}</StatusPill>;
}

/** «obtenidos/meta»; parcial si quedó por debajo de la meta efectiva. */
export function ResultBadge({ job }: { job: Job }) {
  const a = job.analysis;
  if (!a || job.status !== 'completed') return null;
  const got = job.clips.filter((c) => c.file).length;
  const partial = got < a.effectiveTarget;
  return (
    <StatusPill tone={partial ? 'warn' : 'ok'}>
      {got}/{a.effectiveTarget} clips{partial ? ' · parcial' : ''}
    </StatusPill>
  );
}

function Thumb({ job }: { job: Job }) {
  const t = job.clips.find((c) => c.thumb)?.thumb;
  const [broken, setBroken] = useState(false);
  return t && !broken ? (
    <img className="job-thumb" src={`clip://frame/${job.id}/${t}`} alt="" onError={() => setBroken(true)} />
  ) : (
    <div className="job-thumb ph" aria-hidden="true">
      <Icon name="film" size={24} />
    </div>
  );
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

/** Franja «Detalle del proceso» bajo las tarjetas del pipeline. El detalle técnico va en un modal. */
function ProcessStrip({ job, now, onTech }: { job: Job; now: number; onTech: () => void }) {
  const stageElapsed = job.stageStartedAt ? now - Date.parse(job.stageStartedAt) : undefined;
  const total = now - Date.parse(job.createdAt);
  const eta = currentEta(job, stageElapsed);
  const counter = renderCounter(job);
  return (
    <section className="process-strip" aria-label="Detalle del proceso">
      <div>
        <span className="ps-k">Tiempo transcurrido</span>
        <span className="ps-v">{Number.isFinite(total) ? fmtMs(total) : '—'}</span>
      </div>
      <div>
        <span className="ps-k">Estado actual</span>
        <span className="ps-v" role="status" aria-live="polite">
          {STATUS_LABELS[job.status]}
          {counter ? ` · ${counter}` : ''}
          {job.progress > 0 ? ` · ${Math.round(job.progress * 100)} %` : ''}
        </span>
      </div>
      <div className="ps-msg">
        <span className="ps-k">Mensaje</span>
        <span className="ps-v">{job.message || '—'}</span>
      </div>
      <div>
        <span className="ps-k">Tiempo estimado</span>
        <span className="ps-v">{eta !== null ? `≈ ${fmtMs(eta)}` : 'Calculando…'}</span>
      </div>
      <Button variant="link" aria-haspopup="dialog" onClick={onTech}>
        Ver detalle técnico
      </Button>
    </section>
  );
}

/** Fallos de descarga cuyo modal ya se mostró en esta sesión (no se vuelve a abrir solo). */
const shownFailures = new Set<string>();

function JobCard(props: {
  job: Job;
  now: number;
  selecting: boolean;
  selected: boolean;
  onToggle: () => void;
  onOpen: (id: string) => void;
  onDeleteOne: (id: string) => void;
  onRetried: () => void;
  goDiagnostics: () => void;
  onPrefill: (p: HomePrefill) => void;
  toast: (t: Omit<ToastData, 'id'>) => void;
}) {
  const j = props.job;
  // El modal de error de descarga se abre solo una vez, cuando el trabajo acaba de fallar.
  const fresh = !!j.sourceFailure && j.status === 'failed' && !shownFailures.has(j.id) && Date.now() - Date.parse(j.sourceFailure.at) < 10 * 60_000;
  const [sourceOpen, setSourceOpen] = useState(fresh);
  useEffect(() => {
    if (fresh) {
      shownFailures.add(j.id);
      setSourceOpen(true);
    }
  }, [fresh, j.id]);
  const activeJob = !['completed', 'failed', 'cancelled'].includes(j.status);
  const [modal, setModal] = useState<'' | 'cancel' | 'detail' | 'temp'>('');
  const [retry, setRetry] = useState<Record<string, RetryOption> | undefined>();
  const [temp, setTemp] = useState(0);
  const [busy, setBusy] = useState('');
  useEffect(() => {
    if (j.status === 'failed' || j.status === 'cancelled') void api().retryOptions(j.id).then(setRetry).catch(() => setRetry(undefined));
  }, [j.id, j.status]);
  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      props.toast({ kind: 'error', text: errMsg(e) });
    } finally {
      setBusy('');
    }
  };
  const got = j.clips.filter((c) => c.file).length;
  const model = j.metrics?.whisperModel;

  return (
    <article className={`card job-card ${props.selected ? 'selected' : ''}`} aria-label={`${STATUS_LABELS[j.status]}: ${jobLabel(j)}`}>
      <div className={`job-top ${props.selecting && !activeJob ? '' : 'no-select'}`}>
        {props.selecting && !activeJob && (
          <label className="select-box">
            <input type="checkbox" checked={props.selected} onChange={props.onToggle} aria-label={`Seleccionar ${jobLabel(j)}`} />
          </label>
        )}
        <Thumb job={j} />
        <div className="grow">
          <div className="job-title" title={jobLabel(j)}>
            {jobLabel(j)}
          </div>
          <div className="job-src" title={sourceLabel(j.url)}>
            {sourceLabel(j.url)}
          </div>
          <div className="job-meta">
            <StatusPill tone={STATUS_TONE(j.status)} dot>
              {STATUS_LABELS[j.status]}
            </StatusPill>
            {j.localFile && <StatusPill>Archivo local</StatusPill>}
            {j.creationMode === "full-split" && <StatusPill>Vídeo completo{j.split?.segments ? ` · ${j.split.segments} segmentos` : ""}</StatusPill>}
            <StatusPill>Clips de {j.preset} s</StatusPill>
            {/* En «Vídeo completo» no hay máximo: se generan todos los segmentos. */}
            {j.creationMode !== 'full-split' && <StatusPill>{j.status === 'completed' ? `${got} de hasta ${j.analysis?.effectiveTarget ?? j.maxClips} clips` : `Hasta ${j.maxClips} clips`}</StatusPill>}
            {j.sourceDuration ? <StatusPill>Vídeo de {humanDuration(j.sourceDuration)}</StatusPill> : null}
            {model && <StatusPill>Whisper {model}</StatusPill>}
            <DeviceBadge job={j} />
            {j.archivedExportsOnly && <StatusPill tone="warn">Sólo exportados</StatusPill>}
          </div>
        </div>
        <div className="job-actions">
          {activeJob && (
            <Button variant="danger" aria-haspopup="dialog" onClick={() => setModal('cancel')}>
              Cancelar
            </Button>
          )}
          {j.status === 'completed' && (
            <Button variant="primary" onClick={() => props.onOpen(j.id)}>
              Abrir resultados
            </Button>
          )}
          {(j.status === 'failed' || j.status === 'cancelled') && (
            <Button variant="primary" loading={busy === 'retry'} onClick={() => act('retry', async () => (await api().retryJob(j.id), props.onRetried()))}>
              Reintentar
            </Button>
          )}
          {!activeJob && !props.selecting && (
            <Menu
              label="Más"
              items={[
                { label: 'Abrir carpeta', onSelect: () => void act('folder', () => api().openJobFolder(j.id)), disabled: j.status !== 'completed' },
                {
                  label: 'Liberar temporales…',
                  onSelect: () =>
                    void act('temp', async () => {
                      const r = await api().analyzeStorage(TEMP_ONLY, j.id);
                      if (r.recoverableBytes === 0) return props.toast({ text: 'Este trabajo no tiene temporales que limpiar.' });
                      setTemp(r.recoverableBytes);
                      setModal('temp');
                    }),
                },
                { label: 'Ver informe', onSelect: () => setModal('detail') },
                { label: 'Eliminar del historial…', danger: true, onSelect: () => props.onDeleteOne(j.id) },
              ]}
            />
          )}
        </div>
      </div>

      {j.status === 'failed' && j.sourceFailure && (
        <div className="banner error small" role="alert">
          <span className="grow">{describeSourceError(j.sourceFailure).title}</span>
          <Button variant="link" aria-haspopup="dialog" onClick={() => setSourceOpen(true)}>
            Qué puedo hacer
          </Button>
        </div>
      )}
      {j.status === 'failed' && !j.sourceFailure && (
        <div className="banner error small" role="alert">
          <span className="grow">{simpleCause(j.error)}</span>
          <Button variant="link" onClick={props.goDiagnostics}>
            Ver diagnóstico
          </Button>
        </div>
      )}
      {j.sourceFailure && (
        <SourceErrorModal
          open={sourceOpen}
          failure={j.sourceFailure}
          onClose={() => setSourceOpen(false)}
          onAction={(a) => {
            setSourceOpen(false);
            if (a === 'retry-later') props.toast({ text: 'El trabajo queda en «Fallidos»: pulsa «Reintentar» cuando quieras, con la misma URL y ajustes.' });
            else props.onPrefill(prefillFromJob(j, a));
          }}
        />
      )}
      {j.status === 'completed' && j.resultSummary && <p className="small muted">{j.resultSummary}</p>}

      {(activeJob || j.status === 'failed' || j.status === 'cancelled') && (
        <PipelineCards
          job={j}
          now={activeJob ? props.now : Date.now()}
          retry={retry}
          details={<JobReport job={j} />}
          onRetryFrom={activeJob ? undefined : (stage) => act('retry', async () => (await api().retryJobFrom(j.id, stage), props.onRetried()))}
        />
      )}
      {activeJob && <ProcessStrip job={j} now={props.now} onTech={() => setModal('detail')} />}

      {!activeJob && (
        <div className="job-foot small muted">
          <span>{new Date(j.createdAt).toLocaleString('es-ES')}</span>
          {j.metrics?.totalMs !== undefined && <span>· {fmtMs(j.metrics.totalMs)} en total</span>}
          {j.bytesFreed ? <span>· {humanSize(j.bytesFreed)} liberados</span> : null}
        </div>
      )}

      <ConfirmModal
        open={modal === 'cancel'}
        title="Cancelar trabajo"
        confirmLabel="Cancelar trabajo"
        danger
        onClose={() => setModal('')}
        onConfirm={() => {
          setModal('');
          api().cancelJob(j.id).catch((e) => props.toast({ kind: 'error', text: errMsg(e) }));
        }}
      >
        <p>¿Cancelar este trabajo? Lo procesado hasta ahora no se usará.</p>
      </ConfirmModal>
      <ConfirmModal
        open={modal === 'temp'}
        title="Liberar temporales"
        confirmLabel={`Liberar ${humanSize(temp)}`}
        onClose={() => setModal('')}
        onConfirm={() =>
          act('temp', async () => {
            setModal('');
            const res = await api().cleanStorage(TEMP_ONLY, j.id);
            props.toast({ kind: res.errors.length ? 'error' : 'info', text: `Se liberaron ${humanSize(res.freedBytes)}${res.errors.length ? `; ${res.errors.length} archivo(s) no se pudieron borrar` : ''}.` });
          })
        }
      >
        <p>
          Se liberarán <b>{humanSize(temp)}</b> (audio, subtítulos y fotogramas) a la Papelera de reciclaje. No se tocan el vídeo original, los clips ni los exportados.
        </p>
      </ConfirmModal>
      <Modal open={modal === 'detail'} onClose={() => setModal('')} title={j.status === 'failed' ? 'Errores y diagnóstico' : 'Detalle técnico'} size="md">
        {j.status === 'failed' && j.error && <p className="small muted">{j.error}</p>}
        {activeJob && <p className="small muted">{j.message}</p>}
        <JobReport job={j} />
      </Modal>
    </article>
  );
}

/** Confirmación del borrado masivo: resumen real (trabajos, clips, espacio, exports) y «BORRAR» si es mucho. */
export function BulkDeleteModal(props: { ids: string[]; mode: 'history' | 'full' | 'completed'; onClose: () => void; onDone: (deleted: string[], batchId: string, text: string, undoUntil: string, locked: { ids: string[]; deleteExports: boolean; message: string; typed?: string }) => void }) {
  const [deleteExports, setDeleteExports] = useState(props.mode === 'full');
  const [plan, setPlan] = useState<BulkPlan | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const open = props.ids.length > 0;
  useEffect(() => {
    if (!open) return;
    setPlan(null);
    setErr('');
    void api()
      .bulkPlan(props.ids, { deleteExports })
      .then(setPlan)
      .catch((e) => setErr(errMsg(e)));
  }, [open, props.ids, deleteExports]);
  useEffect(() => {
    if (open) {
      setTyped('');
      setDeleteExports(props.mode === 'full');
    }
  }, [open, props.mode]);
  const full = deleteExports;
  const ok = plan && plan.jobs.length > 0 && (!plan.needsTypedConfirm || typed.trim() === TYPED_CONFIRM.word);
  const run = async () => {
    if (!plan) return;
    setBusy(true);
    setErr('');
    try {
      // Los reproductores de la página tienen archivos abiertos: se liberan antes de mover nada.
      const restore = releaseMedia();
      const r = await api().bulkDelete(plan.jobs.map((j) => j.id), { deleteExports }, plan.needsTypedConfirm ? typed : undefined).finally(() => setTimeout(restore, 0));
      const other = r.errors.length - r.locked.length;
      props.onDone(
        r.deletedIds,
        r.batchId,
        `${r.jobs} trabajo${r.jobs === 1 ? '' : 's'} y ${r.clips} clip${r.clips === 1 ? '' : 's'} enviados a la Papelera · ${humanSize(r.freedBytes)} recuperables${r.exportsDeleted ? ` (incluye ${r.exportsDeleted} exportados)` : ''}. El espacio se liberará definitivamente cuando vacíes la Papelera de Windows.${other > 0 ? ` ${other} no se pudieron eliminar: ${r.errors.find((e) => !/vista previa/.test(e))}` : ''}`,
        r.undoUntil,
        { ids: r.locked, deleteExports, typed: plan.needsTypedConfirm ? typed : undefined, message: r.locked.length ? `${r.locked.length} trabajo${r.locked.length === 1 ? '' : 's'} no se ${r.locked.length === 1 ? 'pudo' : 'pudieron'} eliminar todavía: ${r.errors.find((e) => /vista previa/.test(e))}` : '' },
      );
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const title = props.mode === 'completed' ? 'Borrar todos los completados' : full ? 'Eliminar por completo' : 'Eliminar del historial';
  return (
    <Modal
      open={open}
      onClose={() => !busy && props.onClose()}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant={full ? 'danger-solid' : 'danger'} icon="trash" loading={busy} disabled={!ok} onClick={run}>
            {full ? 'Eliminar por completo' : 'Eliminar del historial'}
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
          {props.mode === 'completed' && (
            <fieldset className="cleanup-options">
              <legend className="small">Clips exportados de estos trabajos</legend>
              <label className="check">
                <input type="radio" name="exp" checked={!deleteExports} onChange={() => setDeleteExports(false)} />
                <span>Conservar los exportados (recomendado)</span>
              </label>
              <label className="check">
                <input type="radio" name="exp" checked={deleteExports} onChange={() => setDeleteExports(true)} />
                <span>Borrar también los exportados (van a la Papelera)</span>
              </label>
            </fieldset>
          )}
          <ul className="summary-list">
            <li>
              <span>Trabajos</span>
              <b>{plan.jobs.length}</b>
            </li>
            <li>
              <span>Clips</span>
              <b>{plan.clipCount}</b>
            </li>
            <li>
              <span>Espacio aproximado</span>
              <b>{humanSize(plan.internalBytes + plan.exportBytes)}</b>
            </li>
            <li>
              <span>Clips exportados</span>
              <b>{full ? `${plan.exportCount} se borran (${humanSize(plan.exportBytes)})` : `${plan.keptExports} se conservan`}</b>
            </li>
          </ul>
          {plan.skipped.length > 0 && (
            <p className="small muted">
              {plan.skipped.length} no se tocan (en curso o renderizándose): {plan.skipped.slice(0, 3).map((s) => s.title).join(', ')}
              {plan.skipped.length > 3 ? '…' : ''}
            </p>
          )}
          <p className="small">
            {full
              ? 'Se borran el historial, los temporales, los renders internos y los clips exportados de estos trabajos. Todo va a la Papelera de reciclaje.'
              : 'Se borran los datos internos y el historial. Los clips exportados se conservan en su carpeta.'}{' '}
            Tendrás unos segundos para deshacerlo.
          </p>
          {plan.needsTypedConfirm && (
            <label className="field">
              <span>
                Son muchos elementos. Escribe <b>{TYPED_CONFIRM.word}</b> para confirmar.
              </span>
              <input className="confirm-type" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" aria-label={`Escribe ${TYPED_CONFIRM.word} para confirmar`} />
            </label>
          )}
        </>
      )}
    </Modal>
  );
}

export function JobsPage(props: {
  jobs: Job[];
  onOpen: (id: string) => void;
  onDeleted: (ids: string[]) => void;
  onRestored: () => void;
  goDiagnostics: () => void;
  onPrefill: (p: HomePrefill) => void;
  goHome: () => void;
  toast: (t: Omit<ToastData, 'id'>) => void;
}) {
  const counts = countByFilter(props.jobs);
  const [filter, setFilter] = useState<JobFilter>(counts.activos > 0 ? 'activos' : 'completados');
  const active = filterJobs(props.jobs, 'activos');
  const now = useNow(active.length > 0);
  const shown = useMemo(() => filterJobs(props.jobs, filter), [props.jobs, filter]);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const page = shown.slice(0, limit);
  const [freeOpen, setFreeOpen] = useState(false);
  const [disk, setDisk] = useState<{ free?: number; recoverable: number; min: number } | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<{ ids: string[]; mode: 'history' | 'full' | 'completed' } | null>(null);
  const [bulkBusy, setBulkBusy] = useState('');
  const selectable = (j: Job) => ['completed', 'failed', 'cancelled'].includes(j.status);
  const pageIds = page.filter(selectable).map((j) => j.id);
  const allIds = shown.filter(selectable).map((j) => j.id);

  // Al cambiar de filtro o de lista, la selección sólo conserva lo visible.
  useEffect(() => setSel((s) => pruneSelection(s, allIds)), [filter, props.jobs]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setLimit(PAGE_SIZE), [filter]);

  // Aviso de poco espacio: se compara el libre con el mínimo de Configuración y se sugiere limpiar.
  useEffect(() => {
    void Promise.all([api().analyzeStorage(), api().getSettings()])
      .then(([r, s]) => setDisk({ free: r.freeDiskBytes, recoverable: r.recoverableBytes, min: s.minFreeDiskMB * 1024 * 1024 }))
      .catch(() => undefined);
  }, [props.jobs.length, freeOpen]);
  const lowDisk = disk?.free !== undefined && disk.free < disk.min;

  const ids = [...sel];
  const runEach = async (key: string, fn: (id: string) => Promise<unknown>, done: (n: number) => string) => {
    setBulkBusy(key);
    let n = 0;
    const errs: string[] = [];
    for (const id of ids) {
      try {
        await fn(id);
        n++;
      } catch (e) {
        errs.push(errMsg(e));
      }
    }
    setBulkBusy('');
    props.toast({ kind: errs.length ? 'error' : 'info', text: `${done(n)}${errs.length ? ` ${errs.length} con error: ${errs[0]}` : ''}` });
  };
  const pageState = selectionState(sel, pageIds);

  return (
    <section className="page">
      <PageHeader
        title="Trabajos"
        subtitle="Cada trabajo descarga, transcribe y corta un vídeo en clips. Todo se guarda en tu equipo hasta que lo elimines."
        actions={
          <>
            {filter !== 'activos' && allIds.length > 0 && (
              <Button variant="ghost" aria-pressed={selecting} onClick={() => (setSelecting((v) => !v), setSel(new Set()))}>
                {selecting ? 'Terminar selección' : 'Seleccionar'}
              </Button>
            )}
            <Button icon="broom" aria-haspopup="dialog" onClick={() => setFreeOpen(true)}>
              Liberar espacio{disk && disk.recoverable > 0 ? ` (${humanSize(disk.recoverable)})` : ''}
            </Button>
          </>
        }
      />
      {lowDisk && (
        <div className="banner warn" role="alert">
          <span className="grow">
            Queda poco espacio en disco ({humanSize(disk!.free!)} libres; mínimo configurado {humanSize(disk!.min)}).
          </span>
          {disk!.recoverable > 0 && (
            <Button variant="link" onClick={() => setFreeOpen(true)}>
              Liberar {humanSize(disk!.recoverable)}
            </Button>
          )}
        </div>
      )}
      <FreeSpaceDialog open={freeOpen} onClose={() => setFreeOpen(false)} onSelectJobs={() => (setFilter('completados'), setSelecting(true), setSel(new Set()))} />

      <div className="tabs" role="tablist" aria-label="Filtrar trabajos">
        {JOB_FILTERS.map((f) => (
          <button key={f.id} role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>
            {f.label} <span className="count">{counts[f.id]}</span>
          </button>
        ))}
      </div>

      {selecting && sel.size > 0 && (
        <div className="bulk-bar" role="toolbar" aria-label="Acciones con los seleccionados">
          <span className="bulk-count" aria-live="polite">
            {sel.size} seleccionado{sel.size === 1 ? '' : 's'}
          </span>
          <Button
            icon="download"
            loading={bulkBusy === 'export'}
            onClick={() => runEach('export', (id) => api().exportAll(id), (n) => `Exportados los clips de ${n} trabajo${n === 1 ? '' : 's'}.`)}
          >
            Exportar
          </Button>
          <Button
            icon="broom"
            loading={bulkBusy === 'temp'}
            onClick={() =>
              runEach(
                'temp',
                (id) => api().cleanStorage(TEMP_ONLY, id),
                (n) => `Temporales liberados en ${n} trabajo${n === 1 ? '' : 's'}.`,
              )
            }
          >
            Liberar temporales
          </Button>
          <Button variant="danger" icon="trash" onClick={() => setBulk({ ids, mode: 'history' })}>
            Eliminar del historial
          </Button>
          <Menu
            label="Más"
            items={[
              { label: 'Eliminar por completo (incluye exportados)…', danger: true, onSelect: () => setBulk({ ids, mode: 'full' }) },
              { label: 'Deseleccionar todo', onSelect: () => setSel(new Set()) },
            ]}
          />
        </div>
      )}

      {selecting && filter !== 'activos' && allIds.length > 0 && (
        <div className="list-toolbar">
          <label className="check">
            <input
              type="checkbox"
              checked={pageState === 'all'}
              ref={(el) => {
                if (el) el.indeterminate = pageState === 'some';
              }}
              onChange={(e) => setSel((s) => setMany(s, pageIds, e.target.checked))}
            />
            <span>Seleccionar página ({pageIds.length})</span>
          </label>
          {allIds.length > pageIds.length && (
            <Button variant="link" onClick={() => setSel((s) => setMany(s, allIds, true))}>
              Seleccionar los {allIds.length} trabajos de este filtro
            </Button>
          )}
          {filter === 'completados' && (
            <Button variant="danger" size="sm" icon="trash" onClick={() => setBulk({ ids: allIds, mode: 'completed' })}>
              Borrar todos los completados…
            </Button>
          )}
        </div>
      )}

      {shown.length === 0 && (
        <EmptyState icon="jobs" title="No hay trabajos en este filtro." action={<Button variant="primary" onClick={props.goHome}>Crear un trabajo</Button>}>
          Crea uno desde Inicio.
        </EmptyState>
      )}
      <div className="job-list">
        {page.map((j) => (
          <JobCard
            key={j.id}
            job={j}
            now={now}
            selecting={selecting}
            selected={sel.has(j.id)}
            onToggle={() => setSel((s) => toggle(s, j.id))}
            onOpen={props.onOpen}
            onDeleteOne={(id) => setBulk({ ids: [id], mode: 'history' })}
            onRetried={() => setFilter('activos')}
            goDiagnostics={props.goDiagnostics}
            onPrefill={props.onPrefill}
            toast={props.toast}
          />
        ))}
      </div>
      {shown.length > page.length && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 'var(--s-5)' }}>
          <Button onClick={() => setLimit((l) => l + PAGE_SIZE)}>Mostrar más ({shown.length - page.length})</Button>
        </div>
      )}
      {filter !== 'activos' && active.length > 0 && (
        <p className="small muted" style={{ marginTop: 'var(--s-5)' }}>
          Hay {active.length} trabajo{active.length === 1 ? '' : 's'} en curso.{' '}
          <Button variant="link" onClick={() => setFilter('activos')}>
            Ver activos
          </Button>
        </p>
      )}

      <BulkDeleteModal
        ids={bulk?.ids ?? []}
        mode={bulk?.mode ?? 'history'}
        onClose={() => setBulk(null)}
        onDone={(deleted, batchId, text, undoUntil, locked) => {
          setBulk(null);
          setSel(new Set());
          props.onDeleted(deleted);
          /** Aviso con «Deshacer» para un lote borrado (también los que salen de un reintento). */
          const undoToast = (msg: string, id: string, until: string): void =>
            props.toast({
              text: msg,
              // Caduca exactamente cuando el proceso principal confirma el borrado.
              expiresAt: Date.parse(until),
              action: {
                label: 'Deshacer',
                run: () =>
                  api()
                    .bulkUndo(id)
                    .then(({ restored: n, pending, undoUntil: again, message }) => {
                      props.onRestored();
                      // Con pendientes, el plazo se renovó: un aviso nuevo con su botón sustituye a éste.
                      if (pending && again) return undoToast(`${n ? `${n} trabajo${n === 1 ? '' : 's'} recuperado${n === 1 ? '' : 's'}. ` : ''}${message ?? ''}`, id, again), true;
                      props.toast({ kind: 'info', text: `${n} trabajo${n === 1 ? '' : 's'} recuperado${n === 1 ? '' : 's'}.` });
                      return true;
                    })
                    .catch((e) => (props.toast({ kind: 'error', text: errMsg(e) }), false)),
              },
            });
          if (locked.ids.length) {
            let left = locked.ids;
            const retry = async (): Promise<boolean> => {
              const restore = releaseMedia();
              try {
                // Se reutiliza la confirmación «BORRAR» ya escrita para esta misma selección.
                const r = await api().bulkDelete(left, { deleteExports: locked.deleteExports }, locked.typed).finally(() => setTimeout(restore, 0));
                props.onDeleted(r.deletedIds);
                if (r.deletedIds.length) undoToast(`${r.jobs} trabajo${r.jobs === 1 ? '' : 's'} más enviados a la Papelera · ${humanSize(r.freedBytes)} recuperables. El espacio se liberará definitivamente cuando vacíes la Papelera de Windows.`, r.batchId, r.undoUntil);
                // Fallos que no son bloqueos (p. ej. EIO): se muestran; esos trabajos no se reintentan.
                const other = r.errors.length - r.locked.length;
                if (other > 0) props.toast({ kind: 'error', text: `No se pudo${other === 1 ? '' : 'n'} eliminar ${other} trabajo${other === 1 ? '' : 's'}: ${r.errors.slice(0, 2).join(' · ')}` });
                if (r.locked.length) {
                  left = r.locked;
                  props.toast({ kind: 'error', text: `Siguen bloqueados ${r.locked.length}. Cierra la vista previa o el reproductor que los usa y vuelve a intentarlo.` });
                  return false;
                }
                return true;
              } catch (e) {
                props.toast({ kind: 'error', text: errMsg(e) });
                return false;
              }
            };
            props.toast({ kind: 'error', ttl: 0, text: locked.message, action: { label: 'Cerrar vista previa y reintentar', run: retry } });
          }
          if (!deleted.length && !locked.ids.length) props.toast({ kind: 'error', text: `No se eliminó ningún trabajo. ${text}` });
          if (deleted.length) undoToast(text, batchId, undoUntil);
        }}
      />
    </section>
  );
}
