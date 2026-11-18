// Motores de transcripción local: detección real de CUDA, selección de motor, argumentos y progreso.
// Lógica pura y testeable; la ejecución de procesos vive en pipeline.ts / deps.ts.
import path from 'node:path';
import type { EngineChoice, EngineId, EnginePlan, GpuInfo, Precision, TranscribeProgress } from '../shared/types';

/** Salida JSON de resources/python/probe.py. */
export interface ProbeJson {
  python?: string;
  torch?: string | null;
  torch_cuda?: string | null;
  cuda_available?: boolean;
  cuda_device?: string | null;
  cuda_vram_mb?: number | null;
  whisper?: boolean;
  faster_whisper?: string | null;
  ctranslate2?: string | null;
  ct2_cuda_devices?: number;
  ct2_cuda_compute_types?: string[];
  cache_openai?: string[];
  cache_faster?: string[];
  errors?: string[];
}

export interface NvidiaSmi {
  name: string;
  vramMB: number;
  driver: string;
}

/** Parsea `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(out: string): NvidiaSmi | null {
  const line = out.split(/\r?\n/).find((l) => l.trim());
  if (!line) return null;
  const [name, mem, driver] = line.split(',').map((s) => s.trim());
  const vram = Number(mem);
  if (!name || !Number.isFinite(vram)) return null;
  return { name, vramMB: vram, driver: driver ?? '' };
}

/** Torch CPU-only: el sufijo "+cpu" o la ausencia de torch.version.cuda. */
export function isTorchCpuOnly(p: ProbeJson): boolean {
  if (!p.torch) return true;
  return /\+cpu\b/.test(p.torch) || !p.torch_cuda;
}

/** VRAM aproximada (GB) por modelo. openai-whisper: README oficial; faster-whisper: menor (CTranslate2). */
export const VRAM_GB: Record<'openai' | 'faster', Record<string, number>> = {
  openai: { tiny: 1, base: 1, small: 2, medium: 5, large: 10, turbo: 6 },
  faster: { tiny: 0.5, base: 0.7, small: 1.2, medium: 2.6, large: 4.7, turbo: 2.6 },
};
const MODEL_ORDER = ['tiny', 'base', 'small', 'medium', 'turbo', 'large'];

export { cacheKey } from '../shared/models';
import { isModelCached as cachedIn } from '../shared/models';
export function isModelCached(engine: EngineId, model: string, info: Pick<GpuInfo, 'cachedModels'>): boolean {
  return cachedIn(engine, model, info.cachedModels);
}

export interface EngineAvailability {
  'faster-whisper-cuda': boolean;
  'openai-whisper-cuda': boolean;
  'openai-whisper-cpu': boolean;
}

export function availability(info: Pick<GpuInfo, 'cudaAvailable' | 'whisperInstalled' | 'fasterWhisper' | 'ctranslate2Cuda'>, hasWhisperExe: boolean): EngineAvailability {
  return {
    'faster-whisper-cuda': !!info.fasterWhisper && info.ctranslate2Cuda,
    'openai-whisper-cuda': info.whisperInstalled && info.cudaAvailable,
    'openai-whisper-cpu': info.whisperInstalled || hasWhisperExe,
  };
}

export interface SelectOptions {
  choice: EngineChoice;
  model: string;
  precision: Precision;
  vramMB: number | null;
  avail: EngineAvailability;
  /** Si se pasa, se prefieren modelos ya descargados al degradar por VRAM. */
  isCached?: (engine: EngineId, model: string) => boolean;
}

/** Orden de preferencia: faster-whisper CUDA → openai-whisper CUDA → openai-whisper CPU. */
export function engineCandidates(o: SelectOptions): EngineId[] {
  const order: EngineId[] = ['faster-whisper-cuda', 'openai-whisper-cuda', 'openai-whisper-cpu'];
  const avail = order.filter((e) => o.avail[e]);
  if (o.choice !== 'auto' && o.avail[o.choice]) return [o.choice, ...avail.filter((e) => e !== o.choice)];
  return avail;
}

/** Elige el modelo que cabe en VRAM (el pedido o el mayor inferior que quepa). */
function fitModel(engine: EngineId, wanted: string, vramMB: number | null, warnings: string[]): string | null {
  if (engine === 'openai-whisper-cpu' || vramMB === null) return wanted;
  const table = engine === 'faster-whisper-cuda' ? VRAM_GB.faster : VRAM_GB.openai;
  const vramGB = vramMB / 1024;
  if ((table[wanted] ?? 99) <= vramGB) return wanted;
  const smaller = MODEL_ORDER.slice(0, Math.max(0, MODEL_ORDER.indexOf(wanted)))
    .reverse()
    .find((m) => (table[m] ?? 99) <= vramGB);
  if (!smaller) return null;
  warnings.push(`El modelo «${wanted}» necesita ≈ ${table[wanted]} GB de VRAM y la GPU tiene ${vramGB.toFixed(1)} GB; se usará «${smaller}».`);
  return smaller;
}

export function buildPlan(engine: EngineId, o: SelectOptions): EnginePlan | null {
  const warnings: string[] = [];
  const model = fitModel(engine, o.model, o.vramMB, warnings);
  if (!model) return null;
  if (engine === 'openai-whisper-cpu') {
    // En CPU FP16 no está soportado: siempre --fp16 False.
    return { engine, device: 'cpu', model, fp16: false, warnings };
  }
  if (engine === 'openai-whisper-cuda') {
    const fp16 = o.precision !== 'fp32';
    return { engine, device: 'cuda', model, fp16, warnings };
  }
  // faster-whisper: float16 si hay VRAM holgada; int8_float16 si va justa (menos memoria).
  const need = VRAM_GB.faster[model] ?? 2;
  const vramGB = (o.vramMB ?? 0) / 1024;
  let computeType = o.precision === 'fp32' ? 'float32' : need * 1.5 <= vramGB || o.vramMB === null ? 'float16' : 'int8_float16';
  if (computeType === 'int8_float16') warnings.push('VRAM justa: se usa int8_float16 para reducir memoria.');
  return { engine, device: 'cuda', model, fp16: computeType === 'float16', computeType, warnings };
}

/** Selecciona el mejor motor disponible. null si no hay ninguno. */
export function selectEngine(o: SelectOptions): EnginePlan | null {
  for (const e of engineCandidates(o)) {
    const plan = buildPlan(e, o);
    if (plan) return plan;
  }
  return null;
}

/** Cadena de alternativas segura tras un fallo de GPU (OOM, cuDNN…): mismo motor con modelo menor, luego CPU. */
export function fallbackPlans(failed: EnginePlan, o: SelectOptions): EnginePlan[] {
  const out: EnginePlan[] = [];
  const idx = MODEL_ORDER.indexOf(failed.model);
  if (failed.device === 'cuda') {
    const smaller = MODEL_ORDER.slice(0, Math.max(0, idx)).reverse()[0];
    if (smaller) {
      const p = buildPlan(failed.engine, { ...o, model: smaller });
      if (p) out.push({ ...p, warnings: [...p.warnings, `Reintento con modelo «${smaller}» tras fallo en GPU.`] });
    }
    for (const e of engineCandidates(o).filter((x) => x !== failed.engine)) {
      const p = buildPlan(e, { ...o, model: e === 'openai-whisper-cpu' ? cpuModelFor(failed.model) : failed.model });
      if (p) out.push({ ...p, warnings: [...p.warnings, `Reintento con ${e} tras fallo en GPU.`] });
    }
  }
  return out;
}

/** En CPU, turbo/large son muy lentos: se recomienda small como máximo. */
export function cpuModelFor(model: string): string {
  return ['turbo', 'large', 'medium'].includes(model) ? 'small' : model;
}

export function isGpuFailure(stderr: string): boolean {
  return /CUDA out of memory|OutOfMemoryError|CUBLAS_STATUS|cuDNN|cudnn|CUDA error|no kernel image|cublas64|Could not load library|CUDA failed|out of memory/i.test(stderr);
}

/** Argumentos para el CLI de openai-whisper. */
export function openaiArgs(plan: EnginePlan, audio: string, outDir: string, language: string): string[] {
  const a = [audio, '--model', plan.model, '--word_timestamps', 'True', '--output_format', 'json', '--output_dir', outDir, '--verbose', 'True'];
  a.push('--device', plan.device);
  a.push('--fp16', plan.device === 'cuda' && plan.fp16 ? 'True' : 'False');
  if (language) a.push('--language', language);
  return a;
}

/**
 * Cómo lanzar openai-whisper: con el intérprete diagnosticado (`python -m whisper`) si ese entorno lo tiene,
 * para que lo que se ejecuta coincida con lo detectado (CUDA o no); si no, el whisper.exe resuelto.
 */
export function openaiCommand(
  tools: { python?: string | null; whisper: string | null },
  pythonHasWhisper: boolean,
): { exe: string; prefix: string[] } | null {
  if (tools.python && pythonHasWhisper) return { exe: tools.python, prefix: ['-m', 'whisper'] };
  if (tools.whisper) return { exe: tools.whisper, prefix: [] };
  return null;
}

/** Argumentos para resources/python/fw_transcribe.py (faster-whisper). */
export function fasterArgs(script: string, plan: EnginePlan, audio: string, outJson: string, language: string, allowDownload: boolean): string[] {
  const a = [script, '--audio', audio, '--model', plan.model, '--device', plan.device, '--compute-type', plan.computeType ?? 'float16', '--output', outJson];
  if (language) a.push('--language', language);
  if (!allowDownload) a.push('--local-only');
  return a;
}

/**
 * Intérpretes candidatos para un whisper.exe, en orden:
 * 1) junto al lanzador (virtualenv de Windows: <venv>\Scripts\python.exe);
 * 2) instalación normal de Python (…\PythonXY\Scripts\whisper.exe → …\PythonXY\python.exe).
 */
export function pythonNextToWhisper(whisperExe: string): string[] {
  const exe = process.platform === 'win32' ? 'python.exe' : 'python';
  const dir = path.dirname(whisperExe);
  return [path.join(dir, exe), path.join(path.dirname(dir), exe)];
}

// ---- Progreso ----

/** Extrae el fin del segmento de una línea verbose de openai-whisper: "[00:12.000 --> 00:15.000] texto". */
export function parseOpenaiSegmentEnd(line: string): number | null {
  const m = line.match(/-->\s*(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\]/);
  if (!m) return null;
  return (m[1] ? parseInt(m[1]) * 3600 : 0) + parseInt(m[2]) * 60 + parseFloat(m[3]);
}

/** Barra tqdm de descarga de modelo (openai-whisper / huggingface_hub) en stderr, p. ej. "45%|███ | 210M/461M". */
export function isModelDownloadLine(line: string): boolean {
  return /\d+%\|.*\|\s*[\d.]+\s*[kMG]?i?B?\/[\d.]+\s*[kMG]?i?B?/.test(line) || /Downloading|\.pt\b.*%/.test(line);
}

export interface ProgressState {
  phase: TranscribeProgress['phase'];
  audioDone: number;
  firstSegmentAt: number | null;
}

/** Calcula progreso: velocidad sólo con muestra suficiente (≥ 20 s de audio y ≥ 10 s reales desde el primer segmento). */
export function computeProgress(st: ProgressState, total: number, startedAt: number, now: number, device: 'cpu' | 'cuda'): TranscribeProgress {
  const elapsedSec = (now - startedAt) / 1000;
  const p: TranscribeProgress = { phase: st.phase, audioDoneSec: st.audioDone, audioTotalSec: total, elapsedSec, device };
  // Velocidad = audio procesado / tiempo real desde el inicio (incluye carga del modelo: estimación conservadora).
  if (st.firstSegmentAt !== null && st.audioDone >= 20 && (now - st.firstSegmentAt) / 1000 >= 10 && elapsedSec > 0) {
    const speed = st.audioDone / elapsedSec;
    p.speed = speed;
    p.etaSec = Math.max(0, (total - st.audioDone) / speed);
  }
  return p;
}

export function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.max(0, Math.round(sec))} s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return s ? `${m} min ${s} s` : `${m} min`;
}

export function formatProgress(p: TranscribeProgress): string {
  const dev = p.device === 'cuda' ? 'GPU' : 'CPU';
  if (p.phase === 'downloadingModel') return `[${dev}] Descargando modelo de Whisper… · ${fmtDuration(p.elapsedSec)}`;
  if (p.phase === 'loadingModel') return `[${dev}] Iniciando modelo… · ${fmtDuration(p.elapsedSec)}`;
  const pct = p.audioTotalSec ? Math.round((p.audioDoneSec / p.audioTotalSec) * 100) : 0;
  let s = `[${dev}] ${pct} % · ${fmtDuration(p.audioDoneSec)} de ${fmtDuration(p.audioTotalSec)} de audio · ${fmtDuration(p.elapsedSec)} transcurridos`;
  if (p.speed) s += ` · ${p.speed.toFixed(1)}× tiempo real`;
  if (p.etaSec !== undefined) s += ` · quedan ≈ ${fmtDuration(p.etaSec)}`;
  return s;
}

// ---- Diagnóstico y recomendaciones ----

export const TORCH_CUDA_INDEX = 'https://download.pytorch.org/whl/cu126';

export function recommendation(info: Omit<GpuInfo, 'recommendation' | 'installCommands' | 'plan'>): { text: string; commands: string[] } {
  // PowerShell necesita el operador & para ejecutar una ruta entre comillas.
  const py = info.pythonPath ? `& "${info.pythonPath}"` : 'python';
  if (!info.nvidiaGpu) {
    return {
      text: 'No se detectó GPU NVIDIA: la transcripción usará CPU. Recomendado: modelo «base» (equilibrio) o «small» (más preciso).',
      commands: [],
    };
  }
  if (info.cudaAvailable || info.ctranslate2Cuda) {
    return {
      text: `CUDA está habilitado para la transcripción en ${info.nvidiaGpu}. Recomendado: modelo «turbo».`,
      commands: info.fasterWhisper ? [] : [`${py} -m pip install -U faster-whisper`],
    };
  }
  return {
    text:
      `GPU NVIDIA detectada (${info.nvidiaGpu}), pero Whisper NO puede usar CUDA` +
      (info.torchCpuOnly ? ` porque Torch es una versión sólo CPU (${info.torch ?? 'no instalado'}).` : '.') +
      ' Hasta corregirlo se transcribe en CPU. Instala Torch con CUDA con los comandos de abajo (≈ 2,5 GB) y vuelve a comprobar.',
    commands: [`${py} -m pip uninstall -y torch`, `${py} -m pip install torch --index-url ${TORCH_CUDA_INDEX}`],
  };
}
