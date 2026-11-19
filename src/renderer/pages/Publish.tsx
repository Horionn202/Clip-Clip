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
  type CopyPart,
  type Platform,
  type PublishStatus,
} from '../../shared/publish';
import { NICHES, PLATFORM_GUIDES, TONES, TONE_LABELS, liveIssues, type Tone } from '../../shared/editorial';
import { formatTime } from '../../shared/validation';
import { api, errMsg } from '../api';
import { Modal } from '../components/Modal';

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

/** Hashtags como chips editables: Enter/espacio/coma añade, Retroceso en vacío quita el último. */
function HashtagChips({ value, onChange, max }: { value: string[]; onChange: (v: string[]) => void; max: number }) {
  const [text, setText] = useState('');
  const add = (raw: string) => {
    const next = normalizeHashtags([...value, ...normalizeHashtags(raw)]);
    onChange(next);
    setText('');
  };
  return (
    <div className="chips" role="group" aria-label="Hashtags">
      {value.map((t) => (
        <span key={t} className="chip">
          {t}
          <button type="button" className="chip-x" aria-label={`Quitar ${t}`} onClick={() => onChange(value.filter((x) => x !== t))}>
            ×
          </button>
        </span>
      ))}
      <input
        value={text}
        aria-label="Añadir hashtag"
        placeholder={value.length >= max ? '' : 'Añadir hashtag…'}
        onChange={(e) => (/[\s,;]$/.test(e.target.value) ? add(e.target.value) : setText(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (text.trim()) add(text);
          } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => text.trim() && add(text)}
      />
    </div>
  );
}

interface Draft {
  title: string;
  description: string;
  hashtags: string[];
  cta: string;
}
const toDraft = (m = EMPTY_META): Draft => ({ title: m.title, description: m.description, hashtags: [...m.hashtags], cta: m.cta ?? '' });
const sameDraft = (a: Draft, b: Draft) => a.title.trim() === b.title.trim() && a.description.trim() === b.description.trim() && a.cta.trim() === b.cta.trim() && a.hashtags.join(' ') === b.hashtags.join(' ');

/**
 * Modal «Preparar publicación»: textos por plataforma (IA local o manual), variantes de título, copiar y estado.
 * Nada se sube; sólo se guarda al pulsar «Guardar borrador» (o al copiar/cambiar estado, que guardan antes).
 */
export function PublishModal(props: { open: boolean; onClose: () => void; job: Job; clip: Clip; pub?: ClipPublish; onData: (d: PubMap) => void; onInfo: (m: string) => void }) {
  const { job, clip, pub } = props;
  const [platform, setPlatform] = useState<Platform>('tiktok');
  const entry = pub?.[platform];
  const ed = pub?.editorial;
  const [draft, setDraft] = useState<Draft>(toDraft());
  const [url, setUrl] = useState('');
  const [tone, setTone] = useState<Tone>((ed?.tone as Tone) || 'neutro');
  const [niche, setNiche] = useState(ed?.niche ?? '');
  const [busy, setBusy] = useState<'' | 'ia' | 'save' | 'status' | 'copy'>('');
  const [error, setError] = useState('');
  const [aiIssues, setAiIssues] = useState<string[]>([]);
  const [aiNote, setAiNote] = useState('');
  const [model, setModel] = useState('');

  useEffect(() => {
    void api()
      .getSettings()
      .then((s) => setModel(s.ollamaModel))
      .catch(() => undefined);
  }, []);
  // Al abrir, cambiar de plataforma o llegar datos nuevos, el borrador parte de lo guardado.
  useEffect(() => {
    setDraft(toDraft(entry?.meta));
    setUrl(entry?.publishedUrl ?? '');
  }, [props.open, platform, entry?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!props.open) return;
    setError('');
    setAiIssues([]);
    setAiNote('');
    setTone((ed?.tone as Tone) || 'neutro');
    setNiche(ed?.niche ?? '');
  }, [props.open]); // eslint-disable-line react-hooks/exhaustive-deps

  const saved = toDraft(entry?.meta);
  const dirty = !sameDraft(draft, saved);
  const meta = { title: draft.title.trim(), description: draft.description.trim(), hashtags: draft.hashtags, cta: draft.cta.trim() };
  const lim = PLATFORM_LIMITS[platform];
  const warnings = [...metaWarnings(platform, meta)];
  const inline = liveIssues(platform, meta);
  const issuesOf = (f: string) => inline.filter((i) => i.field === f).map((i) => i.message);
  const duration = clip.end - clip.start;
  const hasText = !!(meta.title || meta.description || meta.hashtags.length);

  const run = async (k: typeof busy, fn: () => Promise<void>) => {
    setBusy(k);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy('');
    }
  };
  const save = async () => props.onData(await api().savePublish(job.id, clip.id, platform, meta));
  const copy = (part: CopyPart, label: string) =>
    run('copy', async () => {
      if (dirty) await save();
      await api().copyPublish(job.id, clip.id, platform, part);
      props.onInfo(`${label} de ${PLATFORM_LABELS[platform]} copiado al portapapeles.`);
    });
  const setStatus = (st: PublishStatus) =>
    run('status', async () => {
      if (dirty) await save();
      props.onData(await api().setPublishStatus(job.id, clip.id, platform, st, st === 'publicado' ? url : undefined));
    });
  const regenerate = () => {
    if (dirty && !window.confirm('Regenerar sustituye el texto sin guardar de esta plataforma. Las versiones guardadas quedan en el historial. ¿Continuar?')) return;
    void run('ia', async () => {
      setAiIssues([]);
      setAiNote('');
      const r = await api().generatePublish(job.id, clip.id, { tone, niche });
      props.onData(r.data);
      if (r.ok) setAiNote(r.repaired ? 'Textos generados; se quitaron algunos hashtags poco relevantes. Revísalos antes de publicar.' : 'Textos generados con IA local para las 3 plataformas. Revísalos antes de publicar.');
      else {
        // Nunca se guarda un resultado inválido: el editor queda como estaba (o vacío) para editar a mano.
        setAiIssues(r.issues ?? []);
        setAiNote(r.reason === 'contexto' ? 'La IA necesita más contexto; edita manualmente.' : 'La IA no generó un texto válido tras dos intentos. No se guardó nada: edita manualmente o prueba otro tono.');
      }
    });
  };

  const thumb = clip.thumb ? `clip://frame/${job.id}/${clip.thumb}` : null;
  const videoSrc = clip.archived ? (clip.exportedPath ? `clip://export/${job.id}/${clip.id}` : null) : clip.file ? `clip://job/${job.id}/${encodeURIComponent(clip.file)}?v=${encodeURIComponent(job.updatedAt)}` : null;

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      dirty={dirty}
      size="lg"
      className="publish-modal"
      title={<span className="sr-only">Preparar publicación</span>}
      headerExtra={
        <div className="pub-head grow">
          {thumb ? <img className="pub-thumb" src={thumb} alt="" /> : <div className="pub-thumb video-ph" aria-hidden="true" />}
          <div className="grow">
            <input
              className="pub-title-input"
              aria-label="Título de la publicación"
              placeholder={lim.hasTitle ? 'Título' : 'Título (opcional, primera línea del texto)'}
              value={draft.title}
              maxLength={300}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
            <div className="small muted">
              {duration.toFixed(0)} s · {entry ? PUBLISH_STATUS_LABELS[entry.status] : 'Sin texto'}
              {clip.dirty ? ' · cambios sin renderizar' : ''}
            </div>
          </div>
        </div>
      }
      footer={
        <>
          <button disabled={!!busy || !dirty} onClick={() => run('save', async () => (await save(), props.onInfo('Borrador guardado.')))}>
            {busy === 'save' ? 'Guardando…' : 'Guardar borrador'}
          </button>
          <button disabled={!!busy} onClick={regenerate}>
            {busy === 'ia' ? 'Generando…' : ed?.variants?.length || entry ? 'Regenerar' : 'Generar con IA'}
          </button>
          <span className="grow" />
          <button className="ghost" disabled={!!busy || !meta.title} onClick={() => copy('title', 'Título')}>
            Copiar título
          </button>
          <button className="ghost" disabled={!!busy || !meta.description} onClick={() => copy('description', 'Descripción')}>
            Copiar descripción
          </button>
          <button className="ghost" disabled={!!busy || !meta.hashtags.length} onClick={() => copy('hashtags', 'Hashtags')}>
            Copiar hashtags
          </button>
          <button className="primary" disabled={!!busy || !hasText} onClick={() => copy('all', 'Texto completo')}>
            Copiar publicación completa
          </button>
        </>
      }
    >
      <div className="tabs" role="tablist" aria-label="Plataforma">
        {PLATFORMS.map((p) => (
          <button
            key={p}
            role="tab"
            aria-selected={platform === p}
            className={platform === p ? 'on' : ''}
            onClick={() => {
              if (p !== platform && dirty && !window.confirm('Hay cambios sin guardar en esta plataforma. ¿Cambiar y descartarlos?')) return;
              setPlatform(p);
            }}
          >
            {PLATFORM_LABELS[p]}
            {pub?.[p] && <span className={`count pub-${pub[p]!.status}`}> · {PUBLISH_STATUS_LABELS[pub[p]!.status]}</span>}
          </button>
        ))}
      </div>
      {error && (
        <div className="banner error small" role="alert">
          {error}
        </div>
      )}
      {aiNote && (
        <div className={`banner ${aiIssues.length || aiNote.includes('contexto') ? 'warn' : 'info'} small`} role="status">
          {aiNote}
        </div>
      )}

      <div className="pub-cols">
        <div className="pub-preview">
          {videoSrc ? <video src={videoSrc} controls preload="metadata" /> : <div className="video-ph">Sin vídeo</div>}
          <p className="small muted">
            {PLATFORM_GUIDES[platform].summary}
          </p>
          <details>
            <summary className="small">Buenas prácticas en {PLATFORM_LABELS[platform]}</summary>
            <ul className="small muted">
              {PLATFORM_GUIDES[platform].tips.map((t) => (
                <li key={t}>{t}</li>
              ))}
              <li>Son recomendaciones, no garantizan alcance ni resultados.</li>
            </ul>
          </details>
          <button className="ghost small" onClick={() => api().revealClipVideo(job.id, clip.id).catch((e) => setError(errMsg(e)))}>
            Mostrar vídeo en la carpeta
          </button>
        </div>

        <div className="pub-fields">
          <div className="grid2">
            <label className="field">
              <span>Tono</span>
              <select value={tone} onChange={(e) => setTone(e.target.value as Tone)}>
                {TONES.map((t) => (
                  <option key={t} value={t}>
                    {TONE_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Nicho / categoría</span>
              <select value={niche} onChange={(e) => setNiche(e.target.value)}>
                {NICHES.map((n) => (
                  <option key={n} value={n}>
                    {n || 'Sin especificar'}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {ed?.variants && ed.variants.length > 0 && (
            <fieldset className="variants">
              <legend className="small">Variantes de título (elige una)</legend>
              {ed.variants.map((v) => (
                <label key={v.title} className="variant">
                  <input type="radio" name="variant" checked={draft.title.trim() === v.title} onChange={() => setDraft({ ...draft, title: v.title })} />
                  <span>
                    <b>{v.title}</b>
                    {v.reason && <span className="small muted"> — {v.reason}</span>}
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {issuesOf('title').map((m) => (
            <p key={m} className="field-issue small">
              Título: {m}
            </p>
          ))}

          <label className="field">
            <span>
              {lim.hasTitle ? 'Descripción' : 'Texto'} ({copyText(platform, meta).length}/{lim.description})
            </span>
            <textarea rows={4} value={draft.description} maxLength={6000} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </label>
          {issuesOf('description').map((m) => (
            <p key={m} className="field-issue small">
              {m}
            </p>
          ))}

          <label className="field">
            <span>Llamada a la acción (opcional)</span>
            <input value={draft.cta} maxLength={300} placeholder="p. ej. ¿Te ha pasado algo así?" onChange={(e) => setDraft({ ...draft, cta: e.target.value })} />
          </label>
          {issuesOf('cta').map((m) => (
            <p key={m} className="field-issue small">
              {m}
            </p>
          ))}

          <div className="field">
            <span>
              Hashtags ({draft.hashtags.length}/{Math.min(6, lim.hashtags)} recomendados)
            </span>
            <HashtagChips value={draft.hashtags} max={lim.hashtags} onChange={(h) => setDraft({ ...draft, hashtags: h })} />
          </div>
          {issuesOf('hashtags').map((m) => (
            <p key={m} className="field-issue small">
              {m}
            </p>
          ))}

          {warnings.length > 0 && (
            <ul className="banner warn small">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

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
                    <b>{new Date(v.at).toLocaleString('es-ES')}</b> · {v.source === 'ia' ? 'IA' : v.source === 'manual' ? 'manual' : 'restaurada'}
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

          <details className="diagnostic">
            <summary className="small">Diagnóstico</summary>
            <ul className="small muted">
              <li>Modelo Ollama: {ed?.model || model || '—'} (local)</li>
              {ed?.generatedAt && <li>Última generación: {new Date(ed.generatedAt).toLocaleString('es-ES')}</li>}
              <li>Tramo del clip: {formatTime(clip.start)} → {formatTime(clip.end)}</li>
              {aiIssues.length > 0 && <li>Motivos del rechazo: {aiIssues.join(' · ')}</li>}
            </ul>
          </details>
        </div>
      </div>
      <p className="small muted model-line">Se genera en tu equipo con Ollama{model ? ` (${model})` : ''}. Las versiones anteriores quedan en el historial.</p>
    </Modal>
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
          <details>
            <summary className="small">Reglas y buenas prácticas</summary>
            <ul className="small muted">
              {PLATFORM_GUIDES[c.platform].tips.map((t) => (
                <li key={t}>{t}</li>
              ))}
              <li>Son recomendaciones, no garantías de alcance.</li>
            </ul>
          </details>
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
