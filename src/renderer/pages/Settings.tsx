import { useEffect, useState } from 'react';
import { OLLAMA_MODEL_OPTIONS, WHISPER_MODEL_OPTIONS, type Diagnostics, type PullProgress, type Settings } from '../../shared/types';
import { api, errMsg } from '../api';

export function SettingsPage(props: { settings: Settings; onChange: (s: Settings) => void; diag: Diagnostics | null; refreshDiag: () => Promise<void> }) {
  const s = props.settings;
  const [err, setErr] = useState('');
  const [checking, setChecking] = useState(false);
  const [installed, setInstalled] = useState<string[]>([]);
  const [pull, setPull] = useState<PullProgress | null>(null);
  const [customModel, setCustomModel] = useState('');

  useEffect(() => {
    void api().listOllamaModels().then(setInstalled);
    return api().onPullProgress((p) => {
      setPull(p);
      if (p.done) void api().listOllamaModels().then(setInstalled).then(props.refreshDiag);
    });
  }, []);

  const patch = async (p: Partial<Settings>) => {
    setErr('');
    try {
      props.onChange(await api().updateSettings(p));
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  const recheck = async () => {
    setChecking(true);
    await props.refreshDiag();
    setChecking(false);
  };
  const doPull = async (name: string) => {
    setErr('');
    setPull({ model: name, status: 'iniciando', done: false });
    try {
      await api().pullOllamaModel(name);
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  const pct = pull?.total ? Math.round(((pull.completed ?? 0) / pull.total) * 100) : null;

  return (
    <section className="page narrow">
      <h1>Configuración</h1>
      {err && <div className="banner error">{err}</div>}

      <h2>Diagnóstico de dependencias</h2>
      <ul className="diag">
        {props.diag?.items.map((i) => (
          <li key={i.id} className={i.ok ? 'ok' : 'bad'}>
            <span className="dot">{i.ok ? '✓' : '✗'}</span>
            <div>
              <b>{i.label}</b> <span className="muted small">{i.detail}</span>
              {!i.ok && i.help && <div className="help">{i.help}</div>}
            </div>
          </li>
        ))}
      </ul>
      <div className="row">
        <button onClick={recheck} disabled={checking}>{checking ? 'Comprobando…' : 'Volver a comprobar'}</button>
        {!s.onboardingDone && (
          <button className="primary" onClick={() => patch({ onboardingDone: true })}>
            {props.diag?.ok ? 'Todo listo, empezar' : 'Continuar de todos modos'}
          </button>
        )}
      </div>

      <h2>Modelo de IA (Ollama)</h2>
      <p className="muted small">Los modelos se descargan una vez y quedan en tu equipo. No se incluyen en el instalador.</p>
      <table className="table">
        <tbody>
          {OLLAMA_MODEL_OPTIONS.map((m) => {
            const have = installed.some((n) => n === m.name || n === `${m.name}:latest`);
            return (
              <tr key={m.name}>
                <td>
                  <input type="radio" name="model" checked={s.ollamaModel === m.name} onChange={() => patch({ ollamaModel: m.name })} />
                </td>
                <td className="grow">
                  <b>{m.name}</b> <span className="muted small">{m.sizeLabel} · {m.note}</span>
                </td>
                <td>{have ? <span className="ok small">Descargado</span> : <button disabled={!!pull && !pull.done} onClick={() => doPull(m.name)}>Descargar ({m.sizeLabel})</button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {installed.length > 0 && (
        <label className="field">
          <span>Modelos ya instalados en Ollama</span>
          <select value={installed.includes(s.ollamaModel) ? s.ollamaModel : ''} onChange={(e) => e.target.value && patch({ ollamaModel: e.target.value }).then(props.refreshDiag)}>
            <option value="">— Elegir —</option>
            {installed.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
      )}
      <div className="row">
        <input placeholder="Otro modelo, p. ej. mistral:7b" value={customModel} onChange={(e) => setCustomModel(e.target.value)} />
        <button disabled={!customModel.trim()} onClick={() => patch({ ollamaModel: customModel.trim() })}>Usar</button>
        <button disabled={!customModel.trim() || (!!pull && !pull.done)} onClick={() => doPull(customModel.trim())}>Descargar</button>
      </div>
      <p className="small muted">Modelo actual: <b>{s.ollamaModel}</b></p>
      {pull && (
        <div className="card">
          <div className="small">
            {pull.model}: {pull.error ? <span className="error">{pull.error}</span> : pull.done ? 'completado' : pull.status} {pct !== null && !pull.done ? `${pct}%` : ''}
          </div>
          {pct !== null && !pull.done && <div className="progress"><div style={{ width: `${pct}%` }} /></div>}
        </div>
      )}

      <h2>Transcripción (Whisper local)</h2>
      <label className="field">
        <span>Modelo de Whisper (se descarga automáticamente la primera vez)</span>
        <select value={s.whisperModel} onChange={(e) => patch({ whisperModel: e.target.value })}>
          {WHISPER_MODEL_OPTIONS.map((m) => (
            <option key={m.name} value={m.name}>{m.name} — {m.sizeLabel} — {m.note}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Idioma (código ISO, vacío = autodetectar)</span>
        <input value={s.whisperLanguage} maxLength={3} placeholder="es" onChange={(e) => patch({ whisperLanguage: e.target.value.toLowerCase().replace(/[^a-z]/g, '') })} />
      </label>

      <h2>Exportación</h2>
      <div className="row">
        <code className="grow">{s.exportDir}</code>
        <button onClick={async () => { const d = await api().chooseExportDir(); if (d) props.onChange({ ...s, exportDir: d }); }}>Cambiar…</button>
      </div>

      <h2>Encuadre y subtítulos</h2>
      <label className="field">
        <span>Desplazamiento horizontal del recorte: {s.cropOffsetX.toFixed(2)} (−1 izquierda, 0 centro, 1 derecha)</span>
        <input type="range" min={-1} max={1} step={0.05} value={s.cropOffsetX} onChange={(e) => patch({ cropOffsetX: Number(e.target.value) })} />
      </label>
      <label className="field">
        <span>Tamaño de subtítulos: {s.subtitleFontSize}</span>
        <input type="range" min={30} max={140} value={s.subtitleFontSize} onChange={(e) => patch({ subtitleFontSize: Number(e.target.value) })} />
      </label>

      <h2>Limpieza y límites</h2>
      <label className="check"><input type="checkbox" checked={s.deleteTempAfterCompletion} onChange={(e) => patch({ deleteTempAfterCompletion: e.target.checked })} /><span>Borrar temporales (audio, subtítulos) al completar</span></label>
      <label className="check"><input type="checkbox" checked={s.deleteSourceAfterCompletion} onChange={(e) => patch({ deleteSourceAfterCompletion: e.target.checked })} /><span>Borrar el vídeo original descargado al completar</span></label>
      <p className="small muted">Sólo se borran archivos creados por la app en su carpeta interna. Los clips exportados nunca se borran.</p>
      <div className="grid2">
        <NumField label="Duración máx. del vídeo (min)" value={s.maxSourceMinutes} min={1} max={600} onSave={(v) => patch({ maxSourceMinutes: v })} />
        <NumField label="Tamaño máx. de descarga (MB)" value={s.maxDownloadMB} min={10} max={20000} onSave={(v) => patch({ maxDownloadMB: v })} />
        <NumField label="Espacio libre mínimo (MB)" value={s.minFreeDiskMB} min={100} max={500000} onSave={(v) => patch({ minFreeDiskMB: v })} />
        <NumField label="Trabajos simultáneos (1–2)" value={s.maxConcurrentJobs} min={1} max={2} onSave={(v) => patch({ maxConcurrentJobs: v })} />
      </div>

      <h2>Rutas de ejecutables (opcional)</h2>
      <p className="small muted">Déjalas vacías para autodetectar (PATH o binarios incluidos). Deben ser rutas absolutas a .exe.</p>
      <PathField label="ffmpeg.exe" value={s.ffmpegPath} onSave={(v) => patch({ ffmpegPath: v }).then(props.refreshDiag)} />
      <PathField label="ffprobe.exe" value={s.ffprobePath} onSave={(v) => patch({ ffprobePath: v }).then(props.refreshDiag)} />
      <PathField label="yt-dlp.exe" value={s.ytDlpPath} onSave={(v) => patch({ ytDlpPath: v }).then(props.refreshDiag)} />
      <PathField label="whisper.exe" value={s.whisperPath} onSave={(v) => patch({ whisperPath: v }).then(props.refreshDiag)} />
    </section>
  );
}

function NumField(p: { label: string; value: number; min: number; max: number; onSave: (v: number) => void }) {
  const [v, setV] = useState(String(p.value));
  return (
    <label className="field">
      <span>{p.label}</span>
      <input type="number" min={p.min} max={p.max} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => { const n = Math.round(Number(v)); if (Number.isFinite(n)) p.onSave(Math.min(p.max, Math.max(p.min, n))); }} />
    </label>
  );
}

function PathField(p: { label: string; value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(p.value);
  return (
    <label className="field">
      <span>{p.label}</span>
      <input value={v} spellCheck={false} placeholder="Autodetectar" onChange={(e) => setV(e.target.value)} onBlur={() => v !== p.value && p.onSave(v.trim())} />
    </label>
  );
}
