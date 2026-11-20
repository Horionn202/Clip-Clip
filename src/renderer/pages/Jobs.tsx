import { useEffect, useMemo, useState } from 'react';
import { STATUS_LABELS, type Job } from '../../shared/types';
import { JOB_FILTERS, countByFilter, currentEta, filterJobs, fmtMs, renderCounter, simpleCause, type JobFilter, type RetryOption } from '../../shared/jobView';
import { humanDuration } from '../../shared/estimates';
import { TEMP_ONLY, humanSize } from '../../shared/storage';
import { TYPED_CONFIRM, pruneSelection, selectionState, setMany, toggle, type BulkPlan } from '../../shared/bulk';
import { api, errMsg } from '../api';
import { JobReport } from './Performance';
import { FreeSpaceDialog } from './Storage';
import { ConfirmModal, Modal } from '../components/Modal';
import { PipelineCards } from '../components/PipelineCards';
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
  toast: (t: Omit<ToastData, 'id'>) => void;
}) {
  const j = props.job;
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
            <StatusPill>Clips de {j.preset} s</StatusPill>
            <StatusPill>{j.status === 'completed' ? `${got}/${j.analysis?.effectiveTarget ?? j.maxClips} clips` : `Meta ${j.maxClips} clips`}</StatusPill>
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

      {j.status === 'failed' && (
        <div className="banner error small" role="alert">
          <span className="grow">{simpleCause(j.error)}</span>
          <Button variant="link" onClick={props.goDiagnostics}>
            Ver diagnóstico
          </Button>
        </div>
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
export function BulkDeleteModal(props: { ids: string[]; mode: 'history' | 'full' | 'completed'; onClose: () => void; onDone: (deleted: string[], batchId: string, text: string, undoUntil: string) => void }) {
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
      const r = await api().bulkDelete(plan.jobs.map((j) => j.id), { deleteExports }, plan.needsTypedConfirm ? typed : undefined);
      props.onDone(
        r.deletedIds,
        r.batchId,
        `${r.jobs} trabajo${r.jobs === 1 ? '' : 's'} y ${r.clips} clip${r.clips === 1 ? '' : 's'} eliminados · ${humanSize(r.freedBytes)} liberados${r.exportsDeleted ? ` · ${r.exportsDeleted} exportados a la Papelera` : ''}.${r.errors.length ? ` ${r.errors.length} no se pudieron eliminar: ${r.errors[0]}` : ''}`,
        r.undoUntil,
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
        onDone={(deleted, batchId, text, undoUntil) => {
          setBulk(null);
          setSel(new Set());
          props.onDeleted(deleted);
          props.toast({
            text,
            // Caduca exactamente cuando el proceso principal confirma el borrado.
            expiresAt: Date.parse(undoUntil),
            action: {
              label: 'Deshacer',
              run: () =>
                api()
                  .bulkUndo(batchId)
                  .then(({ restored: n, pending }) => {
                    props.onRestored();
                    props.toast({ kind: pending ? 'error' : 'info', text: `${n} trabajo${n === 1 ? '' : 's'} recuperado${n === 1 ? '' : 's'}.${pending ? ` Faltan ${pending}: vuelve a pulsar «Deshacer».` : ''}` });
                    return pending === 0; // con pendientes, el aviso sigue con su botón
                  })
                  .catch((e) => (props.toast({ kind: 'error', text: errMsg(e) }), false)),
            },
          });
        }}
      />
    </section>
  );
}
