import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { DurationPreset } from '../../shared/types';
import { adjustRange } from '../../shared/clipEdit';
import { formatTime, presetRange } from '../../shared/validation';
import { api } from '../api';

type Word = { start: number; end: number; text: string };
const STEPS = [-15, -5, 5, 15];

/**
 * Edición del tramo de un clip: inicio, fin, duración, ±5/±15 s, línea de tiempo con controles arrastrables y
 * ajuste a los límites de palabra de Whisper. No guarda nada: el modal guarda y marca el clip pendiente de render.
 */
export function TimeRangeEditor(props: {
  jobId: string;
  clipId: string;
  preset: DurationPreset;
  sourceDuration: number;
  /** Tramo guardado (referencia en la línea de tiempo). */
  original: { start: number; end: number };
  start: number;
  end: number;
  onChange: (r: { start: number; end: number }) => void;
  /** Hay vídeo original para previsualizar el tramo. */
  hasSource: boolean;
}) {
  const { preset, sourceDuration: D, original } = props;
  const [snap, setSnap] = useState(true);
  /** Texto que se está escribiendo en cada campo (se aplica al salir del campo o con Enter). */
  const [draft, setDraft] = useState<{ start?: string; end?: string }>({});
  const [words, setWords] = useState<Word[]>([]);
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<'start' | 'end' | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const { min, max } = presetRange(preset);
  // Ventana visible: el tramo original con margen (y siempre el tramo actual dentro).
  const w0 = Math.max(0, Math.min(original.start - 60, props.start - 10));
  const w1 = Math.min(D || original.end + 60, Math.max(original.end + 60, props.end + 10));
  const span = Math.max(1, w1 - w0);
  const pct = (t: number) => `${((t - w0) / span) * 100}%`;

  useEffect(() => {
    let alive = true;
    api()
      .clipWords(props.jobId, props.clipId, { start: w0, end: w1 })
      .then((w) => alive && setWords(w))
      .catch(() => alive && setWords([]));
    return () => {
      alive = false;
    };
    // Se recargan sólo si la ventana se desplaza de verdad (no en cada pequeño ajuste).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.jobId, props.clipId, Math.round(w0 / 30), Math.round(w1 / 30)]);

  const move = (edge: 'start' | 'end', to: number) => props.onChange(adjustRange({ start: props.start, end: props.end }, { edge, to }, { preset, sourceDuration: D, words, snap }));
  const commit = (edge: 'start' | 'end') => {
    const raw = draft[edge];
    setDraft((d) => ({ ...d, [edge]: undefined }));
    if (raw === undefined || raw.trim() === '' || !Number.isFinite(Number(raw))) return;
    move(edge, Number(raw));
  };
  const timeAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return w0 + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * span;
  };
  const down = (edge: 'start' | 'end') => (e: RPointerEvent) => {
    drag.current = edge;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: RPointerEvent) => drag.current && move(drag.current, timeAt(e.clientX));
  const up = () => (drag.current = null);
  const dur = props.end - props.start;
  const outOfRange = dur < min - 0.01 || dur > max + 0.01;

  return (
    <div className="trange">
      <div className="trange-rows">
        {(['start', 'end'] as const).map((edge) => (
          <div key={edge} className="trange-row">
            <label className="field trange-field">
              <span>{edge === 'start' ? 'Inicio' : 'Fin'}</span>
              <input
                type="number"
                step="0.1"
                min={0}
                max={D}
                value={draft[edge] ?? (edge === 'start' ? props.start : props.end).toFixed(2)}
                onChange={(e) => setDraft((d) => ({ ...d, [edge]: e.target.value }))}
                onBlur={() => commit(edge)}
                onKeyDown={(e) => e.key === 'Enter' && commit(edge)}
              />
              <small className="muted">{formatTime(edge === 'start' ? props.start : props.end)}</small>
            </label>
            <div className="trange-steps" role="group" aria-label={`Mover el ${edge === 'start' ? 'inicio' : 'fin'}`}>
              {STEPS.map((d) => (
                <button key={d} type="button" className="ghost" onClick={() => move(edge, (edge === 'start' ? props.start : props.end) + d)}>
                  {d > 0 ? `+${d}` : d} s
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className={`small ${outOfRange ? 'trange-bad' : 'muted'}`}>
        Duración: <b>{dur.toFixed(1)} s</b> (permitido {min}–{max} s con el preset de {preset} s)
      </p>
      <div
        className="trange-track"
        ref={track}
        onPointerMove={onMove}
        onPointerUp={up}
        onPointerCancel={up}
        aria-label={`Línea de tiempo de ${formatTime(w0)} a ${formatTime(w1)}`}
      >
        {words.map((w, i) => (
          <span key={i} className="trange-word" style={{ left: pct(w.start), width: `calc(${pct(w.end)} - ${pct(w.start)})` }} />
        ))}
        <span className="trange-orig" style={{ left: pct(original.start), width: `calc(${pct(original.end)} - ${pct(original.start)})` }} title="Tramo guardado" />
        <span className="trange-sel" style={{ left: pct(props.start), width: `calc(${pct(props.end)} - ${pct(props.start)})` }} />
        {(['start', 'end'] as const).map((edge) => (
          <span
            key={edge}
            className="trange-handle"
            role="slider"
            tabIndex={0}
            aria-label={edge === 'start' ? 'Inicio del clip' : 'Fin del clip'}
            aria-valuemin={0}
            aria-valuemax={D}
            aria-valuenow={edge === 'start' ? props.start : props.end}
            aria-valuetext={formatTime(edge === 'start' ? props.start : props.end)}
            style={{ left: pct(edge === 'start' ? props.start : props.end) }}
            onPointerDown={down(edge)}
            onKeyDown={(e) => {
              const v = edge === 'start' ? props.start : props.end;
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                move(edge, v + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 0.5));
              }
            }}
          />
        ))}
      </div>
      <div className="trange-scale small muted">
        <span>{formatTime(w0)}</span>
        <span>{formatTime(w1)}</span>
      </div>
      <label className="check">
        <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
        <span>Ajustar a los límites de palabra (transcripción)</span>
      </label>
      {props.hasSource ? (
        <div className="trange-preview">
          <video ref={video} key={`${props.start}-${props.end}`} src={`clip://source/${props.jobId}/video#t=${props.start.toFixed(2)},${props.end.toFixed(2)}`} controls preload="metadata" />
          <p className="small muted">Vista previa del tramo nuevo sobre el vídeo original (sin subtítulos ni composición).</p>
        </div>
      ) : (
        <p className="small muted">El vídeo original ya no está en el equipo: usa «Vista previa rápida» para ver un fotograma del tramo nuevo.</p>
      )}
      <p className="small">Al guardar, el clip queda <b>pendiente de render</b>: pulsa «Renderizar este clip» para aplicar el tramo nuevo al vídeo.</p>
    </div>
  );
}
