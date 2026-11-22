import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type KeyboardEvent as RKeyboardEvent } from 'react';
import type { Clip, ClipPatch, Job } from '../../shared/types';
import { ADVANCED_TEMPLATES, LAYOUT_LABELS, MAIN_TEMPLATES, NEEDS_CAM, NO_CAM_CONFIRMED, VISUAL_LABELS, decideLayout, type LayoutId, type NormRect } from '../../shared/layouts';
import { ASPECT_LABELS, ASPECT_RATIOS, SAFE_AREA, clampRect, compositionErrors, compositionOf, cornerRect, outputSize, type CamCorner, type ClipLayout } from '../../shared/composition';
import { activeWordIndex, buildCues, mergeCues, shiftCue, splitCue, wordTimings, type Cue } from '../../shared/cues';
import { formatTime } from '../../shared/validation';
import { api, errMsg } from '../api';
import { Modal } from '../components/Modal';
import { TimeRangeEditor } from '../components/TimeRangeEditor';

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
export function RectDrag({ value, onChange, label, lockAspect = false }: { value: NormRect; onChange: (r: NormRect) => void; label: string; lockAspect?: boolean }) {
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
    const w = d.start.w + dx;
    // Con la proporción bloqueada, el alto sigue al ancho (misma forma en el vídeo original).
    const r = d.mode === 'move' ? { ...d.start, x: d.start.x + dx, y: d.start.y + dy } : { ...d.start, w, h: lockAspect ? (w * d.start.h) / d.start.w : d.start.h + dy };
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

/** Frase del subtítulo en mayúsculas; en karaoke, SÓLO la palabra que se dice en el color activo (igual que el ASS). */
export function KaraokeLine({ cue, t, karaoke, color }: { cue?: Cue; t: number; karaoke: boolean; color: string }) {
  if (!cue) return null;
  if (!karaoke) return <>{cue.text.toUpperCase()}</>;
  const ws = wordTimings(cue);
  const active = activeWordIndex(ws, t);
  return (
    <>
      {ws.map((w, i) => (
        <span key={i} className={i === active ? 'kw on' : 'kw'} style={{ color: i === active ? color : 'var(--c-ivory)' }}>
          {w.text.toUpperCase()}
          {i < ws.length - 1 ? ' ' : ''}
        </span>
      ))}
    </>
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
  /** Inicio (s del vídeo) al que son relativos los tiempos de `cues`. */
  const [cuesOrigin, setCuesOrigin] = useState(clip.start);
  const [sel, setSel] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<'' | 'preview' | 'save' | 'render'>('');
  const [err, setErr] = useState('');
  const [now, setNow] = useState(0);
  const [lockAspect, setLockAspect] = useState(false);
  const [showDiag, setShowDiag] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  /** Mientras se reproduce, el karaoke sigue al vídeo fotograma a fotograma (timeupdate sólo llega cada ~250 ms). */
  const followPlayback = () => {
    const tick = () => {
      const v = video.current;
      if (!v || v.paused || v.ended) return;
      setNow(v.currentTime);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  const [subStyle, setSubStyle] = useState<{ style: 'standard' | 'karaoke'; color: string }>({ style: 'karaoke', color: '#00C285' });
  useEffect(() => {
    if (open) void api().getSettings().then((st) => setSubStyle({ style: st.subtitleStyle ?? 'karaoke', color: st.subtitleActiveColor ?? '#00C285' })).catch(() => undefined);
  }, [open]);

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
    setCuesOrigin(clip.start);
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
  /** Las guías de área segura sólo tienen sentido si la cámara flota sobre el gameplay. */
  const floating = comp.template === 'game_cam_float' || comp.template === 'custom';
  const srcW = job.sourceVideo?.width ?? 1920;
  const srcH = job.sourceVideo?.height ?? 1080;
  /** Ajusta la selección de la cámara del ORIGEN a una proporción (en píxeles reales), alrededor de su centro. */
  const fitSourceTo = (aspect: number) => {
    const r = comp.sourceFacecamRect ?? DEFAULT_CAM;
    let w = r.w;
    let h = (w * srcW) / aspect / srcH;
    if (h > 1) {
      h = 1;
      w = (h * srcH * aspect) / srcW;
    }
    editComp({ sourceFacecamRect: clampRect({ x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h }) });
  };
  const resetDetection = () => {
    const d = decideLayout('auto', clip.visual);
    setComp(compositionOf({ layout: d.layout, camRect: clip.visual?.cam, visual: clip.visual }));
    setCompTouched(false);
    setResetAuto(true);
    setPreview(null);
  };
  const diag = clip.visual?.diagnostic;
  const pickTemplate = (l: LayoutId) =>
    editComp({
      template: l,
      sourceFacecamRect: comp.sourceFacecamRect ?? (NEEDS_CAM.includes(l) || l === 'custom' ? clip.visual?.cam ?? DEFAULT_CAM : undefined),
      outputFacecamRect: l === 'custom' ? comp.outputFacecamRect ?? cornerRect('top-right', 0.4, 4 / 3, out) : comp.outputFacecamRect,
    });
  const templateOption = (l: LayoutId) => (
    <label key={l} className={`template ${comp.template === l ? 'on' : ''}`}>
      <input type="radio" name="template" checked={comp.template === l} onChange={() => pickTemplate(l)} />
      <span>{LAYOUT_LABELS[l]}</span>
    </label>
  );

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
        sourceFacecamRect: comp.sourceFacecamRect,
        facecamCrop: comp.facecamCrop,
        facecamPosition: comp.facecamPosition,
        facecamFit: comp.facecamFit,
        outputFacecamRect: usesOverlay ? comp.outputFacecamRect : undefined,
        gameplayCrop: comp.gameplayCrop,
        outputAspectRatio: comp.outputAspectRatio,
      };
    }
    if (cuesReset) p.subtitleCues = null;
    else if (cuesTouched) {
      // Si el tramo cambió en esta misma sesión, los tiempos se pasan al nuevo inicio (siguen pegados a las mismas palabras).
      const shift = cuesOrigin - Number(start);
      p.subtitleCues = shift ? cues.map((c) => shiftCue(c, shift)).filter((c) => c.end > 0) : cues;
    }
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
        // Sólo una composición editada (o ya manual) se envía como ajuste manual; la automática conserva el desplazamiento global.
        await api().previewLayout(job.id, clip.id, comp.template, comp.sourceFacecamRect ?? null, { start: Number(start), end: Number(end) }, !compTouched && (resetAuto || !clip.composition?.manualOverride) ? null : {
          template: comp.template,
          sourceFacecamRect: comp.sourceFacecamRect,
          facecamCrop: comp.facecamCrop,
          facecamPosition: comp.facecamPosition,
          facecamFit: comp.facecamFit,
          outputFacecamRect: usesOverlay ? comp.outputFacecamRect : undefined,
          gameplayCrop: comp.gameplayCrop,
          outputAspectRatio: comp.outputAspectRatio,
        }),
      ),
    );

  const frame = clip.thumb ? `clip://frame/${job.id}/${clip.thumb}` : null;
  const videoSrc = clip.archived ? (clip.exportedPath ? `clip://export/${job.id}/${clip.id}` : null) : clip.file ? `clip://job/${job.id}/${encodeURIComponent(clip.file)}?v=${encodeURIComponent(job.updatedAt)}` : null;
  const liveCue = cues.find((c) => now >= c.start && now < c.end);
  // Al editar el texto o los tiempos, los tiempos por palabra de Whisper dejan de valer: se reparten provisionalmente.
  const setCue = (i: number, p: Partial<Cue>) => editCues(cues.map((c, k) => (k === i ? { ...c, ...p, words: undefined } : c)));
  const noKaraoke = cues.length > 0 && cues.every((c) => c.noWordTiming);
  const approxCount = cues.filter((c) => !c.noWordTiming && wordTimings(c).some((w) => w.approx)).length;

  return (
    <Modal
      open={open}
      onClose={onClose}
      dirty={dirty}
      size="lg"
      title={`Editar clip ${clip.index}`}
      footer={
        <>
          <button className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button disabled={!!busy || !dirty} onClick={() => run('save', async () => (await api().updateClip(job.id, clip.id, patch()), onInfo(`Clip ${clip.index} guardado. Renderízalo para aplicar los cambios.`)), true)}>
            {busy === 'save' ? 'Guardando…' : 'Guardar cambios'}
          </button>
          <button disabled={!!busy || compErr.length > 0} aria-busy={busy === 'preview' || undefined} onClick={quickPreview}>
            {busy === 'preview' && <span className="spinner" aria-hidden="true" />}
            {busy === 'preview' ? 'Generando…' : 'Vista previa rápida'}
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
          {NO_CAM_CONFIRMED} La detección automática no fue fiable ({Math.round((clip.visual?.confidence ?? 0) * 100)} %): se usó un encuadre seguro.
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
              {MAIN_TEMPLATES.map(templateOption)}
              <details className="advanced" open={ADVANCED_TEMPLATES.includes(comp.template)}>
                <summary className="small">Herramientas avanzadas (no usan la cámara detectada)</summary>
                {ADVANCED_TEMPLATES.map(templateOption)}
              </details>
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
                  <span>Posición de la cámara en el resultado</span>
                  <select value={comp.facecamPosition} onChange={(e) => editComp({ facecamPosition: e.target.value as CamCorner, outputFacecamRect: comp.outputFacecamRect ?? cornerRect('top-right', 0.4, 4 / 3, out) })}>
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
                <fieldset className="fit-choice">
                  <legend className="small">Cámara en su panel</legend>
                  <label className="check">
                    <input type="radio" name="fit" checked={comp.facecamFit !== 'contain'} onChange={() => editComp({ facecamFit: 'cover' })} />
                    <span>
                      <b>Llenar panel sin barras negras</b> <span className="small muted">(recomendado, como un Short)</span>
                    </span>
                  </label>
                  <label className="check">
                    <input type="radio" name="fit" checked={comp.facecamFit === 'contain'} onChange={() => editComp({ facecamFit: 'contain' })} />
                    <span>
                      Mostrar cámara completa con fondo desenfocado <span className="small muted">(avanzado)</span>
                    </span>
                  </label>
                </fieldset>
                <Slider label="Zoom de cámara" value={comp.facecamCrop.zoom} min={1} max={3} step={0.05} fmt={(v) => `${v.toFixed(2)}×`} onChange={(v) => editComp({ facecamCrop: { ...comp.facecamCrop, zoom: v } })} />
                <Slider label="Encuadre horizontal" value={comp.facecamCrop.x} min={-1} max={1} step={0.05} onChange={(v) => editComp({ facecamCrop: { ...comp.facecamCrop, x: v } })} />
                <Slider label="Encuadre vertical" value={comp.facecamCrop.y} min={-1} max={1} step={0.05} onChange={(v) => editComp({ facecamCrop: { ...comp.facecamCrop, y: v } })} />
              </>
            )}
            {compErr.map((m) => (
              <p key={m} className="field-issue small">
                {m}
              </p>
            ))}
          </div>
          <div>
            {needsCam && (
              <section className="editor-section" aria-labelledby="src-cam-h">
                <h3 id="src-cam-h" className="small">
                  1 · Cámara en el vídeo original
                </h3>
                <p className="small muted">Selecciona toda la ventana de la cámara. Este recuadro determina qué se extrae del vídeo original.</p>
                {clip.composition?.needsReview && !compTouched && (
                  <p className="small warn-text" role="status">
                    No pudimos confirmar la cámara. Ajusta el recuadro manualmente.
                  </p>
                )}
                <div className="cam-frame" style={{ aspectRatio: `${srcW} / ${srcH}` }}>
                  {frame ? <img src={frame} alt="Fotograma del vídeo original" draggable={false} /> : <div className="video-ph">Sin fotograma</div>}
                  <RectDrag label="Cámara en el vídeo original" lockAspect={lockAspect} value={comp.sourceFacecamRect ?? DEFAULT_CAM} onChange={(r) => editComp({ sourceFacecamRect: r })} />
                </div>
                <div className="row small wrap">
                  <label className="check">
                    <input type="checkbox" checked={lockAspect} onChange={(e) => setLockAspect(e.target.checked)} />
                    <span>Mantener proporción</span>
                  </label>
                  <button className="ghost" onClick={() => fitSourceTo(16 / 9)}>
                    Ajustar a 16:9
                  </button>
                  <button className="ghost" onClick={() => fitSourceTo(4 / 3)}>
                    Ajustar a 4:3
                  </button>
                  <button className="ghost" onClick={() => fitSourceTo(1)}>
                    Ajustar a cuadrado
                  </button>
                </div>
              </section>
            )}
            <div className="row small wrap">
              <button className="ghost" onClick={resetDetection}>
                Restablecer detección automática
              </button>
              <button className="link" aria-expanded={showDiag} onClick={() => setShowDiag((v) => !v)}>
                Ver diagnóstico
              </button>
            </div>
            {showDiag && (
              <div className="diagnostic small" role="region" aria-label="Diagnóstico de la detección">
                {clip.visual ? (
                  <ul>
                    <li>
                      Resultado: {VISUAL_LABELS[clip.visual.cls]} · confianza {Math.round(clip.visual.confidence * 100)} % · motor {clip.visual.engine}
                    </li>
                    {diag && (
                      <li>
                        Muestras: {diag.samples} fotogramas en {diag.windows} ventanas · consistencia {Math.round(diag.consistency * 100)} %
                      </li>
                    )}
                    {diag?.rect && (
                      <li>
                        Rectángulo final: x {Math.round(diag.rect.x * 100)} %, y {Math.round(diag.rect.y * 100)} %, {Math.round(diag.rect.w * 100)}×{Math.round(diag.rect.h * 100)} %
                      </li>
                    )}
                    <li>Motivo: {diag?.reason ?? clip.layoutReason ?? '—'}</li>
                    {diag?.candidates && diag.candidates.length > 0 && (
                      <li>
                        Candidatos ({diag.candidates.length}):{' '}
                        {diag.candidates.map((c, i) => (
                          <span key={i} className="small muted">
                            {i ? ' · ' : ''}
                            {Math.round(c.rect.x * 100)},{Math.round(c.rect.y * 100)} {Math.round(c.rect.w * 100)}×{Math.round(c.rect.h * 100)} % ({Math.round(c.confidence * 100)} %)
                          </span>
                        ))}
                      </li>
                    )}
                    {clip.layoutReason && diag && <li>Decisión: {clip.layoutReason}</li>}
                  </ul>
                ) : (
                  <p className="muted">Este clip no tiene análisis visual.</p>
                )}
              </div>
            )}
            <section className="editor-section" aria-labelledby="out-h">
              <h3 id="out-h" className="small">
                {needsCam ? '2 · ' : ''}Resultado {comp.outputAspectRatio === '9:16' ? 'vertical' : comp.outputAspectRatio}
              </h3>
              <p className="small muted">Así quedará el clip: la vista previa usa el mismo filtro que el render final.</p>
              <div className="out-frame" style={{ aspectRatio: `${out.w} / ${out.h}`, width: `min(100%, calc(min(520px, 60vh) * ${(out.w / out.h).toFixed(4)}))` }}>
                {preview ? <img src={`clip://frame/${job.id}/${preview}?t=${Date.now()}`} alt="Vista previa del resultado" /> : <div className="video-ph small">Pulsa «Vista previa rápida»</div>}
                {floating && <SafeGuides />}
                {usesOverlay && <RectDrag label="Cámara en el resultado" value={comp.outputFacecamRect ?? cornerRect('top-right', 0.4, 4 / 3, out)} onChange={(r) => editComp({ outputFacecamRect: r })} />}
              </div>
              {usesOverlay && <p className="small muted">Este recuadro sólo mueve la cámara en el resultado; no cambia qué parte del original se recorta.</p>}
            </section>
          </div>
        </div>
      )}

      {tab === 'subtitulos' && (
        <div className="editor-cols">
          <div className="sub-video">
            {videoSrc ? <video ref={video} src={videoSrc} controls preload="metadata" onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} onPlay={followPlayback} /> : <div className="video-ph">Sin vídeo renderizado</div>}
            <div className="live-cue" aria-live="off">
              <KaraokeLine cue={liveCue} t={now} karaoke={subStyle.style === 'karaoke' && !liveCue?.noWordTiming} color={subStyle.color} />
            </div>
            <p className="small muted">Vista previa instantánea sobre el vídeo actual, con el mismo resaltado que el render final. Los cambios se aplican al renderizar.</p>
            {subStyle.style === 'karaoke' && noKaraoke && (
              <p className="small warn-text" role="status">
                Karaoke no disponible: esta transcripción no tiene tiempos por palabra. Se usa el subtítulo estándar. Prueba «Reprocesar transcripción en modo preciso».
              </p>
            )}
            {subStyle.style === 'karaoke' && approxCount > 0 && (
              <p className="small warn-text" role="status">
                {approxCount} {approxCount === 1 ? 'frase editada tiene' : 'frases editadas tienen'} tiempos por palabra aproximados (repartidos según el texto): puede que necesiten ajuste.
              </p>
            )}
            <button
              className="ghost"
              onClick={() => {
                void api()
                  .clipWords(job.id, clip.id, { start: Number(start), end: Number(end) })
                  .then((w) => {
                    setCues(buildCues(w, Number(start), Number(end)));
                    setCuesOrigin(Number(start));
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
              <li key={i} className={i === sel ? 'on' : ''} onFocus={() => setSel(i)}>
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
                {!c.noWordTiming && !c.words && <span className="small muted">≈ tiempos por palabra aproximados</span>}
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
          <h3 className="sub-h">Tramo del vídeo</h3>
          <TimeRangeEditor
            jobId={job.id}
            clipId={clip.id}
            preset={job.preset}
            sourceDuration={job.sourceDuration ?? clip.end}
            original={{ start: clip.start, end: clip.end }}
            start={Number(start)}
            end={Number(end)}
            onChange={(r) => {
              setStart(r.start.toFixed(2));
              setEnd(r.end.toFixed(2));
            }}
            hasSource={!job.sourceCleaned && !job.archivedExportsOnly}
          />
          {rangeChanged && cues.length > 0 && !cuesTouched && <p className="small muted">Los subtítulos automáticos se recalculan para el nuevo tramo al renderizar.</p>}
        </>
      )}
    </Modal>
  );
}
