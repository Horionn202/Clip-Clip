import { useState } from 'react';
import type { Clip, ClipPatch, Job } from '../../shared/types';
import { formatTime } from '../../shared/validation';
import { LAYOUT_IDS, LAYOUT_LABELS, NEEDS_CAM, VISUAL_LABELS, type LayoutId, type NormRect } from '../../shared/layouts';
import { readyCount } from '../../shared/clipEdit';
import { api, errMsg } from '../api';

const DEFAULT_CAM: NormRect = { x: 0.7, y: 0.6, w: 0.28, h: 0.36 };

/** Editor manual de la facecam sobre el fotograma real del clip (accesible por teclado con los deslizadores). */
function CamEditor({ job, clip, value, onChange }: { job: Job; clip: Clip; value: NormRect; onChange: (r: NormRect) => void }) {
  const set = (k: keyof NormRect, v: number) => {
    const r = { ...value, [k]: v / 100 };
    // Mantener dentro de la imagen.
    r.w = Math.min(r.w, 1 - r.x);
    r.h = Math.min(r.h, 1 - r.y);
    onChange(r);
  };
  const pct = (n: number) => Math.round(n * 100);
  return (
    <div className="cam-editor">
      {/* El marco usa el aspecto real del origen y la imagen entera (sin recortes), así las coordenadas coinciden con el render. */}
      <div
        className="cam-frame"
        style={
          job.sourceVideo
            ? {
                aspectRatio: `${job.sourceVideo.width} / ${job.sourceVideo.height}`,
                // Vídeos verticales: se limita el ancho para no pasar de 420 px de alto sin deformar.
                width: `min(100%, calc(420px * ${job.sourceVideo.width} / ${job.sourceVideo.height}))`,
              }
            : { aspectRatio: '16 / 9' }
        }
      >
        {clip.thumb ? <img src={`clip://frame/${job.id}/${clip.thumb}`} alt="Fotograma del clip" /> : <div className="video-ph">Sin fotograma</div>}
        <div
          className="cam-box"
          style={{ left: `${value.x * 100}%`, top: `${value.y * 100}%`, width: `${value.w * 100}%`, height: `${value.h * 100}%` }}
          aria-hidden="true"
        />
      </div>
      {(['x', 'y', 'w', 'h'] as const).map((k) => (
        <label key={k} className="slider">
          <span>{{ x: 'Izquierda', y: 'Arriba', w: 'Ancho', h: 'Alto' }[k]}: {pct(value[k])} %</span>
          <input type="range" min={k === 'w' || k === 'h' ? 3 : 0} max={100} value={pct(value[k])} onChange={(e) => set(k, Number(e.target.value))} />
        </label>
      ))}
    </div>
  );
}

function ClipCard({ job, clip, onError, onInfo }: { job: Job; clip: Clip; onError: (m: string) => void; onInfo: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(clip.title);
  const [hook, setHook] = useState(clip.hook);
  const [start, setStart] = useState(clip.start.toFixed(2));
  const [end, setEnd] = useState(clip.end.toFixed(2));
  const [layout, setLayout] = useState<LayoutId>(clip.layout ?? 'gameplay_full');
  const [cam, setCam] = useState<NormRect | null>(clip.camRect ?? null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<'' | 'preview' | 'save' | 'render'>('');

  const needsCam = NEEDS_CAM.includes(layout);
  const patch = (): ClipPatch => ({ title: title.trim(), hook: hook.trim(), start: Number(start), end: Number(end), layout, camRect: cam });
  const run = async (kind: 'preview' | 'save' | 'render', fn: () => Promise<void>) => {
    setBusy(kind);
    try {
      await fn();
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setBusy('');
    }
  };

  const videoSrc = clip.file ? `clip://job/${job.id}/${encodeURIComponent(clip.file)}?v=${encodeURIComponent(job.updatedAt)}` : null;
  return (
    <article className="clip" aria-label={`Clip ${clip.index}`}>
      {videoSrc ? <video src={videoSrc} controls preload="metadata" /> : <div className="video-ph">Sin renderizar</div>}
      <div className="row">
        <b className="grow clip-title">{clip.title}</b>
        {clip.dirty && <span className="badge partial">Cambios sin renderizar</span>}
      </div>
      {clip.hook && <p className="hook">«{clip.hook}»</p>}
      <div className="muted small">
        {formatTime(clip.start)} → {formatTime(clip.end)} · {(clip.end - clip.start).toFixed(1)} s · {LAYOUT_LABELS[clip.layout ?? 'gameplay_full']}
      </div>
      {clip.visual && (
        <div className="small muted">
          Análisis visual (experimental): {VISUAL_LABELS[clip.visual.cls]} · confianza {Math.round(clip.visual.confidence * 100)} %
        </div>
      )}
      {clip.layoutSuggestion && clip.layoutSuggestion !== (clip.layout ?? 'gameplay_full') && (
        <div className="banner warn small">
          Sugerencia: {LAYOUT_LABELS[clip.layoutSuggestion]}. {clip.layoutReason}
        </div>
      )}
      <div className="row">
        <button
          disabled={!clip.file || clip.dirty}
          title={clip.dirty ? 'Vuelve a renderizar el clip antes de exportarlo' : undefined}
          onClick={async () => {
            try {
              onInfo(`Exportado a ${await api().exportClip(job.id, clip.id)}`);
            } catch (e) {
              onError(errMsg(e));
            }
          }}
        >
          Exportar
        </button>
        <button
          className="ghost"
          aria-expanded={editing}
          onClick={() => {
            // Al abrir el editor, los borradores parten del clip guardado actual.
            if (!editing) {
              setTitle(clip.title);
              setHook(clip.hook);
              setStart(clip.start.toFixed(2));
              setEnd(clip.end.toFixed(2));
              setLayout(clip.layout ?? 'gameplay_full');
              setCam(clip.camRect ?? null);
              setPreview(null);
            }
            setEditing(!editing);
          }}
        >
          {editing ? 'Cerrar edición' : 'Editar clip'}
        </button>
        {clip.exportedPath && <span className="small ok">✓ exportado</span>}
      </div>

      {editing && (
        <div className="editor">
          <label className="field">
            <span>Título</span>
            <input value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field">
            <span>Hook</span>
            <input value={hook} maxLength={200} onChange={(e) => setHook(e.target.value)} />
          </label>
          <div className="grid2">
            <label className="field">
              <span>Inicio (s)</span>
              <input type="number" step="0.1" min={0} value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label className="field">
              <span>Fin (s)</span>
              <input type="number" step="0.1" min={0} value={end} onChange={(e) => setEnd(e.target.value)} />
            </label>
          </div>
          <label className="field">
            <span>Plantilla vertical</span>
            <select
              value={layout}
              onChange={(e) => {
                const l = e.target.value as LayoutId;
                setLayout(l);
                setPreview(null);
                if (NEEDS_CAM.includes(l) && !cam) setCam(clip.visual?.cam ?? DEFAULT_CAM);
              }}
            >
              {LAYOUT_IDS.map((l) => (
                <option key={l} value={l}>
                  {LAYOUT_LABELS[l]}
                </option>
              ))}
            </select>
          </label>
          {needsCam && cam && (
            <>
              <p className="small muted">Ajusta el recuadro a la cámara si la detección falló.</p>
              <CamEditor
                job={job}
                clip={clip}
                value={cam}
                onChange={(r) => {
                  setCam(r);
                  setPreview(null);
                }}
              />
            </>
          )}
          {preview && <img className="layout-preview" src={`clip://frame/${job.id}/${preview}?t=${Date.now()}`} alt="Vista previa del layout" />}
          <div className="row">
            <button disabled={!!busy} onClick={() => run('preview', async () => setPreview(await api().previewLayout(job.id, clip.id, layout, needsCam ? cam : null, { start: Number(start), end: Number(end) })))}>
              {busy === 'preview' ? 'Generando…' : 'Vista previa'}
            </button>
            <button
              disabled={!!busy}
              onClick={() =>
                run('save', async () => {
                  await api().updateClip(job.id, clip.id, patch());
                  onInfo(`Clip ${clip.index} actualizado.`);
                })
              }
            >
              {busy === 'save' ? 'Guardando…' : 'Guardar cambios'}
            </button>
            <button
              className="primary"
              disabled={!!busy}
              onClick={() =>
                run('render', async () => {
                  await api().updateClip(job.id, clip.id, patch());
                  await api().rerenderClip(job.id, clip.id);
                  onInfo(`Clip ${clip.index} re-renderizado.`);
                })
              }
            >
              {busy === 'render' ? 'Renderizando…' : 'Guardar y volver a renderizar'}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

export function ResultsPage(props: { jobs: Job[]; selected: string | null; onSelect: (id: string) => void }) {
  const done = props.jobs.filter((j) => j.status === 'completed');
  const job = done.find((j) => j.id === props.selected) ?? done[0];
  const [msg, setMsg] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);

  if (!job)
    return (
      <section className="page">
        <h1>Resultados</h1>
        <div className="empty">Todavía no hay clips. Cuando un trabajo termine, aparecerán aquí.</div>
      </section>
    );
  const { ready, total } = readyCount(job.clips);

  return (
    <section className="page">
      <div className="row">
        <h1 className="grow">Resultados</h1>
        <select aria-label="Trabajo" value={job.id} onChange={(e) => props.onSelect(e.target.value)}>
          {done.map((j) => (
            <option key={j.id} value={j.id}>
              {(j.sourceTitle || j.url).slice(0, 60)}
            </option>
          ))}
        </select>
      </div>
      <p className="ready-count" role="status">
        <b>
          {ready}/{total} clips listos
        </b>
        {ready < total && ' · hay clips con cambios sin renderizar'}
      </p>
      <div className="row toolbar">
        <button onClick={() => api().openJobFolder(job.id).catch((e) => setMsg({ kind: 'error', text: errMsg(e) }))}>Abrir carpeta de resultados</button>
        <button
          onClick={async () => {
            try {
              const n = await api().exportAll(job.id);
              setMsg({ kind: 'info', text: `${n} clips exportados.` });
            } catch (e) {
              setMsg({ kind: 'error', text: errMsg(e) });
            }
          }}
        >
          Exportar todos
        </button>
        <button className="ghost" onClick={() => api().openExportFolder()}>
          Abrir carpeta de exportación
        </button>
      </div>
      {job.resultSummary && (
        <div className={`banner ${job.analysis && job.analysis.obtained < job.analysis.effectiveTarget ? 'warn' : 'info'}`}>{job.resultSummary}</div>
      )}
      {msg && (
        <div className={`banner ${msg.kind === 'error' ? 'error' : 'info'}`} role="alert">
          {msg.text}
        </div>
      )}
      <div className="gallery">
        {job.clips.map((c) => (
          <ClipCard key={c.id} job={job} clip={c} onError={(t) => setMsg({ kind: 'error', text: t })} onInfo={(t) => setMsg({ kind: 'info', text: t })} />
        ))}
      </div>
    </section>
  );
}
