import { useEffect, useState } from 'react';
import type { Clip, Job, PublishedExportInfo } from '../../shared/types';
import { PLATFORMS, PLATFORM_LABELS, type ClipPublish, type Platform } from '../../shared/publish';
import { humanSize } from '../../shared/storage';
import { api, errMsg } from '../api';
import { Modal } from '../components/Modal';

/** Botón «Eliminar export ya publicado» en la tarjeta del clip (sólo si está publicado y tiene export). */
export function PublishedExportAction({ job, clip, pub, onError, onInfo }: { job: Job; clip: Clip; pub?: ClipPublish; onError: (m: string) => void; onInfo: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<PublishedExportInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const published = PLATFORMS.some((p) => pub?.[p]?.status === 'publicado');
  useEffect(() => {
    if (!open) return;
    setInfo(null);
    void api()
      .listPublishedExports(undefined, job.id, clip.id)
      .then((r) => setInfo(r.items[0] ?? null))
      .catch((e) => onError(errMsg(e)));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!published || !clip.exportedPath) return null;
  return (
    <>
      <button className="ghost small" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        Eliminar export ya publicado
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="sm"
        title="Eliminar export ya publicado"
        footer={
          <>
            <button className="ghost" onClick={() => setOpen(false)}>
              Cancelar
            </button>
            <button
              className="danger"
              disabled={!info || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await api().deletePublishedExports([{ jobId: job.id, clipId: clip.id }]);
                  if (r.deleted) onInfo(`Export enviado a la Papelera (${humanSize(r.freedBytes)}). Se conservan título, textos e historial.`);
                  else if (r.errors.length) onError(r.errors[0].message);
                  setOpen(false);
                } catch (e) {
                  onError(errMsg(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Enviar a la Papelera
            </button>
          </>
        }
      >
        {!info ? (
          <p className="small muted">Este export no se puede eliminar: tiene plataformas pendientes, no está en la carpeta de exportación o ya no existe.</p>
        ) : (
          <>
            <table className="table kv">
              <tbody>
                <tr><td>Archivo</td><td><b>{info.name}</b></td></tr>
                <tr><td>Tamaño</td><td>{humanSize(info.bytes)}</td></tr>
                <tr><td>Ruta</td><td className="path small">{info.path}</td></tr>
                <tr><td>Publicado en</td><td>{info.platforms.map((p) => PLATFORM_LABELS[p]).join(', ')}</td></tr>
              </tbody>
            </table>
            <p className="small">Se elimina el MP4 exportado (va a la Papelera de reciclaje). El clip queda marcado como «export eliminado tras publicación» y se conservan su título, descripción, hashtags e historial.</p>
          </>
        )}
      </Modal>
    </>
  );
}

/** Acción de lote «Limpiar exports publicados»: elige plataformas, revisa la lista y confirma. */
export function PublishedExportsCleanup({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [plats, setPlats] = useState<Platform[]>([...PLATFORMS]);
  const [items, setItems] = useState<PublishedExportInfo[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const key = (x: { jobId: string; clipId: string }) => `${x.jobId}/${x.clipId}`;

  useEffect(() => {
    if (!open) return;
    setMsg(null);
    setItems(null);
    void api()
      .listPublishedExports(plats.length ? plats : undefined)
      .then((r) => {
        const list = plats.length ? r.items : [];
        setItems(list);
        setSel(new Set(list.map(key)));
      })
      .catch((e) => setMsg({ kind: 'error', text: errMsg(e) }));
  }, [open, plats.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = (items ?? []).filter((x) => sel.has(key(x)));
  const bytes = chosen.reduce((a, x) => a + x.bytes, 0);
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title="Limpiar exports publicados"
      footer={
        <>
          <span className="grow small muted">
            {chosen.length} clip{chosen.length === 1 ? '' : 's'} · {humanSize(bytes)} recuperables
          </span>
          <button className="ghost" onClick={onClose}>
            Cerrar
          </button>
          <button
            className="danger"
            disabled={!chosen.length || busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api().deletePublishedExports(chosen.map(({ jobId, clipId }) => ({ jobId, clipId })));
                setMsg({ kind: r.errors.length ? 'error' : 'info', text: `${r.deleted} export(s) enviados a la Papelera (${humanSize(r.freedBytes)}).${r.errors.length ? ` ${r.errors.length} no se pudieron eliminar.` : ''}` });
                const again = await api().listPublishedExports(plats);
                setItems(again.items);
                setSel(new Set(again.items.map(key)));
              } catch (e) {
                setMsg({ kind: 'error', text: errMsg(e) });
              } finally {
                setBusy(false);
              }
            }}
          >
            Enviar a la Papelera…
          </button>
        </>
      }
    >
      <p className="small">
        Sólo aparecen clips <b>publicados</b> cuyo export está en tu carpeta de exportación. Nunca se incluyen clips en borrador, listos, programados o sin publicar. Se conservan títulos, textos e historial.
      </p>
      <fieldset className="row">
        <legend className="small">Publicados en:</legend>
        {PLATFORMS.map((p) => (
          <label key={p} className="check">
            <input type="checkbox" checked={plats.includes(p)} onChange={(e) => setPlats(e.target.checked ? [...plats, p] : plats.filter((x) => x !== p))} /> {PLATFORM_LABELS[p]}
          </label>
        ))}
      </fieldset>
      {msg && (
        <div className={`banner ${msg.kind === 'error' ? 'error' : 'info'} small`} role="status">
          {msg.text}
        </div>
      )}
      {items === null ? (
        <p className="small muted">Buscando…</p>
      ) : items.length === 0 ? (
        <p className="small muted">No hay exports publicados que se puedan limpiar.</p>
      ) : (
        <ul className="pick-list">
          {items.map((x) => (
            <li key={key(x)}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={sel.has(key(x))}
                  onChange={(e) => {
                    const n = new Set(sel);
                    if (e.target.checked) n.add(key(x));
                    else n.delete(key(x));
                    setSel(n);
                  }}
                />
                <span className="grow">
                  <b>{x.title}</b> · {humanSize(x.bytes)} · {x.platforms.map((p) => PLATFORM_LABELS[p]).join(', ')}
                  <span className="small muted path"> {x.name}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
