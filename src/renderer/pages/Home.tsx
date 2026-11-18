import { useState } from 'react';
import { DURATION_PRESETS, MAX_CLIPS, type Diagnostics, type DurationPreset } from '../../shared/types';
import { validateVideoUrl } from '../../shared/validation';
import { api, errMsg } from '../api';

export function HomePage(props: { diag: Diagnostics | null; onCreated: () => void; goSettings: () => void; goPolicy: () => void }) {
  const [url, setUrl] = useState('');
  const [preset, setPreset] = useState<DurationPreset>(30);
  const [maxClips, setMaxClips] = useState(5);
  const [rights, setRights] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const urlError = (() => {
    if (!url.trim()) return '';
    try {
      validateVideoUrl(url);
      return '';
    } catch (e) {
      return (e as Error).message;
    }
  })();
  const depsOk = props.diag?.ok ?? false;
  const canStart = !!url.trim() && !urlError && rights && depsOk && !busy;

  const start = async () => {
    setError('');
    setBusy(true);
    try {
      await api().createJob({ url: url.trim(), preset, maxClips, rightsConfirmed: rights });
      setUrl('');
      setRights(false);
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

      <label className="field">
        <span>URL del vídeo</span>
        <input type="url" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus spellCheck={false} />
        {urlError && <small className="error">{urlError}</small>}
      </label>

      <div className="field">
        <span>Duración de cada clip</span>
        <div className="seg">
          {DURATION_PRESETS.map((p) => (
            <button key={p} className={p === preset ? 'on' : ''} onClick={() => setPreset(p)}>
              {p} s
            </button>
          ))}
        </div>
      </div>

      <label className="field">
        <span>
          Máximo de clips: <b>{maxClips}</b>
        </span>
        <input type="range" min={1} max={MAX_CLIPS} value={maxClips} onChange={(e) => setMaxClips(Math.min(MAX_CLIPS, Math.max(1, Number(e.target.value))))} />
      </label>

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
