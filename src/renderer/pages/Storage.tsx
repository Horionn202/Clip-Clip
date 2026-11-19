import { useEffect, useRef, useState } from 'react';
import { CATEGORY_LABELS, FREE_SPACE_DEFAULTS, confirmText, humanSize, type CleanupOptions, type CleanupResult, type StorageCategory, type StorageReport } from '../../shared/storage';
import { api, errMsg } from '../api';

const OPTION_ROWS: { key: keyof CleanupOptions; cat: StorageCategory; label: string; note?: string }[] = [
  { key: 'source', cat: 'source', label: 'Vídeo original descargado', note: 'Sin él no se puede volver a renderizar un clip.' },
  { key: 'audio', cat: 'audio', label: 'Audio WAV' },
  { key: 'frames', cat: 'frames', label: 'Fotogramas de análisis visual' },
  { key: 'temp', cat: 'temp', label: 'Subtítulos ASS y temporales' },
  { key: 'transcript', cat: 'transcript', label: 'Transcripción (opcional)', note: 'Ocupa poco; permite rehacer subtítulos.' },
  { key: 'internalClips', cat: 'internalClip', label: 'Clips internos', note: 'Sólo los que ya tienen un export verificado.' },
];

/** Diálogo «Liberar espacio»: análisis, selección, confirmación explícita y resumen final. */
export function FreeSpaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [opts, setOpts] = useState<CleanupOptions>(FREE_SPACE_DEFAULTS);
  const [report, setReport] = useState<StorageReport | null>(null);
  const [step, setStep] = useState<'review' | 'confirm' | 'cleaning' | 'done'>('review');
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setStep('review');
      setResult(null);
      setErr('');
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open]);
  useEffect(() => {
    if (!open || step !== 'review') return;
    void api()
      .analyzeStorage(opts)
      .then(setReport)
      .catch((e) => setErr(errMsg(e)));
  }, [open, opts, step]);

  const run = async () => {
    setStep('cleaning');
    setErr('');
    try {
      setResult(await api().cleanStorage(opts));
      setStep('done');
    } catch (e) {
      setErr(errMsg(e));
      setStep('review');
    }
  };
  const r = report;
  const sizeOf = (c: StorageCategory) => r?.files.filter((f) => f.category === c).reduce((a, f) => a + f.bytes, 0) ?? 0;

  return (
    <dialog ref={ref} className="modal wide" onClose={onClose} aria-labelledby="fs-title">
      <h3 id="fs-title">Liberar espacio</h3>
      {err && (
        <div className="banner error small" role="alert">
          {err}
        </div>
      )}
      {!r && step === 'review' && <p className="small muted">Analizando…</p>}

      {r && (step === 'review' || step === 'confirm') && (
        <>
          <table className="table kv">
            <tbody>
              <tr><td>Espacio usado por los trabajos</td><td><b>{humanSize(r.totalBytes)}</b></td></tr>
              <tr><td>Espacio recuperable con la selección</td><td><b>{humanSize(r.recoverableBytes)}</b> · {r.jobsAffected} trabajo{r.jobsAffected === 1 ? '' : 's'}</td></tr>
              <tr><td>{CATEGORY_LABELS.exports}</td><td>{humanSize(r.exportsBytes)}</td></tr>
              {r.freeDiskBytes !== undefined && <tr><td>Libre en el disco</td><td>{humanSize(r.freeDiskBytes)}</td></tr>}
              {r.skippedActive > 0 && <tr><td>Trabajos en curso</td><td>{r.skippedActive} (no se tocan)</td></tr>}
            </tbody>
          </table>
          <fieldset className="cleanup-options" disabled={step === 'confirm'}>
            <legend className="small">Qué se borrará (va a la Papelera de reciclaje):</legend>
            {OPTION_ROWS.map((o) => (
              <label key={o.key} className="check">
                <input type="checkbox" checked={opts[o.key]} onChange={(e) => setOpts({ ...opts, [o.key]: e.target.checked })} />
                <span className="grow">
                  {o.label} · <b>{humanSize(opts[o.key] ? sizeOf(o.cat) : 0)}</b>
                  <span className="muted"> de {humanSize(r.byCategory[o.cat])}</span>
                  {o.note && <span className="small muted"> — {o.note}</span>}
                </span>
              </label>
            ))}
          </fieldset>
          <p className="small">
            <b>Se conserva siempre:</b> clips exportados, títulos, hooks, historial, métricas y el registro de cada trabajo.
          </p>
          {step === 'review' ? (
            <div className="row">
              <button className="primary" disabled={r.recoverableBytes === 0} onClick={() => setStep('confirm')}>
                Continuar
              </button>
              <button className="ghost" onClick={onClose}>
                Cancelar
              </button>
            </div>
          ) : (
            <div className="banner warn" role="alert">
              <p>
                <b>{confirmText(r)}</b>
              </p>
              <p className="small">Los archivos van a la Papelera de reciclaje: vacíala para recuperar el espacio en disco.</p>
              <div className="row">
                <button className="primary" onClick={run}>
                  Liberar espacio
                </button>
                <button className="ghost" onClick={() => setStep('review')}>
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {step === 'cleaning' && (
        <p role="status" aria-live="polite">
          Liberando espacio…
        </p>
      )}

      {step === 'done' && result && (
        <div role="status" aria-live="polite">
          <p>
            <b>✓ Se liberaron {humanSize(result.freedBytes)}</b> ({result.deleted} archivo{result.deleted === 1 ? '' : 's'} en {result.jobs.length} trabajo{result.jobs.length === 1 ? '' : 's'}). Tus clips exportados se conservaron.
          </p>
          {result.usedTrash && <p className="small muted">Están en la Papelera de reciclaje hasta que la vacíes.</p>}
          {result.errors.length > 0 && (
            <details className="banner warn small">
              <summary>{result.errors.length} archivo(s) no se pudieron borrar (el resto sí)</summary>
              <ul>
                {result.errors.slice(0, 20).map((e) => (
                  <li key={e.jobId + e.rel}>
                    {e.rel}: {e.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <button className="primary" onClick={onClose}>
            Cerrar
          </button>
        </div>
      )}
    </dialog>
  );
}
