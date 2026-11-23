// Diagnóstico de fallos al leer o descargar un vídeo con yt-dlp. Puro (main, renderer y tests).
// Distingue la causa real para no dar consejos falsos: si yt-dlp es reciente, nunca se recomienda actualizarlo.
// Sin evasión: no se usan cookies, cuentas, proxies ni nada para saltarse las restricciones de la plataforma.

export type SourceErrorKind = 'bot' | 'outdated' | 'unavailable' | 'private' | 'login' | 'network' | 'invalid_url' | 'unknown';

export interface SourceFailure {
  kind: SourceErrorKind;
  /** Versión de yt-dlp con la que falló (p. ej. «2026.10.26»). */
  ytDlpVersion?: string;
  /** Intentos realizados (los reintentos sólo se hacen ante el bloqueo anti-bot). */
  attempts: number;
  /** Final de la salida de error de yt-dlp, para el diagnóstico avanzado. */
  technical: string;
  at: string;
}

export function isBotCheck(stderr: string): boolean {
  return /confirm you.{0,3}re not a bot/i.test(stderr);
}

/** Clasifica la salida de error de yt-dlp. El orden importa: lo más concreto primero. */
export function classifySourceError(stderr: string): SourceErrorKind {
  const s = stderr;
  if (isBotCheck(s)) return 'bot';
  if (/Private video/i.test(s)) return 'private';
  if (/confirm your age|age.restricted|inappropriate for some users|members.only|Join this channel|requires? (a )?(login|sign.?in|authentication)|needs_auth|premium/i.test(s)) return 'login';
  if (/Unsupported URL|is not a valid URL|Incomplete YouTube ID|Invalid URL|unknown url type/i.test(s)) return 'invalid_url';
  if (/Video unavailable|video is unavailable|video is not available|has been removed|does not exist|no longer available|HTTP Error 404|available in your country|geo.?restrict/i.test(s)) return 'unavailable';
  if (/getaddrinfo|Network is unreachable|timed? ?out|Connection (refused|reset|aborted)|Temporary failure in name resolution|Name or service not known|SSL|CERTIFICATE|HTTP Error 5\d\d|No route to host/i.test(s)) return 'network';
  if (/nsig extraction failed|Signature extraction failed|Unable to extract|please report this issue|update yt-dlp|yt-dlp -U|outdated|Requested format is not available/i.test(s)) return 'outdated';
  return 'unknown';
}

/** Días de una versión «AAAA.MM.DD[.n]» respecto a `now`. null si no se reconoce. */
export function ytDlpAgeDays(version: string | undefined, now = new Date()): number | null {
  const m = version?.trim().match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})/);
  if (!m) return null;
  const built = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Math.max(0, Math.floor((now.getTime() - built) / 86_400_000));
}

/** Una versión de hace menos de 60 días se considera reciente: no se recomienda actualizar. */
export const RECENT_DAYS = 60;
export function isRecentYtDlp(version: string | undefined, now = new Date()): boolean {
  const age = ytDlpAgeDays(version, now);
  return age !== null && age < RECENT_DAYS;
}

export interface SourceErrorView {
  title: string;
  /** Explicación sencilla, sin comandos técnicos. */
  message: string;
  /** Sólo si la versión NO es reciente y la causa puede ser la versión. */
  suggestUpdate: boolean;
  /** Tiene sentido volver a intentarlo más tarde (bloqueos temporales y red). */
  retryLater: boolean;
}

export function describeSourceError(f: Pick<SourceFailure, 'kind' | 'ytDlpVersion' | 'attempts'>, now = new Date()): SourceErrorView {
  const v = f.ytDlpVersion;
  const recent = isRecentYtDlp(v, now);
  const age = ytDlpAgeDays(v, now);
  const versionNote = !v ? '' : recent ? ` Tu yt-dlp (${v}) está actualizado.` : age !== null ? ` Tu yt-dlp (${v}) tiene ${age} días.` : '';
  // Sólo ante el bloqueo se aclara que no es culpa de la versión instalada.
  const botVersionNote = recent && v ? ` Tu yt-dlp (${v}) está actualizado: el bloqueo no viene de la versión instalada.` : versionNote;
  switch (f.kind) {
    case 'bot':
      return {
        title: 'YouTube no permitió descargar este video',
        message: `YouTube limitó temporalmente las descargas desde tu conexión y pidió verificar que no eres un bot.${f.attempts > 1 ? ` Se probaron ${f.attempts} intentos, con un método alternativo y esperas entre ellos.` : ''}${botVersionNote} Suele pasarse solo al cabo de un rato. Mientras tanto puedes importar el archivo de vídeo desde tu equipo.`,
        suggestUpdate: !recent && age !== null,
        retryLater: true,
      };
    case 'outdated':
      return {
        title: 'yt-dlp no sabe leer este video',
        message: recent
          ? `YouTube ha cambiado algo que yt-dlp todavía no entiende.${versionNote} Suele arreglarse en una versión nueva en pocos días: inténtalo más tarde o importa el archivo.`
          : `YouTube ha cambiado su formato y tu versión de yt-dlp${v ? ` (${v})` : ''} es antigua. Comprueba si hay una actualización en Configuración → Diagnóstico o importa el archivo.`,
        suggestUpdate: !recent,
        retryLater: true,
      };
    case 'private':
      return { title: 'Este video es privado', message: 'Sólo se pueden procesar vídeos públicos. Si es tuyo, descárgalo desde tu cuenta e impórtalo como archivo.', suggestUpdate: false, retryLater: false };
    case 'login':
      return { title: 'Este video requiere iniciar sesión', message: 'Tiene restricción de edad, es para miembros o exige una cuenta. La app no usa cuentas ni cookies: si tienes derecho a usarlo, impórtalo como archivo.', suggestUpdate: false, retryLater: false };
    case 'unavailable':
      return { title: 'El video no está disponible', message: 'No existe, se eliminó o no está disponible en tu país. Revisa la URL.', suggestUpdate: false, retryLater: false };
    case 'network':
      return { title: 'No hay conexión con el sitio del video', message: 'No se pudo contactar con el sitio. Revisa tu conexión a internet y vuelve a intentarlo.', suggestUpdate: false, retryLater: true };
    case 'invalid_url':
      return { title: 'La URL no es válida', message: 'Esa dirección no es un vídeo que yt-dlp pueda leer. Comprueba que has copiado la URL completa del vídeo.', suggestUpdate: false, retryLater: false };
    default:
      return {
        title: 'No se pudo leer el video',
        message: `Comprueba que la URL es pública y accesible.${versionNote} Puedes ver el detalle en el diagnóstico técnico o importar el archivo.`,
        suggestUpdate: !recent && age !== null && age >= RECENT_DAYS,
        retryLater: true,
      };
  }
}

/** Mensaje de una línea (para el historial y los logs). Nunca incluye comandos. */
export function friendlySourceError(stderr: string, ytDlpVersion?: string, attempts = 1): string {
  const d = describeSourceError({ kind: classifySourceError(stderr), ytDlpVersion, attempts });
  return `${d.title}. ${d.message}`;
}

export type SourceErrorAction = 'retry-later' | 'change-url' | 'import-file' | 'diagnostics';
export const SOURCE_ERROR_ACTIONS: { id: SourceErrorAction; label: string }[] = [
  { id: 'retry-later', label: 'Reintentar más tarde' },
  { id: 'change-url', label: 'Cambiar URL' },
  { id: 'import-file', label: 'Importar archivo de video' },
  { id: 'diagnostics', label: 'Ver diagnóstico técnico' },
];

/** Comandos sólo para el diagnóstico avanzado (con botón de copiar), nunca en el mensaje principal. */
export function technicalCommands(f: Pick<SourceFailure, 'kind' | 'ytDlpVersion'>, now = new Date()): { label: string; command: string }[] {
  const out = [{ label: 'Ver la versión de yt-dlp', command: 'yt-dlp --version' }];
  if (!isRecentYtDlp(f.ytDlpVersion, now)) out.push({ label: 'Actualizar yt-dlp instalado con winget', command: 'winget upgrade yt-dlp.yt-dlp' });
  return out;
}

// ---- Reintentos ante el bloqueo anti-bot ----

/** Cliente alternativo ya soportado por la app (sin cookies ni cuentas). */
export const FALLBACK_CLIENT_ARGS = ['--extractor-args', 'youtube:player_client=mweb'];

/** Como máximo 3 intentos con espera creciente; sólo ante el bloqueo anti-bot. */
export const BOT_RETRY_PLAN: { waitMs: number; clientArgs: string[] }[] = [
  { waitMs: 0, clientArgs: [] },
  { waitMs: 4_000, clientArgs: FALLBACK_CLIENT_ARGS },
  { waitMs: 12_000, clientArgs: FALLBACK_CLIENT_ARGS },
];

export const botRetryMessage = (attempt: number, of: number): string =>
  `YouTube limitó temporalmente la descarga. Reintentando método alternativo… (intento ${attempt} de ${of})`;

/** Recorta la salida técnica a lo útil (final del stderr). */
export const technicalTail = (stderr: string, max = 2000): string => stderr.trim().slice(-max);

// ---- Actualización de yt-dlp (origen oficial y hash) ----

export const YTDLP_RELEASES_API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
/** Sólo se aceptan descargas del repositorio oficial. */
export const YTDLP_OFFICIAL_DOWNLOAD = /^https:\/\/github\.com\/yt-dlp\/yt-dlp\/releases\/download\/[\w.-]+\/[\w.-]+$/;

/** Compara versiones «AAAA.MM.DD[.n]». >0 si a es más nueva. */
export function compareYtDlpVersions(a: string, b: string): number {
  const p = (v: string) => v.trim().split('.').map((x) => Number.parseInt(x, 10) || 0);
  const x = p(a);
  const y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** Hash SHA-256 de un archivo en «SHA2-256SUMS» («<hash>  <nombre>»). null si no aparece o es inválido. */
export function sha256For(sums: string, file: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (m && m[2].trim() === file) return m[1].toLowerCase();
  }
  return null;
}
