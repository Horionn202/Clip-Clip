import { useEffect, useState } from 'react';
import type { Diagnostics, PullProgress, Settings } from '../../shared/types';
import {
  BIGGER_IS_NOT_ALWAYS_BETTER,
  evaluateProfiles,
  placementLabel,
  recommendProfile,
  type BenchmarkResult,
  type Fit,
} from '../../shared/aiProfiles';
import { api, errMsg } from '../api';

const FIT_LABEL: Record<Fit, string> = {
  gpu: 'Cabe en GPU',
  parcial: 'GPU parcial · más lento',
  cpu: 'CPU/RAM · lento',
  'no-cabe': 'Puede no caber',
};

/** Configuración → Modelo de IA: perfiles comprensibles, descarga confirmada y cancelable, benchmark. */
export function AiModelPanel(props: {
  settings: Settings;
  diag: Diagnostics | null;
  patch: (p: Partial<Settings>) => Promise<void>;
  /** Refresca el diagnóstico global (p. ej. el modelo configurado acaba de descargarse). */
  onModelsChanged: () => void;
}) {
  const s = props.settings;
  const gpu = props.diag?.gpu;
  const vram = gpu?.vramMB ?? null;
  const ram = gpu?.ramTotalMB ?? 16384;
  const fits = evaluateProfiles(vram, ram);
  const recommended = recommendProfile(vram, ram);
  const [installed, setInstalled] = useState<string[]>([]);
  const [pull, setPull] = useState<PullProgress | null>(null);
  const [bench, setBench] = useState<Record<string, BenchmarkResult>>(s.benchmarks ?? {});
  const [benching, setBenching] = useState<string | null>(null);
  const [custom, setCustom] = useState('');
  const [err, setErr] = useState('');

  const refresh = () => void api().listOllamaModels().then(setInstalled);
  useEffect(() => {
    refresh();
    return api().onPullProgress((p) => {
      setPull(p);
      if (p.done) {
        refresh();
        props.onModelsChanged();
      }
    });
  }, []);

  const has = (m: string) => installed.some((n) => n === m || n === `${m}:latest`);
  const pulling = !!pull && !pull.done;
  const pct = pull?.total ? Math.round(((pull.completed ?? 0) / pull.total) * 100) : null;

  const download = async (model: string, sizeGB?: number) => {
    const size = sizeGB ? `≈ ${sizeGB.toString().replace('.', ',')} GB` : 'tamaño desconocido';
    // Confirmación explícita antes de cualquier descarga.
    if (!window.confirm(`¿Descargar el modelo «${model}» (${size}) desde la biblioteca oficial de Ollama?\n\nSe guarda en tu equipo y puedes cancelar la descarga.`)) return;
    setErr('');
    setPull({ model, status: 'iniciando', done: false });
    try {
      await api().pullOllamaModel(model);
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  const runBench = async (model: string) => {
    setErr('');
    setBenching(model);
    try {
      const r = await api().benchmarkModel(model);
      setBench((b) => ({ ...b, [model]: r }));
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBenching(null);
    }
  };

  return (
    <div>
      <p className="small muted">{BIGGER_IS_NOT_ALWAYS_BETTER}</p>
      {gpu && (
        <p className="small muted">
          Este equipo: {gpu.nvidiaGpu ? `${gpu.nvidiaGpu} · ${((vram ?? 0) / 1024).toFixed(1)} GB VRAM` : 'sin GPU NVIDIA'}
          {gpu.vramFreeMB != null && ` (${(gpu.vramFreeMB / 1024).toFixed(1)} GB libres ahora)`} · {(ram / 1024).toFixed(0)} GB RAM
        </p>
      )}
      {err && <div className="banner error">{err}</div>}
      <div className="profiles">
        {fits.map(({ profile: p, fit, note }) => {
          const active = s.ollamaModel === p.model;
          const b = bench[p.model];
          return (
            <section key={p.id} className={`profile ${active ? 'active' : ''}`} aria-label={`Perfil ${p.label}`}>
              <header className="row">
                <h3 className="grow">
                  {p.label} {p.id === recommended && <span className="badge completed">Recomendado</span>}
                </h3>
                <span className={`badge fit-${fit}`}>{FIT_LABEL[fit]}</span>
              </header>
              <div className="small muted">{p.model}</div>
              <dl className="specs">
                <dt>Descarga</dt>
                <dd>≈ {p.downloadGB.toString().replace('.', ',')} GB</dd>
                <dt>Memoria (RAM/VRAM)</dt>
                <dd>≈ {p.memoryGB.toString().replace('.', ',')} GB</dd>
                <dt>Calidad</dt>
                <dd>{p.quality}</dd>
                <dt>Velocidad</dt>
                <dd>{p.speed}</dd>
              </dl>
              {fit !== 'gpu' && <div className="banner warn small">{note}</div>}
              {b && (
                <div className="small">
                  Benchmark: <b>{b.tokensPerSec} tokens/s</b> · carga {b.loadSec} s · {b.placement ? placementLabel(b.placement) : 'ubicación desconocida'} · JSON{' '}
                  {b.validJson ? 'válido' : 'inválido'}
                </div>
              )}
              <div className="row">
                {has(p.model) ? (
                  <>
                    <button className={active ? 'primary' : ''} disabled={active} onClick={() => props.patch({ ollamaModel: p.model })}>
                      {active ? 'En uso' : 'Usar este perfil'}
                    </button>
                    <button className="ghost" disabled={!!benching} onClick={() => runBench(p.model)}>
                      {benching === p.model ? 'Midiendo…' : 'Probar velocidad'}
                    </button>
                  </>
                ) : (
                  <button disabled={pulling} onClick={() => download(p.model, p.downloadGB)}>
                    Descargar (≈ {p.downloadGB.toString().replace('.', ',')} GB)
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>

      {pull && (
        <div className="card" role="status" aria-live="polite">
          <div className="row">
            <div className="grow small">
              {pull.model}: {pull.error ? <span className={pull.status === 'cancelled' ? 'muted' : 'error'}>{pull.error}</span> : pull.done ? 'descarga completada' : pull.status}{' '}
              {pct !== null && !pull.done ? `${pct} %` : ''}
            </div>
            {pulling && (
              <button className="danger" onClick={() => api().cancelOllamaPull()}>
                Cancelar descarga
              </button>
            )}
          </div>
          {pct !== null && !pull.done && (
            <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      )}

      <details className="card">
        <summary>Personalizado: otro modelo de Ollama</summary>
        <div className="row">
          <input aria-label="Nombre del modelo" placeholder="p. ej. mistral:7b" value={custom} onChange={(e) => setCustom(e.target.value)} />
          <button disabled={!custom.trim() || !has(custom.trim())} onClick={() => props.patch({ ollamaModel: custom.trim() })}>
            Usar
          </button>
          <button disabled={!custom.trim() || pulling || has(custom.trim())} onClick={() => download(custom.trim())}>
            Descargar
          </button>
        </div>
        {installed.length > 0 && (
          <label className="field">
            <span>Modelos ya instalados</span>
            <select value={installed.includes(s.ollamaModel) ? s.ollamaModel : ''} onChange={(e) => e.target.value && props.patch({ ollamaModel: e.target.value })}>
              <option value="">— Elegir —</option>
              {installed.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
      </details>
      <div className="row">
        <span className="small muted grow">
          Modelo en uso: <b>{s.ollamaModel}</b>
          {bench[s.ollamaModel] &&
            ` · ${bench[s.ollamaModel].tokensPerSec} tokens/s · ${bench[s.ollamaModel].placement ? placementLabel(bench[s.ollamaModel].placement!) : 'ubicación desconocida'}`}
        </span>
        {has(s.ollamaModel) && (
          <button className="ghost" disabled={!!benching} onClick={() => runBench(s.ollamaModel)}>
            {benching === s.ollamaModel ? 'Midiendo…' : 'Probar velocidad del modelo en uso'}
          </button>
        )}
      </div>
    </div>
  );
}
