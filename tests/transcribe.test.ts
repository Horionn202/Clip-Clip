import { describe, it, expect } from 'vitest';
import { probeGpu, type GpuProbes, type ResolvedTools } from '../src/main/deps';
import { defaultSettings } from '../src/main/store';
import {
  buildPlan,
  computeProgress,
  fallbackPlans,
  formatProgress,
  isGpuFailure,
  isModelDownloadLine,
  isTorchCpuOnly,
  openaiArgs,
  parseNvidiaSmi,
  parseOpenaiSegmentEnd,
  selectEngine,
  type SelectOptions,
} from '../src/main/transcribe';
import { cacheKey } from '../src/shared/models';

const tools: ResolvedTools = { ffmpeg: 'f', ffprobe: 'p', ytDlp: 'y', whisper: 'C:/Py/Scripts/whisper.exe', ollama: 'o', python: 'C:/Py/python.exe', nvidiaSmi: 'smi' };
const smi = 'NVIDIA GeForce GTX 1660 SUPER, 6144, 616.64\n';
const mk = (probe: object, smiOut: string | null = smi): GpuProbes => ({ nvidiaSmi: async () => smiOut, pythonProbe: async () => JSON.stringify(probe) });

describe('detección Torch CPU-only vs CUDA real', () => {
  it('GPU NVIDIA presente pero Torch +cpu → NO hay CUDA y se usa CPU', async () => {
    const g = await probeGpu(tools, defaultSettings('x'), 'probe.py', mk({ python: '3.14.10', torch: '2.15.0+cpu', torch_cuda: null, cuda_available: false, whisper: true }));
    expect(g.nvidiaGpu).toBe('NVIDIA GeForce GTX 1660 SUPER');
    expect(g.cudaAvailable).toBe(false);
    expect(g.torchCpuOnly).toBe(true);
    expect(g.plan).toMatchObject({ engine: 'openai-whisper-cpu', device: 'cpu', fp16: false });
    expect(g.recommendation).toMatch(/NO puede usar CUDA.*sólo CPU/);
    expect(g.installCommands.join(' ')).toMatch(/download\.pytorch\.org\/whl\/cu126/);
  });
  it('Torch CUDA funcional → plan GPU con FP16', async () => {
    const g = await probeGpu(
      tools,
      defaultSettings('x'),
      'probe.py',
      mk({ python: '3.14.10', torch: '2.14.1+cu126', torch_cuda: '12.6', cuda_available: true, cuda_device: 'GTX 1660 SUPER', cuda_vram_mb: 6144, whisper: true }),
    );
    expect(g.cudaAvailable).toBe(true);
    expect(g.plan).toMatchObject({ engine: 'openai-whisper-cuda', device: 'cuda', fp16: true });
  });
  it('torch con versión CUDA pero is_available() false (driver) → CPU', async () => {
    const g = await probeGpu(tools, defaultSettings('x'), 'probe.py', mk({ torch: '2.14.1+cu126', torch_cuda: '12.6', cuda_available: false, whisper: true }));
    expect(g.cudaAvailable).toBe(false);
    expect(g.torchCpuOnly).toBe(false);
    expect(g.plan?.device).toBe('cpu');
  });
  it('sin GPU NVIDIA → recomendación CPU base/small', async () => {
    const g = await probeGpu(tools, defaultSettings('x'), 'probe.py', mk({ torch: '2.15.0+cpu', whisper: true }, null));
    expect(g.nvidiaGpu).toBeNull();
    expect(g.recommendation).toMatch(/base.*small/);
  });
  it('isTorchCpuOnly y parseNvidiaSmi', () => {
    expect(isTorchCpuOnly({ torch: '2.15.0+cpu', torch_cuda: null })).toBe(true);
    expect(isTorchCpuOnly({ torch: '2.14.1+cu126', torch_cuda: '12.6' })).toBe(false);
    expect(parseNvidiaSmi(smi)).toEqual({ name: 'NVIDIA GeForce GTX 1660 SUPER', vramMB: 6144, driver: '616.64' });
    expect(parseNvidiaSmi('')).toBeNull();
  });
});

const opts = (o: Partial<SelectOptions> = {}): SelectOptions => ({
  choice: 'auto',
  model: 'turbo',
  precision: 'auto',
  vramMB: 6144,
  avail: { 'faster-whisper-cuda': false, 'openai-whisper-cuda': true, 'openai-whisper-cpu': true },
  ...o,
});

describe('selección de motor y FP16', () => {
  it('CPU siempre --fp16 False', () => {
    const p = buildPlan('openai-whisper-cpu', opts({ model: 'base' }))!;
    const a = openaiArgs(p, 'a.wav', 'out', 'es');
    expect(a.slice(a.indexOf('--fp16'), a.indexOf('--fp16') + 2)).toEqual(['--fp16', 'False']);
    expect(a.slice(a.indexOf('--device'), a.indexOf('--device') + 2)).toEqual(['--device', 'cpu']);
  });
  it('CUDA → --device cuda --fp16 True (no fuerza False)', () => {
    const p = selectEngine(opts())!;
    expect(p.engine).toBe('openai-whisper-cuda');
    const a = openaiArgs(p, 'a.wav', 'out', '');
    expect(a.join(' ')).toContain('--device cuda');
    expect(a.join(' ')).toContain('--fp16 True');
  });
  it('precisión fp32 forzada en GPU', () => {
    expect(selectEngine(opts({ precision: 'fp32' }))!.fp16).toBe(false);
  });
  it('prioriza faster-whisper CUDA cuando está disponible', () => {
    const p = selectEngine(opts({ avail: { 'faster-whisper-cuda': true, 'openai-whisper-cuda': true, 'openai-whisper-cpu': true } }))!;
    expect(p).toMatchObject({ engine: 'faster-whisper-cuda', model: 'turbo', computeType: 'float16' });
  });
  it('VRAM insuficiente → modelo menor con aviso', () => {
    const p = selectEngine(opts({ model: 'large', vramMB: 6144 }))!;
    expect(p.model).toBe('turbo');
    expect(p.warnings[0]).toMatch(/VRAM/);
    const q = selectEngine(opts({ model: 'medium', vramMB: 4096 }))!;
    expect(q.model).toBe('small');
  });
  it('sin CUDA → CPU', () => {
    const p = selectEngine(opts({ avail: { 'faster-whisper-cuda': false, 'openai-whisper-cuda': false, 'openai-whisper-cpu': true }, model: 'base' }))!;
    expect(p).toMatchObject({ device: 'cpu', fp16: false });
  });
  it('fallo de GPU → alternativas: modelo menor en GPU y luego CPU con modelo razonable', () => {
    const p = selectEngine(opts())!;
    const f = fallbackPlans(p, opts());
    expect(f[0]).toMatchObject({ engine: 'openai-whisper-cuda', model: 'medium' });
    expect(f[f.length - 1]).toMatchObject({ engine: 'openai-whisper-cpu', model: 'small', fp16: false });
    expect(isGpuFailure('torch.OutOfMemoryError: CUDA out of memory.')).toBe(true);
    expect(isGpuFailure('FileNotFoundError: audio')).toBe(false);
  });
  it('nombres de caché oficiales', () => {
    expect(cacheKey('openai-whisper-cpu', 'turbo')).toBe('large-v3-turbo.pt');
    expect(cacheKey('faster-whisper-cuda', 'turbo')).toBe('models--mobiuslabsgmbh--faster-whisper-large-v3-turbo');
    expect(cacheKey('faster-whisper-cuda', 'small')).toBe('models--Systran--faster-whisper-small');
  });
});

describe('progreso de transcripción', () => {
  it('parsea segmentos y descargas', () => {
    expect(parseOpenaiSegmentEnd('[00:12.000 --> 01:15.500]  hola')).toBe(75.5);
    expect(parseOpenaiSegmentEnd('Detecting language')).toBeNull();
    expect(isModelDownloadLine(' 45%|████      | 210M/461M [00:10<00:12, 21.0MiB/s]')).toBe(true);
  });
  it('sin muestra suficiente no hay ETA ni velocidad; muestra segundos, no «0 min»', () => {
    const p = computeProgress({ phase: 'loadingModel', audioDone: 0, firstSegmentAt: null }, 421.86, 0, 25_000, 'cpu');
    expect(p.speed).toBeUndefined();
    expect(p.etaSec).toBeUndefined();
    const msg = formatProgress(p);
    expect(msg).toMatch(/Iniciando modelo… · 25 s/);
    expect(msg).not.toMatch(/0 min/);
    expect(formatProgress({ ...p, phase: 'downloadingModel' })).toMatch(/Descargando modelo/);
  });
  it('con muestra suficiente: velocidad × tiempo real y ETA', () => {
    const p = computeProgress({ phase: 'transcribing', audioDone: 120, firstSegmentAt: 10_000 }, 421.86, 0, 60_000, 'cuda');
    expect(p.speed).toBeCloseTo(2, 1);
    expect(p.etaSec).toBeCloseTo((421.86 - 120) / 2, 0);
    expect(formatProgress(p)).toMatch(/\[GPU\] 28 % · 2 min de 7 min 2 s de audio · 1 min transcurridos · 2\.0× tiempo real · quedan ≈ 2 min 31 s/);
  });
});
