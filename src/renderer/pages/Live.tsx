import { useEffect, useState } from 'react';
import { DURATION_PRESETS } from '../../shared/types';
import { LIVE_DEFAULTS, MONITOR_STATUS_LABELS, isActive, monitorSummary, type LiveMonitor, type LiveSettings } from '../../shared/live';
import { humanSize } from '../../shared/storage';
import { fmtMs } from '../../shared/jobView';
import { api, errMsg } from '../api';
import { ConfirmModal, Modal } from '../components/Modal';
import { Button, EmptyState, PageHeader, StatusPill, type Tone } from '../components/ui';

const TONE: Record<LiveMonitor['status'], Tone> = { esperando: 'neutral', verificando: 'neutral', 'en-directo': 'active', procesando: 'active', pausado: 'warn', finalizando: 'active', finalizado: 'ok', detenido: 'warn', error: 'err' };

const dur = (sec: number) => fmtMs(Math.round(sec * 1000));

/** Monitor de directos de YouTube: vigila un directo propio o autorizado y genera clips por bloques. */
export function LivePage({ onOpenResults }: { onOpenResults: () => void }) {
  const [monitors, setMonitors] = useState<LiveMonitor[]>([]);
  const [ack, setAck] = useState(false);
  const [url, setUrl] = useState('');
  const [settings, setSettings] = useState<LiveSettings>(LIVE_DEFAULTS);
  const [warnOpen, setWarnOpen] = useState(false);
  const [detail, setDetail] = useState<LiveMonitor | null>(null);
  const [err, setErr] = useState('');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    void api()
      .liveList()
      .then((r) => {
        setMonitors(r.monitors);
        setAck(r.ack);
      })
      .catch((e) => setErr(errMsg(e)));
    const off = api().onLiveUpdate((m) => setMonitors((prev) => [m, ...prev.filter((x) => x.id !== m.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt))));
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);

  const create = async (acknowledged: boolean) => {
    setErr('');
    try {
      await api().liveCreate(url.trim(), settings, acknowledged);
      setAck(true);
      setUrl('');
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  const act = (fn: () => Promise<unknown>) => fn().catch((e) => setErr(errMsg(e)));
  const shown = detail ? monitors.find((m) => m.id === detail.id) ?? detail : null;

  return (
    <section className="page">
      <PageHeader title="Directos" subtitle={`Vigila un directo de YouTube y genera clips a medida que avanza, por bloques de ${settings.blockSec} s con ${settings.overlapSec} s de solape. Todo se procesa en este equipo.`} />
      <div className="banner warn small">Sólo para directos propios, autorizados o con derechos de uso. Se graba desde el momento en que empiezas a vigilar: no se descarga el directo completo ni lo emitido antes.</div>
      <div className="card">
        <label className="field">
          <span>URL del directo o del canal de YouTube</span>
          <input value={url} placeholder="https://www.youtube.com/@canal o https://www.youtube.com/watch?v=…" onChange={(e) => setUrl(e.target.value)} />
        </label>
        <div className="grid2">
          <label className="field">
            <span>Duración de los clips</span>
            <select value={settings.preset} onChange={(e) => setSettings({ ...settings, preset: Number(e.target.value) as LiveSettings['preset'], blockSec: Math.max(settings.blockSec, Number(e.target.value) + 10) })}>
              {DURATION_PRESETS.map((p) => (
                <option key={p} value={p}>
                  {p} s
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Bloque (s)</span>
            <input type="number" min={Math.max(30, settings.preset + 10)} max={600} value={settings.blockSec} onChange={(e) => setSettings({ ...settings, blockSec: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>Solape técnico (3–5 s)</span>
            <input type="number" min={3} max={5} value={settings.overlapSec} onChange={(e) => setSettings({ ...settings, overlapSec: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>Clips máximos por bloque</span>
            <input type="number" min={1} max={5} value={settings.maxClipsPerBlock} onChange={(e) => setSettings({ ...settings, maxClipsPerBlock: Number(e.target.value) })} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={settings.keepSegments} onChange={(e) => setSettings({ ...settings, keepSegments: e.target.checked })} />
          <span>Conservar los segmentos grabados tras procesarlos (ocupa disco; por defecto se borran y se conservan los clips)</span>
        </label>
        <div className="row">
          <button className="primary" disabled={!url.trim()} onClick={() => (ack ? void create(false) : setWarnOpen(true))}>
            Vigilar directo
          </button>
        </div>
        {err && (
          <div className="banner error small" role="alert">
            {err}
          </div>
        )}
      </div>

      <div className="monitor-list">
        {monitors.map((m) => {
          const s = monitorSummary(m, now);
          const processing = m.blocks.some((b) => b.status === 'procesando');
          return (
            <article key={m.id} className={`card monitor ${m.status}`} aria-label={`Monitor: ${m.title ?? m.url}`}>
              <div className="row">
                <StatusPill tone={processing && m.status !== 'pausado' ? 'active' : TONE[m.status] ?? 'neutral'} dot>
                  {processing && m.status !== 'pausado' ? MONITOR_STATUS_LABELS.procesando : MONITOR_STATUS_LABELS[m.status]}
                </StatusPill>
                <b className="grow job-title">{m.title ?? 'Directo de YouTube'}</b>
              </div>
              <div className="metric-grid">
                <div className="metric"><span className="m-k">En directo</span><span className="m-v">{dur(s.watchedSec)}</span></div>
                <div className="metric"><span className="m-k">Procesado</span><span className="m-v">{dur(s.processedSec)}</span></div>
                <div className="metric"><span className="m-k">Retraso</span><span className="m-v">{dur(s.lagSec)}</span></div>
                <div className="metric"><span className="m-k">Clips</span><span className="m-v">{m.clipsGenerated}</span></div>
                <div className="metric"><span className="m-k">Disco temporal</span><span className="m-v">{humanSize(m.tempBytes)}</span></div>
              </div>
              {m.notice && <p className="small muted">{m.notice}</p>}
              {m.error && (
                <div className="banner error small" role="alert">
                  {m.error}
                </div>
              )}
              <div className="row">
                {isActive(m.status) && (
                  <Button icon="pause" onClick={() => act(() => api().livePause(m.id))}>
                    Pausar
                  </Button>
                )}
                {(m.status === 'pausado' || m.status === 'error') && (
                  <Button variant="primary" icon="play" onClick={() => act(() => api().liveResume(m.id))}>
                    Reanudar
                  </Button>
                )}
                {m.status !== 'finalizado' && m.status !== 'detenido' && (
                  <Button variant="danger" icon="stop" onClick={() => act(() => api().liveStop(m.id))}>
                    Detener
                  </Button>
                )}
                <span className="grow" />
                <Button variant="ghost" onClick={onOpenResults} disabled={!m.clipsGenerated}>
                  Abrir resultados
                </Button>
                <Button variant="ghost" aria-haspopup="dialog" onClick={() => setDetail(m)}>
                  Ver detalles
                </Button>
              </div>
            </article>
          );
        })}
        {monitors.length === 0 && <EmptyState icon="live" title="Aún no vigilas ningún directo.">Pega arriba la URL de un directo propio o autorizado.</EmptyState>}
      </div>

      <ConfirmModal open={warnOpen} title="Antes de vigilar un directo" confirmLabel="Lo confirmo" onClose={() => setWarnOpen(false)} onConfirm={() => (setWarnOpen(false), void create(true))}>
        <p>Usa esta función sólo con <b>directos propios, autorizados o con derechos de uso</b>.</p>
        <ul className="small">
          <li>Se graba desde que empiezas a vigilar, en bloques; nunca se descarga el directo completo ni lo anterior.</li>
          <li>Se graba sólo hacia adelante: lo emitido antes de empezar, durante una pausa o con la app cerrada no se recupera y se marca como hueco. La app no puede saber si el directo permite retroceder (DVR), así que no lo intenta.</li>
          <li>Los temporales de cada bloque se borran al procesarlo; los clips se conservan.</li>
        </ul>
      </ConfirmModal>

      <Modal open={!!shown} onClose={() => setDetail(null)} title={shown?.title ?? 'Monitor de directo'} size="md">
        {shown && (
          <>
            <table className="table kv">
              <tbody>
                <tr><td>Estado</td><td>{MONITOR_STATUS_LABELS[shown.status]}</td></tr>
                <tr><td>URL</td><td className="path small">{shown.url}</td></tr>
                <tr><td>Bloques procesados</td><td>{shown.blocks.filter((b) => b.status === 'procesado').length} de {shown.blocks.length}</td></tr>
                <tr><td>Clips generados</td><td>{shown.clipsGenerated} ({shown.duplicatesSkipped} duplicados descartados por el solape)</td></tr>
                <tr><td>Espacio liberado</td><td>{humanSize(shown.freedBytes)}</td></tr>
                <tr><td>Ajustes</td><td>bloques de {shown.settings.blockSec} s · solape {shown.settings.overlapSec} s · clips de {shown.settings.preset} s · máx. {shown.settings.maxClipsPerBlock}/bloque</td></tr>
                {shown.finishedAt && <tr><td>Terminado</td><td>{new Date(shown.finishedAt).toLocaleString('es-ES')}</td></tr>}
              </tbody>
            </table>
            {shown.gaps.length > 0 && (
              <>
                <h3 className="small">Huecos sin grabar</h3>
                <ul className="small muted">
                  {shown.gaps.map((g) => (
                    <li key={g.at}>
                      {new Date(g.at).toLocaleTimeString('es-ES')}: {g.reason}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <h3 className="small">Bloques</h3>
            <ol className="small block-list">
              {shown.blocks.map((b) => (
                <li key={b.index}>
                  Bloque {b.index + 1} · {dur(b.startSec)}–{dur(b.endSec)} · {b.status}
                  {b.clips ? ` · ${b.clips} clips` : ''}
                  {b.error ? ` · ${b.error}` : ''}
                  {b.status === 'error' && (
                    <button className="link" onClick={() => act(() => api().liveRetryBlock(shown.id, b.index))}>
                      Reintentar bloque
                    </button>
                  )}
                </li>
              ))}
            </ol>
            {!isActive(shown.status) && (
              <button className="ghost" onClick={() => act(async () => (await api().liveRemove(shown.id), setMonitors((p) => p.filter((x) => x.id !== shown.id)), setDetail(null)))}>
                Quitar de la lista (los clips se conservan)
              </button>
            )}
          </>
        )}
      </Modal>
    </section>
  );
}
