// Lectura de metadatos con yt-dlp y archivos locales. Compartido por pipeline e IPC.
// Ante el bloqueo anti-bot sólo se reintenta de forma limitada (máx. 3 intentos con espera creciente) y con los
// clientes ya soportados: sin cookies, cuentas, proxies ni técnicas de evasión.
import fs from 'node:fs';
import path from 'node:path';
import type { Settings } from '../shared/types';
import { UserFacingError } from '../shared/validation';
import { BOT_RETRY_PLAN, classifySourceError, describeSourceError, technicalTail, type SourceFailure } from '../shared/sourceErrors';
import { CancelledError, runProcess } from './proc';
import { ytDlpVersion } from './ytdlp';

export interface SourceInfo {
  title: string;
  /** Descripción (contexto editorial para la IA), recortada. */
  description?: string;
  duration: number;
  filesize?: number;
  clientArgs: string[];
}

/** Fallo de yt-dlp con su diagnóstico (tipo, versión, intentos). */
export class SourceError extends UserFacingError {
  constructor(public readonly failure: SourceFailure) {
    const d = describeSourceError(failure);
    super(`${d.title}. ${d.message}`, failure.technical);
    this.name = 'SourceError';
  }
}

export interface SourceDeps {
  run?: typeof runProcess;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  version?: (ytDlp: string) => Promise<string | undefined>;
}

const sleepFor = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new CancelledError())), { once: true });
  });

/**
 * Ejecuta una orden de yt-dlp; si YouTube pide verificar que no eres un bot, reintenta según `BOT_RETRY_PLAN`.
 * Cualquier otro fallo se diagnostica al momento (sin reintentos). Devuelve la salida y el cliente que funcionó.
 */
export async function withBotRetries(
  ytDlp: string,
  attempt: (clientArgs: string[]) => Promise<{ code: number; stdout: string; stderr: string }>,
  o: { signal?: AbortSignal; onRetry?: (attempt: number, of: number) => void; from?: number } & SourceDeps = {},
): Promise<{ stdout: string; clientArgs: string[] }> {
  const plan = BOT_RETRY_PLAN.slice(o.from ?? 0);
  let last = { code: 1, stdout: '', stderr: '' };
  let tries = 0;
  for (const [i, step] of plan.entries()) {
    if (i > 0) {
      o.onRetry?.(i + 1, plan.length);
      await (o.sleep ?? sleepFor)(step.waitMs, o.signal);
    }
    tries++;
    last = await attempt(step.clientArgs);
    if (last.code === 0) return { stdout: last.stdout, clientArgs: step.clientArgs };
    if (classifySourceError(last.stderr) !== 'bot') break;
  }
  const version = await (o.version ?? ytDlpVersion)(ytDlp).catch(() => undefined);
  throw new SourceError({ kind: classifySourceError(last.stderr), ytDlpVersion: version, attempts: tries, technical: technicalTail(last.stderr), at: new Date().toISOString() });
}

/**
 * Para reintentar una orden que ya se ejecutó: la primera llamada devuelve ese resultado (no se repite) y las
 * siguientes ejecutan de verdad.
 */
export function reuseFirst<R>(first: R, run: (clientArgs: string[]) => Promise<R>): (clientArgs: string[]) => Promise<R> {
  let used = false;
  return (clientArgs) => {
    if (used) return run(clientArgs);
    used = true;
    return Promise.resolve(first);
  };
}

const BLOCKED_AVAILABILITY = new Set(['premium_only', 'subscriber_only', 'needs_auth']);

export async function readSourceInfo(
  ytDlp: string,
  url: string,
  s: Pick<Settings, 'maxSourceMinutes' | 'maxDownloadMB'>,
  signal?: AbortSignal,
  onRetry?: (attempt: number, of: number) => void,
  deps: SourceDeps = {},
): Promise<SourceInfo> {
  const run = deps.run ?? runProcess;
  const { stdout, clientArgs } = await withBotRetries(
    ytDlp,
    (extra) => run(ytDlp, ['--dump-single-json', '--no-playlist', '--no-warnings', ...extra, '--', url], { signal, timeoutMs: 90_000 }),
    { signal, onRetry, ...deps },
  );
  let info: { title?: string; description?: string; duration?: number; is_live?: boolean; availability?: string; filesize_approx?: number; filesize?: number };
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new UserFacingError('yt-dlp devolvió información no válida.');
  }
  if (info.is_live) throw new UserFacingError('No se admiten emisiones en directo.');
  if (info.availability && BLOCKED_AVAILABILITY.has(info.availability)) {
    throw new UserFacingError('El vídeo requiere inicio de sesión o suscripción; la app sólo procesa contenido público y autorizado.');
  }
  if (!info.duration || info.duration <= 0) throw new UserFacingError('No se pudo determinar la duración del vídeo.');
  if (info.duration > s.maxSourceMinutes * 60) {
    throw new UserFacingError(`El vídeo dura más de ${s.maxSourceMinutes} minutos (límite configurable en Configuración).`);
  }
  const approx = info.filesize ?? info.filesize_approx;
  if (approx && approx / (1024 * 1024) > s.maxDownloadMB) {
    throw new UserFacingError(`El vídeo supera el tamaño máximo de descarga (${s.maxDownloadMB} MB).`);
  }
  return { title: (info.title ?? '').slice(0, 200), description: typeof info.description === 'string' ? info.description.slice(0, 2000) : undefined, duration: info.duration, filesize: approx, clientArgs };
}

// ---- Archivo local ----

/** Entradas de ffprobe para medir la imagen tal como se ve (incluida la rotación de los vídeos de móvil). */
export const PROBE_DISPLAY_ENTRIES = 'stream=codec_type,width,height:stream_tags=rotate:stream_side_data=rotation:format=duration';

export interface ProbedStream {
  codec_type?: string;
  width?: number;
  height?: number;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number | string }[];
}

/**
 * Dimensiones como se ven. FFmpeg aplica la rotación al filtrar (autorrotación por defecto), así que con 90° o 270°
 * hay que intercambiar ancho y alto o los recortes del render no casan con la imagen.
 */
export function displaySize(s: ProbedStream): { width: number; height: number } {
  const w = s.width ?? 0;
  const h = s.height ?? 0;
  const raw = s.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? s.tags?.rotate ?? 0;
  const rot = ((Math.round(Number(raw) || 0) % 360) + 360) % 360;
  return rot === 90 || rot === 270 ? { width: h, height: w } : { width: w, height: h };
}

export const LOCAL_VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm'];

export interface LocalVideo {
  path: string;
  name: string;
  title: string;
  duration: number;
  sizeBytes: number;
  width: number;
  height: number;
}

/** Comprueba con ffprobe que el archivo es un vídeo con imagen, sonido y duración dentro del límite. */
export async function probeLocalVideo(ffprobe: string, file: string, s: Pick<Settings, 'maxSourceMinutes'>, run = runProcess): Promise<LocalVideo> {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!LOCAL_VIDEO_EXTENSIONS.includes(ext)) throw new UserFacingError('Formato no admitido: elige un vídeo MP4, MOV, MKV o WebM.');
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    throw new UserFacingError('No se encuentra el archivo seleccionado.');
  }
  if (!st.isFile() || st.size === 0) throw new UserFacingError('El archivo seleccionado está vacío o no es un archivo.');
  const r = await run(ffprobe, ['-v', 'error', '-show_entries', PROBE_DISPLAY_ENTRIES, '-of', 'json', file], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new UserFacingError('No se pudo leer el vídeo: el archivo puede estar dañado o en un formato no compatible.', technicalTail(r.stderr));
  let data: { streams?: ProbedStream[]; format?: { duration?: string } };
  try {
    data = JSON.parse(r.stdout);
  } catch {
    throw new UserFacingError('No se pudo leer la información del vídeo.');
  }
  const video = data.streams?.find((x) => x.codec_type === 'video' && x.width && x.height);
  if (!video) throw new UserFacingError('El archivo no tiene imagen de vídeo.');
  if (!data.streams?.some((x) => x.codec_type === 'audio')) throw new UserFacingError('El vídeo no tiene sonido: hace falta voz para transcribirlo y elegir momentos.');
  const duration = Number(data.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new UserFacingError('No se pudo determinar la duración del vídeo.');
  if (duration > s.maxSourceMinutes * 60) throw new UserFacingError(`El vídeo dura más de ${s.maxSourceMinutes} minutos (límite configurable en Configuración).`);
  const name = path.basename(file);
  return { path: file, name, title: name.replace(/\.[^.]+$/, '').slice(0, 200), duration, sizeBytes: st.size, ...displaySize(video) };
}

/**
 * Pone el vídeo local en la carpeta del trabajo SIN copiarlo si es posible (enlace duro: no ocupa espacio extra y
 * borrarlo luego no toca el original). Sólo si está en otra unidad se copia, para que re-render y limpieza funcionen.
 */
export function placeLocalSource(file: string, dir: string): { path: string; copied: boolean } {
  const dst = path.join(dir, `source${path.extname(file).toLowerCase() || '.mp4'}`);
  try {
    fs.linkSync(file, dst);
    return { path: dst, copied: false };
  } catch {
    fs.copyFileSync(file, dst);
    return { path: dst, copied: true };
  }
}
