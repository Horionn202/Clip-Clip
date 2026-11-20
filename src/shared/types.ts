import type { BenchmarkResult, Placement } from './aiProfiles';
import type { CleanupOptions, CleanupResult, KeepSource, KeepTemp, StorageReport } from './storage';
import type { AccelStatus, SetupPlan, SetupState } from './gpuSetup';

export interface GpuSetupInfo {
  plan: SetupPlan;
  state: SetupState | null;
  status: AccelStatus;
  verifiedPython: string | null;
  currentPython: string | null;
  usingAppEnv: boolean;
  engine: EngineChoice;
}
import type { LayoutChoice, LayoutId, NormRect, VisualResult } from './layouts';
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
  /** Layout vertical aplicado (por defecto, gameplay completo). */
  layout?: LayoutId;
  /** Posición de la facecam (normalizada 0–1), detectada o ajustada a mano. */
  camRect?: NormRect;
  /** Resultado del análisis visual del clip (experimental). */
  visual?: VisualResult;
  /** Layout sugerido cuando no hubo confianza para aplicarlo automáticamente. */
  layoutSuggestion?: LayoutId;
  layoutReason?: string;
  /** Fotograma de referencia (frames/…) para el editor de facecam. */
  thumb?: string;
  /** Hay cambios sin renderizar (título, rango, hook o layout). */
  dirty?: boolean;
  /** Parámetros con los que se renderizó el MP4 actual (para saber si hay cambios pendientes de verdad). */
  rendered?: RenderedState;
  /** El export existe fuera de la carpeta de trabajos y coincide con el clip (requisito para borrar el interno). */
  exportVerified?: boolean;
  /** El clip interno se borró al liberar espacio; se usa el export. */
  archived?: boolean;
  /** Composición no destructiva (plantilla, cámara, zoom, aspecto). Ausente en clips antiguos: se deriva de layout/camRect. */
  composition?: Partial<import('./composition').ClipLayout>;
  /** Subtítulos editados a mano (tiempos relativos al clip). Ausente = automáticos desde las palabras. */
  subtitleCues?: import('./cues').Cue[];
  /** Fecha en que se envió a la Papelera el export tras publicarlo (se conserva toda la metadata). */
  exportDeletedAfterPublish?: string;
}

export interface PublishedExportInfo {
  jobId: string;
  clipId: string;
  title: string;
  path: string;
  name: string;
  bytes: number;
  platforms: import('./publish').Platform[];
}

/** Datos de la versión anterior («ClipsVirales») encontrados en el equipo. */
export interface LegacyItem {
  kind: 'data' | 'install' | 'exports';
  path: string;
  bytes: number;
}
export interface LegacyScan {
  found: boolean;
  items: LegacyItem[];
  totalBytes: number;
  /** El usuario eligió «Ignorar por ahora» (no se vuelve a mostrar el aviso automáticamente). */
  dismissed: boolean;
  migrated: boolean;
}
export interface LegacyMigrateResult {
  ok: boolean;
  migrated: { linked: number; copied: number; skippedExisting: number; mergedJobs: number };
  verified: boolean;
  trashed: { path: string; bytes: number }[];
  freedBytes: number;
  errors: string[];
}

export interface RenderedState {
  start: number;
  end: number;
  layout: LayoutId;
  camRect?: NormRect;
  /** Huella de la composición y de los subtítulos editados con los que se renderizó. */
  composition?: string;
  cues?: string;
}

export interface ClipPatch {
  title?: string;
  hook?: string;
  start?: number;
  end?: number;
  layout?: LayoutId;
  camRect?: NormRect | null;
  /** Composición completa (null = volver a la automática). */
  composition?: Partial<import('./composition').ClipLayout> | null;
  /** Subtítulos editados (null = volver a los automáticos). */
  subtitleCues?: import('./cues').Cue[] | null;
}

/** Motores de transcripción soportados. */
export const ENGINE_IDS = ['faster-whisper-cuda', 'openai-whisper-cuda', 'openai-whisper-cpu'] as const;
export type EngineId = (typeof ENGINE_IDS)[number];
export type EngineChoice = 'auto' | EngineId;
export const ENGINE_LABELS: Record<EngineId, string> = {
  'faster-whisper-cuda': 'faster-whisper · GPU (CUDA)',
  'openai-whisper-cuda': 'openai-whisper · GPU (CUDA)',
  'openai-whisper-cpu': 'openai-whisper · CPU',
};
export type Precision = 'auto' | 'fp16' | 'fp32';

export interface EnginePlan {
  engine: EngineId;
  device: 'cpu' | 'cuda';
  model: string;
  /** openai-whisper: fp16 true/false. faster-whisper: compute_type. */
  fp16: boolean;
  computeType?: string;
  warnings: string[];
}

export type MetricStage = 'validating' | 'downloading' | 'extractingAudio' | 'transcribing' | 'analyzing' | 'rendering';

export interface JobMetrics {
  stagesMs: Partial<Record<MetricStage, number>>;
  renderMsPerClip: number[];
  totalMs?: number;
  engine?: EngineId;
  device?: 'cpu' | 'cuda';
  whisperModel?: string;
  ollamaModel?: string;
  sourceDuration?: number;
  clipsFinal?: number;
  /** Segundos de audio procesados por segundo real (2 = 2× tiempo real). */
  transcribeSpeed?: number;
  /** Idioma pedido a Whisper ('auto' = autodetección) y el que devolvió el motor. */
  languageRequested?: string;
  languageDetected?: string;
  /** La transcripción trae tiempos por palabra (necesarios para el karaoke). */
  wordTimestamps?: boolean;
  /** Última transcripción hecha en modo preciso. */
  preciseTranscription?: boolean;
  modelDownloadMs?: number;
  /** Cada intento de transcripción (incluidos los reintentos) con su resultado. */
  transcribeAttempts?: TranscribeAttempt[];
  /** VRAM libre justo antes del análisis con Ollama. */
  vramFreeBeforeAnalysisMB?: number;
  /** Dónde quedó cargado el modelo de Ollama durante el análisis (según /api/ps). */
  ollamaPlacement?: Placement;
}

export interface TranscribeAttempt {
  engine: EngineId;
  model: string;
  device: 'cpu' | 'cuda';
  precision: string;
  exitCode: number | null;
  ok: boolean;
  reason?: string;
  ms: number;
}

export interface AnalysisRound {
  round: number;
  requested: number;
  received: number;
  accepted: number;
  rejected: Record<string, number>;
  failed?: boolean;
}

export interface AnalysisReport {
  /** Meta pedida por el usuario (1–20). */
  target: number;
  /** Máximo matemático sin solapes = floor(duración / preset), con tope 20. */
  feasibleMax: number;
  /** min(meta, 20, máximo factible). */
  effectiveTarget: number;
  rounds: AnalysisRound[];
  candidates: number;
  rejected: number;
  obtained: number;
  partialReason?: string;
}

export interface Job {
  id: string;
  url: string;
  preset: DurationPreset;
  /** Meta de clips elegida por el usuario (1–20). Es un máximo, no una garantía. */
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
  allowModelDownload?: boolean;
  /** Dimensiones del vídeo de origen (para re-render y vista previa). */
  sourceVideo?: { width: number; height: number };
  /** Estado de limpieza de almacenamiento (todo opcional: los trabajos antiguos no lo tienen). */
  sourceCleaned?: boolean;
  tempCleaned?: boolean;
  internalClipsCleaned?: boolean;
  /** Archivado: sólo quedan los clips exportados. */
  archivedExportsOnly?: boolean;
  lastCleanupAt?: string;
  bytesFreed?: number;
  metrics?: JobMetrics;
  analysis?: AnalysisReport;
  engine?: EnginePlan;
  /** Resumen final legible, p. ej. «5/5 clips generados». */
  resultSummary?: string;
  /** Subestado de la fase actual (p. ej. 'downloadingModel', 'loadingModel'). */
  detail?: TranscribeProgress;
  /** Momento en que empezó la etapa actual (para tiempo transcurrido y ETA en la UI). */
  stageStartedAt?: string;
  /** Última etapa en la que entró (se conserva al fallar: «Reintentar desde este paso»). */
  stage?: MetricStage;
  /** Material reutilizado de un trabajo anterior (reintento desde un paso). */
  reuse?: ('source' | 'audio' | 'transcript' | 'clips')[];
  resumedFrom?: string;
  /** Vídeo local ya descargado (bloques de un directo): no se usa yt-dlp. */
  localSource?: string;
  /** Bloque de un monitor de directo. */
  live?: { monitorId: string; block: number; offsetSec: number };
}

export interface TranscribeProgress {
  phase: 'loadingModel' | 'downloadingModel' | 'transcribing';
  audioDoneSec: number;
  audioTotalSec: number;
  elapsedSec: number;
  speed?: number;
  etaSec?: number;
  device: 'cpu' | 'cuda';
}

export interface CreateJobRequest {
  url: string;
  preset: DurationPreset;
  maxClips: number;
  rightsConfirmed: boolean;
  /** Permite descargar el modelo de Whisper si no está en caché (confirmación explícita). */
  allowModelDownload?: boolean;
}

export interface UrlProbe {
  title: string;
  duration: number;
  feasibleMax: number;
  /** Tamaño aproximado de la descarga, si la fuente lo informa. */
  filesizeBytes?: number;
}

export interface GpuInfo {
  nvidiaGpu: string | null;
  vramMB: number | null;
  /** VRAM libre en el momento del diagnóstico (nvidia-smi). */
  vramFreeMB?: number | null;
  ramTotalMB?: number;
  driver: string | null;
  python: string | null;
  pythonPath: string | null;
  torch: string | null;
  torchCuda: string | null;
  /** Torch puede usar CUDA de verdad (no basta con que exista una GPU NVIDIA). */
  cudaAvailable: boolean;
  torchCpuOnly: boolean;
  whisperInstalled: boolean;
  fasterWhisper: string | null;
  ctranslate2Cuda: boolean;
  cachedModels: { openai: string[]; faster: string[] };
  plan: EnginePlan | null;
  recommendation: string;
  installCommands: string[];
  probeError?: string;
}

export interface Settings {
  ollamaHost: string;
  ollamaModel: string;
  whisperModel: string;
  /** Código ISO ('es' por defecto). 'auto' = autodetectar, sólo si el usuario lo elige. '' (ajustes antiguos) se migra a 'es'. */
  whisperLanguage: string;
  exportDir: string;
  ffmpegPath: string; // '' = autodetectar
  ffprobePath: string;
  ytDlpPath: string;
  whisperPath: string;
  pythonPath: string; // '' = autodetectar (junto a whisper.exe o en PATH)
  transcriptionEngine: EngineChoice;
  whisperPrecision: Precision;
  /** @deprecated sustituido por keepSource/keepTemp; se conserva sólo para migrar ajustes antiguos. */
  deleteSourceAfterCompletion?: boolean;
  /** @deprecated sustituido por keepTemp. */
  deleteTempAfterCompletion?: boolean;
  /** Vídeo original: siempre / hasta exportar (se borra al verificar todos los exports) / sólo con confirmación. */
  keepSource: KeepSource;
  /** Temporales (audio WAV, subtítulos, fotogramas): siempre / tras completar / tras exportar. */
  keepTemp: KeepTemp;
  keepTranscript: boolean;
  /** Enviar a la Papelera el MP4 exportado al marcar el clip como publicado (desactivado por defecto). */
  deleteExportsAfterPublish?: boolean;
  /** Limpieza automática de trabajos completados tras N días (0 = desactivada). */
  autoCleanupDays: number;
  maxConcurrentJobs: number;
  maxSourceMinutes: number;
  maxDownloadMB: number;
  minFreeDiskMB: number;
  cropOffsetX: number; // -1 (izquierda) .. 1 (derecha), 0 = centro
  /** Layout por defecto de los clips: «auto» usa el análisis visual con fallback seguro. */
  defaultLayout: LayoutChoice;
  subtitleFontSize: number;
  /** «karaoke»: resalta sólo la palabra que se está diciendo. */
  subtitleStyle: 'standard' | 'karaoke';
  /** Color de la palabra activa en karaoke (#RRGGBB). */
  subtitleActiveColor: string;
  onboardingDone: boolean;
  /** Resultados del benchmark local por modelo (sólo los escribe el proceso principal). */
  benchmarks?: Record<string, BenchmarkResult>;
  /** Python con el que se verificó CUDA mediante una transcripción real (sólo lo escribe el proceso principal). */
  gpuVerifiedPython?: string;
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
  gpu?: GpuInfo;
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
  { name: 'base', sizeLabel: '≈ 145 MB', note: 'CPU: recomendado (equilibrio)' },
  { name: 'small', sizeLabel: '≈ 465 MB', note: 'CPU: más preciso, más lento' },
  { name: 'medium', sizeLabel: '≈ 1,5 GB', note: 'Preciso; lento sin GPU' },
  { name: 'large', sizeLabel: '≈ 2,9 GB', note: 'Máxima precisión; requiere GPU con mucha VRAM' },
  { name: 'turbo', sizeLabel: '≈ 1,6 GB', note: 'GPU CUDA: recomendado (velocidad)' },
];

export const CLIP_TARGET_PRESETS = [
  { label: 'Rápido', value: 5 },
  { label: 'Estándar', value: 10 },
  { label: 'Máximo', value: 20 },
] as const;

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
  // Publicar (local; sin subida real)
  getPublish(jobId: string): Promise<Record<string, import('./publish').ClipPublish>>;
  generatePublish(jobId: string, clipId: string, opts?: { tone?: string; niche?: string }): Promise<{ ok: boolean; reason?: 'contexto' | 'invalido'; issues?: string[]; repaired?: boolean; data: Record<string, import('./publish').ClipPublish> }>;
  savePublish(jobId: string, clipId: string, platform: import('./publish').Platform, meta: import('./publish').PublishMeta): Promise<Record<string, import('./publish').ClipPublish>>;
  restorePublish(jobId: string, clipId: string, platform: import('./publish').Platform, index: number): Promise<Record<string, import('./publish').ClipPublish>>;
  setPublishStatus(jobId: string, clipId: string, platform: import('./publish').Platform, status: import('./publish').PublishStatus, url?: string): Promise<Record<string, import('./publish').ClipPublish>>;
  copyPublish(jobId: string, clipId: string, platform: import('./publish').Platform, part?: import('./publish').CopyPart): Promise<boolean>;
  revealClipVideo(jobId: string, clipId: string): Promise<boolean>;
  publishConnections(): Promise<import('./publish').ConnectionInfo[]>;
  onPublishUpdate(cb: (u: { jobId: string; data: Record<string, import('./publish').ClipPublish> }) => void): () => void;
  checkDeps(): Promise<Diagnostics>;
  analyzeStorage(opts?: CleanupOptions, jobId?: string): Promise<StorageReport>;
  cleanStorage(opts: CleanupOptions, jobId?: string): Promise<CleanupResult>;
  startupNotice(): Promise<{ kind: 'info' | 'error'; text: string } | null>;
  probeUrl(url: string): Promise<UrlProbe>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  chooseExportDir(): Promise<string | null>;
  listOllamaModels(): Promise<string[]>;
  pullOllamaModel(name: string): Promise<void>;
  cancelOllamaPull(): Promise<void>;
  benchmarkModel(name: string): Promise<BenchmarkResult>;
  gpuSetupInfo(): Promise<GpuSetupInfo>;
  startGpuSetup(mode: 'install' | 'verify'): Promise<void>;
  cancelGpuSetup(): Promise<void>;
  useCpuEngine(): Promise<void>;
  useSystemPython(): Promise<void>;
  onGpuSetup(cb: (s: SetupState) => void): () => void;
  createJob(req: CreateJobRequest): Promise<Job>;
  listJobs(): Promise<Job[]>;
  cancelJob(id: string): Promise<void>;
  retryJob(id: string): Promise<Job>;
  /** Reintenta desde un paso reutilizando lo producido antes (vídeo, audio, transcripción). */
  retryJobFrom(id: string, stage: MetricStage): Promise<Job>;
  retryOptions(id: string): Promise<Record<string, import('./jobView').RetryOption>>;
  liveList(): Promise<{ ack: boolean; monitors: import('./live').LiveMonitor[] }>;
  liveCreate(url: string, settings: Partial<import('./live').LiveSettings>, acknowledged: boolean): Promise<import('./live').LiveMonitor>;
  livePause(id: string): Promise<import('./live').LiveMonitor>;
  liveResume(id: string): Promise<import('./live').LiveMonitor>;
  liveStop(id: string): Promise<import('./live').LiveMonitor>;
  liveRemove(id: string): Promise<void>;
  liveRetryBlock(id: string, index: number): Promise<import('./live').LiveMonitor>;
  onLiveUpdate(cb: (m: import('./live').LiveMonitor) => void): () => void;
  /** Vuelve a transcribir un trabajo terminado sin descargar ni analizar de nuevo. */
  retranscribeJob(id: string, opts?: { precise?: boolean }): Promise<Job>;
  bulkPlan(ids: string[], opts: import('./bulk').BulkOptions): Promise<import('./bulk').BulkPlan>;
  bulkDelete(ids: string[], opts: import('./bulk').BulkOptions, typed?: string): Promise<import('./bulk').BulkResult>;
  bulkUndo(batchId: string): Promise<{ restored: number; pending: number }>;
  deleteJob(id: string): Promise<boolean>;
  renameClip(jobId: string, clipId: string, title: string): Promise<Job>;
  updateClip(jobId: string, clipId: string, patch: ClipPatch): Promise<Job>;
  rerenderClip(jobId: string, clipId: string): Promise<Job>;
  previewLayout(jobId: string, clipId: string, layout: LayoutId, camRect: NormRect | null, range?: { start: number; end: number } | null, composition?: Partial<import('./composition').ClipLayout> | null): Promise<string>;
  /** Palabras de la transcripción en el tramo del clip (para el editor de subtítulos). */
  clipWords(jobId: string, clipId: string, range?: { start: number; end: number } | null): Promise<{ start: number; end: number; text: string }[]>;
  exportClip(jobId: string, clipId: string): Promise<string>;
  exportAll(jobId: string): Promise<number>;
  listPublishedExports(platforms?: import('./publish').Platform[], jobId?: string, clipId?: string): Promise<{ items: PublishedExportInfo[]; totalBytes: number }>;
  deletePublishedExports(items: { jobId: string; clipId: string }[]): Promise<{ deleted: number; freedBytes: number; errors: { clipId: string; message: string }[] }>;
  legacyScan(): Promise<LegacyScan>;
  legacyMigrate(mode: 'keep' | 'free'): Promise<LegacyMigrateResult>;
  legacyDismiss(): Promise<void>;
  appVersion(): Promise<{ version: string; name: string }>;
  openJobFolder(jobId: string): Promise<void>;
  openExportFolder(): Promise<void>;
  onJobUpdate(cb: (job: Job) => void): () => void;
  onPullProgress(cb: (p: PullProgress) => void): () => void;
}
