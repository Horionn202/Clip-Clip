import { useEffect, useState } from 'react';
import type { LegacyMigrateResult, LegacyScan } from '../../shared/types';
import { humanSize } from '../../shared/storage';
import { api, errMsg } from '../api';
import { Modal } from '../components/Modal';

const KIND_LABELS = { data: 'Datos (ajustes, historial y clips)', install: 'Instalación antigua de ClipsVirales', exports: 'Exports antiguos (Vídeos\\ClipsVirales)' } as const;

/**
 * Modal «Datos de ClipsVirales»: se muestra al abrir si se encuentran datos o instalación de la versión anterior
 * (o desde Configuración → Almacenamiento). Nada se migra ni se borra sin elegir una opción.
 */
export function LegacyModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone?: () => void }) {
  const [scan, setScan] = useState<LegacyScan | null>(null);
  const [busy, setBusy] = useState<'' | 'keep' | 'free'>('');
  const [result, setResult] = useState<LegacyMigrateResult | null>(null);
  const [confirmFree, setConfirmFree] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!open) return;
    setResult(null);
    setErr('');
    setConfirmFree(false);
    void api().legacyScan().then(setScan).catch((e) => setErr(errMsg(e)));
  }, [open]);

  const run = async (mode: 'keep' | 'free') => {
    setBusy(mode);
    setErr('');
    try {
      setResult(await api().legacyMigrate(mode));
      onDone?.();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy('');
    }
  };
  const exportsItem = scan?.items.find((i) => i.kind === 'exports');

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title="Datos de ClipsVirales"
      footer={
        result ? (
          <button className="primary" onClick={onClose}>
            Cerrar
          </button>
        ) : confirmFree ? (
          <>
            <button className="ghost" onClick={() => setConfirmFree(false)} disabled={!!busy}>
              Volver
            </button>
            <button className="danger" disabled={!!busy} onClick={() => run('free')}>
              {busy === 'free' ? 'Migrando…' : 'Migrar y enviar lo antiguo a la Papelera'}
            </button>
          </>
        ) : (
          <>
            <button
              className="ghost"
              disabled={!!busy}
              onClick={async () => {
                await api().legacyDismiss().catch(() => undefined);
                onClose();
              }}
            >
              Ignorar por ahora
            </button>
            <span className="grow" />
            <button disabled={!!busy || !scan?.found} onClick={() => run('keep')}>
              {busy === 'keep' ? 'Migrando…' : 'Migrar y conservar copia antigua'}
            </button>
            <button className="primary" disabled={!!busy || !scan?.found} onClick={() => setConfirmFree(true)}>
              Migrar y liberar espacio
            </button>
          </>
        )
      }
    >
      {err && (
        <div className="banner error small" role="alert">
          {err}
        </div>
      )}
      {!scan && !err && <p className="small muted">Buscando datos de ClipsVirales…</p>}
      {scan && !result && (
        <>
          {scan.found ? (
            <p>
              <b>Encontramos datos de ClipsVirales que ocupan {humanSize(scan.totalBytes)}.</b> ClipsVirales es el nombre anterior de Clip Clip; Windows lo trata como otra aplicación y por eso quedan aparte.
            </p>
          ) : (
            <p>No se encontraron datos ni instalación de ClipsVirales.</p>
          )}
          {scan.migrated && <p className="small ok">Tus ajustes, historial y clips ya se migraron antes. Sólo queda la copia antigua.</p>}
          <table className="table kv">
            <tbody>
              {scan.items.map((i) => (
                <tr key={i.kind}>
                  <td>{KIND_LABELS[i.kind]}</td>
                  <td>
                    <b>{humanSize(i.bytes)}</b>
                    <div className="small muted path">{i.path}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {confirmFree ? (
            <div className="banner warn small" role="alert">
              Se migrarán ajustes, historial y metadata sin sobrescribir lo que ya tienes en Clip Clip. Sólo si la verificación es correcta, la carpeta de datos y la instalación de ClipsVirales irán a la <b>Papelera de reciclaje</b> (no se borran de forma irreversible). Si Clip Clip usa algo de esa carpeta (p. ej. el entorno Python con CUDA), esa parte se conserva.
            </div>
          ) : (
            <ul className="small muted">
              <li>«Migrar y conservar copia antigua»: copia lo útil y no toca ClipsVirales.</li>
              <li>«Migrar y liberar espacio»: copia, verifica y envía lo antiguo a la Papelera.</li>
              <li>«Ignorar por ahora»: no hace nada; puedes volver desde Configuración → Almacenamiento.</li>
            </ul>
          )}
          {exportsItem && <p className="small">Los exports antiguos ({humanSize(exportsItem.bytes)}) no se migran ni se borran aquí: revísalos tú en esa carpeta.</p>}
        </>
      )}
      {result && (
        <div role="status" aria-live="polite">
          <p>
            <b>{result.ok ? '✓ Migración completada.' : 'La migración terminó con avisos.'}</b> {result.verified ? 'Verificada: todo lo útil está en Clip Clip.' : 'No se pudo verificar; no se envió nada a la Papelera.'}
          </p>
          <ul className="small">
            <li>{result.migrated.copied + result.migrated.linked} archivos migrados ({result.migrated.linked} enlazados sin ocupar más disco)</li>
            <li>{result.migrated.mergedJobs} trabajos añadidos al historial</li>
            <li>{result.migrated.skippedExisting} archivos ya existían en Clip Clip (no se sobrescribieron)</li>
            {result.trashed.length > 0 && (
              <li>
                <b>{humanSize(result.freedBytes)}</b> enviados a la Papelera ({result.trashed.length} carpeta{result.trashed.length === 1 ? '' : 's'}). Vacíala para recuperar el espacio.
              </li>
            )}
          </ul>
          {result.trashed.some((t) => /Programs/i.test(t.path)) && <p className="small muted">Puede quedar un acceso directo o una entrada antigua de «ClipsVirales» en Aplicaciones de Windows: puedes quitarla desde ahí.</p>}
          {result.errors.length > 0 && (
            <details className="banner warn small">
              <summary>{result.errors.length} aviso(s)</summary>
              <ul>
                {result.errors.slice(0, 20).map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Al arrancar: si hay datos de ClipsVirales y el usuario no eligió «Ignorar», se abre el modal. */
export function useLegacyPrompt(): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    void api()
      .legacyScan()
      .then((s) => {
        if (s.found && !s.dismissed) setOpen(true);
      })
      .catch(() => undefined);
  }, []);
  return [open, setOpen];
}
