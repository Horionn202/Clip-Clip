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
export const DURATION_PRESETS = [15, 30, 45, 60, 90, 120] as const;
export type DurationPreset = (typeof DURATION_PRESETS)[number];
/** Duración máxima absoluta de un clip (s). */
export const MAX_CLIP_SEC = 120;
/** A partir de esta duración un clip se considera «largo»: más contexto, más render y más espacio. */
export const LONG_CLIP_SEC = 90;

export function isDurationPreset(v: unknown): v is DurationPreset {
  return typeof v === 'number' && (DURATION_PRESETS as readonly number[]).includes(v);
}

/** Etiqueta del botón: «2 min» en vez de «120 s». */
export function presetLabel(p: DurationPreset): string {
  return p === 120 ? '2 min' : `${p} s`;
}

/** Duración legible de un clip: «45 s», «1 min», «1 min 30 s», «2 min». */
export function clipLengthLabel(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${Math.round(sec * 10) / 10} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

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
  /** Por qué se eligió (categoría, puntuación editorial, relación con el tema). Ausente en clips antiguos. */
  editorial?: ClipEditorial;
}

/** Tipo de evento según el verificador de destacados. */
export type HighlightEvent =
  | 'introduccion'
  | 'preparacion'
  | 'desplazamiento'
  | 'llegada'
  | 'contexto'
  | 'inicio_real'
  | 'accion_activa'
  | 'choque_accion'
  | 'resultado'
  | 'reaccion'
  | 'revelacion'
  | 'explicacion'
  | 'humor';

/** Prueba de un destacado: la cita existe en la transcripción, al principio del clip. */
export interface HighlightVerification {
  model: string;
  confidence: number;
  eventType: HighlightEvent;
  /** Cita tal como está en la transcripción. */
  quote: string;
  /** Segundo real de la cita en el vídeo (localizado en la transcripción, no el que diga la IA). */
  evidenceStart: number;
  evidenceEnd: number;
  /** Tramo con todo lo que respalda el título (la cita y las frases de inicio, resultado o choque). Recortarlo quita la estrella. */
  supportStart?: number;
  supportEnd?: number;
}

/** Criterios editoriales con los que se eligió un clip (0–100). */
export interface ClipEditorial {
  score: number;
  /** En la selección: aspira a destacado. En un trabajo terminado: destacado, válido sólo con `verification`. */
  featured?: boolean;
  verification?: HighlightVerification;
  /** Por qué un aspirante se quedó como «Otro momento». */
  notVerified?: string;
  topicRelevance: number;
  hookStrength: number;
  payoffStrength: number;
  selfContained: number;
  momentType?: import('./editorialBrief').MomentType;
  why: string;
  /** Añadido por la app sin valoración de la IA: no se muestra su puntuación. */
  auto?: boolean;
  /** El inicio se movió a la frase gancho real. */
  aligned?: boolean;
}

/** Diagnóstico del ranking: cada candidato válido y si entró o no. */
export interface RankingEntry {
  start: number;
  end: number;
  title: string;
  score: number;
  topicRelevance?: number;
  momentType?: import('./editorialBrief').MomentType;
  featured?: boolean;
  accepted: boolean;
  /** Motivo de descarte (si no entró). */
  reason?: string;
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
/** Estado de la migración (se guarda en el marcador; su mera existencia ya no significa «terminada»). */
export type MigrationState = 'none' | 'completed' | 'partial' | 'needs_repair' | 'repaired' | 'verified' | 'legacy_trashed';
export type MissingCategory = 'source' | 'audio' | 'internalClip' | 'frames' | 'transcript' | 'data';
export const MISSING_LABELS: Record<MissingCategory, string> = {
  source: 'Vídeos fuente',
  audio: 'Audio',
  internalClip: 'Clips internos',
  frames: 'Frames',
  transcript: 'Transcripciones',
  data: 'Datos y configuración',
};
/** Diagnóstico completo de la versión anterior para el modal y el centro de almacenamiento. */
export interface LegacyCheck {
  state: MigrationState;
  data?: { path: string; bytes: number };
  install?: { path: string; bytes: number; freeableBytes: number; keptInUse: string[] };
  exports?: { path: string; bytes: number };
  /** Archivos que faltan en Clip Clip y se necesitan (rutas relativas, máx. 500). */
  missing: { rel: string; category: MissingCategory }[];
  missingTotal: number;
  byCategory: Record<MissingCategory, number>;
  /** Archivos que ya no están en Clip Clip porque se borraron a propósito allí (trabajos eliminados o espacio liberado). */
  intentional: number;
  /** Carpetas que no se pudieron leer (permisos…). */
  readErrors: string[];
  /** Se puede enviar la carpeta de datos antigua a la Papelera (todo verificado). */
  canFreeData: boolean;
  /** Bytes que se liberarían enviando la carpeta de datos (sin lo que esté en uso). */
  dataFreeableBytes: number;
}
export interface LegacyRepairResult {
  linked: number;
  copied: number;
  /** Bytes añadidos al disco al copiar (los enlaces no ocupan más). */
  copiedBytes: number;
  skippedExisting: number;
  errors: string[];
  check: LegacyCheck;
}
export interface LegacyFreeResult {
  target: 'data' | 'install' | 'exports';
  trashed: { path: string; bytes: number }[];
  freedBytes: number;
  kept: string[];
  errors: string[];
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
  /** Brief editorial (tema, eventos, promesa del título) usado en todas las rondas. */
  brief?: import('./editorialBrief').EditorialBrief;
  /** Puntuación mínima para aspirar a destacado (0–100). */
  minScore?: number;
  /** Destacados verificados. */
  featured?: number;
  /** Fase B: qué modelo verificó y por qué cayó cada aspirante. */
  verification?: { model: string; checked: number; rejected: { start: number; title: string; reason: string }[] };
  /** «Otros momentos» que añadió la app porque la IA no propuso suficientes. */
  added?: number;
  quality?: import('./editorialBrief').SelectionQuality;
  /** Candidatos válidos ordenados, con el motivo de los que no entraron (para diagnóstico). */
  ranking?: RankingEntry[];
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
  /** Descripción del vídeo de origen (contexto editorial para la IA). */
  sourceDescription?: string;
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
  /** Vídeo local ya en disco (bloques de un directo o archivo importado): no se usa yt-dlp. */
  localSource?: string;
  /** Archivo importado por el usuario desde su equipo (no un bloque de directo). */
  localFile?: boolean;
  /** Por qué falló la lectura o descarga del vídeo (tipo, versión de yt-dlp, intentos). */
  sourceFailure?: import('./sourceErrors').SourceFailure;
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

/** Resultado de «Comprobar vídeo»: la info o, si yt-dlp falló, su diagnóstico (para el modal de error). */
export type UrlProbeResult = ({ ok: true } & UrlProbe) | { ok: false; message: string; failure?: import('./sourceErrors').SourceFailure };

/** Vídeo elegido en el equipo. El proceso principal guarda la ruta; el renderer sólo recibe un token. */
export interface LocalVideoChoice {
  token: string;
  name: string;
  title: string;
  duration: number;
  sizeBytes: number;
}

export interface CreateLocalJobRequest {
  token: string;
  preset: DurationPreset;
  maxClips: number;
  rightsConfirmed: boolean;
  allowModelDownload?: boolean;
}

export interface YtDlpUpdateInfo {
  installed?: string;
  latest: string;
  publishedAt?: string;
  notesUrl: string;
  updateAvailable: boolean;
  /** Ruta del yt-dlp en uso. */
  path?: string;
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
  /** Profundidad de la búsqueda de momentos (no cambia el modelo). */
  selectionQuality?: import('./editorialBrief').SelectionQuality;
  /** Puntuación editorial mínima para renderizar un clip (0–100). */
  minClipScore?: number;
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
  /** Límite de temporales por directo (MB): al llegar se libera lo procesado y, si no basta, se pausa. */
  liveTempLimitMB: number;
  /** Limpiar los temporales de los directos al terminar o detenerse (según su retención). */
  autoCleanLiveTemps: boolean;
  cropOffsetX: number; // -1 (izquierda) .. 1 (derecha), 0 = centro
  /** Layout por defecto de los clips: «auto» usa el análisis visual con fallback seguro. */
  defaultLayout: LayoutChoice;
  subtitleFontSize: number;
  /** «karaoke»: resalta sólo la palabra que se está diciendo. */
  subtitleStyle: 'standard' | 'karaoke';
  /** Color de la palabra activa en karaoke (#RRGGBB). */
  subtitleActiveColor: string;
  /** Centro vertical de los subtítulos en % (0 = automático: en la separación cámara/gameplay). */
  subtitlePositionY: number;
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
  probeUrl(url: string): Promise<UrlProbeResult>;
  /** Abre el selector de archivos (MP4, MOV, MKV, WebM). null si se cancela. */
  chooseLocalVideo(): Promise<LocalVideoChoice | null>;
  createLocalJob(req: CreateLocalJobRequest): Promise<Job>;
  checkYtDlpUpdate(): Promise<YtDlpUpdateInfo>;
  /** Descarga del repositorio oficial, verifica el hash y la usa. Devuelve la versión instalada. */
  installYtDlpUpdate(): Promise<string>;
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
  liveRemove(id: string): Promise<{ freedBytes: number; clips: number }>;
  liveFreeTemps(id?: string): Promise<number>;
  cacheSize(): Promise<number>;
  clearCache(): Promise<number>;
  liveUsage(): Promise<{ id: string; title: string; active: boolean; bytes: number; clips: number }[]>;
  liveRetryBlock(id: string, index: number): Promise<import('./live').LiveMonitor>;
  onLiveUpdate(cb: (m: import('./live').LiveMonitor) => void): () => void;
  /** Vuelve a transcribir un trabajo terminado sin descargar ni analizar de nuevo. */
  retranscribeJob(id: string, opts?: { precise?: boolean }): Promise<Job>;
  bulkPlan(ids: string[], opts: import('./bulk').BulkOptions): Promise<import('./bulk').BulkPlan>;
  bulkDelete(ids: string[], opts: import('./bulk').BulkOptions, typed?: string): Promise<import('./bulk').BulkResult & { locked: string[] }>;
  /** Si quedan pendientes, `undoUntil` es el nuevo plazo y el aviso con «Deshacer» debe renovarse. */
  bulkUndo(batchId: string): Promise<{ restored: number; pending: number; undoUntil?: string; message?: string }>;
  deleteJob(id: string): Promise<boolean>;
  clipsDeletePlan(jobId: string, ids: string[], opts: import('./bulk').BulkOptions): Promise<import('./bulk').ClipPlan>;
  clipsDelete(jobId: string, ids: string[], opts: import('./bulk').BulkOptions): Promise<import('./bulk').BulkResult & { locked: string[]; wholeJob: boolean }>;
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
  legacyCheck(): Promise<LegacyCheck>;
  legacyRepair(): Promise<LegacyRepairResult>;
  legacyFree(target: 'data' | 'install' | 'exports'): Promise<LegacyFreeResult>;
  legacyOpen(kind: 'data' | 'install' | 'exports'): Promise<void>;
  appVersion(): Promise<{ version: string; name: string }>;
  openJobFolder(jobId: string): Promise<void>;
  openExportFolder(): Promise<void>;
  onJobUpdate(cb: (job: Job) => void): () => void;
  onPullProgress(cb: (p: PullProgress) => void): () => void;
}
