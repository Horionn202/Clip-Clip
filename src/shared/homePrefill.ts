// Qué conserva Inicio cuando un trabajo falla y el usuario elige «Cambiar URL» o «Importar archivo». Puro.
import type { DurationPreset, Job } from './types';

export interface HomePrefill {
  /** URL original (no se pierde al fallar). Vacía para un archivo local. */
  url: string;
  preset: DurationPreset;
  maxClips: number;
  /** Abrir el selector de archivos al llegar a Inicio. */
  pickFile: boolean;
  /** Cambia en cada petición para que Inicio la aplique aunque los datos se repitan. */
  nonce: number;
}

export function prefillFromJob(job: Pick<Job, 'url' | 'preset' | 'maxClips' | 'localFile'>, action: 'change-url' | 'import-file', nonce = Date.now()): HomePrefill {
  return { url: job.localFile || job.url.startsWith('local:') ? '' : job.url, preset: job.preset, maxClips: job.maxClips, pickFile: action === 'import-file', nonce };
}
