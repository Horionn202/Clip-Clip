import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accelStatus, friendlySetupError, parsePipProgress, planSetup, type SetupState } from '../src/shared/gpuSetup';
import { runSetup, venvPython, type SetupDeps } from '../src/main/gpuSetupRunner';
import { CancelledError, type RunOptions, type RunResult } from '../src/main/proc';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-gpu-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const PROBE_OK = JSON.stringify({ torch: '2.14.1+cu126', cuda_available: true, cuda_device: 'GTX 1660 SUPER', whisper: true });
const PROBE_CPU = JSON.stringify({ torch: '2.15.0+cpu', cuda_available: false, whisper: true });
const TRANSCRIPT = JSON.stringify({ segments: [{ start: 0, end: 2, text: ' Hola prueba' }] });

/** Simulador de procesos: venv crea python.exe, pip emite progreso «raw», probe y whisper responden según el caso. */
function fakeRun(o: { probe?: string; failTorch?: string; whisperJson?: string | null; hang?: boolean } = {}) {
  const calls: string[][] = [];
  const run = async (cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> => {
    calls.push(args);
    if (args[0] === '-m' && args[1] === 'venv') {
      const py = venvPython(args[2]);
      fs.mkdirSync(path.dirname(py), { recursive: true });
      fs.writeFileSync(py, '');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args.includes('pip')) {
      if (o.hang) {
        await new Promise((_r, rej) => opts.signal?.addEventListener('abort', () => rej(new CancelledError())));
      }
      if (args.includes('torch') && o.failTorch) return { code: 1, stdout: '', stderr: o.failTorch };
      for (const p of [0, 50, 100]) opts.onStdout?.(`Progress ${p} of 100`);
      opts.onStdout?.('Successfully installed');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args.some((a) => a.endsWith('probe.py'))) return { code: 0, stdout: o.probe ?? PROBE_OK, stderr: '' };
    if (args[1] === 'whisper') {
      const outDir = args[args.indexOf('--output_dir') + 1];
      if (o.whisperJson !== null) fs.writeFileSync(path.join(outDir, 'prueba.json'), o.whisperJson ?? TRANSCRIPT);
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

function deps(run: SetupDeps['run'], states: SetupState[], extra: Partial<SetupDeps> = {}): SetupDeps {
  return {
    run,
    python: 'C:/Python312/python.exe',
    venvDir: path.join(dir, 'python-env'),
    probeScript: 'probe.py',
    workDir: path.join(dir, 'work'),
    logFile: path.join(dir, 'logs', 'gpu-setup.log'),
    gpuName: 'NVIDIA GeForce GTX 1660 SUPER',
    onState: (s) => states.push(s),
    makeSpeech: async (out) => {
      fs.writeFileSync(out, Buffer.alloc(20000));
      return true;
    },
    ...extra,
  };
}

describe('instalación guiada (simulada)', () => {
  it('instala en el entorno aislado, informa progreso y sólo termina bien tras la transcripción real', async () => {
    const { run, calls } = fakeRun();
    const states: SetupState[] = [];
    const st = await runSetup('install', deps(run, states), new AbortController().signal);
    expect(st.ok).toBe(true);
    expect(st.steps.map((s) => s.status)).toEqual(['hecho', 'hecho', 'hecho', 'hecho', 'hecho']);
    expect(states.some((s) => s.steps.find((x) => x.id === 'torch')?.progress === 0.5)).toBe(true);
    // torch desde el índice oficial de PyTorch y dentro del venv (nunca el Python global)
    const torchCall = calls.find((a) => a.includes('torch'))!;
    expect(torchCall).toContain('https://download.pytorch.org/whl/cu126');
    expect(calls.find((a) => a[1] === 'whisper')).toContain('--device');
    expect(fs.readFileSync(path.join(dir, 'logs', 'gpu-setup.log'), 'utf8')).toMatch(/pip install/);
  });
  it('GTX 16xx: la prueba en GPU usa FP32', async () => {
    const { run, calls } = fakeRun();
    await runSetup('verify', deps(run, []), new AbortController().signal);
    const w = calls.find((a) => a[1] === 'whisper')!;
    expect(w[w.indexOf('--fp16') + 1]).toBe('False');
  });
  it('fallo de descarga → error accionable, pasos siguientes omitidos', async () => {
    const { run } = fakeRun({ failTorch: 'ConnectionError: Read timed out' });
    const st = await runSetup('install', deps(run, []), new AbortController().signal);
    expect(st.ok).toBe(false);
    expect(st.error).toMatch(/conexión/);
    expect(st.steps.map((s) => s.status)).toEqual(['hecho', 'error', 'omitido', 'omitido', 'omitido']);
  });
  it('cancelación durante la descarga → cancelado y reintentable', async () => {
    const { run } = fakeRun({ hang: true });
    const ctrl = new AbortController();
    const p = runSetup('install', deps(run, []), ctrl.signal);
    setTimeout(() => ctrl.abort(), 30);
    const st = await p;
    expect(st).toMatchObject({ ok: false, cancelled: true, running: false });
    expect(st.error).toMatch(/Reintentar|reintentar/);
  });
  it('Torch dice CUDA=false → nunca «listo»', async () => {
    const { run } = fakeRun({ probe: PROBE_CPU });
    const st = await runSetup('verify', deps(run, []), new AbortController().signal);
    expect(st.ok).toBe(false);
    expect(st.error).toMatch(/CUDA no está disponible/);
  });
  it('CUDA=true pero la transcripción no genera JSON válido → no está lista', async () => {
    const { run } = fakeRun({ whisperJson: '{"segments": []}' });
    const st = await runSetup('verify', deps(run, []), new AbortController().signal);
    expect(st.ok).toBe(false);
    expect(st.error).toMatch(/transcripción de prueba/);
  });
  it('sin audio de prueba no se marca como lista', async () => {
    const { run } = fakeRun();
    const st = await runSetup('verify', deps(run, [], { makeSpeech: async () => false }), new AbortController().signal);
    expect(st.ok).toBe(false);
  });
  it('el registro no guarda rutas de usuario', async () => {
    const { run } = fakeRun();
    const st = await runSetup('verify', deps(run, [], { python: 'C:\\Users\\Rafael\\py\\python.exe' }), new AbortController().signal);
    expect(st.logTail.join('\n')).not.toMatch(/Rafael/);
  });
});

describe('plan y estado de la aceleración', () => {
  const base = { nvidiaGpu: 'GTX 1660 SUPER', python: 'C:/py/python.exe', pythonVersion: '3.14.10', venvDir: 'X', freeGB: 50, tinyCached: true };
  it('compatible con Python 3.11–3.14, GPU y espacio', () => {
    expect(planSetup(base)).toMatchObject({ compatible: true, requiredFreeGB: 6 });
  });
  it.each([
    [{ nvidiaGpu: null }, /driver de NVIDIA/],
    [{ python: null }, /Instala Python 3.12/],
    [{ pythonVersion: '3.9.1' }, /no tiene ruedas oficiales/],
    [{ pythonVersion: '3.15.0' }, /no tiene ruedas oficiales/],
    [{ freeGB: 3 }, /6 GB libres/],
  ])('no compatible %j', (patch, re) => {
    const p = planSetup({ ...base, ...patch });
    expect(p.compatible).toBe(false);
    expect(p.reason).toMatch(re);
  });
  it('incluye el modelo tiny en la descarga si falta', () => {
    expect(planSetup({ ...base, tinyCached: false }).needsTinyModel).toBe(true);
  });
  it('CUDA sólo «listo» si se verificó con el mismo Python', () => {
    const s = { nvidiaGpu: 'GTX', cudaAvailable: true, verifiedPython: 'A', currentPython: 'A', running: false };
    expect(accelStatus(s)).toBe('listo');
    expect(accelStatus({ ...s, verifiedPython: null })).toBe('sin-verificar');
    expect(accelStatus({ ...s, currentPython: 'B' })).toBe('sin-verificar');
    expect(accelStatus({ ...s, cudaAvailable: false, verifiedPython: null })).toBe('disponible');
    expect(accelStatus({ ...s, nvidiaGpu: null })).toBe('no-disponible');
    expect(accelStatus({ ...s, running: true })).toBe('instalando');
  });
  it('progreso «raw» de pip y errores accionables', () => {
    expect(parsePipProgress('Progress 25 of 100')).toBe(0.25);
    expect(parsePipProgress('Collecting torch')).toBeNull();
    expect(friendlySetupError('ERROR: No matching distribution found for torch')).toMatch(/Python 3.12/);
    expect(friendlySetupError('OSError: [Errno 28] No space left on device')).toMatch(/espacio/);
  });
});
