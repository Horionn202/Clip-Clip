// Perfiles de modelo de IA (Ollama) y recomendación según RAM/VRAM. Puro: renderer, main y tests.

export type ProfileId = 'rapido' | 'equilibrado' | 'calidad';

export interface AiProfile {
  id: ProfileId;
  label: string;
  model: string;
  /** Descarga aproximada (Q4_K_M de la biblioteca de Ollama). */
  downloadGB: number;
  /** Memoria aproximada con contexto de 8K tokens (pesos + caché KV). */
  memoryGB: number;
  quality: string;
  speed: string;
}

export const AI_PROFILES: AiProfile[] = [
  { id: 'rapido', label: 'Rápido', model: 'qwen2.5:3b', downloadGB: 1.9, memoryGB: 2.8, quality: 'Buena para vídeos claros; a veces títulos simples.', speed: 'La más rápida.' },
  { id: 'equilibrado', label: 'Equilibrado', model: 'qwen2.5:7b', downloadGB: 4.7, memoryGB: 5.6, quality: 'Mejor comprensión y cumplimiento del formato.', speed: 'Media; lenta si no cabe en la GPU.' },
  { id: 'calidad', label: 'Calidad', model: 'llama3.1:8b', downloadGB: 4.9, memoryGB: 6.1, quality: 'La más fina en títulos y hooks.', speed: 'La más lenta; con 6 GB de VRAM suele ir parcialmente en CPU.' },
];

export const BIGGER_IS_NOT_ALWAYS_BETTER =
  'Un modelo mayor puede mejorar la selección y el cumplimiento del formato, pero usa más RAM/VRAM y puede tardar más.';

export type Fit = 'gpu' | 'parcial' | 'cpu' | 'no-cabe';

export interface ProfileFit {
  profile: AiProfile;
  fit: Fit;
  /** Texto corto y honesto sobre dónde se ejecutará. */
  note: string;
}

/** Uso máximo de VRAM considerado seguro (deja sitio al sistema y al escritorio). */
export const VRAM_USABLE = 0.9;

export function evaluateProfile(p: Pick<AiProfile, 'memoryGB'> & Partial<AiProfile>, vramTotalMB: number | null, ramTotalMB: number): Omit<ProfileFit, 'profile'> {
  const need = p.memoryGB * 1024;
  if (vramTotalMB && need <= vramTotalMB * VRAM_USABLE) return { fit: 'gpu', note: 'Cabe por completo en la GPU.' };
  if (need > ramTotalMB * 0.7) return { fit: 'no-cabe', note: 'Probablemente no cabe en la memoria de este equipo.' };
  if (vramTotalMB && vramTotalMB >= 2048) {
    return { fit: 'parcial', note: 'No cabe entero en la GPU: una parte irá a CPU/RAM y el análisis será más lento.' };
  }
  return { fit: 'cpu', note: 'Se ejecutará en CPU/RAM (sin GPU suficiente): lento.' };
}

export function evaluateProfiles(vramTotalMB: number | null, ramTotalMB: number): ProfileFit[] {
  return AI_PROFILES.map((profile) => ({ profile, ...evaluateProfile(profile, vramTotalMB, ramTotalMB) }));
}

/** Recomienda «Equilibrado» sólo si cabe entero en GPU; si no, «Rápido». «Calidad» nunca por defecto. */
export function recommendProfile(vramTotalMB: number | null, ramTotalMB: number): ProfileId {
  const fits = evaluateProfiles(vramTotalMB, ramTotalMB);
  return fits.find((f) => f.profile.id === 'equilibrado')?.fit === 'gpu' ? 'equilibrado' : 'rapido';
}

export interface Placement {
  sizeMB: number;
  vramMB: number;
  /** 0–1: fracción del modelo cargada en GPU. */
  gpuRatio: number;
  where: 'gpu' | 'parcial' | 'cpu';
}

/** A partir de /api/ps (size, size_vram): nunca afirma «GPU» si parte del modelo está en CPU/RAM. */
export function placementFrom(sizeBytes: number, vramBytes: number): Placement {
  const ratio = sizeBytes > 0 ? Math.max(0, Math.min(1, vramBytes / sizeBytes)) : 0;
  return {
    sizeMB: Math.round(sizeBytes / 1048576),
    vramMB: Math.round(vramBytes / 1048576),
    gpuRatio: ratio,
    where: ratio >= 0.99 ? 'gpu' : ratio > 0.01 ? 'parcial' : 'cpu',
  };
}

export function placementLabel(p: Placement): string {
  if (p.where === 'gpu') return 'Modelo 100 % en GPU';
  if (p.where === 'cpu') return 'Modelo en CPU/RAM (sin GPU)';
  return `Modelo ${Math.round(p.gpuRatio * 100)} % en GPU y el resto en CPU/RAM (más lento)`;
}

export interface BenchmarkResult {
  model: string;
  tokensPerSec: number;
  loadSec: number;
  totalSec: number;
  placement?: Placement;
  validJson: boolean;
  at: string;
}

/** tokens/s a partir de las estadísticas finales de Ollama (duraciones en nanosegundos). */
export function tokensPerSecond(evalCount: number, evalDurationNs: number): number {
  if (!evalCount || !evalDurationNs) return 0;
  return Math.round((evalCount / (evalDurationNs / 1e9)) * 10) / 10;
}
