import { useEffect, useState } from 'react';
import { PageHeader, SectionCard } from '../components/ui';
import { WHISPER_MODEL_OPTIONS, type Diagnostics, type Job, type Settings } from '../../shared/types';
import { AiModelPanel } from './AiModels';
import { AccelPanel } from './Accel';
import { LAYOUT_IDS, LAYOUT_LABELS } from '../../shared/layouts';
import { GpuPanel, LastRunPanel } from './Performance';
import { api, errMsg } from '../api';
import { PublishedExportsCleanup } from './PublishedExport';
import { LegacyModal } from './Legacy';

export function SettingsPage(props: { settings: Settings; onChange: (s: Settings) => void; diag: Diagnostics | null; refreshDiag: () => Promise<void>; jobs: Job[] }) {
  const s = props.settings;
  const [err, setErr] = useState('');
  const [checking, setChecking] = useState(false);
  const [pubClean, setPubClean] = useState(false);
  const [legacy, setLegacy] = useState(false);
  const [version, setVersion] = useState('');
  useEffect(() => {
    void api().appVersion().then((v) => setVersion(v.version)).catch(() => undefined);
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

  return (
    <section className="page settings-page">
      <PageHeader title="Configuración" subtitle="Ajustes de rendimiento, transcripción, IA local, almacenamiento y apariencia. Los cambios se guardan al momento." />
      {err && <div className="banner error">{err}</div>}

      <nav className="tabs settings-nav" aria-label="Secciones de Configuración">
        <a className="tab-link" href="#rendimiento">Rendimiento y GPU</a>
        <a className="tab-link" href="#transcripcion">Transcripción</a>
        <a className="tab-link" href="#ia">IA local</a>
        <a className="tab-link" href="#almacenamiento">Almacenamiento</a>
        <a className="tab-link" href="#apariencia">Apariencia de los clips</a>
        <a className="tab-link" href="#diagnostico">Diagnóstico</a>
      </nav>
      {!s.onboardingDone && (
      <SectionCard id="diagnostico-inicio" icon="stethoscope" title="Antes de empezar" description="Comprueba que están los programas necesarios.">
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
  
      </SectionCard>
      )}
      <SectionCard id="rendimiento" icon="cpu" title="Rendimiento y GPU" description="Aceleración por GPU, motor de transcripción y límites de cada trabajo.">
        <AccelPanel
          onChanged={() => {
            void api().getSettings().then(props.onChange);
            void props.refreshDiag();
          }}
        />
            <h3 className="sub-h">Detalles de la GPU y del motor</h3>
        <GpuPanel gpu={props.diag?.gpu} settings={s} patch={(p) => patch(p).then(props.refreshDiag)} />
            <h3 className="sub-h">Última ejecución</h3>
        <LastRunPanel jobs={props.jobs} />
            <h3 className="sub-h">Límites</h3>
        <div className="grid2">
          <NumField label="Duración máx. del vídeo (min)" value={s.maxSourceMinutes} min={1} max={600} onSave={(v) => patch({ maxSourceMinutes: v })} />
          <NumField label="Tamaño máx. de descarga (MB)" value={s.maxDownloadMB} min={10} max={20000} onSave={(v) => patch({ maxDownloadMB: v })} />
          <NumField label="Espacio libre mínimo (MB)" value={s.minFreeDiskMB} min={100} max={500000} onSave={(v) => patch({ minFreeDiskMB: v })} />
          <NumField label="Trabajos simultáneos (1–2)" value={s.maxConcurrentJobs} min={1} max={2} onSave={(v) => patch({ maxConcurrentJobs: v })} />
        </div>
  
      </SectionCard>
      <SectionCard id="transcripcion" icon="mic" title="Transcripción" description="Modelo de Whisper e idioma del audio. Todo se transcribe en este equipo.">
        <label className="field">
          <span>Modelo de Whisper (sólo se descarga si lo confirmas al iniciar un trabajo)</span>
          <small className="muted">Recomendado: CPU → «base» (equilibrio) o «small» (más preciso) · GPU CUDA → «turbo» con 8 GB de VRAM o más; con 6 GB se usa «medium» automáticamente.</small>
          <select value={s.whisperModel} onChange={(e) => patch({ whisperModel: e.target.value }).then(props.refreshDiag)}>
            {WHISPER_MODEL_OPTIONS.map((m) => (
              <option key={m.name} value={m.name}>{m.name} — {m.sizeLabel} — {m.note}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Idioma del audio (se fuerza en Whisper; mejora la precisión)</span>
          <select value={s.whisperLanguage || 'es'} onChange={(e) => patch({ whisperLanguage: e.target.value })}>
            {[['es', 'Español'], ['en', 'Inglés'], ['pt', 'Portugués'], ['fr', 'Francés'], ['it', 'Italiano'], ['de', 'Alemán'], ['ca', 'Catalán'], ['auto', 'Detectar idioma automáticamente']].map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
  
      </SectionCard>
      <SectionCard id="ia" icon="sparkle" title="IA local" description="Modelo de Ollama que elige los mejores momentos y redacta títulos.">
        <AiModelPanel settings={s} diag={props.diag} patch={(p) => patch(p).then(props.refreshDiag)} onModelsChanged={() => void props.refreshDiag()} />
  
      </SectionCard>
      <SectionCard id="almacenamiento" icon="disk" title="Almacenamiento" description="Dónde se exportan los clips y qué se conserva. Sólo se borran archivos de la app, siempre a la Papelera.">
            <h3 className="sub-h">Carpeta de exportación</h3>
        <div className="row">
          <code className="grow">{s.exportDir}</code>
          <button onClick={async () => { const d = await api().chooseExportDir(); if (d) props.onChange({ ...s, exportDir: d }); }}>Cambiar…</button>
        </div>
            <h3 className="sub-h">Conservación y limpieza</h3>
        <p className="small muted">
          Sólo se borran archivos creados por la app dentro de su carpeta de datos, y van a la Papelera de reciclaje. Los clips exportados nunca se borran.
        </p>
        <div className="grid2">
          <label className="field">
            <span>Conservar vídeos originales</span>
            <select value={s.keepSource} onChange={(e) => patch({ keepSource: e.target.value as Settings['keepSource'] })}>
              <option value="confirmar">Hasta que pulse «Liberar espacio» (recomendado)</option>
              <option value="hasta-exportar">Hasta exportar todos los clips (se verifica cada export)</option>
              <option value="siempre">Siempre (permite volver a renderizar)</option>
            </select>
          </label>
          <label className="field">
            <span>Conservar temporales (audio, subtítulos, fotogramas)</span>
            <select value={s.keepTemp} onChange={(e) => patch({ keepTemp: e.target.value as Settings['keepTemp'] })}>
              <option value="tras-completar">Borrar audio y subtítulos al completar</option>
              <option value="tras-exportar">Borrar al exportar todos los clips</option>
              <option value="siempre">Conservar siempre</option>
            </select>
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={s.keepTranscript} onChange={(e) => patch({ keepTranscript: e.target.checked })} />
          <span>Conservar la transcripción (ocupa poco y permite rehacer subtítulos)</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={!!s.deleteExportsAfterPublish} onChange={(e) => patch({ deleteExportsAfterPublish: e.target.checked })} />
          <span>
            Eliminar exports después de marcarlos como publicados
            <span className="small muted"> — elimina el MP4 exportado (no sólo temporales), lo envía a la Papelera al confirmar «publicado». Se conservan títulos, textos e historial. Desactivado por defecto.</span>
          </span>
        </label>
        <div className="row">
          <button aria-haspopup="dialog" onClick={() => setPubClean(true)}>
            Limpiar exports publicados…
          </button>
          <button className="ghost" aria-haspopup="dialog" onClick={() => setLegacy(true)}>
            Datos de ClipsVirales…
          </button>
        </div>
        <PublishedExportsCleanup open={pubClean} onClose={() => setPubClean(false)} />
        <LegacyModal open={legacy} onClose={() => setLegacy(false)} onDone={() => window.location.reload()} />
        <div className="grid2">
          <NumField label="Limpieza automática tras N días (0 = desactivada)" value={s.autoCleanupDays} min={0} max={365} onSave={(v) => patch({ autoCleanupDays: v })} />
          <p className="small muted">Sólo afecta a trabajos completados y sigue las opciones de arriba. Nunca toca exports ni trabajos en curso.</p>
        </div>
  
      </SectionCard>
      <SectionCard id="apariencia" icon="palette" title="Apariencia de los clips" description="Plantilla vertical por defecto, encuadre y estilo de subtítulos.">
        <label className="field">
          <span>Plantilla vertical por defecto</span>
          <select value={s.defaultLayout} onChange={(e) => patch({ defaultLayout: e.target.value as Settings['defaultLayout'] })}>
            <option value="auto">Auto: según la detección de facecam (experimental, con fallback seguro)</option>
            {LAYOUT_IDS.map((l) => (
              <option key={l} value={l}>
                {LAYOUT_LABELS[l]}
              </option>
            ))}
          </select>
          <small className="muted">Si la detección no es fiable se usa «Sin cámara: sólo gameplay» y se muestra la sugerencia en cada clip. Puedes cambiar la plantilla de cada clip en Resultados.</small>
        </label>
        <label className="field">
          <span>Desplazamiento horizontal del recorte: {s.cropOffsetX.toFixed(2)} (−1 izquierda, 0 centro, 1 derecha)</span>
          <input type="range" min={-1} max={1} step={0.05} value={s.cropOffsetX} onChange={(e) => patch({ cropOffsetX: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>Tamaño de subtítulos: {s.subtitleFontSize}</span>
          <input type="range" min={30} max={140} value={s.subtitleFontSize} onChange={(e) => patch({ subtitleFontSize: Number(e.target.value) })} />
        </label>
        <div className="grid2">
          <label className="field">
            <span>Estilo de subtítulo</span>
            <select value={s.subtitleStyle ?? 'karaoke'} onChange={(e) => patch({ subtitleStyle: e.target.value as Settings['subtitleStyle'] })}>
              <option value="standard">Estándar (frase en blanco)</option>
              <option value="karaoke">Karaoke por palabra (resalta la palabra que se dice)</option>
            </select>
          </label>
          <label className="field">
            <span>Color de la palabra activa</span>
            <input type="color" value={s.subtitleActiveColor ?? '#00C285'} disabled={s.subtitleStyle === 'standard'} onChange={(e) => patch({ subtitleActiveColor: e.target.value.toUpperCase() })} />
          </label>
        </div>
        <label className="field">
        <span>Posición vertical de los subtítulos: {s.subtitlePositionY ? `${s.subtitlePositionY} % desde arriba` : 'automática (en la separación cámara/gameplay)'}</span>
        <input type="range" min={0} max={78} step={1} value={s.subtitlePositionY ?? 0} onChange={(e) => patch({ subtitlePositionY: Number(e.target.value) })} aria-describedby="subpos-help" />
        <small id="subpos-help" className="muted">0 = automática. Nunca baja de la zona que tapan los controles de TikTok, Shorts y Reels.</small>
      </label>
      <small className="muted">Se aplica a los clips que renderices a partir de ahora (los ya renderizados no cambian hasta volver a renderizarlos).</small>
  
      </SectionCard>
      {s.onboardingDone && (
      <SectionCard id="diagnostico" icon="stethoscope" title="Diagnóstico" description="Programas necesarios, rutas manuales y versión.">
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
            <h3 className="sub-h">Rutas de ejecutables (opcional)</h3>
        <p className="small muted">Déjalas vacías para autodetectar (PATH o binarios incluidos). Deben ser rutas absolutas a .exe.</p>
        <PathField label="ffmpeg.exe" value={s.ffmpegPath} onSave={(v) => patch({ ffmpegPath: v }).then(props.refreshDiag)} />
        <PathField label="ffprobe.exe" value={s.ffprobePath} onSave={(v) => patch({ ffprobePath: v }).then(props.refreshDiag)} />
        <PathField label="yt-dlp.exe" value={s.ytDlpPath} onSave={(v) => patch({ ytDlpPath: v }).then(props.refreshDiag)} />
        <PathField label="whisper.exe" value={s.whisperPath} onSave={(v) => patch({ whisperPath: v }).then(props.refreshDiag)} />
        <PathField label="python.exe (del entorno de Whisper)" value={s.pythonPath} onSave={(v) => patch({ pythonPath: v }).then(props.refreshDiag)} />
            <h3 className="sub-h">Acerca de</h3>
        <p className="small">
          <b>Clip Clip</b> {version ? `versión ${version}` : ''} · todo se procesa en este equipo. Las actualizaciones sustituyen la instalación anterior y conservan tus datos en %APPDATA%\Clip Clip.
        </p>
  
      </SectionCard>
      )}
      {!s.onboardingDone && (
      <SectionCard id="diagnostico" icon="stethoscope" title="Diagnóstico" description="Programas necesarios, rutas manuales y versión.">
            <h3 className="sub-h">Rutas de ejecutables (opcional)</h3>
        <p className="small muted">Déjalas vacías para autodetectar (PATH o binarios incluidos). Deben ser rutas absolutas a .exe.</p>
        <PathField label="ffmpeg.exe" value={s.ffmpegPath} onSave={(v) => patch({ ffmpegPath: v }).then(props.refreshDiag)} />
        <PathField label="ffprobe.exe" value={s.ffprobePath} onSave={(v) => patch({ ffprobePath: v }).then(props.refreshDiag)} />
        <PathField label="yt-dlp.exe" value={s.ytDlpPath} onSave={(v) => patch({ ytDlpPath: v }).then(props.refreshDiag)} />
        <PathField label="whisper.exe" value={s.whisperPath} onSave={(v) => patch({ whisperPath: v }).then(props.refreshDiag)} />
        <PathField label="python.exe (del entorno de Whisper)" value={s.pythonPath} onSave={(v) => patch({ pythonPath: v }).then(props.refreshDiag)} />
            <h3 className="sub-h">Acerca de</h3>
        <p className="small">
          <b>Clip Clip</b> {version ? `versión ${version}` : ''} · todo se procesa en este equipo. Las actualizaciones sustituyen la instalación anterior y conservan tus datos en %APPDATA%\Clip Clip.
        </p>
  
      </SectionCard>
      )}
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
