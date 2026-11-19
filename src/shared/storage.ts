// Gestión de almacenamiento: tipos, clasificación de archivos de un trabajo y formato. Puro.
import type { Job } from './types';

export type StorageCategory = 'source' | 'audio' | 'frames' | 'temp' | 'transcript' | 'internalClip' | 'other';

export const CATEGORY_LABELS: Record<StorageCategory | 'exports', string> = {
  source: 'Vídeo original descargado',
  audio: 'Audio WAV',
  frames: 'Fotogramas de análisis visual',
  temp: 'Subtítulos y temporales',
  transcript: 'Transcripción',
  internalClip: 'Clips internos',
  other: 'Otros archivos del trabajo',
  exports: 'Clips exportados (se conservan)',
};

/** Clasifica una ruta relativa a la carpeta del trabajo. */
export function classify(rel: string): StorageCategory {
  const r = rel.replace(/\\/g, '/');
  if (/^source\.(mp4|mkv|webm|mov)$/i.test(r)) return 'source';
  if (/^audio\.wav$/i.test(r)) return 'audio';
  if (/^frames\//i.test(r)) return 'frames';
  if (/^transcript\.json$/i.test(r)) return 'transcript';
  if (/^clips\/[^/]+\.part\.mp4$/i.test(r)) return 'temp';
  if (/^clips\/[^/]+\.mp4$/i.test(r)) return 'internalClip';
  if (/^clips\/[^/]+\.ass$/i.test(r) || /\.(gray|tmp)$/i.test(r) || /^audio\.json$/i.test(r) || /^salida\//i.test(r)) return 'temp';
  return 'other';
}

/** Estados de un trabajo en los que se puede limpiar (nunca en curso). */
export const CLEANABLE_STATUSES: readonly Job['status'][] = ['completed', 'failed', 'cancelled'];

export interface CleanupOptions {
  source: boolean;
  audio: boolean;
  frames: boolean;
  temp: boolean;
  transcript: boolean;
  /** Clips internos: sólo los que tienen un export verificado. */
  internalClips: boolean;
}

/** «Liberar espacio» por defecto: todo lo regenerable; transcripción opcional (desactivada). */
export const FREE_SPACE_DEFAULTS: CleanupOptions = { source: true, audio: true, frames: true, temp: true, transcript: false, internalClips: true };
/** «Limpiar temporales» de un trabajo: sólo temporales (nunca originales, clips ni exports). */
export const TEMP_ONLY: CleanupOptions = { source: false, audio: true, frames: true, temp: true, transcript: false, internalClips: false };

export interface PlannedFile {
  jobId: string;
  rel: string;
  category: StorageCategory;
  bytes: number;
}

export interface StorageReport {
  totalBytes: number;
  byCategory: Record<StorageCategory, number>;
  exportsBytes: number;
  recoverableBytes: number;
  jobsAffected: number;
  files: PlannedFile[];
  /** Trabajos excluidos por estar en curso. */
  skippedActive: number;
  freeDiskBytes?: number;
}

export interface CleanupResult {
  freedBytes: number;
  deleted: number;
  errors: { rel: string; jobId: string; message: string }[];
  jobs: string[];
  usedTrash: boolean;
}

export function humanSize(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
  if (b >= 1024 ** 2) return `${Math.round(b / 1024 ** 2)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}

export function confirmText(r: Pick<StorageReport, 'recoverableBytes'>): string {
  return `Se liberarán ${humanSize(r.recoverableBytes)}. Tus clips exportados se conservarán.`;
}

/** Políticas de conservación (Configuración → Almacenamiento). */
export type KeepSource = 'siempre' | 'hasta-exportar' | 'confirmar';
export type KeepTemp = 'siempre' | 'tras-completar' | 'tras-exportar';
