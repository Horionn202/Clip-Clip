// Estado y plan de la «Activación de aceleración GPU». Puro: lo comparten main, renderer y tests.

export type AccelStatus =
  | 'listo' // CUDA verificado con una transcripción real
  | 'sin-verificar' // Torch dice CUDA=true pero falta la prueba real
  | 'disponible' // GPU NVIDIA presente; se puede instalar el entorno
  | 'instalando'
  | 'error'
  | 'requiere-reinicio'
  | 'no-disponible'; // sin GPU NVIDIA o sin Python compatible

export type SetupStepId = 'venv' | 'torch' | 'whisper' | 'verify-cuda' | 'verify-transcribe';

export const SETUP_STEPS: { id: SetupStepId; label: string }[] = [
  { id: 'venv', label: 'Crear entorno aislado de la app' },
  { id: 'torch', label: 'Instalar PyTorch con CUDA 12.6 (≈ 2,5 GB)' },
  { id: 'whisper', label: 'Instalar openai-whisper' },
  { id: 'verify-cuda', label: 'Comprobar que CUDA funciona' },
  { id: 'verify-transcribe', label: 'Transcripción de prueba en GPU' },
];

export const VERIFY_STEPS: SetupStepId[] = ['verify-cuda', 'verify-transcribe'];

/** Origen oficial de PyTorch con CUDA 12.6 (ruedas para Windows x64, Python 3.11–3.14 verificadas). */
export const TORCH_INDEX = 'https://download.pytorch.org/whl/cu126';
export const PYPI = 'https://pypi.org/simple';
/** Versiones de Python con ruedas torch+cu126 para Windows comprobadas en el índice oficial (2026-11-18). */
export const SUPPORTED_PYTHON = ['3.11', '3.12', '3.13', '3.14'];
export const DOWNLOAD_GB = 2.8;
export const REQUIRED_FREE_GB = 6;

export interface SetupPlan {
  compatible: boolean;
  /** Motivo y acción si no es compatible. */
  reason?: string;
  actionUrl?: string;
  python: string | null;
  pythonVersion: string | null;
  venvDir: string;
  freeGB: number;
  downloadGB: number;
  requiredFreeGB: number;
  sources: string[];
  /** Incluye el modelo «tiny» de Whisper (≈ 75 MB) para la prueba si aún no está descargado. */
  needsTinyModel: boolean;
}

export interface StepState {
  id: SetupStepId;
  label: string;
  status: 'pendiente' | 'en-curso' | 'hecho' | 'error' | 'omitido';
  progress?: number; // 0–1
  detail?: string;
}

export interface SetupState {
  running: boolean;
  mode: 'install' | 'verify';
  steps: StepState[];
  startedAt?: string;
  finishedAt?: string;
  ok?: boolean;
  cancelled?: boolean;
  error?: string;
  /** Últimas líneas del registro (sin rutas de usuario). */
  logTail: string[];
}

export function minorVersion(v: string | null | undefined): string | null {
  const m = v?.match(/^(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : null;
}

export function planSetup(i: {
  nvidiaGpu: string | null;
  python: string | null;
  pythonVersion: string | null;
  venvDir: string;
  freeGB: number;
  tinyCached: boolean;
}): SetupPlan {
  const base = {
    python: i.python,
    pythonVersion: i.pythonVersion,
    venvDir: i.venvDir,
    freeGB: Math.round(i.freeGB * 10) / 10,
    downloadGB: DOWNLOAD_GB + (i.tinyCached ? 0 : 0.08),
    requiredFreeGB: REQUIRED_FREE_GB,
    sources: [TORCH_INDEX, PYPI, ...(i.tinyCached ? [] : ['https://openaipublic.azureedge.net (modelo tiny de Whisper)'])],
    needsTinyModel: !i.tinyCached,
  };
  if (!i.nvidiaGpu) {
    return { ...base, compatible: false, reason: 'No se detectó una GPU NVIDIA con driver. Instala o actualiza el driver de NVIDIA y vuelve a comprobar.', actionUrl: 'https://www.nvidia.com/es-es/drivers/' };
  }
  if (!i.python) {
    return { ...base, compatible: false, reason: 'No se encontró Python. Instala Python 3.12 (64 bits) desde python.org y vuelve a comprobar.', actionUrl: 'https://www.python.org/downloads/windows/' };
  }
  const mv = minorVersion(i.pythonVersion);
  if (!mv || !SUPPORTED_PYTHON.includes(mv)) {
    return {
      ...base,
      compatible: false,
      reason: `Python ${i.pythonVersion ?? 'desconocido'} no tiene ruedas oficiales de PyTorch con CUDA comprobadas (compatibles: ${SUPPORTED_PYTHON.join(', ')}). Instala Python 3.12 (64 bits) desde python.org.`,
      actionUrl: 'https://www.python.org/downloads/windows/',
    };
  }
  if (i.freeGB < REQUIRED_FREE_GB) {
    return { ...base, compatible: false, reason: `Hace falta al menos ${REQUIRED_FREE_GB} GB libres en el disco de la app (hay ${base.freeGB} GB).` };
  }
  return { ...base, compatible: true };
}

/** Estado de la aceleración para la UI. CUDA sólo es «listo» tras una transcripción real verificada. */
export function accelStatus(i: {
  nvidiaGpu: string | null;
  cudaAvailable: boolean;
  verifiedPython: string | null;
  currentPython: string | null;
  running: boolean;
  lastError?: string;
}): AccelStatus {
  if (i.running) return 'instalando';
  if (!i.nvidiaGpu) return 'no-disponible';
  // La última prueba fallida manda sobre un éxito anterior (p. ej. modelo corrupto o VRAM insuficiente).
  if (i.lastError) return 'error';
  if (i.cudaAvailable && i.verifiedPython && i.verifiedPython === i.currentPython) return 'listo';
  if (i.cudaAvailable) return 'sin-verificar';
  return 'disponible';
}

export const ACCEL_LABELS: Record<AccelStatus, string> = {
  listo: 'GPU lista (verificada)',
  'sin-verificar': 'CUDA detectado, sin verificar',
  disponible: 'Disponible para instalar',
  instalando: 'Instalando…',
  error: 'Error',
  'requiere-reinicio': 'Requiere reiniciar la app',
  'no-disponible': 'No disponible',
};

/** «Progress 123 of 456» (pip --progress-bar raw) → fracción 0–1. */
export function parsePipProgress(line: string): number | null {
  const m = line.match(/^Progress (\d+) of (\d+)/);
  if (!m) return null;
  const total = Number(m[2]);
  return total > 0 ? Math.min(1, Number(m[1]) / total) : null;
}

/** Traduce fallos típicos de pip/venv a una acción concreta. */
export function friendlySetupError(output: string): string {
  if (/No matching distribution|Could not find a version that satisfies/i.test(output)) {
    return 'No hay paquetes de PyTorch con CUDA para esta versión de Python. Instala Python 3.12 (64 bits) y reintenta.';
  }
  if (/No space left|Errno 28|not enough space/i.test(output)) return 'No hay espacio suficiente en disco. Libera espacio y reintenta.';
  if (/ConnectionError|Connection (reset|aborted|refused)|Read timed out|getaddrinfo|NewConnectionError|SSLError/i.test(output)) {
    return 'Se perdió la conexión al descargar. Comprueba internet y pulsa «Reintentar» (lo ya descargado se reaprovecha).';
  }
  if (/Access is denied|PermissionError|WinError 5/i.test(output)) return 'Windows denegó el acceso a un archivo. Cierra otras ventanas de Python y reintenta.';
  if (/hash|THESE PACKAGES DO NOT MATCH/i.test(output)) return 'Un paquete descargado no superó la comprobación de integridad. Reintenta la instalación.';
  return 'La instalación falló. Revisa el registro técnico y pulsa «Reintentar».';
}
