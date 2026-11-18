// Instalación guiada de la aceleración GPU en un entorno virtual de la app (userData), sin tocar el Python global.
// Pasos: venv → torch CUDA (índice oficial) → openai-whisper (PyPI) → comprobar CUDA → transcripción real de prueba.
import fs from 'node:fs';
import path from 'node:path';
import {
  PYPI,
  SETUP_STEPS,
  TORCH_INDEX,
  VERIFY_STEPS,
  friendlySetupError,
  parsePipProgress,
  type SetupState,
  type SetupStepId,
} from '../shared/gpuSetup';
import { CancelledError, runProcess, type RunOptions, type RunResult } from './proc';
import { fp16Unsafe, whisperSkipped } from './transcribe';
import { locateTranscript, sanitizeArgs } from './transcriptOutput';

export interface SetupDeps {
  run: (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;
  /** Python base para crear el entorno (modo «install») o Python a verificar (modo «verify»). */
  python: string;
  venvDir: string;
  probeScript: string;
  workDir: string;
  logFile: string;
  gpuName: string | null;
  onState: (s: SetupState) => void;
  /** Sólo Windows: genera audio hablado de prueba con las voces del sistema. */
  makeSpeech?: (out: string, signal: AbortSignal) => Promise<boolean>;
}

export function venvPython(venvDir: string): string {
  return path.join(venvDir, process.platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python'));
}

const PY_ENV = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' };

export async function runSetup(mode: 'install' | 'verify', deps: SetupDeps, signal: AbortSignal): Promise<SetupState> {
  const ids: SetupStepId[] = mode === 'install' ? SETUP_STEPS.map((s) => s.id) : VERIFY_STEPS;
  const state: SetupState = {
    running: true,
    mode,
    steps: SETUP_STEPS.filter((s) => ids.includes(s.id)).map((s) => ({ ...s, status: 'pendiente' })),
    startedAt: new Date().toISOString(),
    logTail: [],
  };
  fs.mkdirSync(path.dirname(deps.logFile), { recursive: true });
  fs.mkdirSync(deps.workDir, { recursive: true });
  const log = (line: string) => {
    const clean = line.replace(/[A-Za-z]:\\Users\\[^\\\s]+/gi, '<usuario>').slice(0, 400);
    state.logTail = [...state.logTail, clean].slice(-200);
    try {
      fs.appendFileSync(deps.logFile, `${new Date().toISOString()} ${clean}\n`);
    } catch {
      /* ignorar */
    }
  };
  const emit = () => deps.onState(JSON.parse(JSON.stringify(state)) as SetupState);
  const step = (id: SetupStepId) => state.steps.find((s) => s.id === id)!;
  const py = mode === 'install' ? venvPython(deps.venvDir) : deps.python;

  const exec = async (id: SetupStepId, cmd: string, args: string[], timeoutMs: number): Promise<RunResult> => {
    log(`$ ${path.basename(cmd)} ${sanitizeArgs(args).join(' ')}`);
    const r = await deps.run(cmd, args, {
      signal,
      timeoutMs,
      env: PY_ENV,
      onStdout: (l) => {
        const p = parsePipProgress(l);
        if (p !== null) {
          step(id).progress = p;
          emit();
          return;
        }
        log(l);
        if (/^(Collecting|Downloading|Installing|Successfully)/.test(l)) {
          step(id).detail = l.slice(0, 120);
          emit();
        }
      },
      onStderr: (l) => log(l),
    });
    log(`(código de salida ${r.code})`);
    return r;
  };

  const fail = (id: SetupStepId, message: string) => {
    step(id).status = 'error';
    state.error = message;
    state.ok = false;
  };

  try {
    for (const id of ids) {
      if (signal.aborted) throw new CancelledError();
      step(id).status = 'en-curso';
      step(id).progress = undefined;
      emit();
      let ok = true;
      if (id === 'venv') {
        if (fs.existsSync(py)) {
          step(id).detail = 'El entorno ya existe: se reutiliza.';
        } else {
          const r = await exec(id, deps.python, ['-m', 'venv', deps.venvDir], 5 * 60_000);
          ok = r.code === 0 && fs.existsSync(py);
          if (!ok) fail(id, 'No se pudo crear el entorno aislado. ' + friendlySetupError(r.stderr));
        }
      } else if (id === 'torch') {
        const r = await exec(id, py, ['-m', 'pip', 'install', '--progress-bar', 'raw', '--index-url', TORCH_INDEX, 'torch'], 2 * 60 * 60_000);
        ok = r.code === 0;
        if (!ok) fail(id, friendlySetupError(`${r.stdout}\n${r.stderr}`));
      } else if (id === 'whisper') {
        const r = await exec(id, py, ['-m', 'pip', 'install', '--progress-bar', 'raw', '--index-url', PYPI, 'openai-whisper'], 60 * 60_000);
        ok = r.code === 0;
        if (!ok) fail(id, friendlySetupError(`${r.stdout}\n${r.stderr}`));
      } else if (id === 'verify-cuda') {
        const r = await exec(id, py, [deps.probeScript], 3 * 60_000);
        let cuda = false;
        let detail = '';
        try {
          const j = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? '{}') as { torch?: string; cuda_available?: boolean; cuda_device?: string; whisper?: boolean };
          cuda = j.cuda_available === true && j.whisper === true;
          detail = `Torch ${j.torch ?? '—'} · CUDA ${j.cuda_available ? 'sí' : 'no'} · ${j.cuda_device ?? 'sin GPU'} · Whisper ${j.whisper ? 'instalado' : 'no instalado'}`;
        } catch {
          detail = 'El diagnóstico no devolvió datos válidos.';
        }
        step(id).detail = detail;
        ok = r.code === 0 && cuda;
        if (!ok) fail(id, `CUDA no está disponible en este entorno (${detail}). Revisa el driver de NVIDIA o reintenta la instalación.`);
      } else if (id === 'verify-transcribe') {
        const audio = path.join(deps.workDir, 'prueba.wav');
        const outDir = path.join(deps.workDir, 'salida');
        fs.rmSync(outDir, { recursive: true, force: true });
        fs.mkdirSync(outDir, { recursive: true });
        const spoken = deps.makeSpeech ? await deps.makeSpeech(audio, signal) : false;
        if (!spoken) {
          ok = false;
          fail(id, 'No se pudo generar el audio de prueba con las voces de Windows. La GPU no se marcará como lista.');
        } else {
          const started = Date.now();
          const fp16 = fp16Unsafe(deps.gpuName) ? 'False' : 'True';
          const r = await exec(id, py, ['-m', 'whisper', audio, '--model', 'tiny', '--device', 'cuda', '--fp16', fp16, '--language', 'es', '--output_format', 'json', '--output_dir', outDir], 10 * 60_000);
          const skipped = whisperSkipped(`${r.stdout}\n${r.stderr}`);
          const check = locateTranscript(outDir, 'prueba', started);
          ok = r.code === 0 && !skipped && check.ok;
          step(id).detail = ok ? `Transcripción en GPU correcta (${check.segments} segmentos, ${((Date.now() - started) / 1000).toFixed(1)} s).` : skipped ?? check.error;
          if (!ok) fail(id, `La transcripción de prueba en GPU falló: ${skipped ?? check.error ?? `código ${r.code}`}.`);
        }
      }
      if (!ok) break;
      step(id).status = 'hecho';
      step(id).progress = 1;
      emit();
    }
    if (state.ok !== false) state.ok = true;
  } catch (e) {
    if (e instanceof CancelledError || signal.aborted) {
      state.cancelled = true;
      state.ok = false;
      state.error = 'Instalación cancelada. Puedes reintentar: lo ya descargado se reaprovecha.';
      const cur = state.steps.find((s) => s.status === 'en-curso');
      if (cur) cur.status = 'error';
    } else {
      state.ok = false;
      state.error = 'Error inesperado durante la instalación. Revisa el registro técnico.';
      log(String(e));
    }
  }
  for (const s of state.steps) if (s.status === 'pendiente' && state.ok === false) s.status = 'omitido';
  state.running = false;
  state.finishedAt = new Date().toISOString();
  emit();
  return state;
}

/** Audio de prueba con la síntesis de voz de Windows (script fijo; la ruta va como argumento, no interpolada). */
export function windowsSpeech(workDir: string, run: typeof runProcess = runProcess) {
  return async (out: string, signal: AbortSignal): Promise<boolean> => {
    if (process.platform !== 'win32') return false;
    const script = path.join(workDir, 'voz.ps1');
    fs.writeFileSync(
      script,
      [
        'param([string]$Out)',
        'Add-Type -AssemblyName System.Speech',
        '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
        '$s.SetOutputToWaveFile($Out)',
        "$s.Speak('Hola. Esta es una prueba de transcripción con la tarjeta gráfica. Uno, dos, tres.')",
        '$s.Dispose()',
      ].join('\r\n'),
      'utf8',
    );
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Out', out], { signal, timeoutMs: 60_000 });
    return r.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 10_000;
  };
}
