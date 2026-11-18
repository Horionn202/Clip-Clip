// Lectura de metadatos con yt-dlp (con reintento ante verificación anti-bot). Compartido por pipeline e IPC.
import type { Settings } from '../shared/types';
import { UserFacingError } from '../shared/validation';
import { runProcess } from './proc';
import { FALLBACK_CLIENT_ARGS, friendlyYtDlpError, isBotCheck } from './ytdlp';

export interface SourceInfo {
  title: string;
  duration: number;
  filesize?: number;
  clientArgs: string[];
}

const BLOCKED_AVAILABILITY = new Set(['premium_only', 'subscriber_only', 'needs_auth']);

export async function readSourceInfo(
  ytDlp: string,
  url: string,
  s: Pick<Settings, 'maxSourceMinutes' | 'maxDownloadMB'>,
  signal?: AbortSignal,
  onRetry?: () => void,
): Promise<SourceInfo> {
  const read = (extra: string[]) =>
    runProcess(ytDlp, ['--dump-single-json', '--no-playlist', '--no-warnings', ...extra, '--', url], { signal, timeoutMs: 90_000 });
  let clientArgs: string[] = [];
  let meta = await read(clientArgs);
  if (meta.code !== 0 && isBotCheck(meta.stderr)) {
    onRetry?.();
    clientArgs = FALLBACK_CLIENT_ARGS;
    meta = await read(clientArgs);
  }
  if (meta.code !== 0) throw new UserFacingError(friendlyYtDlpError(meta.stderr), meta.stderr);
  let info: { title?: string; duration?: number; is_live?: boolean; availability?: string; filesize_approx?: number; filesize?: number };
  try {
    info = JSON.parse(meta.stdout);
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
  return { title: (info.title ?? '').slice(0, 200), duration: info.duration, filesize: approx, clientArgs };
}
