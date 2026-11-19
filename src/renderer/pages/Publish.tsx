import { useEffect, useRef, useState } from 'react';
import type { Clip, Job } from '../../shared/types';
import {
  EMPTY_META,
  PLATFORMS,
  PLATFORM_LABELS,
  PLATFORM_LIMITS,
  PUBLISH_STATUS_LABELS,
  STATUS_ORDER,
  copyText,
  metaWarnings,
  normalizeHashtags,
  publishSummary,
  type ClipPublish,
  type ConnectionInfo,
  type Platform,
  type PublishStatus,
} from '../../shared/publish';
import { api, errMsg } from '../api';

type PubMap = Record<string, ClipPublish>;

/** Chips de estado por plataforma para la tarjeta del clip. */
export function PublishBadges({ pub }: { pub?: ClipPublish }) {
  const s = publishSummary(pub);
  if (!s.length) return null;
  return (
    <div className="row small publish-badges">
      {s.map((x) => (
        <span key={x.platform} className={`badge pub-${x.status}`}>
          {PLATFORM_LABELS[x.platform]}: {PUBLISH_STATUS_LABELS[x.status]}
        </span>
      ))}
    </div>
  );
}

/** Panel «Publicar» de un clip: texto por plataforma (IA o manual), copiar, estados e historial. Nada se sube. */
export function PublishPanel(props: { job: Job; clip: Clip; pub?: ClipPublish; onData: (d: PubMap) => void; onError: (m: string) => void; onInfo: (m: string) => void }) {
  const { job, clip, pub } = props;
  const [platform, setPlatform] = useState<Platform>('tiktok');
  const entry = pub?.[platform];
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [tags, setTags] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<'' | 'ia' | 'save' | 'status'>('');

  // Al cambiar de plataforma o llegar datos nuevos, el borrador parte de lo guardado.
  useEffect(() => {
    const m = entry?.meta ?? EMPTY_META;
    setTitle(m.title);
    setDesc(m.description);
    setTags(m.hashtags.join(' '));
    setUrl(entry?.publishedUrl ?? '');
  }, [platform, entry?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const draft = { title, description: desc, hashtags: normalizeHashtags(tags) };
  const dirty = !entry || entry.meta.title !== draft.title.trim() || entry.meta.description !== desc.trim() || entry.meta.hashtags.join(' ') !== draft.hashtags.join(' ');
  const warnings = metaWarnings(platform, { ...draft, title: draft.title.trim(), description: desc.trim() });
  const lim = PLATFORM_LIMITS[platform];

  const run = async (k: 'ia' | 'save' | 'status', fn: () => Promise<void>) => {
    setBusy(k);
    try {
      await fn();
    } catch (e) {
      props.onError(errMsg(e));
    } finally {
      setBusy('');
    }
  };
  const save = async () => props.onData(await api().savePublish(job.id, clip.id, platform, draft));
  const setStatus = (st: PublishStatus) =>
    run('status', async () => {
      if (dirty) await save();
      props.onData(await api().setPublishStatus(job.id, clip.id, platform, st, st === 'publicado' ? url : undefined));
    });

  return (
    <div className="editor publish-panel">
      <div className="tabs" role="tablist" aria-label="Plataforma">
        {PLATFORMS.map((p) => (
          <button key={p} role="tab" aria-selected={platform === p} className={platform === p ? 'on' : ''} onClick={() => setPlatform(p)}>
            {PLATFORM_LABELS[p]}
            {pub?.[p] && <span className={`count pub-${pub[p]!.status}`}> · {PUBLISH_STATUS_LABELS[pub[p]!.status]}</span>}
          </button>
        ))}
      </div>
      <div className="row">
        <button disabled={!!busy} onClick={() => run('ia', async () => (props.onData(await api().generatePublish(job.id, clip.id)), props.onInfo('Textos generados con IA local para las 3 plataformas. Revísalos antes de publicar.')))}>
          {busy === 'ia' ? 'Generando con IA…' : pub ? 'Regenerar con IA (3 plataformas)' : 'Generar con IA (3 plataformas)'}
        </button>
        <span className="small muted grow">Se genera en tu equipo con Ollama. Las versiones anteriores quedan en el historial.</span>
      </div>
      {lim.hasTitle && (
        <label className="field">
          <span>
            Título ({title.trim().length}/{lim.title})
          </span>
          <input value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
        </label>
      )}
      <label className="field">
        <span>{lim.hasTitle ? 'Descripción' : 'Texto'}</span>
        <textarea rows={4} value={desc} maxLength={6000} onChange={(e) => setDesc(e.target.value)} />
      </label>
      <label className="field">
        <span>Hashtags ({draft.hashtags.length}/{lim.hashtags})</span>
        <input value={tags} placeholder="#gaming #clips" onChange={(e) => setTags(e.target.value)} />
      </label>
      {warnings.length > 0 && (
        <ul className="banner warn small">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <div className="row">
        <button className="primary" disabled={!!busy || !dirty} onClick={() => run('save', async () => (await save(), props.onInfo('Texto guardado.')))}>
          {busy === 'save' ? 'Guardando…' : 'Guardar texto'}
        </button>
        <button
          disabled={!!busy || (!entry && !dirty)}
          onClick={() =>
            run('save', async () => {
              if (dirty) await save();
              await api().copyPublish(job.id, clip.id, platform);
              props.onInfo(`Texto de ${PLATFORM_LABELS[platform]} copiado al portapapeles.`);
            })
          }
        >
          Copiar texto
        </button>
        <button className="ghost" onClick={() => api().revealClipVideo(job.id, clip.id).catch((e) => props.onError(errMsg(e)))}>
          Mostrar vídeo en la carpeta
        </button>
      </div>
      <details>
        <summary className="small">Vista previa del texto a pegar</summary>
        <pre className="publish-preview">{copyText(platform, { ...draft, title: draft.title.trim(), description: desc.trim() }) || '(vacío)'}</pre>
      </details>

      <fieldset className="publish-status" disabled={!!busy || (!entry && !dirty)}>
        <legend className="small">Estado en {PLATFORM_LABELS[platform]} (lo marcas tú; Clip Clip no publica nada)</legend>
        <div className="row">
          {STATUS_ORDER.filter((s) => s !== 'publicado').map((s) => (
            <button key={s} className={entry?.status === s ? 'on' : 'ghost'} aria-pressed={entry?.status === s} onClick={() => setStatus(s)}>
              {PUBLISH_STATUS_LABELS[s]}
            </button>
          ))}
        </div>
        <div className="row">
          <input className="grow" type="url" placeholder="Enlace de la publicación (opcional, https://…)" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Enlace de la publicación" />
          <button className={entry?.status === 'publicado' ? 'on' : ''} onClick={() => setStatus('publicado')}>
            Marcar como publicado…
          </button>
        </div>
        {entry?.status === 'publicado' && entry.publishedAt && (
          <p className="small ok">
            ✓ Publicado el {new Date(entry.publishedAt).toLocaleString('es-ES')}
            {entry.publishedUrl && (
              <>
                {' · '}
                <a href={entry.publishedUrl} target="_blank" rel="noreferrer">
                  ver publicación
                </a>
              </>
            )}
          </p>
        )}
      </fieldset>

      {entry && entry.versions.length > 0 && (
        <details>
          <summary className="small">Historial de versiones ({entry.versions.length})</summary>
          <ol className="versions">
            {entry.versions.map((v, i) => (
              <li key={`${v.at}-${i}`} className="small">
                <b>{new Date(v.at).toLocaleString('es-ES')}</b> · {v.source === 'ia' ? `IA${v.model ? ` (${v.model})` : ''}` : v.source === 'manual' ? 'manual' : 'restaurada'}
                {i === 0 ? ' · vigente' : ''}
                <div className="muted">{(v.meta.title ? `${v.meta.title} — ` : '') + v.meta.description.slice(0, 140)}</div>
                {i > 0 && (
                  <button className="link" disabled={!!busy} onClick={() => run('save', async () => (props.onData(await api().restorePublish(job.id, clip.id, platform, i)), props.onInfo('Versión restaurada.')))}>
                    Restaurar
                  </button>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

/** Carga los metadatos de publicación del trabajo seleccionado. */
export function usePublish(jobId: string | undefined): [PubMap, (forJob: string, d: PubMap) => void] {
  const [data, setData] = useState<PubMap>({});
  const current = useRef(jobId);
  current.current = jobId;
  // Las respuestas de otro trabajo (cambiado mientras se esperaba) se descartan.
  const setFor = (forJob: string, d: PubMap) => {
    if (forJob === current.current) setData(d);
  };
  useEffect(() => {
    setData({});
    if (jobId) void api().getPublish(jobId).then((d) => setFor(jobId, d)).catch(() => undefined);
  }, [jobId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Cambios hechos desde el proceso principal (p. ej. una generación que terminó tras salir y volver).
  useEffect(() => api().onPublishUpdate((u) => setFor(u.jobId, u.data)), []); // eslint-disable-line react-hooks/exhaustive-deps
  return [data, setFor];
}

/** Pantalla «Conexiones»: hoy todo es manual; se explica cómo se haría la conexión en el futuro. */
export function ConnectionsPage() {
  const [list, setList] = useState<ConnectionInfo[]>([]);
  useEffect(() => {
    void api().publishConnections().then(setList).catch(() => undefined);
  }, []);
  return (
    <section className="page">
      <h1>Conexiones</h1>
      <p className="muted">
        Clip Clip prepara el texto y el vídeo de cada clip, pero <b>no publica nada por ti</b>. Copias el texto, subes el vídeo exportado desde la app o la web de cada plataforma y luego marcas el clip como publicado.
      </p>
      {list.map((c) => (
        <article key={c.platform} className="card">
          <div className="row">
            <b className="grow">{c.name}</b>
            <span className="badge">{c.state === 'manual' ? 'Manual' : 'No disponible'}</span>
          </div>
          <p className="small muted">{c.detail}</p>
          <button disabled title="Aún no disponible">
            Conectar cuenta (próximamente)
          </button>
        </article>
      ))}
      <div className="banner info small">
        Privacidad: no se guardan contraseñas ni tokens. Si en el futuro se añade la conexión directa, las credenciales se guardarán cifradas en el almacén seguro de Windows y cada subida pedirá tu confirmación explícita para ese clip.
      </div>
    </section>
  );
}
