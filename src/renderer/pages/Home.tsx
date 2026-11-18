import { useEffect, useState } from 'react';
import { CLIP_TARGET_PRESETS, DURATION_PRESETS, ENGINE_LABELS, MAX_CLIPS, WHISPER_MODEL_OPTIONS, type Diagnostics, type DurationPreset, type Job, type UrlProbe } from '../../shared/types';
import { LONG_VIDEO_SEC, engineLabel, estimateJob, humanBytes, humanDuration } from '../../shared/estimates';
import { validateVideoUrl } from '../../shared/validation';
import { effectiveTarget, feasibilityAdvice, feasibleMax, requiredDuration } from '../../shared/selection';
import { isModelCached } from '../../shared/models';
import { api, errMsg } from '../api';

export function HomePage(props: { jobs: Job[]; diag: Diagnostics | null; onCreated: () => void; goSettings: () => void; goPolicy: () => void }) {
  const [url, setUrl] = useState('');
  const [preset, setPreset] = useState<DurationPreset>(30);
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

  useEffect(() => {
    setProbeResult(null);
    setLongOk(false);
  }, [url]);

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

  const depsOk = props.diag?.ok ?? false;
  const isLong = !!probe && probe.duration > LONG_VIDEO_SEC;
  // Hay que comprobar el vídeo antes de iniciar: así se ven duración, estimaciones y máximo de clips.
  const canStart =
    !!url.trim() && !urlError && rights && depsOk && !busy && target !== null && !!probe && (!isLong || longOk) && (modelCached || allowDownload) && (feasibleMax(probe.duration, preset) > 0);
  const est = probe ? estimateJob(probe.duration, probe.filesizeBytes, plan, props.jobs) : null;
  const feas = probe ? feasibleMax(probe.duration, preset) : null;
  const eff = probe && target !== null ? effectiveTarget(target, probe.duration, preset) : null;
  const advice = probe && target !== null ? feasibilityAdvice(target, probe.duration, preset) : null;

  const check = async () => {
    setError('');
    setProbing(true);
    try {
      const asked = url.trim();
      const r = await api().probeUrl(asked);
      setProbeResult({ ...r, url: asked });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setProbing(false);
    }
  };

  const start = async () => {
    if (target === null) return;
    setError('');
    setBusy(true);
    try {
      await api().createJob({ url: url.trim(), preset, maxClips: target, rightsConfirmed: rights, allowModelDownload: allowDownload });
      setUrl('');
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

      <label className="field">
        <span>URL del vídeo</span>
        <div className="row">
          <input className="grow" type="url" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus spellCheck={false} />
          <button disabled={!url.trim() || !!urlError || probing} onClick={check}>{probing ? 'Comprobando…' : 'Comprobar vídeo'}</button>
        </div>
        {urlError && <small className="error">{urlError}</small>}
        {!probe && url.trim() && !urlError && <small className="muted">Pulsa «Comprobar vídeo» para ver su duración y las estimaciones antes de iniciar.</small>}
      </label>

      {probe && (
        <div className="card source-card">
          <div className="title">«{probe.title || 'Sin título'}»</div>
          <table className="table kv">
            <tbody>
              <tr><td>Duración del vídeo fuente</td><td><b>{humanDuration(probe.duration)}</b></td></tr>
              <tr><td>Duración de cada clip</td><td><b>{preset} s</b></td></tr>
              <tr><td>Máximo posible de clips sin solapes</td><td>{feasibleMax(probe.duration, preset)}{feasibleMax(probe.duration, preset) === MAX_CLIPS ? ' (tope de la app)' : ''}</td></tr>
              {est && (
                <>
                  <tr><td>Espacio en disco necesario (aprox.)</td><td>{humanBytes(est.diskBytes)}</td></tr>
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

      <div className="field">
        <span>Duración de cada clip (no es la duración del vídeo)</span>
        <div className="seg">
          {DURATION_PRESETS.map((p) => (
            <button key={p} className={p === preset ? 'on' : ''} onClick={() => setPreset(p)}>
              {p} s
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span>Meta de clips (hasta {MAX_CLIPS}, no garantizados)</span>
        <div className="seg">
          {CLIP_TARGET_PRESETS.map((p) => (
            <button key={p.value} className={target === p.value ? 'on' : ''} onClick={() => setTarget(p.value)}>
              {p.label}: {p.value === MAX_CLIPS ? `hasta ${p.value}` : p.value}
            </button>
          ))}
        </div>
        <div className="row">
          <input type="range" min={1} max={MAX_CLIPS} value={target ?? 1} onChange={(e) => setTarget(Math.min(MAX_CLIPS, Math.max(1, Number(e.target.value))))} />
          <b>{target === null ? 'Elige una meta' : `Meta seleccionada: ${target} clip${target === 1 ? '' : 's'}`}</b>
        </div>
        {target !== null && (
          <small className="muted">
            {target} clips de {preset} s necesitan al menos {requiredDuration(target, preset)} s de vídeo.
            {probe && feas !== null && eff !== null && ` Este vídeo admite hasta ${feas} sin solaparse → meta efectiva: ${eff}.`}
            {!probe && ' Pulsa «Comprobar vídeo» para calcular la meta efectiva.'}
          </small>
        )}
        {advice && <div className="banner warn">{advice}</div>}
      </div>

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
      <button className="primary big" disabled={!canStart} onClick={start}>
        {busy ? 'Creando…' : 'Iniciar'}
      </button>
    </section>
  );
}
