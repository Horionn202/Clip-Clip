// Monitor de directos de YouTube: modelo y lógica pura (sin procesos). El control de procesos vive en main/liveMonitor.ts.
//
// Estrategia (ver docs/adr/0003-monitor-de-directos.md): se graba el directo HACIA ADELANTE en segmentos de N s
// (FFmpeg -f segment sobre el HLS), sin descargar nunca el directo entero ni repetir ventanas. Cada segmento
// completo se procesa como un bloque con S s de solape con el anterior, para no cortar frases en los bordes.

export type MonitorStatus = 'esperando' | 'verificando' | 'en-directo' | 'procesando' | 'pausado' | 'finalizando' | 'finalizado' | 'detenido' | 'error';

export const MONITOR_STATUS_LABELS: Record<MonitorStatus, string> = {
  esperando: 'Esperando directo',
  verificando: 'Verificando',
  'en-directo': 'En directo',
  procesando: 'Procesando bloque',
  pausado: 'Pausado',
  finalizando: 'Finalizando',
  finalizado: 'Finalizado',
  detenido: 'Detenido',
  error: 'Error',
};

export interface LiveSettings {
  /** Duración de cada bloque (s). */
  blockSec: number;
  /** Solape técnico con el bloque anterior (s). */
  overlapSec: number;
  /** Duración de los clips (preset) y máximo por bloque. */
  preset: 15 | 30 | 45 | 60;
  maxClipsPerBlock: number;
  /** Cada cuánto se comprueba si el canal empezó un directo (s). */
  pollSec: number;
  /** Conservar los segmentos grabados tras procesarlos (por defecto no). */
  keepSegments: boolean;
}

export const LIVE_DEFAULTS: LiveSettings = { blockSec: 60, overlapSec: 4, preset: 15, maxClipsPerBlock: 2, pollSec: 120, keepSegments: false };

export interface LiveBlock {
  index: number;
  /** Segundos desde que empezó la grabación (sin contar huecos). */
  startSec: number;
  endSec: number;
  /** Huella del bloque (índice + tamaño + duración) para no reprocesarlo. */
  hash: string;
  status: 'en-cola' | 'procesando' | 'procesado' | 'error' | 'omitido';
  jobId?: string;
  clips: number;
  error?: string;
}

export interface LiveMonitor {
  id: string;
  url: string;
  title?: string;
  status: MonitorStatus;
  settings: LiveSettings;
  createdAt: string;
  updatedAt: string;
  /** Momento en que se detectó el directo. */
  liveDetectedAt?: string;
  /** Segundos grabados y procesados (estado de reanudación). */
  recordedSec: number;
  lastProcessedSec: number;
  nextSegment: number;
  blocks: LiveBlock[];
  clipsGenerated: number;
  duplicatesSkipped: number;
  tempBytes: number;
  freedBytes: number;
  /** Huecos sin grabar (pausa, cierre de la app, reconexión): sin DVR no se recuperan. */
  gaps: { at: string; reason: string }[];
  notice?: string;
  error?: string;
  finishedAt?: string;
}

export function isActive(s: MonitorStatus): boolean {
  return s === 'esperando' || s === 'verificando' || s === 'en-directo' || s === 'procesando' || s === 'finalizando';
}

/** URL a consultar: para un canal se usa su pestaña /live (YouTube redirige al directo activo si lo hay). */
export function liveCheckUrl(raw: string): string {
  const u = new URL(raw);
  const host = u.hostname.replace(/^www\.|^m\./, '');
  if (host !== 'youtube.com' && host !== 'youtu.be') throw new Error('Sólo se admiten directos de YouTube.');
  if (host === 'youtube.com' && /^\/(@[\w.-]+|channel\/[\w-]+|c\/[\w.-]+|user\/[\w.-]+)\/?$/.test(u.pathname)) return `https://www.youtube.com${u.pathname.replace(/\/$/, '')}/live`;
  return u.toString();
}

export type LiveState = 'live' | 'upcoming' | 'ended' | 'not-live';

/** Interpreta el JSON de `yt-dlp -J` (live_status / is_live). */
export function parseLiveStatus(raw: string): { state: LiveState; title?: string; dvr?: boolean } {
  let j: Record<string, unknown> = {};
  try {
    j = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { state: 'not-live' };
  }
  const ls = typeof j.live_status === 'string' ? j.live_status : j.is_live ? 'is_live' : '';
  const title = typeof j.title === 'string' ? j.title : undefined;
  const state: LiveState = ls === 'is_live' ? 'live' : ls === 'is_upcoming' ? 'upcoming' : ls === 'was_live' || ls === 'post_live' ? 'ended' : 'not-live';
  return { state, title, dvr: typeof j.is_live === 'boolean' ? undefined : undefined };
}

/** Errores de yt-dlp que significan «ahora no hay directo» (no un fallo real). */
export function isNotLiveError(stderr: string): boolean {
  return /not currently live|is not live|will begin|Premieres in|scheduled|This live event will|channel is not currently live|does not have a live/i.test(stderr);
}

/** Índice del segmento a partir del nombre seg_00012.ts. */
export function segmentIndex(name: string): number | null {
  const m = name.match(/^seg_(\d{5})\.(ts|mp4|mkv)$/);
  return m ? Number(m[1]) : null;
}

/**
 * Segmentos completos listos para procesar: un segmento está completo cuando ya existe el siguiente
 * (FFmpeg lo cerró) o cuando la grabación terminó. Nunca se devuelven índices ya procesados.
 */
export function completeSegments(files: string[], recorderRunning: boolean, done: Set<number>): number[] {
  const idx = files.map(segmentIndex).filter((n): n is number => n !== null).sort((a, b) => a - b);
  const out: number[] = [];
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    if (done.has(i)) continue;
    const closed = idx.includes(i + 1) || !recorderRunning;
    if (closed) out.push(i);
  }
  return out;
}

export function blockHash(index: number, bytes: number, durationSec: number): string {
  return `${index}:${bytes}:${Math.round(durationSec * 10)}`;
}

/** Ventana de un bloque en el tiempo grabado, con solape hacia atrás (nunca antes del inicio). */
export function blockWindow(index: number, startSec: number, durationSec: number, overlapSec: number, hasPrev: boolean): { from: number; to: number; overlap: number } {
  const overlap = hasPrev ? Math.max(0, Math.min(overlapSec, startSec)) : 0;
  return { from: startSec - overlap, to: startSec + durationSec, overlap };
}

export interface AbsClip {
  start: number;
  end: number;
  title: string;
}

/**
 * Deduplica clips de un bloque contra los ya generados (tiempos absolutos de la grabación):
 * comparten ≥ 50 % del más corto o ≥ `minSharedSec` (lo que da el solape técnico entre bloques), o mismo título normalizado.
 */
export function dedupeClips<T extends AbsClip>(candidates: T[], previous: AbsClip[], minSharedSec = 3): { keep: T[]; duplicates: T[] } {
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const keep: T[] = [];
  const duplicates: T[] = [];
  for (const c of candidates) {
    const dup = [...previous, ...keep].some((p) => {
      const inter = Math.min(c.end, p.end) - Math.max(c.start, p.start);
      const shortest = Math.min(c.end - c.start, p.end - p.start);
      return (shortest > 0 && (inter / shortest >= 0.5 || inter >= minSharedSec)) || (norm(c.title) && norm(c.title) === norm(p.title));
    });
    (dup ? duplicates : keep).push(c);
  }
  return { keep, duplicates };
}

/** Resumen visible: tiempo vigilado, procesado, retraso respecto al vivo. */
export function monitorSummary(m: LiveMonitor, now: number): { watchedSec: number; processedSec: number; lagSec: number; blocksDone: number } {
  const watchedSec = m.liveDetectedAt && isActive(m.status) ? Math.max(m.recordedSec, (now - Date.parse(m.liveDetectedAt)) / 1000) : m.recordedSec;
  const blocksDone = m.blocks.filter((b) => b.status === 'procesado').length;
  return { watchedSec, processedSec: m.lastProcessedSec, lagSec: Math.max(0, m.recordedSec - m.lastProcessedSec), blocksDone };
}

/** Al abrir la app, un monitor que estaba activo queda en pausa (sin DVR, lo no grabado no se recupera). */
export function recoverMonitor(m: LiveMonitor, now: string): LiveMonitor {
  if (!isActive(m.status)) return m;
  return { ...m, status: 'pausado', updatedAt: now, gaps: [...m.gaps, { at: now, reason: 'La aplicación se cerró mientras se vigilaba el directo.' }], notice: 'La app se cerró. Pulsa «Reanudar» para seguir desde el momento actual del directo; lo emitido mientras estaba cerrada no se puede recuperar sin DVR.' };
}

export function validateLiveSettings(s: Partial<LiveSettings>): LiveSettings {
  const n = (v: unknown, a: number, b: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(b, Math.max(a, Math.round(v))) : d);
  const preset = ([15, 30, 45, 60] as const).find((p) => p === s.preset) ?? LIVE_DEFAULTS.preset;
  const blockSec = n(s.blockSec, Math.max(30, preset + 10), 600, Math.max(LIVE_DEFAULTS.blockSec, preset + 10));
  return {
    blockSec,
    overlapSec: n(s.overlapSec, 3, 5, LIVE_DEFAULTS.overlapSec),
    preset,
    maxClipsPerBlock: n(s.maxClipsPerBlock, 1, 5, LIVE_DEFAULTS.maxClipsPerBlock),
    pollSec: n(s.pollSec, 30, 1800, LIVE_DEFAULTS.pollSec),
    keepSegments: s.keepSegments === true,
  };
}
