import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type KeyboardEvent as RKeyboardEvent } from 'react';
import type { Clip, ClipPatch, Job } from '../../shared/types';
import { LAYOUT_IDS, LAYOUT_LABELS, NEEDS_CAM, VISUAL_LABELS, decideLayout, type LayoutId, type NormRect } from '../../shared/layouts';
import { ASPECT_LABELS, ASPECT_RATIOS, SAFE_AREA, clampRect, compositionErrors, compositionOf, cornerRect, outputSize, type CamCorner, type ClipLayout } from '../../shared/composition';
import { buildCues, mergeCues, splitCue, type Cue } from '../../shared/cues';
import { formatTime } from '../../shared/validation';
import { api, errMsg } from '../api';
import { Modal } from '../components/Modal';

const DEFAULT_CAM: NormRect = { x: 0.7, y: 0.6, w: 0.28, h: 0.36 };
const CORNERS: [CamCorner, string][] = [
  ['top-left', 'Arriba izquierda'],
  ['top-right', 'Arriba derecha'],
  ['bottom-left', 'Abajo izquierda'],
  ['bottom-right', 'Abajo derecha'],
  ['custom', 'Personalizada'],
];

/**
 * Caja arrastrable y redimensionable sobre una imagen (coordenadas normalizadas 0–1).
 * Teclado: flechas mueven, Mayús+flechas cambian el tamaño.
 */
export function RectDrag({ value, onChange, label }: { value: NormRect; onChange: (r: NormRect) => void; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: 'move' | 'resize'; x: number; y: number; start: NormRect } | null>(null);
  const begin = (mode: 'move' | 'resize') => (e: RPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { mode, x: e.clientX, y: e.clientY, start: value };
  };
  const move = (e: RPointerEvent) => {
    const d = drag.current;
    const box = host.current?.parentElement?.getBoundingClientRect();
    if (!d || !box) return;
    const dx = (e.clientX - d.x) / box.width;
    const dy = (e.clientY - d.y) / box.height;
    const r = d.mode === 'move' ? { ...d.start, x: d.start.x + dx, y: d.start.y + dy } : { ...d.start, w: d.start.w + dx, h: d.start.h + dy };
    onChange(clampRect(r));
  };
  const key = (e: RKeyboardEvent) => {
    const step = 0.01;
    const k: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const v = k[e.key];
    if (!v) return;
    e.preventDefault();
    onChange(clampRect(e.shiftKey ? { ...value, w: value.w + v[0], h: value.h + v[1] } : { ...value, x: value.x + v[0], y: value.y + v[1] }));
  };
  return (
    <div
      ref={host}
      className="rect-drag"
      role="slider"
      tabIndex={0}
      aria-label={`${label}: flechas para mover, Mayús+flechas para cambiar el tamaño`}
      aria-valuetext={`x ${Math.round(value.x * 100)} %, y ${Math.round(value.y * 100)} %, ${Math.round(value.w * 100)}×${Math.round(value.h * 100)} %`}
      style={{ left: `${value.x * 100}%`, top: `${value.y * 100}%`, width: `${value.w * 100}%`, height: `${value.h * 100}%` }}
      onPointerDown={begin('move')}
      onPointerMove={move}
      onPointerUp={() => (drag.current = null)}
      onKeyDown={key}
    >
      <span className="rect-handle" aria-hidden="true" onPointerDown={begin('resize')} onPointerMove={move} onPointerUp={() => (drag.current = null)} />
    </div>
  );
}

/** Guías del área segura (cabecera arriba, descripción y botones de la app abajo y a la derecha). */
function SafeGuides() {
  return (
    <div className="safe-guides" aria-hidden="true" style={{ top: `${SAFE_AREA.top * 100}%`, bottom: `${SAFE_AREA.bottom * 100}%`, left: `${SAFE_AREA.left * 100}%`, right: `${SAFE_AREA.right * 100}%` }}>
      <span>Área segura</span>
    </div>
  );
}

function Slider(p: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmt?: (v: number) => string }) {
  return (
    <label className="slider">
      <span>
        {p.label}: {p.fmt ? p.fmt(p.value) : p.value.toFixed(2)}
      </span>
      <input type="range" min={p.min} max={p.max} step={p.step} value={p.value} onChange={(e) => p.onChange(Number(e.target.value))} />
    </label>
  );
}

/** Editor de un clip en modal: datos, composición (gameplay/facecam) y subtítulos. Sólo guarda al pulsar «Guardar». */
export function EditClipModal({ open, onClose, job, clip, onError, onInfo }: { open: boolean; onClose: () => void; job: Job; clip: Clip; onError: (m: string) => void; onInfo: (m: string) => void }) {
  const [tab, setTab] = useState<'composicion' | 'subtitulos' | 'datos'>('composicion');
  const [title, setTitle] = useState(clip.title);
  const [hook, setHook] = useState(clip.hook);
  const [start, setStart] = useState(clip.start.toFixed(2));
  const [end, setEnd] = useState(clip.end.toFixed(2));
  const [comp, setComp] = useState<ClipLayout>(compositionOf(clip));
  const [compTouched, setCompTouched] = useState(false);
  const [resetAuto, setResetAuto] = useState(false);
  const [cues, setCues] = useState<Cue[]>([]);
  const [cuesTouched, setCuesTouched] = useState(false);
  const [cuesReset, setCuesReset] = useState(false);
  const [sel, setSel] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<'' | 'preview' | 'save' | 'render'>('');
  const [err, setErr] = useState('');
  const [now, setNow] = useState(0);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(clip.title);
    setHook(clip.hook);
    setStart(clip.start.toFixed(2));
    setEnd(clip.end.toFixed(2));
    setComp(compositionOf(clip));
    setCompTouched(false);
    setResetAuto(false);
    setCuesTouched(false);
    setCuesReset(false);
    setPreview(null);
    setErr('');
    setSel(0);
    if (clip.subtitleCues) setCues(clip.subtitleCues);
    else
      void api()
        .clipWords(job.id, clip.id)
        .then((w) => setCues(buildCues(w, clip.start, clip.end)))
        .catch(() => setCues([]));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const editComp = (p: Partial<ClipLayout>) => {
    setComp((c) => ({ ...c, ...p }));
    setCompTouched(true);
    setResetAuto(false);
    setPreview(null);
  };
  const editCues = (next: Cue[]) => {
    setCues(next);
    setCuesTouched(true);
    setCuesReset(false);
  };
  const needsCam = NEEDS_CAM.includes(comp.template) || comp.template === 'custom';
  const usesOverlay = comp.template === 'custom' || (comp.template === 'game_cam_float' && comp.facecamPosition === 'custom');
  const out = outputSize(comp.outputAspectRatio);
  const compErr = compositionErrors(comp);

  const rangeChanged = Number(start) !== Number(clip.start.toFixed(2)) || Number(end) !== Number(clip.end.toFixed(2));
  const dirty = title.trim() !== clip.title || hook.trim() !== clip.hook || rangeChanged || compTouched || resetAuto || cuesTouched || cuesReset;

  const patch = (): ClipPatch => {
    const p: ClipPatch = { title: title.trim(), hook: hook.trim(), start: Number(start), end: Number(end) };
    if (resetAuto) {
      const d = decideLayout('auto', clip.visual);
      Object.assign(p, { composition: null, layout: d.layout, camRect: clip.visual?.cam ?? null });
    } else if (compTouched) {
      p.composition = {
        template: comp.template,
        facecamRect: comp.facecamRect,
        facecamCrop: comp.facecamCrop,
        facecamPosition: comp.facecamPosition,
        overlayRect: usesOverlay ? comp.overlayRect : undefined,
        gameplayCrop: comp.gameplayCrop,
        outputAspectRatio: comp.outputAspectRatio,
      };
    }
    if (cuesReset) p.subtitleCues = null;
    else if (cuesTouched) p.subtitleCues = cues;
    return p;
  };
  const run = async (kind: 'preview' | 'save' | 'render', fn: () => Promise<void>, close = false) => {
    setBusy(kind);
    setErr('');
    try {
      await fn();
      if (close) onClose();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy('');
    }
  };
  const quickPreview = () =>
    run('preview', async () =>
      setPreview(
        await api().previewLayout(job.id, clip.id, comp.template, comp.facecamRect ?? null, { start: Number(start), end: Number(end) }, {
          template: comp.template,
          facecamRect: comp.facecamRect,
          facecamCrop: comp.facecamCrop,
          facecamPosition: comp.facecamPosition,
          overlayRect: usesOverlay ? comp.overlayRect : undefined,
          gameplayCrop: comp.gameplayCrop,
          outputAspectRatio: comp.outputAspectRatio,
        }),
      ),
    );

  const frame = clip.thumb ? `clip://frame/${job.id}/${clip.thumb}` : null;
  const videoSrc = clip.archived ? (clip.exportedPath ? `clip://export/${job.id}/${clip.id}` : null) : clip.file ? `clip://job/${job.id}/${encodeURIComponent(clip.file)}?v=${encodeURIComponent(job.updatedAt)}` : null;
  const liveCue = cues.find((c) => now >= c.start && now < c.end);
  const setCue = (i: number, p: Partial<Cue>) => editCues(cues.map((c, k) => (k === i ? { ...c, ...p } : c)));

  return (
    <Modal
      open={open}
      onClose={onClose}
      dirty={dirty}
      size="lg"
      title={`Editar clip ${clip.index}`}
      footer={
        <>
          <button disabled={!!busy || compErr.length > 0} onClick={quickPreview}>
            {busy === 'preview' ? 'Generando…' : 'Vista previa rápida'}
          </button>
          <span className="grow" />
          <button className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button disabled={!!busy || !dirty} onClick={() => run('save', async () => (await api().updateClip(job.id, clip.id, patch()), onInfo(`Clip ${clip.index} guardado. Renderízalo para aplicar los cambios.`)), true)}>
            {busy === 'save' ? 'Guardando…' : 'Guardar cambios'}
          </button>
          <button
            className="primary"
            disabled={!!busy || compErr.length > 0}
            onClick={() =>
              run(
                'render',
                async () => {
                  if (dirty) await api().updateClip(job.id, clip.id, patch());
                  await api().rerenderClip(job.id, clip.id);
                  onInfo(`Clip ${clip.index} renderizado.`);
                },
                true,
              ).catch((e) => onError(errMsg(e)))
            }
          >
            {busy === 'render' ? 'Renderizando…' : 'Renderizar este clip'}
          </button>
        </>
      }
    >
      {err && (
        <div className="banner error small" role="alert">
          {err} {busy === '' && err && <span className="muted">Se conserva el resultado anterior.</span>}
        </div>
      )}
      {clip.composition?.needsReview && !compTouched && (
        <div className="banner warn small" role="status">
          Revisar composición: la detección automática de la cámara no fue fiable ({Math.round((clip.visual?.confidence ?? 0) * 100)} %). Se usó un encuadre seguro.
        </div>
      )}
      <div className="tabs" role="tablist" aria-label="Secciones del editor">
        {(
          [
            ['composicion', 'Composición'],
            ['subtitulos', 'Subtítulos'],
            ['datos', 'Título y tramo'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>

      {tab === 'composicion' && (
        <div className="editor-cols">
          <div>
            <fieldset className="templates">
              <legend className="small">Plantilla</legend>
              {LAYOUT_IDS.map((l: LayoutId) => (
                <label key={l} className={`template ${comp.template === l ? 'on' : ''}`}>
                  <input
                    type="radio"
                    name="template"
                    checked={comp.template === l}
                    onChange={() => editComp({ template: l, facecamRect: comp.facecamRect ?? ((NEEDS_CAM.includes(l) || l === 'custom') ? clip.visual?.cam ?? DEFAULT_CAM : undefined), overlayRect: l === 'custom' ? comp.overlayRect ?? cornerRect('top-right', 0.4, 4 / 3, out) : comp.overlayRect })}
                  />
                  <span>{LAYOUT_LABELS[l]}</span>
                </label>
              ))}
            </fieldset>
            <div className="grid2">
              <label className="field">
                <span>Formato de salida</span>
                <select value={comp.outputAspectRatio} onChange={(e) => editComp({ outputAspectRatio: e.target.value as ClipLayout['outputAspectRatio'] })}>
                  {ASPECT_RATIOS.map((a) => (
                    <option key={a} value={a}>
                      {ASPECT_LABELS[a]}
                    </option>
                  ))}
                </select>
              </label>
              {comp.template === 'game_cam_float' && (
                <label className="field">
                  <span>Posición de la cámara</span>
                  <select value={comp.facecamPosition} onChange={(e) => editComp({ facecamPosition: e.target.value as CamCorner, overlayRect: comp.overlayRect ?? cornerRect('top-right', 0.4, 4 / 3, out) })}>
                    {CORNERS.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <Slider label="Desplazamiento del gameplay" value={comp.gameplayCrop.x} min={-1} max={1} step={0.05} onChange={(v) => editComp({ gameplayCrop: { ...comp.gameplayCrop, x: v } })} />
            <Slider label="Zoom del gameplay" value={comp.gameplayCrop.zoom} min={1} max={3} step={0.05} fmt={(v) => `${v.toFixed(2)}×`} onChange={(v) => editComp({ gameplayCrop: { ...comp.gameplayCrop, zoom: v } })} />
            {needsCam && (
              <>
                <Slider label="Zoom de la cámara" value={comp.facecamCrop.zoom} min={1} max={3} step={0.05} fmt={(v) => `${v.toFixed(2)}×`} onChange={(v) => editComp({ facecamCrop: { ...comp.facecamCrop, zoom: v } })} />
                <Slider label="Encuadre horizontal de la cámara" value={comp.facecamCrop.x} min={-1} max={1} step={0.05} onChange={(v) => editComp({ facecamCrop: { ...comp.facecamCrop, x: v } })} />
                <Slider label="Encuadre vertical de la cámara" value={comp.facecamCrop.y} min={-1} max={1} step={0.05} onChange={(v) => editComp({ facecamCrop: { ...comp.facecamCrop, y: v } })} />
              </>
            )}
            <div className="row">
              <button
                className="ghost"
                onClick={() => {
                  const d = decideLayout('auto', clip.visual);
                  setComp(compositionOf({ layout: d.layout, camRect: clip.visual?.cam, visual: clip.visual }));
                  setCompTouched(false);
                  setResetAuto(true);
                  setPreview(null);
                }}
              >
                Restablecer detección automática
              </button>
            </div>
            {compErr.map((m) => (
              <p key={m} className="field-issue small">
                {m}
              </p>
            ))}
            {clip.visual && (
              <details className="diagnostic">
                <summary className="small">Diagnóstico de la detección</summary>
                <p className="small muted">
                  {VISUAL_LABELS[clip.visual.cls]} · confianza {Math.round(clip.visual.confidence * 100)} % · {clip.visual.engine} · origen {comp.source}
                </p>
              </details>
            )}
          </div>
          <div>
            {needsCam && (
              <>
                <p className="small muted">Arrastra el recuadro hasta la cámara (esquina inferior derecha para redimensionar).</p>
                <div className="cam-frame" style={job.sourceVideo ? { aspectRatio: `${job.sourceVideo.width} / ${job.sourceVideo.height}` } : { aspectRatio: '16 / 9' }}>
                  {frame ? <img src={frame} alt="Fotograma del clip" draggable={false} /> : <div className="video-ph">Sin fotograma</div>}
                  <RectDrag label="Cámara en el vídeo original" value={comp.facecamRect ?? DEFAULT_CAM} onChange={(r) => editComp({ facecamRect: r })} />
                </div>
              </>
            )}
            <div className="out-frame" style={{ aspectRatio: `${out.w} / ${out.h}` }}>
              {preview ? <img src={`clip://frame/${job.id}/${preview}?t=${Date.now()}`} alt="Vista previa del resultado" /> : <div className="video-ph small">Pulsa «Vista previa rápida»</div>}
              <SafeGuides />
              {usesOverlay && <RectDrag label="Cámara en el vídeo final" value={comp.overlayRect ?? cornerRect('top-right', 0.4, 4 / 3, out)} onChange={(r) => editComp({ overlayRect: r })} />}
            </div>
          </div>
        </div>
      )}

      {tab === 'subtitulos' && (
        <div className="editor-cols">
          <div className="sub-video">
            {videoSrc ? <video ref={video} src={videoSrc} controls preload="metadata" onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} /> : <div className="video-ph">Sin vídeo renderizado</div>}
            <div className="live-cue" aria-live="polite">
              {liveCue?.text.toUpperCase() ?? ''}
            </div>
            <p className="small muted">Vista previa instantánea sobre el vídeo actual. Los cambios se aplican al renderizar.</p>
            <button
              className="ghost"
              onClick={() => {
                void api()
                  .clipWords(job.id, clip.id)
                  .then((w) => {
                    setCues(buildCues(w, Number(start), Number(end)));
                    setCuesTouched(false);
                    setCuesReset(true);
                  });
              }}
            >
              Restablecer versión automática
            </button>
          </div>
          <ol className="cue-list">
            {cues.map((c, i) => (
              <li key={`${i}-${c.start}`} className={i === sel ? 'on' : ''} onFocus={() => setSel(i)}>
                <div className="row">
                  <input className="cue-time" type="number" step={0.05} min={0} aria-label={`Inicio del subtítulo ${i + 1}`} value={c.start} onChange={(e) => setCue(i, { start: Number(e.target.value) })} />
                  <span aria-hidden="true">→</span>
                  <input className="cue-time" type="number" step={0.05} min={0} aria-label={`Fin del subtítulo ${i + 1}`} value={c.end} onChange={(e) => setCue(i, { end: Number(e.target.value) })} />
                  <button
                    className="link small"
                    aria-label={`Reproducir desde el subtítulo ${i + 1}`}
                    onClick={() => {
                      setSel(i);
                      if (video.current) {
                        video.current.currentTime = c.start;
                        void video.current.play();
                      }
                    }}
                  >
                    ▶ {formatTime(c.start)}
                  </button>
                </div>
                <input className="cue-text" aria-label={`Texto del subtítulo ${i + 1}`} value={c.text} maxLength={120} onChange={(e) => setCue(i, { text: e.target.value })} />
                <div className="row small">
                  <button className="link" disabled={c.text.split(' ').length < 2} onClick={() => editCues(splitCue(cues, i, Math.ceil(c.text.split(' ').length / 2)))}>
                    Dividir
                  </button>
                  <button className="link" disabled={i === cues.length - 1} onClick={() => editCues(mergeCues(cues, i))}>
                    Unir con el siguiente
                  </button>
                  <button className="link" onClick={() => editCues(cues.filter((_, k) => k !== i))}>
                    Quitar
                  </button>
                </div>
              </li>
            ))}
            {cues.length === 0 && <li className="small muted">No hay subtítulos para este tramo.</li>}
          </ol>
        </div>
      )}

      {tab === 'datos' && (
        <>
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
          {rangeChanged && cues.length > 0 && !cuesTouched && <p className="small muted">Los subtítulos automáticos se recalculan para el nuevo tramo al renderizar.</p>}
        </>
      )}
    </Modal>
  );
}
