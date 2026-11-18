import { useEffect, useRef, useState } from 'react';
import type { GpuSetupInfo } from '../../shared/types';
import { ACCEL_LABELS, type SetupState } from '../../shared/gpuSetup';
import { api, errMsg } from '../api';

const STATUS_CLASS: Record<string, string> = {
  listo: 'ok',
  'sin-verificar': 'warn',
  disponible: 'warn',
  instalando: 'info',
  error: 'error',
  'requiere-reinicio': 'warn',
  'no-disponible': 'muted',
};

/** Configuración → Aceleración: activar la GPU sin abrir PowerShell, con confirmación, progreso y vuelta atrás. */
export function AccelPanel({ onChanged }: { onChanged: () => void }) {
  const [info, setInfo] = useState<GpuSetupInfo | null>(null);
  const [live, setLive] = useState<SetupState | null>(null);
  const [err, setErr] = useState('');
  const [confirmMode, setConfirmMode] = useState<'install' | 'verify' | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const load = () =>
    api()
      .gpuSetupInfo()
      .then((i) => {
        setInfo(i);
        if (i.state) setLive(i.state);
      })
      .catch((e) => setErr(errMsg(e)));

  useEffect(() => {
    void load();
    return api().onGpuSetup((s) => {
      setLive(s);
      if (!s.running) {
        void load();
        onChanged();
      }
    });
  }, []);
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (confirmMode && !d.open) d.showModal();
    if (!confirmMode && d.open) d.close();
  }, [confirmMode]);

  const start = async (mode: 'install' | 'verify') => {
    setConfirmMode(null);
    setErr('');
    try {
      await api().startGpuSetup(mode);
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  const act = async (fn: () => Promise<void>) => {
    setErr('');
    try {
      await fn();
      await load();
      onChanged();
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  if (!info) return <p className="small muted">Comprobando la aceleración…</p>;
  const running = !!live?.running;
  const status = running ? 'instalando' : info.status;
  const plan = info.plan;

  return (
    <div className="accel">
      <div className="row">
        <span className={`badge accel-${STATUS_CLASS[status]}`} role="status">
          {ACCEL_LABELS[status]}
        </span>
        <span className="small muted grow">
          {info.usingAppEnv ? 'Usando el entorno aislado de la app.' : info.currentPython ? 'Usando el Python del sistema.' : 'Sin Python.'}
          {info.engine === 'openai-whisper-cpu' && ' Motor fijado en CPU.'}
        </span>
      </div>

      {status === 'listo' && <p className="small">La transcripción por GPU está verificada con una prueba real en este equipo.</p>}
      {status === 'sin-verificar' && (
        <p className="small">CUDA aparece disponible, pero aún no se ha comprobado con una transcripción real. Verifícalo antes de confiar en la GPU.</p>
      )}
      {!plan.compatible && status !== 'listo' && status !== 'sin-verificar' && (
        <div className="banner warn small">
          {plan.reason}{' '}
          {plan.actionUrl && (
            <a href={plan.actionUrl} target="_blank" rel="noreferrer">
              Abrir la página oficial
            </a>
          )}
        </div>
      )}
      {err && (
        <div className="banner error small" role="alert">
          {err}
        </div>
      )}

      <div className="row">
        {!running && status !== 'listo' && (
          <button className="primary" disabled={!plan.compatible} onClick={() => setConfirmMode('install')}>
            Activar aceleración GPU
          </button>
        )}
        {!running && info.currentPython && (status === 'sin-verificar' || status === 'listo' || status === 'error') && (
          <button onClick={() => setConfirmMode('verify')}>{status === 'listo' ? 'Volver a verificar' : 'Verificar GPU ahora'}</button>
        )}
        {running && (
          <button className="danger" onClick={() => act(() => api().cancelGpuSetup())}>
            Cancelar
          </button>
        )}
        {!running && live && live.ok === false && (
          <button onClick={() => start(live.mode)}>Reintentar</button>
        )}
        {!running && info.engine !== 'openai-whisper-cpu' && (
          <button className="ghost" onClick={() => act(() => api().useCpuEngine())}>
            Usar CPU
          </button>
        )}
        {!running && info.engine === 'openai-whisper-cpu' && status === 'listo' && (
          <button
            onClick={() =>
              act(async () => {
                await api().updateSettings({ transcriptionEngine: 'auto' });
              })
            }
          >
            Usar GPU
          </button>
        )}
        {!running && info.usingAppEnv && (
          <button className="ghost" onClick={() => act(() => api().useSystemPython())}>
            Usar el Python del sistema
          </button>
        )}
      </div>

      {live && (
        <div className="card" aria-live="polite">
          <ol className="setup-steps">
            {live.steps.map((s) => (
              <li key={s.id} className={`step-${s.status}`}>
                <span className="step-icon" aria-hidden="true">
                  {{ pendiente: '○', 'en-curso': '◐', hecho: '✓', error: '✗', omitido: '–' }[s.status]}
                </span>
                <div className="grow">
                  <div>
                    {s.label}
                    {s.status === 'en-curso' && s.progress !== undefined && ` · ${Math.round(s.progress * 100)} %`}
                  </div>
                  {s.detail && <div className="small muted">{s.detail}</div>}
                  {s.status === 'en-curso' && s.progress !== undefined && (
                    <div className="progress" role="progressbar" aria-valuenow={Math.round(s.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                      <div style={{ width: `${Math.round(s.progress * 100)}%` }} />
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
          {live.ok && <div className="banner info small">Listo: la transcripción usará la GPU.</div>}
          {live.ok === false && live.error && <div className="banner error small">{live.error}</div>}
          <details>
            <summary className="small">Registro técnico</summary>
            <pre className="cmd">{live.logTail.slice(-40).join('\n') || 'Sin registro todavía.'}</pre>
          </details>
        </div>
      )}

      <dialog ref={dialogRef} className="modal" onClose={() => setConfirmMode(null)} aria-labelledby="accel-title">
        <h3 id="accel-title">{confirmMode === 'verify' ? 'Verificar la GPU' : 'Activar aceleración GPU'}</h3>
        {confirmMode === 'install' ? (
          <ul className="small">
            <li>
              <b>Qué se instala:</b> PyTorch con CUDA 12.6 y openai-whisper{plan.needsTinyModel ? ', más el modelo «tiny» de Whisper (≈ 75 MB) para la prueba' : ''}.
            </li>
            <li>
              <b>Origen oficial:</b> {plan.sources.join(' · ')}
            </li>
            <li>
              <b>Tamaño aproximado:</b> {plan.downloadGB.toFixed(1).replace('.', ',')} GB de descarga · se necesitan {plan.requiredFreeGB} GB libres (hay {plan.freeGB.toString().replace('.', ',')} GB).
            </li>
            <li>
              <b>Dónde:</b> en un entorno aislado dentro de la carpeta de datos de la app. Tu Python del sistema no se modifica (Python {plan.pythonVersion}).
            </li>
            <li>Al final se hace una transcripción real de prueba en la GPU; sólo entonces se marca como lista. Puedes cancelar en cualquier momento.</li>
          </ul>
        ) : (
          <p className="small">
            Se comprobará CUDA y se hará una transcripción corta de prueba en la GPU con el Python actual{plan.needsTinyModel ? ' (descarga el modelo «tiny», ≈ 75 MB)' : ''}. No se instala nada.
          </p>
        )}
        <div className="row">
          <button className="primary" onClick={() => confirmMode && start(confirmMode)}>
            Confirmar
          </button>
          <button className="ghost" onClick={() => setConfirmMode(null)}>
            Cancelar
          </button>
        </div>
      </dialog>
    </div>
  );
}
