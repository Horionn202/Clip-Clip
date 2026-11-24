// Qué conserva Inicio cuando un trabajo falla y el usuario elige «Cambiar URL» o «Importar archivo». Puro.
import type { DurationPreset, Job } from './types';
import type { BoundaryMode, CreationMode } from './fullSplit';

export interface HomePrefill {
  /** URL original (no se pierde al fallar). Vacía para un archivo local. */
  url: string;
  preset: DurationPreset;
  maxClips: number;
  /** Modo de creación y tipo de corte del trabajo fallido (para no volver sin querer a «IA encuentra momentos»). */
  creationMode: CreationMode;
  boundaryMode: BoundaryMode;
  /** Abrir el selector de archivos al llegar a Inicio. */
  pickFile: boolean;
  /** Cambia en cada petición para que Inicio la aplique aunque los datos se repitan. */
  nonce: number;
}

export function prefillFromJob(job: Pick<Job, 'url' | 'preset' | 'maxClips' | 'localFile' | 'creationMode' | 'split'>, action: 'change-url' | 'import-file', nonce = Date.now()): HomePrefill {
  return { url: job.localFile || job.url.startsWith('local:') ? '' : job.url, preset: job.preset, maxClips: job.maxClips, creationMode: job.creationMode ?? 'ai-highlights', boundaryMode: job.split?.boundaryMode ?? 'exact', pickFile: action === 'import-file', nonce };
}
