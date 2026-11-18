import fs from 'node:fs';
import path from 'node:path';
import type { DepId, DepStatus, Diagnostics, GpuInfo, Settings } from '../shared/types';
import { runProcess } from './proc';
import { listModels } from './ollama';
import { availability, isTorchCpuOnly, parseNvidiaSmi, pythonNextToWhisper, recommendation, selectEngine, type ProbeJson } from './transcribe';

export type ToolName = 'ffmpeg' | 'ffprobe' | 'yt-dlp' | 'whisper' | 'ollama' | 'python' | 'nvidia-smi';

export interface ResolvedTools {
  ffmpeg: string | null;
  ffprobe: string | null;
  ytDlp: string | null;
  whisper: string | null;
  ollama: string | null;
  python?: string | null;
  nvidiaSmi?: string | null;
}

/** Busca un ejecutable: ruta configurada → resources/bin empaquetado → PATH → ubicaciones conocidas. */
export function findExecutable(name: ToolName, override: string, bundledDir: string | null, env = process.env): string | null {
  const isFile = (p: string) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (override) return isFile(override) ? override : null;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd'] : [''];
  const candidates: string[] = [];
  if (bundledDir) for (const e of exts) candidates.push(path.join(bundledDir, name + e));
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    for (const e of exts) candidates.push(path.join(dir, name + e));
  }
  if (process.platform === 'win32' && name === 'ollama' && env.LOCALAPPDATA) {
    candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'));
  }
  if (process.platform === 'win32' && name === 'nvidia-smi') {
    candidates.push(path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'nvidia-smi.exe'));
  }
  // El alias "python.exe" de Microsoft Store (WindowsApps) no es un Python real.
  return candidates.find((c) => isFile(c) && !(name === 'python' && /WindowsApps/i.test(c))) ?? null;
}

export function resolveTools(s: Settings, bundledDir: string | null): ResolvedTools {
  const whisper = findExecutable('whisper', s.whisperPath, bundledDir);
  // Python del mismo entorno que whisper.exe (pip), o el configurado, o el del PATH.
  let python = s.pythonPath ? findExecutable('python', s.pythonPath, null) : null;
  if (!python && whisper) {
    const sibling = pythonNextToWhisper(whisper);
    if (fs.existsSync(sibling)) python = sibling;
  }
  if (!python && !s.pythonPath) python = findExecutable('python', '', null);
  return {
    ffmpeg: findExecutable('ffmpeg', s.ffmpegPath, bundledDir),
    ffprobe: findExecutable('ffprobe', s.ffprobePath, bundledDir),
    ytDlp: findExecutable('yt-dlp', s.ytDlpPath, bundledDir),
    whisper,
    ollama: findExecutable('ollama', '', null),
    python,
    nvidiaSmi: findExecutable('nvidia-smi', '', null),
  };
}

// ---- GPU / CUDA ----

export interface GpuProbes {
  nvidiaSmi: (exe: string) => Promise<string | null>;
  pythonProbe: (python: string, script: string) => Promise<string | null>;
}

export const realGpuProbes: GpuProbes = {
  async nvidiaSmi(exe) {
    try {
      const r = await runProcess(exe, ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], { timeoutMs: 15000 });
      return r.code === 0 ? r.stdout : null;
    } catch {
      return null;
    }
  },
  async pythonProbe(python, script) {
    try {
      const r = await runProcess(python, [script], { timeoutMs: 90000, env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
      return r.code === 0 ? r.stdout.trim().split(/\r?\n/).pop() ?? null : null;
    } catch {
      return null;
    }
  },
};

/** Distingue «GPU NVIDIA detectada» de «Whisper puede usar CUDA de verdad». */
export async function probeGpu(tools: ResolvedTools, s: Settings, probeScript: string, probes: GpuProbes = realGpuProbes): Promise<GpuInfo> {
  const smi = tools.nvidiaSmi ? parseNvidiaSmi((await probes.nvidiaSmi(tools.nvidiaSmi)) ?? '') : null;
  let pj: ProbeJson = {};
  let probeError: string | undefined;
  if (tools.python) {
    const raw = await probes.pythonProbe(tools.python, probeScript);
    try {
      pj = raw ? (JSON.parse(raw) as ProbeJson) : {};
      if (!raw) probeError = 'No se pudo ejecutar el diagnóstico de Python.';
    } catch {
      probeError = 'El diagnóstico de Python devolvió datos no válidos.';
    }
  } else {
    probeError = 'No se encontró Python (necesario para Whisper).';
  }
  const base = {
    nvidiaGpu: smi?.name ?? pj.cuda_device ?? null,
    vramMB: pj.cuda_vram_mb ?? smi?.vramMB ?? null,
    driver: smi?.driver ?? null,
    python: pj.python ?? null,
    pythonPath: tools.python ?? null,
    torch: pj.torch ?? null,
    torchCuda: pj.torch_cuda ?? null,
    cudaAvailable: pj.cuda_available === true, // sólo si Torch lo confirma, nunca por la mera presencia de la GPU
    torchCpuOnly: isTorchCpuOnly(pj),
    whisperInstalled: pj.whisper === true,
    fasterWhisper: pj.faster_whisper ?? null,
    ctranslate2Cuda: (pj.ct2_cuda_devices ?? 0) > 0 && (pj.ct2_cuda_compute_types ?? []).includes('float16'),
    cachedModels: { openai: pj.cache_openai ?? [], faster: pj.cache_faster ?? [] },
    probeError,
  };
  const rec = recommendation(base);
  const plan = selectEngine({
    choice: s.transcriptionEngine,
    model: s.whisperModel,
    precision: s.whisperPrecision,
    vramMB: base.vramMB,
    avail: availability(base, !!tools.whisper),
  });
  return { ...base, plan, recommendation: rec.text, installCommands: rec.commands };
}

export const HELP: Record<DepId, string> = {
  ffmpeg:
    'Instala FFmpeg: abre PowerShell y ejecuta «winget install Gyan.FFmpeg.Essentials», reinicia la app. ' +
    'O indica la ruta de ffmpeg.exe en Configuración.',
  ffprobe: 'FFprobe viene con FFmpeg. Instala FFmpeg (winget install Gyan.FFmpeg.Essentials) o indica la ruta de ffprobe.exe.',
  ytDlp: 'Instala yt-dlp: «winget install yt-dlp.yt-dlp» y reinicia la app, o indica la ruta de yt-dlp.exe en Configuración.',
  whisper:
    'Instala Whisper local: instala Python 3.10+ y ejecuta «pip install -U openai-whisper». ' +
    'Después reinicia la app o indica la ruta de whisper.exe (p. ej. %LOCALAPPDATA%\\Programs\\Python\\Python3xx\\Scripts\\whisper.exe).',
  ollamaInstalled: 'Descarga e instala Ollama desde https://ollama.com/download/windows y reinicia la app.',
  ollamaService: 'Abre la aplicación Ollama (o ejecuta «ollama serve» en una terminal) y pulsa «Volver a comprobar».',
  ollamaModel: 'Descarga el modelo desde Configuración → Modelo de IA, o ejecuta «ollama pull <modelo>».',
};

export interface DiagnosticProbes {
  version: (exe: string, args: string[]) => Promise<string | null>;
  ollamaModels: (host: string) => Promise<string[] | null>;
}

export const realProbes: DiagnosticProbes = {
  async version(exe, args) {
    try {
      const r = await runProcess(exe, args, { timeoutMs: 20000 });
      if (r.code !== 0) return null;
      return (r.stdout || r.stderr).split(/\r?\n/)[0]?.trim().slice(0, 120) || 'ok';
    } catch {
      return null;
    }
  },
  async ollamaModels(host) {
    try {
      return await listModels(host, 3000);
    } catch {
      return null;
    }
  },
};

export async function runDiagnostics(tools: ResolvedTools, s: Settings, probes: DiagnosticProbes = realProbes): Promise<Diagnostics> {
  const items: DepStatus[] = [];
  const check = async (id: DepId, label: string, exe: string | null, args: string[]) => {
    if (!exe) return items.push({ id, label, ok: false, detail: 'No encontrado', help: HELP[id] });
    const v = await probes.version(exe, args);
    items.push(v ? { id, label, ok: true, detail: `${v} — ${exe}` } : { id, label, ok: false, detail: `No responde: ${exe}`, help: HELP[id] });
  };
  await Promise.all([
    check('ffmpeg', 'FFmpeg', tools.ffmpeg, ['-hide_banner', '-version']),
    check('ffprobe', 'FFprobe', tools.ffprobe, ['-hide_banner', '-version']),
    check('ytDlp', 'yt-dlp', tools.ytDlp, ['--version']),
  ]);
  // whisper --help es lento; basta con comprobar que existe el ejecutable
  items.push(
    tools.whisper
      ? { id: 'whisper', label: 'Motor de transcripción (Whisper)', ok: true, detail: `${tools.whisper} (modelo ${s.whisperModel})` }
      : { id: 'whisper', label: 'Motor de transcripción (Whisper)', ok: false, detail: 'No encontrado', help: HELP.whisper },
  );
  items.push(
    tools.ollama
      ? { id: 'ollamaInstalled', label: 'Ollama instalado', ok: true, detail: tools.ollama }
      : { id: 'ollamaInstalled', label: 'Ollama instalado', ok: false, detail: 'No encontrado', help: HELP.ollamaInstalled },
  );
  const models = await probes.ollamaModels(s.ollamaHost);
  items.push(
    models
      ? { id: 'ollamaService', label: 'Servicio Ollama', ok: true, detail: `Disponible en ${s.ollamaHost}` }
      : { id: 'ollamaService', label: 'Servicio Ollama', ok: false, detail: `Sin respuesta en ${s.ollamaHost}`, help: HELP.ollamaService },
  );
  const hasModel = !!models && models.some((m) => m === s.ollamaModel || m === `${s.ollamaModel}:latest`);
  items.push(
    hasModel
      ? { id: 'ollamaModel', label: `Modelo «${s.ollamaModel}»`, ok: true, detail: 'Descargado' }
      : {
          id: 'ollamaModel',
          label: `Modelo «${s.ollamaModel}»`,
          ok: false,
          detail: models ? 'No descargado' : 'No se puede comprobar sin el servicio Ollama',
          help: HELP.ollamaModel.replace('<modelo>', s.ollamaModel),
        },
  );
  const order: DepId[] = ['ollamaInstalled', 'ollamaService', 'ollamaModel', 'ffmpeg', 'ffprobe', 'ytDlp', 'whisper'];
  items.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return { ok: items.every((i) => i.ok), checkedAt: new Date().toISOString(), items };
}

/** Mensaje claro cuando falta una dependencia en el pipeline. */
export function missingDepMessage(d: Diagnostics): string | null {
  const bad = d.items.filter((i) => !i.ok);
  if (bad.length === 0) return null;
  return `Faltan dependencias: ${bad.map((b) => b.label).join(', ')}. Abre Configuración → Diagnóstico para ver cómo resolverlo.`;
}
