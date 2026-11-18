import { useState } from 'react';
import { ENGINE_IDS, ENGINE_LABELS, STATUS_LABELS, TERMINAL_STATUSES, type GpuInfo, type Job, type MetricStage, type Settings } from '../../shared/types';
import { REJECT_LABELS, type RejectReason } from '../../shared/selection';

const fmt = (ms?: number) => (ms === undefined ? '—' : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);

export function GpuPanel(props: { gpu: GpuInfo | undefined; settings: Settings; patch: (p: Partial<Settings>) => Promise<void> }) {
  const g = props.gpu;
  const [copied, setCopied] = useState(false);
  if (!g) return <p className="muted small">Comprobando GPU y motor de transcripción…</p>;
  const yesNo = (b: boolean) => (b ? <span className="ok">sí</span> : <span className="error">no</span>);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(g.installCommands.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* portapapeles no disponible */
    }
  };
  return (
    <>
      <table className="table kv">
        <tbody>
          <tr><td>GPU NVIDIA detectada</td><td>{g.nvidiaGpu ? `${g.nvidiaGpu}${g.vramMB ? ` · ${(g.vramMB / 1024).toFixed(1)} GB VRAM` : ''}${g.driver ? ` · driver ${g.driver}` : ''}` : 'no'}</td></tr>
          <tr><td>CUDA habilitado para Whisper (Torch)</td><td>{yesNo(g.cudaAvailable)} {g.torchCpuOnly && g.torch && <span className="muted small">(Torch sólo CPU)</span>}</td></tr>
          <tr><td>CUDA en faster-whisper (CTranslate2)</td><td>{g.fasterWhisper ? yesNo(g.ctranslate2Cuda) : <span className="muted">no instalado</span>}</td></tr>
          <tr><td>Python / Torch / CUDA</td><td>{g.python ?? '—'} / {g.torch ?? 'no instalado'} / {g.torchCuda ?? '—'}</td></tr>
          <tr>
            <td>Motor activo</td>
            <td>
              {g.plan ? (
                <span className={`badge dev-${g.plan.device}`}>{g.plan.device === 'cuda' ? 'GPU' : 'CPU'}</span>
              ) : null}{' '}
              {g.plan ? `${ENGINE_LABELS[g.plan.engine]} · modelo ${g.plan.model}${g.plan.computeType ? ` · ${g.plan.computeType}` : g.plan.device === 'cuda' ? ` · ${g.plan.fp16 ? 'FP16' : 'FP32'}` : ' · FP32'}` : 'ninguno disponible'}
            </td>
          </tr>
        </tbody>
      </table>
      {g.plan?.warnings.map((w) => <div key={w} className="banner warn">{w}</div>)}
      {g.probeError && <div className="banner warn">{g.probeError}</div>}
      <div className={`banner ${g.cudaAvailable || g.ctranslate2Cuda ? 'info' : 'warn'}`}>{g.recommendation}</div>
      {g.installCommands.length > 0 && (
        <div className="card">
          <div className="small muted">Ejecuta en PowerShell (no se instala nada automáticamente):</div>
          <pre className="cmd">{g.installCommands.join('\n')}</pre>
          <button onClick={copy}>{copied ? 'Copiado ✓' : 'Copiar comandos'}</button>
        </div>
      )}
      <div className="grid2">
        <label className="field">
          <span>Motor de transcripción</span>
          <select value={props.settings.transcriptionEngine} onChange={(e) => props.patch({ transcriptionEngine: e.target.value as Settings['transcriptionEngine'] })}>
            <option value="auto">Automático (mejor disponible)</option>
            {ENGINE_IDS.map((id) => <option key={id} value={id}>{ENGINE_LABELS[id]}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Precisión en GPU</span>
          <select value={props.settings.whisperPrecision} onChange={(e) => props.patch({ whisperPrecision: e.target.value as Settings['whisperPrecision'] })}>
            <option value="auto">Automática (FP16 en GPU, FP32 en CPU)</option>
            <option value="fp16">FP16</option>
            <option value="fp32">FP32 (más VRAM; para GPU con problemas de FP16)</option>
          </select>
        </label>
      </div>
    </>
  );
}

const STAGE_LABELS: Record<MetricStage, string> = {
  validating: 'Validación',
  downloading: 'Descarga',
  extractingAudio: 'Extracción de audio',
  transcribing: 'Transcripción',
  analyzing: 'Análisis Ollama',
  rendering: 'Render',
};

export function LastRunPanel({ jobs }: { jobs: Job[] }) {
  const job = jobs.find((j) => TERMINAL_STATUSES.includes(j.status) && j.metrics);
  if (!job || !job.metrics) return <div className="empty">Aún no hay ejecuciones con métricas.</div>;
  const m = job.metrics;
  const a = job.analysis;
  return (
    <div className="card">
      <div className="title">{job.sourceTitle || job.url}</div>
      <div className="small muted">
        {STATUS_LABELS[job.status]} · {new Date(job.createdAt).toLocaleString('es-ES')}
        {job.resultSummary && ` · ${job.resultSummary}`}
      </div>
      <table className="table kv">
        <tbody>
          {(Object.keys(STAGE_LABELS) as MetricStage[]).map((s) => (
            <tr key={s}><td>{STAGE_LABELS[s]}</td><td>{fmt(m.stagesMs[s])}</td></tr>
          ))}
          <tr><td>Render por clip</td><td>{m.renderMsPerClip.length ? m.renderMsPerClip.map((x) => fmt(x)).join(' · ') : '—'}</td></tr>
          <tr><td>Total</td><td><b>{fmt(m.totalMs)}</b></td></tr>
          <tr><td>Motor</td><td>{m.engine ? `${ENGINE_LABELS[m.engine]} · ${m.whisperModel}` : '—'}{m.transcribeSpeed ? ` · ${m.transcribeSpeed.toFixed(1)}× tiempo real` : ''}{m.modelDownloadMs ? ` · descarga de modelo ${fmt(m.modelDownloadMs)}` : ''}</td></tr>
          {m.transcribeAttempts?.map((t, i) => (
            <tr key={i}>
              <td>Intento de transcripción {i + 1}</td>
              <td>
                <span className={t.ok ? 'ok' : 'error'}>{t.ok ? 'correcto' : 'fallido'}</span> · {t.device === 'cuda' ? 'GPU' : 'CPU'} · {t.model} · {t.precision} · código {t.exitCode ?? '—'} · {fmt(t.ms)}
                {t.reason && <div className="small muted">{t.reason}</div>}
              </td>
            </tr>
          ))}
          <tr><td>Modelo Ollama</td><td>{m.ollamaModel ?? '—'}</td></tr>
          <tr><td>Duración del vídeo</td><td>{m.sourceDuration ? `${Math.round(m.sourceDuration)} s` : '—'}</td></tr>
          {a && <tr><td>Clips</td><td>meta {a.target} · máx. factible {a.feasibleMax} · efectiva {a.effectiveTarget} · obtenidos {a.obtained}</td></tr>}
        </tbody>
      </table>
      {a && (
        <table className="table kv">
          <tbody>
            {a.rounds.map((r) => (
              <tr key={r.round}>
                <td>Ronda {r.round}</td>
                <td>
                  {r.failed ? <span className="error">JSON inválido</span> : `pidió ${r.requested} · recibió ${r.received} · aceptó ${r.accepted}`}
                  {Object.entries(r.rejected).length > 0 &&
                    ` · descartes: ${Object.entries(r.rejected).map(([k, v]) => `${REJECT_LABELS[k as RejectReason] ?? k} ×${v}`).join(', ')}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="small muted">Detalle técnico: %APPDATA%\ClipsVirales\logs\events.jsonl y app.log</p>
    </div>
  );
}
