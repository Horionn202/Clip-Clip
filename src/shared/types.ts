// Tipos compartidos entre main, preload y renderer. Sin dependencias de Node.

export const MAX_CLIPS = 20;
export const DURATION_PRESETS = [15, 30, 45, 60] as const;
export type DurationPreset = (typeof DURATION_PRESETS)[number];

export const JOB_STATUSES = [
  'queued',
  'validating',
  'downloading',
  'extractingAudio',
  'transcribing',
  'analyzing',
  'rendering',
  'completed',
  'cancelled',
  'failed',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const TERMINAL_STATUSES: readonly JobStatus[] = ['completed', 'cancelled', 'failed'];

export const STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'En cola',
  validating: 'Validando',
  downloading: 'Descargando',
  extractingAudio: 'Extrayendo audio',
  transcribing: 'Transcribiendo',
  analyzing: 'Analizando con IA',
  rendering: 'Renderizando clips',
  completed: 'Completado',
  cancelled: 'Cancelado',
  failed: 'Error',
};

export interface Clip {
  id: string;
  index: number;
  start: number;
  end: number;
  title: string;
  hook: string;
  reason: string;
  score: number;
  /** Nombre de archivo relativo a la carpeta de clips del trabajo. */
  file?: string;
  exportedPath?: string;
}

export interface Job {
  id: string;
  url: string;
  preset: DurationPreset;
  maxClips: number;
  status: JobStatus;
  progress: number; // 0..1 dentro de la etapa actual
  message: string;
  error?: string;
  sourceTitle?: string;
  sourceDuration?: number;
  clips: Clip[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateJobRequest {
  url: string;
  preset: DurationPreset;
  maxClips: number;
  rightsConfirmed: boolean;
}

export interface Settings {
  ollamaHost: string;
  ollamaModel: string;
  whisperModel: string;
  whisperLanguage: string; // '' = autodetectar
  exportDir: string;
  ffmpegPath: string; // '' = autodetectar
  ffprobePath: string;
  ytDlpPath: string;
  whisperPath: string;
  deleteSourceAfterCompletion: boolean;
  deleteTempAfterCompletion: boolean;
  maxConcurrentJobs: number;
  maxSourceMinutes: number;
  maxDownloadMB: number;
  minFreeDiskMB: number;
  cropOffsetX: number; // -1 (izquierda) .. 1 (derecha), 0 = centro
  subtitleFontSize: number;
  onboardingDone: boolean;
}

export type DepId = 'ffmpeg' | 'ffprobe' | 'ytDlp' | 'whisper' | 'ollamaInstalled' | 'ollamaService' | 'ollamaModel';

export interface DepStatus {
  id: DepId;
  label: string;
  ok: boolean;
  detail: string;
  /** Instrucciones accionables si falla. */
  help?: string;
}

export interface Diagnostics {
  ok: boolean;
  checkedAt: string;
  items: DepStatus[];
}

export interface ModelOption {
  name: string;
  sizeLabel: string;
  note: string;
}

export const OLLAMA_MODEL_OPTIONS: ModelOption[] = [
  { name: 'llama3.2:3b', sizeLabel: '≈ 2,0 GB', note: 'Rápido, recomendado para equipos modestos' },
  { name: 'gemma3:4b', sizeLabel: '≈ 3,3 GB', note: 'Buen equilibrio calidad/velocidad' },
  { name: 'qwen2.5:7b', sizeLabel: '≈ 4,7 GB', note: 'Mejor comprensión, multilingüe' },
  { name: 'llama3.1:8b', sizeLabel: '≈ 4,9 GB', note: 'Mayor calidad, requiere ~8 GB RAM libre' },
];

export const WHISPER_MODEL_OPTIONS: ModelOption[] = [
  { name: 'tiny', sizeLabel: '≈ 75 MB', note: 'Muy rápido, menor precisión' },
  { name: 'base', sizeLabel: '≈ 145 MB', note: 'Rápido' },
  { name: 'small', sizeLabel: '≈ 465 MB', note: 'Recomendado' },
  { name: 'medium', sizeLabel: '≈ 1,5 GB', note: 'Preciso, lento sin GPU' },
  { name: 'turbo', sizeLabel: '≈ 1,6 GB', note: 'Preciso y rápido con GPU' },
];

export interface PullProgress {
  model: string;
  status: string;
  completed?: number;
  total?: number;
  done: boolean;
  error?: string;
}

/** API expuesta por el preload en window.clipsApi. */
export interface ClipsApi {
  checkDeps(): Promise<Diagnostics>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  chooseExportDir(): Promise<string | null>;
  listOllamaModels(): Promise<string[]>;
  pullOllamaModel(name: string): Promise<void>;
  createJob(req: CreateJobRequest): Promise<Job>;
  listJobs(): Promise<Job[]>;
  cancelJob(id: string): Promise<void>;
  deleteJob(id: string): Promise<boolean>;
  renameClip(jobId: string, clipId: string, title: string): Promise<Job>;
  exportClip(jobId: string, clipId: string): Promise<string>;
  exportAll(jobId: string): Promise<number>;
  openJobFolder(jobId: string): Promise<void>;
  openExportFolder(): Promise<void>;
  onJobUpdate(cb: (job: Job) => void): () => void;
  onPullProgress(cb: (p: PullProgress) => void): () => void;
}
