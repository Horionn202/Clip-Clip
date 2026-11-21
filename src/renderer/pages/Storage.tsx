// Centro de almacenamiento: cuánto ocupa cada categoría y acciones seguras con confirmación.
// Nunca borra clips sin exportar, trabajos o directos activos ni exportados; sólo archivos de la app que se pueden
// regenerar o que ya no hacen falta, y siempre a la Papelera.
import { useEffect, useState } from 'react';
import { humanSize, type CleanupOptions, type CleanupResult, type StorageReport } from '../../shared/storage';
import type { LegacyScan } from '../../shared/types';
import { api, errMsg } from '../api';
import { Modal } from '../components/Modal';
import { Button, Icon, StatusPill, type IconName } from '../components/ui';
import { LegacyModal } from './Legacy';

const NONE: CleanupOptions = { source: false, audio: false, frames: false, temp: false, transcript: false, internalClips: false };

type ActionId = 'live' | 'sources' | 'regen' | 'internal' | 'cache';
interface Action {
  id: ActionId;
  title: string;
  /** Qué se conserva siempre. */
  keeps: string;
  /** Qué deja de poder hacerse después. */
  loses: string;
  bytes: number;
  files: number;
  /** Se borra para siempre (no va a la Papelera). */
  permanent?: boolean;
}

interface Overview {
  report: StorageReport;
  live: { id: string; title: string; active: boolean; bytes: number; clips: number }[];
  cache: number;
  legacy: LegacyScan | null;
  clips: number;
  plans: Record<'sources' | 'regen' | 'internal', StorageReport>;
}

async function loadOverview(): Promise<Overview> {
  const [report, live, cache, legacy, jobs, sources, regen, internal] = await Promise.all([
    api().analyzeStorage({ source: true, audio: true, frames: true, temp: true, transcript: true, internalClips: true }),
    api().liveUsage(),
    api().cacheSize().catch(() => 0),
    api().legacyScan().catch(() => null),
    api().listJobs(),
    api().analyzeStorage({ ...NONE, source: true, sourceOnlyExported: true }),
    api().analyzeStorage({ ...NONE, audio: true, frames: true, temp: true }),
    api().analyzeStorage({ ...NONE, internalClips: true }),
  ]);
  return { report, live, cache, legacy, clips: jobs.reduce((a, j) => a + j.clips.length, 0), plans: { sources, regen, internal } };
}

function Card({ icon, title, bytes, note, kept, children }: { icon: IconName; title: string; bytes: number; note?: string; kept?: boolean; children?: React.ReactNode }) {
  return (
    <article className="storage-card">
      <div className="row">
        <span className="sc-icon" aria-hidden="true">
          <Icon name={icon} />
        </span>
        <b className="grow">{title}</b>
        {kept && <StatusPill tone="ok">Se conserva</StatusPill>}
      </div>
      <div className="storage-size">{humanSize(bytes)}</div>
      {note && <p className="small muted">{note}</p>}
      {children}
    </article>
  );
}

/** «Liberar espacio» como centro de almacenamiento. */
export function FreeSpaceDialog({ open, onClose, onSelectJobs }: { open: boolean; onClose: () => void; onSelectJobs?: () => void }) {
  const [ov, setOv] = useState<Overview | null>(null);
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [legacyOpen, setLegacyOpen] = useState(false);
  const refresh = () =>
    void loadOverview()
      .then(setOv)
      .catch((e) => setErr(errMsg(e)));
  useEffect(() => {
    if (!open) return;
    setOv(null);
    setErr('');
    setDone('');
    refresh();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const r = ov?.report;
  const cat = (c: keyof StorageReport['byCategory']) => r?.byCategory[c] ?? 0;
  const liveDone = ov?.live.filter((m) => !m.active) ?? [];
  const liveBytes = ov?.live.reduce((a, m) => a + m.bytes, 0) ?? 0;
  const liveDoneBytes = liveDone.reduce((a, m) => a + m.bytes, 0);
  const plan = (k: 'sources' | 'regen' | 'internal') => ov?.plans[k];

  const actions: Record<ActionId, Action> = {
    live: { id: 'live', title: 'Limpiar temporales de directos terminados', keeps: 'Los clips generados, sus trabajos y los exportados. Los directos activos o pausados no se tocan.', loses: 'No se podrá «Reintentar bloque» con segmentos borrados.', bytes: liveDoneBytes, files: liveDone.length, permanent: true },
    sources: { id: 'sources', title: 'Borrar fuentes de trabajos ya exportados', keeps: 'Clips, exportados, transcripción, títulos e historial. Sólo trabajos con TODOS sus clips exportados y verificados.', loses: 'Esos clips ya no podrán volver a editarse ni renderizarse (falta el vídeo original).', bytes: plan('sources')?.recoverableBytes ?? 0, files: plan('sources')?.files.length ?? 0 },
    regen: { id: 'regen', title: 'Borrar audio y frames regenerables', keeps: 'Vídeo original, clips, transcripción, miniaturas de los clips y exportados.', loses: 'Nada importante: se vuelven a generar si hacen falta.', bytes: plan('regen')?.recoverableBytes ?? 0, files: plan('regen')?.files.length ?? 0 },
    internal: { id: 'internal', title: 'Borrar clips internos ya exportados', keeps: 'Los exportados (se reproducen desde ahí) y los clips aún no exportados.', loses: 'Para re-editar un clip archivado hará falta el vídeo original.', bytes: plan('internal')?.recoverableBytes ?? 0, files: plan('internal')?.files.length ?? 0 },
    cache: { id: 'cache', title: 'Limpiar caché', keeps: 'Todos tus datos: la caché es del navegador interno.', loses: 'Nada: se vuelve a crear sola.', bytes: ov?.cache ?? 0, files: 0 },
  };

  const run = async (a: Action) => {
    setBusy(true);
    setErr('');
    try {
      let freed = 0;
      let errors = 0;
      if (a.id === 'live') for (const m of liveDone) freed += await api().liveFreeTemps(m.id); // sólo los del resumen
      else if (a.id === 'cache') freed = await api().clearCache();
      else {
        const opts: CleanupOptions = a.id === 'sources' ? { ...NONE, source: true, sourceOnlyExported: true } : a.id === 'regen' ? { ...NONE, audio: true, frames: true, temp: true } : { ...NONE, internalClips: true };
        const res: CleanupResult = await api().cleanStorage(opts);
        freed = res.freedBytes;
        errors = res.errors.length;
      }
      const kept = a.id === 'live' ? liveDone.reduce((n, m) => n + m.clips, 0) : ov!.clips;
      setDone(`Se liberaron ${humanSize(freed)}. Tus ${kept} clips se conservaron.${errors ? ` ${errors} archivo(s) no se pudieron borrar.` : ''}`);
      setConfirm(null);
      refresh();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const act = (a: Action) => (
    <Button size="sm" disabled={!a.bytes} onClick={() => setConfirm(a)} aria-haspopup="dialog">
      {a.title}
    </Button>
  );

  return (
    <>
      <Modal open={open && !legacyOpen} onClose={onClose} title="Almacenamiento" size="lg">
        {err && (
          <div className="banner error small" role="alert">
            {err}
          </div>
        )}
        {done && (
          <div className="banner info small" role="status">
            {done}
          </div>
        )}
        {!ov && !err && <p className="small muted">Midiendo el espacio…</p>}
        {ov && r && (
          <>
            <p className="small muted">
              La app ocupa <b>{humanSize(r.totalBytes + liveBytes)}</b> en tu disco{r.freeDiskBytes !== undefined ? ` · libres ${humanSize(r.freeDiskBytes)}` : ''}. Lo que se borra va a la Papelera de reciclaje, salvo los segmentos de directos (temporales), que se borran definitivamente. Nunca se borran clips sin exportar, trabajos o directos activos ni exportados.
            </p>
            <div className="storage-grid">
              <Card icon="live" title="Segmentos de directos" bytes={liveBytes} note={liveBytes ? `${humanSize(liveDoneBytes)} de directos terminados o detenidos.` : 'Sin temporales de directos.'}>
                {act(actions.live)}
              </Card>
              <Card icon="film" title="Vídeos fuente" bytes={cat('source')} note="Necesarios para volver a editar o renderizar.">
                {act(actions.sources)}
              </Card>
              <Card icon="mic" title="Audio WAV" bytes={cat('audio')} note="Se regenera a partir del vídeo.">
                {act(actions.regen)}
              </Card>
              <Card icon="results" title="Frames y previews" bytes={cat('frames') + cat('temp')} note="Las miniaturas de los clips se conservan." />
              <Card icon="check" title="Clips internos ya exportados" bytes={actions.internal.bytes} note={`Clips internos en total: ${humanSize(cat('internalClip'))}.`}>
                {act(actions.internal)}
              </Card>
              <Card icon="export" title="Clips exportados" bytes={r.exportsBytes} kept note="Están en tu carpeta de exportación. Sólo se borran si lo pides expresamente." />
              <Card icon="folder" title="Datos de una versión anterior" bytes={ov.legacy?.totalBytes ?? 0} note={ov.legacy?.found ? 'Datos de una versión anterior detectados. No se borran solos.' : 'No se detectaron.'}>
                {ov.legacy?.found && (
                  <Button size="sm" onClick={() => setLegacyOpen(true)} aria-haspopup="dialog">
                    Revisar datos de versión anterior
                  </Button>
                )}
              </Card>
              <Card icon="disk" title="Caché" bytes={ov.cache} note="Caché del navegador interno de la app.">
                {act(actions.cache)}
              </Card>
              <Card icon="mic" title="Transcripciones" bytes={cat('transcript')} kept note="Ocupan poco y permiten rehacer subtítulos." />
            </div>
            {onSelectJobs && (
              <p className="small" style={{ marginTop: 'var(--s-4)' }}>
                ¿Quieres borrar trabajos completos?{' '}
                <Button variant="link" onClick={() => (onClose(), onSelectJobs())}>
                  Eliminar trabajos seleccionados
                </Button>
              </p>
            )}
          </>
        )}
      </Modal>

      <Modal
        open={!!confirm}
        onClose={() => !busy && setConfirm(null)}
        title={confirm?.title ?? ''}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)} disabled={busy}>
              Cancelar
            </Button>
            <Button variant="primary" loading={busy} onClick={() => confirm && void run(confirm)}>
              Liberar {humanSize(confirm?.bytes ?? 0)}
            </Button>
          </>
        }
      >
        {confirm && (
          <>
            <ul className="summary-list">
              <li>
                <span>Espacio que se libera</span>
                <b>{humanSize(confirm.bytes)}</b>
              </li>
              {confirm.files > 0 && (
                <li>
                  <span>{confirm.id === 'live' ? 'Directos afectados' : 'Archivos afectados'}</span>
                  <b>{confirm.files}</b>
                </li>
              )}
            </ul>
            {confirm.permanent && (
              <div className="banner warn small" role="alert">
                Estos archivos se borran <b>definitivamente</b>: no van a la Papelera de reciclaje.
              </div>
            )}
            <p className="small">
              <b>Se conserva:</b> {confirm.keeps}
            </p>
            <p className="small">
              <b>Después:</b> {confirm.loses}
            </p>
          </>
        )}
      </Modal>
      <LegacyModal open={legacyOpen} onClose={() => setLegacyOpen(false)} onDone={refresh} />
    </>
  );
}
