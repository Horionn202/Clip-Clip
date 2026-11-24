import { useEffect, useRef, useState } from 'react';
import { CLIP_TARGET_PRESETS, DURATION_PRESETS, ENGINE_LABELS, LONG_CLIP_SEC, clipLengthLabel, presetLabel, MAX_CLIPS, WHISPER_MODEL_OPTIONS, type Diagnostics, type DurationPreset, type Job, type LocalVideoChoice, type UrlProbe } from '../../shared/types';
import type { SourceFailure } from '../../shared/sourceErrors';
import type { HomePrefill } from '../../shared/homePrefill';
import { BOUNDARY_MODE_LABELS, CREATION_MODE_LABELS, FULL_SPLIT_HARD_LIMIT, FULL_SPLIT_SAFE_LIMIT, splitPlan, type BoundaryMode, type CreationMode } from '../../shared/fullSplit';
import { SourceErrorModal } from '../components/SourceErrorModal';
import { LONG_VIDEO_SEC, engineLabel, estimateJob, humanBytes, humanDuration } from '../../shared/estimates';
import { validateVideoUrl } from '../../shared/validation';
import { effectiveTarget, feasibilityAdvice, feasibleMax, requiredDuration } from '../../shared/selection';
import { isModelCached } from '../../shared/models';
import { api, errMsg } from '../api';

export function HomePage(props: { prefill?: HomePrefill | null; onPrefillUsed?: () => void; ollamaModel?: string; jobs: Job[]; diag: Diagnostics | null; onCreated: () => void; goSettings: () => void; goPolicy: () => void }) {
  const [url, setUrl] = useState('');
  const [preset, setPreset] = useState<DurationPreset>(30);
  /** «IA encuentra momentos» (como siempre) o «Dividir video completo». */
  const [mode, setMode] = useState<CreationMode>('ai-highlights');
  const [boundary, setBoundary] = useState<BoundaryMode>('exact');
  const [confirmLarge, setConfirmLarge] = useState(false);
  const fullSplit = mode === 'full-split';
  const [target, setTarget] = useState<number | null>(null); // sin valor implícito: el usuario elige
  const [rights, setRights] = useState(false);
  const [allowDownload, setAllowDownload] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Cada resultado queda ligado a la URL consultada: una respuesta tardía de otra URL se ignora.
  const [probeResult, setProbeResult] = useState<(UrlProbe & { url: string }) | null>(null);
  const probe = probeResult && probeResult.url === url.trim() ? probeResult : null;
  const [probing, setProbing] = useState(false);
  const [longOk, setLongOk] = useState(false);
  /** Vídeo elegido en el equipo (alternativa a la URL). */
  const [local, setLocal] = useState<LocalVideoChoice | null>(null);
  const [picking, setPicking] = useState(false);
  const [failure, setFailure] = useState<SourceFailure | null>(null);
  const urlInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setProbeResult(null);
    setLongOk(false);
  }, [url]);

  const pickFile = async () => {
    setError('');
    setPicking(true);
    try {
      const v = await api().chooseLocalVideo();
      if (v) {
        setLocal(v);
        setLongOk(false);
      }
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setPicking(false);
    }
  };

  // Tras un fallo: se recuperan la URL, la duración de cada clip y el máximo (y, si se pidió, se abre el selector).
  const applied = useRef(0);
  useEffect(() => {
    const p = props.prefill;
    if (!p || applied.current === p.nonce) return;
    applied.current = p.nonce;
    // Se consume: al volver a Inicio más tarde no se repite (ni se abre otra vez el selector).
    props.onPrefillUsed?.();
    setUrl(p.url);
    setPreset(p.preset);
    setTarget(p.maxClips);
    setMode(p.creationMode);
    setBoundary(p.boundaryMode);
    setConfirmLarge(false);
    setLocal(null);
    if (p.pickFile) void pickFile();
    else setTimeout(() => urlInput.current?.select(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.prefill]);

  const urlError = (() => {
    if (!url.trim()) return '';
    try {
      validateVideoUrl(url);
      return '';
    } catch (e) {
      return (e as Error).message;
    }
  })();

  const gpu = props.diag?.gpu;
  const plan = gpu?.plan ?? null;
  const modelCached =
    !plan || !gpu
      ? true
      : isModelCached(plan.engine, plan.model, gpu.cachedModels);
  const modelSize = WHISPER_MODEL_OPTIONS.find((m) => m.name === plan?.model)?.sizeLabel ?? '';

  const depsOkUrl = props.diag?.ok ?? false;
  // Un archivo local no necesita yt-dlp: no se bloquea por su falta.
  const depsOk = local ? (props.diag?.items.filter((i) => i.id !== 'ytDlp').every((i) => i.ok) ?? false) : depsOkUrl;
  /** La fuente comprobada: el archivo local o el resultado de «Comprobar vídeo». */
  const src = local ? { duration: local.duration, filesizeBytes: local.sizeBytes } : probe;
  const isLong = !!src && src.duration > LONG_VIDEO_SEC;
  // Hay que comprobar el vídeo antes de iniciar: así se ven duración, estimaciones y máximo de clips.
  // «Dividir video completo»: tantos segmentos como hagan falta para cubrir el vídeo (sin el tope de 20).
  const split = fullSplit && src ? splitPlan(src.duration, preset) : null;
  const splitOk = !split || (!split.tooMany && (!split.needsConfirm || confirmLarge) && split.count > 0);
  const canStart =
    (local ? true : !!url.trim() && !urlError) &&
    rights &&
    depsOk &&
    !busy &&
    (fullSplit || target !== null) &&
    !!src &&
    (!isLong || longOk) &&
    (modelCached || allowDownload) &&
    (fullSplit ? splitOk : feasibleMax(src.duration, preset) > 0);
  // Espacio y render según cuántos clips caben de verdad y cuánto dura cada uno (los de 2 min ocupan y tardan más).
  const clipsOut = split ? { count: split.count, preset } : src && target !== null ? { count: effectiveTarget(target, src.duration, preset), preset } : undefined;
  const est = src ? estimateJob(src.duration, local ? undefined : src.filesizeBytes, plan, props.jobs, clipsOut) : null;
  const feas = src ? feasibleMax(src.duration, preset) : null;
  const eff = src && target !== null ? effectiveTarget(target, src.duration, preset) : null;
  const advice = src && target !== null ? feasibilityAdvice(target, src.duration, preset) : null;

  const check = async () => {
    setError('');
    setProbing(true);
    try {
      const asked = url.trim();
      const r = await api().probeUrl(asked);
      if (r.ok) setProbeResult({ title: r.title, duration: r.duration, feasibleMax: r.feasibleMax, filesizeBytes: r.filesizeBytes, url: asked });
      else if (r.failure) setFailure(r.failure);
      else setError(r.message);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setProbing(false);
    }
  };

  const start = async () => {
    if (target === null && !fullSplit) return;
    // En «Dividir video completo» el máximo de clips no se usa (se generan todos los segmentos).
    const maxClips = fullSplit ? MAX_CLIPS : target!;
    const modeReq = fullSplit ? { creationMode: mode, boundaryMode: boundary, confirmLarge } : {};
    setError('');
    setBusy(true);
    try {
      if (local) await api().createLocalJob({ token: local.token, preset, maxClips, rightsConfirmed: rights, allowModelDownload: allowDownload, ...modeReq });
      else await api().createJob({ url: url.trim(), preset, maxClips, rightsConfirmed: rights, allowModelDownload: allowDownload, ...modeReq });
      setConfirmLarge(false);
      setUrl('');
      setLocal(null);
      setRights(false);
      setLongOk(false);
      setAllowDownload(false);
      props.onCreated();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="page narrow">
      <h1>Nuevo trabajo</h1>
      <p className="muted">Pega la URL de un vídeo que tengas derecho a reutilizar. Se descarga, transcribe y analiza en local.</p>

      {props.diag && !props.diag.ok && (
        <div className="banner warn">
          Faltan dependencias locales. <button className="link" onClick={props.goSettings}>Ver diagnóstico y cómo instalarlas</button>
        </div>
      )}
      {plan && (
        <div className={`engine-pill ${plan.device}`}>
          Transcripción: <b>{engineLabel(plan)}</b> · {ENGINE_LABELS[plan.engine]}
          {gpu?.nvidiaGpu && plan.device === 'cpu' && (
            <> · <button className="link" onClick={props.goSettings}>tu GPU no se está usando: ver cómo activarla</button></>
          )}
        </div>
      )}

      {!local && (
        <label className="field">
          <span>URL del vídeo</span>
          <div className="row">
            <input ref={urlInput} className="grow" type="url" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus spellCheck={false} />
            <button disabled={!url.trim() || !!urlError || probing} onClick={check}>{probing ? 'Comprobando…' : 'Comprobar vídeo'}</button>
          </div>
          {urlError && <small className="error">{urlError}</small>}
          {probing && <small className="muted">Si YouTube limita la descarga se reintenta un par de veces con un método alternativo; puede tardar unos segundos.</small>}
          {!probe && !probing && url.trim() && !urlError && <small className="muted">Pulsa «Comprobar vídeo» para ver su duración y las estimaciones antes de iniciar.</small>}
        </label>
      )}
      <div className="local-pick">
        {local ? (
          <div className="card source-card">
            <div className="row">
              <div className="title grow">«{local.title}»</div>
              <span className="badge">Archivo local</span>
            </div>
            <table className="table kv">
              <tbody>
                <tr><td>Archivo</td><td>{local.name}</td></tr>
                <tr><td>Duración del vídeo fuente</td><td><b>{humanDuration(local.duration)}</b></td></tr>
                <tr><td>Tamaño</td><td>{humanBytes(local.sizeBytes)} · no se copia si está en la misma unidad que los datos de la app</td></tr>
                <tr><td>Máximo posible de clips sin solapes</td><td>{feasibleMax(local.duration, preset)}</td></tr>
                {est && <tr><td>Tiempo de transcripción (aprox.)</td><td>{humanDuration(est.transcribeSec)}</td></tr>}
                {est && est.renderSec > 0 && <tr><td>Render de los clips (aprox.)</td><td>{humanDuration(est.renderSec)}</td></tr>}
              </tbody>
            </table>
            <div className="row">
              <button className="ghost" onClick={() => void pickFile()} disabled={picking}>Elegir otro archivo</button>
              <button className="ghost" onClick={() => setLocal(null)}>Usar una URL</button>
            </div>
          </div>
        ) : (
          <button className="link" onClick={() => void pickFile()} disabled={picking}>
            {picking ? 'Leyendo el vídeo…' : 'O selecciona un video de tu equipo (MP4, MOV, MKV o WebM)'}
          </button>
        )}
      </div>
      {isLong && local && (
        <label className="check">
          <input type="checkbox" checked={longOk} onChange={(e) => setLongOk(e.target.checked)} />
          <span>Este vídeo es largo ({humanDuration(local.duration)}). Confirmo que quiero procesarlo completo.</span>
        </label>
      )}

      {!local && probe && (
        <div className="card source-card">
          <div className="title">«{probe.title || 'Sin título'}»</div>
          <table className="table kv">
            <tbody>
              <tr><td>Duración del vídeo fuente</td><td><b>{humanDuration(probe.duration)}</b></td></tr>
              <tr><td>Duración de cada clip</td><td><b>{presetLabel(preset)}</b></td></tr>
              <tr><td>Transcripción (Whisper)</td><td>{plan ? engineLabel(plan) : '—'}</td></tr>
              <tr><td>Modelo de IA (Ollama)</td><td>{props.ollamaModel ?? '—'}</td></tr>
              <tr><td>Máximo posible de clips sin solapes</td><td>{feasibleMax(probe.duration, preset)}{feasibleMax(probe.duration, preset) === MAX_CLIPS ? ' (tope de la app)' : ''}</td></tr>
              {est && (
                <>
                  <tr><td>Espacio en disco necesario (aprox.)</td><td>{humanBytes(est.diskBytes)}</td></tr>
                  {est.renderSec > 0 && (
                    <tr><td>Render de los clips (aprox.)</td><td>{humanDuration(est.renderSec)}{preset >= LONG_CLIP_SEC ? ' · los clips largos tardan más' : ''}</td></tr>
                  )}
                  <tr><td>Tiempo de transcripción (aprox.)</td><td>{humanDuration(est.transcribeSec)} {plan ? `con ${engineLabel(plan)}` : ''}{est.speedMeasured ? ' · según tus trabajos anteriores' : ' · estimación orientativa'}</td></tr>
                </>
              )}
            </tbody>
          </table>
          {isLong && (
            <label className="check">
              <input type="checkbox" checked={longOk} onChange={(e) => setLongOk(e.target.checked)} />
              <span>
                Este vídeo es largo ({humanDuration(probe.duration)}). Confirmo que quiero procesar el vídeo completo; tardará y ocupará espacio según las estimaciones de arriba.
              </span>
            </label>
          )}
        </div>
      )}

      <div className="field" role="radiogroup" aria-label="Modo de creación">
        <span>Modo de creación</span>
        <div className="mode-pick">
          {(Object.keys(CREATION_MODE_LABELS) as CreationMode[]).map((m) => (
            <button key={m} role="radio" aria-checked={mode === m} className={`mode-card ${mode === m ? 'on' : ''}`} onClick={() => setMode(m)}>
              <b>{CREATION_MODE_LABELS[m].label}</b>
              <small>{CREATION_MODE_LABELS[m].help}</small>
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span>Duración de cada clip (no es la duración del vídeo)</span>
        <div className="seg">
          {DURATION_PRESETS.map((p) => (
            <button key={p} className={p === preset ? 'on' : ''} onClick={() => setPreset(p)}>
              {presetLabel(p)}
            </button>
          ))}
        </div>
        {preset >= LONG_CLIP_SEC && <small className="muted">Los clips largos tardan más en renderizar y suelen requerir más contexto para mantener la retención.</small>}
      </div>

      {fullSplit && (
        <div className="field">
          <span>Tipo de corte</span>
          <div className="seg" role="radiogroup" aria-label="Tipo de corte">
            {(Object.keys(BOUNDARY_MODE_LABELS) as BoundaryMode[]).map((b) => (
              <button key={b} role="radio" aria-checked={boundary === b} className={boundary === b ? 'on' : ''} onClick={() => setBoundary(b)}>
                {BOUNDARY_MODE_LABELS[b].label}
              </button>
            ))}
          </div>
          <small className="muted">{BOUNDARY_MODE_LABELS[boundary].help}</small>
          <div className="banner warn small">Este modo procesa todo el video y puede ocupar bastante espacio.</div>
          {src && split ? (
            <table className="table kv small">
              <tbody>
                <tr><td>Duración total del vídeo</td><td>{humanDuration(src.duration)}</td></tr>
                <tr><td>Duración de cada bloque</td><td>{presetLabel(preset)}</td></tr>
                <tr><td>Clips estimados</td><td><b>{split.count}</b> (cubren todo el vídeo, sin huecos)</td></tr>
                <tr><td>Último bloque</td><td>{clipLengthLabel(split.lastSec)}</td></tr>
                {est && <tr><td>Espacio en disco (aprox.)</td><td>{humanBytes(est.diskBytes)}</td></tr>}
                {est && est.renderSec > 0 && <tr><td>Render de todos los clips (aprox.)</td><td>{humanDuration(est.renderSec)}</td></tr>}
              </tbody>
            </table>
          ) : (
            <small className="muted">Comprueba el vídeo o elige un archivo para ver cuántos clips saldrán.</small>
          )}
          {split?.tooMany && <div className="banner error small">Saldrían {split.count} clips (máximo {FULL_SPLIT_HARD_LIMIT}). Elige una duración de clip mayor.</div>}
          {split?.needsConfirm && !split.tooMany && (
            <label className="check">
              <input type="checkbox" checked={confirmLarge} onChange={(e) => setConfirmLarge(e.target.checked)} />
              <span>
                Saldrían {split.count} clips (más de {FULL_SPLIT_SAFE_LIMIT}). Te recomendamos una duración mayor. Confirmo que quiero procesarlos todos.
              </span>
            </label>
          )}
        </div>
      )}

      {!fullSplit && (
      <div className="field">
        <span>Máximo de clips (hasta {MAX_CLIPS}: la IA prioriza calidad sobre cantidad)</span>
        <div className="seg">
          {CLIP_TARGET_PRESETS.map((p) => (
            <button key={p.value} className={target === p.value ? 'on' : ''} onClick={() => setTarget(p.value)}>
              {p.label}: {p.value === MAX_CLIPS ? `hasta ${p.value}` : p.value}
            </button>
          ))}
        </div>
        <div className="row">
          <input type="range" min={1} max={MAX_CLIPS} value={target ?? 1} onChange={(e) => setTarget(Math.min(MAX_CLIPS, Math.max(1, Number(e.target.value))))} />
          <b>{target === null ? 'Elige un máximo' : `Hasta ${target} clip${target === 1 ? '' : 's'}`}</b>
        </div>
        {target !== null && (
          <small className="muted">
            {target} clip{target === 1 ? '' : 's'} de {presetLabel(preset)} necesitan al menos {humanDuration(requiredDuration(target, preset))} de vídeo.
            {probe && feas !== null && eff !== null && ` Este vídeo admite hasta ${feas} sin solaparse → hasta ${eff}.`}
            {!probe && ' Pulsa «Comprobar vídeo» para calcular el máximo real.'}
          </small>
        )}
        {advice && <div className="banner warn">{advice}</div>}
      </div>
      )}

      {plan && !modelCached && (
        <label className="check">
          <input type="checkbox" checked={allowDownload} onChange={(e) => setAllowDownload(e.target.checked)} />
          <span>
            Permitir descargar el modelo de Whisper «{plan.model}» ({modelSize}) la primera vez. Sin esto el trabajo no se iniciará.
          </span>
        </label>
      )}

      <label className="check">
        <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} />
        <span>
          Confirmo que soy titular de este contenido o tengo autorización para descargarlo y editarlo, y que respeto los términos de la plataforma de origen.{' '}
          <button className="link" onClick={props.goPolicy}>Política de uso</button>
        </span>
      </label>

      {error && <div className="banner error">{error}</div>}
      {failure && (
        <SourceErrorModal
          open
          failure={failure}
          onClose={() => setFailure(null)}
          onAction={(a) => {
            setFailure(null);
            // Ninguna acción borra la URL ni los ajustes elegidos.
            if (a === 'import-file') void pickFile();
            else if (a === 'change-url') setTimeout(() => urlInput.current?.select(), 0);
          }}
        />
      )}
      <button className="primary big" disabled={!canStart} onClick={start}>
        {busy ? 'Creando…' : 'Iniciar'}
      </button>
    </section>
  );
}
