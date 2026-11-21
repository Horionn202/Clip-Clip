import { useEffect, useState } from 'react';
import { MISSING_LABELS, type LegacyCheck, type LegacyFreeResult, type LegacyMigrateResult, type LegacyRepairResult, type MissingCategory } from '../../shared/types';
import { humanSize } from '../../shared/storage';
import { api, errMsg } from '../api';
import { ConfirmModal, Modal } from '../components/Modal';
import { Button, StatusPill } from '../components/ui';

type Target = 'data' | 'install' | 'exports';
const TARGET_LABELS: Record<Target, string> = { data: 'copia antigua de datos', install: 'instalación antigua', exports: 'exports antiguos' };

/**
 * «Datos de ClipsVirales»: migrar, verificar, reparar y liberar por partes. Nunca deja al usuario sin una acción:
 * si faltan archivos se ofrece «Reparar migración»; la instalación antigua y los exports se pueden liberar aparte.
 * Las rutas las decide el proceso principal (el modal sólo elige qué parte).
 */
export function LegacyModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone?: () => void }) {
  const [c, setC] = useState<LegacyCheck | null>(null);
  const [busy, setBusy] = useState<'' | 'check' | 'migrate' | 'repair' | Target>('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [repair, setRepair] = useState<LegacyRepairResult | null>(null);
  const [migr, setMigr] = useState<LegacyMigrateResult | null>(null);
  const [confirm, setConfirm] = useState<Target | null>(null);
  const [showList, setShowList] = useState(false);

  const recheck = async () => {
    setBusy('check');
    setErr('');
    try {
      setC(await api().legacyCheck());
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy('');
    }
  };
  useEffect(() => {
    if (!open) return;
    setC(null);
    setMsg('');
    setRepair(null);
    setMigr(null);
    setShowList(false);
    void recheck();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const doMigrate = async () => {
    setBusy('migrate');
    setErr('');
    try {
      setMigr(await api().legacyMigrate('keep'));
      onDone?.();
      setC(await api().legacyCheck());
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy('');
    }
  };
  const doRepair = async () => {
    setBusy('repair');
    setErr('');
    try {
      const r = await api().legacyRepair();
      setRepair(r);
      setC(r.check);
      onDone?.();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy('');
    }
  };
  const doFree = async (t: Target) => {
    setConfirm(null);
    setBusy(t);
    setErr('');
    try {
      const r: LegacyFreeResult = await api().legacyFree(t);
      setMsg(
        r.errors.length
          ? `No se pudo enviar todo a la Papelera (${r.errors.length} error${r.errors.length === 1 ? '' : 'es'}): no se ha borrado nada de forma permanente. Puedes reintentarlo. ${r.errors[0]}`
          : `Se enviaron ${humanSize(r.freedBytes)} de la ${TARGET_LABELS[t]} a la Papelera de reciclaje. Vacíala para recuperar el espacio.${r.kept.length ? ` Se conservó lo que Clip Clip usa (${r.kept.length} carpeta${r.kept.length === 1 ? '' : 's'}).` : ''}`,
      );
      setC(await api().legacyCheck());
      onDone?.();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy('');
    }
  };

  const cats = c ? (Object.keys(c.byCategory) as MissingCategory[]).filter((k) => c.byCategory[k] > 0) : [];
  const confirmBytes = confirm === 'data' ? c?.dataFreeableBytes : confirm === 'install' ? c?.install?.freeableBytes : c?.exports?.bytes;

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        size="md"
        title="Datos de ClipsVirales"
        footer={
          <>
            {c?.state === 'none' && c.data ? (
              <Button variant="ghost" onClick={() => void api().legacyDismiss().catch(() => undefined).then(onClose)}>
                Ignorar por ahora
              </Button>
            ) : (
              <Button variant="ghost" onClick={onClose}>
                {c?.state === 'needs_repair' ? 'Conservar copia antigua por ahora' : 'Cerrar'}
              </Button>
            )}
            {c && c.state !== 'none' && (
              <Button variant="ghost" loading={busy === 'check'} onClick={() => void recheck()}>
                Volver a verificar
              </Button>
            )}
          </>
        }
      >
        {err && (
          <div className="banner error small" role="alert">
            <span className="grow">{err}</span>
            <Button size="sm" onClick={() => void recheck()}>
              Reintentar
            </Button>
          </div>
        )}
        {msg && (
          <div className="banner info small" role="status">
            {msg}
          </div>
        )}
        {!c && !err && <p className="small muted">Comprobando los datos de la versión anterior…</p>}

        {c && (
          <>
            {/* A. Todo migrado y verificado */}
            {c.state === 'verified' && (
              <div className="banner info" role="status">
                <span className="grow">
                  <b>Tus datos ya están seguros en Clip Clip.</b> La copia antigua ocupa {humanSize(c.data?.bytes ?? 0)}; se pueden recuperar {humanSize(c.dataFreeableBytes)}.
                </span>
              </div>
            )}

            {/* B. Migración parcial: faltan archivos */}
            {c.state === 'needs_repair' && (
              <div className="banner warn" role="status">
                <span className="grow">
                  Encontramos <b>{c.missingTotal} archivos</b> que aún no están disponibles en Clip Clip. Por seguridad, no borraremos la copia antigua.
                </span>
              </div>
            )}

            {/* C. Error de lectura o permisos */}
            {c.state === 'partial' && (
              <div className="banner error" role="alert">
                <span className="grow">
                  No se pudieron leer estas carpetas de la versión anterior, así que no se borra nada:
                  <ul className="small">
                    {c.readErrors.slice(0, 5).map((e) => (
                      <li key={e} className="path">
                        {e}
                      </li>
                    ))}
                  </ul>
                  Comprueba que ningún programa las está usando y pulsa «Volver a verificar».
                </span>
              </div>
            )}

            {c.state === 'none' && c.data && (
              <p>
                <b>Encontramos datos de ClipsVirales ({humanSize(c.data.bytes)}).</b> ClipsVirales es el nombre anterior de Clip Clip. Migra tus ajustes, historial y clips: nada se sobrescribe y la copia antigua se conserva hasta que lo verifiques.
              </p>
            )}
            {c.state === 'legacy_trashed' && !c.install && !c.exports && <p>La copia antigua ya se envió a la Papelera. No queda nada de ClipsVirales por revisar.</p>}

            {cats.length > 0 && (
              <ul className="summary-list" aria-label="Archivos que faltan por categoría">
                {cats.map((k) => (
                  <li key={k}>
                    <span>{MISSING_LABELS[k]}</span>
                    <b>{c.byCategory[k]}</b>
                  </li>
                ))}
              </ul>
            )}
            {c.intentional > 0 && (
              <p className="small muted">
                {c.intentional} archivo{c.intentional === 1 ? '' : 's'} de la copia antigua no están en Clip Clip porque los borraste allí (trabajos eliminados o espacio liberado): no hacen falta.
              </p>
            )}
            {c.missingTotal > 0 && (
              <details open={showList} onToggle={(e) => setShowList((e.target as HTMLDetailsElement).open)}>
                <summary className="small">Ver archivos faltantes</summary>
                <ul className="small pick-list">
                  {c.missing.map((m) => (
                    <li key={m.rel} className="path">
                      {m.rel}
                    </li>
                  ))}
                  {c.missingTotal > c.missing.length && <li className="muted">…y {c.missingTotal - c.missing.length} más</li>}
                </ul>
              </details>
            )}

            {repair && (
              <div className="banner info small" role="status">
                Reparación: {repair.linked + repair.copied} archivos recuperados ({repair.linked} enlazados sin ocupar más disco, {repair.copied} copiados: +{humanSize(repair.copiedBytes)} en disco). {repair.skippedExisting ? `${repair.skippedExisting} ya existían y no se tocaron. ` : ''}
                {repair.check.state === 'verified' ? 'Verificación correcta.' : `Aún faltan ${repair.check.missingTotal}.`}
                {repair.errors.length > 0 && ` ${repair.errors.length} error(es): ${repair.errors[0]}`}
              </div>
            )}
            {migr && (
              <div className="banner info small" role="status">
                Migración: {migr.migrated.copied + migr.migrated.linked} archivos ({migr.migrated.linked} enlazados), {migr.migrated.mergedJobs} trabajos añadidos al historial, {migr.migrated.skippedExisting} ya existían.
              </div>
            )}

            <div className="row" style={{ margin: 'var(--s-4) 0' }}>
              {c.state === 'none' && c.data && (
                <Button variant="primary" loading={busy === 'migrate'} onClick={() => void doMigrate()}>
                  Migrar y conservar copia antigua
                </Button>
              )}
              {(c.state === 'needs_repair' || c.state === 'repaired') && c.missingTotal > 0 && (
                <Button variant="primary" loading={busy === 'repair'} onClick={() => void doRepair()}>
                  Reparar migración ({c.missingTotal} archivos faltantes)
                </Button>
              )}
              {c.canFreeData && (
                <Button variant="primary" loading={busy === 'data'} onClick={() => setConfirm('data')} aria-haspopup="dialog">
                  Enviar copia antigua a la Papelera ({humanSize(c.dataFreeableBytes)})
                </Button>
              )}
              {c.data && (
                <Button variant="ghost" onClick={() => void api().legacyOpen('data').catch((e) => setErr(errMsg(e)))}>
                  Abrir ubicación
                </Button>
              )}
            </div>

            {/* D. Instalación antigua independiente */}
            {c.install && (
              <section className="storage-card" aria-label="Instalación antigua">
                <div className="row">
                  <b className="grow">Instalación antigua de ClipsVirales</b>
                  <StatusPill>{humanSize(c.install.bytes)}</StatusPill>
                </div>
                <p className="small muted path">{c.install.path}</p>
                {!c.canFreeData && c.data && <p className="small muted">Se puede liberar aunque los datos antiguos sigan sin verificar: esos datos se conservan hasta que la migración esté verificada.</p>}
                {c.install.keptInUse.length > 0 && <p className="small muted">Se conserva lo que Clip Clip usa todavía ({c.install.keptInUse.length} carpeta{c.install.keptInUse.length === 1 ? '' : 's'}).</p>}
                <div className="row">
                  <Button size="sm" loading={busy === 'install'} disabled={!c.install.freeableBytes} onClick={() => setConfirm('install')} aria-haspopup="dialog">
                    Enviar sólo instalación antigua a la Papelera ({humanSize(c.install.freeableBytes)})
                  </Button>
                </div>
              </section>
            )}

            {/* E. Exports antiguos */}
            {c.exports && (
              <section className="storage-card" aria-label="Exports antiguos">
                <div className="row">
                  <b className="grow">Exports antiguos</b>
                  <StatusPill>{humanSize(c.exports.bytes)}</StatusPill>
                </div>
                <p className="small muted path">{c.exports.path}</p>
                <p className="small muted">No se borran automáticamente. Revísalos antes: pueden ser clips que quieras conservar.</p>
                <div className="row">
                  <Button size="sm" variant="ghost" onClick={() => void api().legacyOpen('exports').catch((e) => setErr(errMsg(e)))}>
                    Abrir carpeta
                  </Button>
                  <Button size="sm" variant="danger" loading={busy === 'exports'} onClick={() => setConfirm('exports')} aria-haspopup="dialog">
                    Enviar exports antiguos a la Papelera…
                  </Button>
                </div>
              </section>
            )}
          </>
        )}
      </Modal>
      <ConfirmModal
        open={!!confirm}
        title={confirm ? `Enviar ${TARGET_LABELS[confirm]} a la Papelera` : ''}
        confirmLabel={`Enviar ${humanSize(confirmBytes ?? 0)} a la Papelera`}
        danger={confirm === 'exports'}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm && void doFree(confirm)}
      >
        {confirm && (
          <>
            <p className="small path">{confirm === 'data' ? c?.data?.path : confirm === 'install' ? c?.install?.path : c?.exports?.path}</p>
            <p>
              Irá a la <b>Papelera de reciclaje</b> ({humanSize(confirmBytes ?? 0)}). Si la Papelera falla, no se borra nada de forma permanente.
            </p>
            {confirm === 'exports' && <p className="small warn-text">Son vídeos exportados por la versión anterior: confirma que ya no los necesitas.</p>}
            {confirm !== 'exports' && <p className="small muted">Lo que Clip Clip todavía usa (por ejemplo, el entorno de Python con CUDA) se conserva.</p>}
          </>
        )}
      </ConfirmModal>
    </>
  );
}

/** Al arrancar: si hay datos de ClipsVirales y el usuario no eligió «Ignorar», se abre el modal. */
export function useLegacyPrompt(): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    void api()
      .legacyScan()
      .then((s) => {
        if (s.found && !s.dismissed && !s.migrated) setOpen(true);
      })
      .catch(() => undefined);
  }, []);
  return [open, setOpen];
}
