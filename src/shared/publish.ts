// Módulo «Publicar»: metadatos por plataforma, estados e historial de versiones. Puro (sin Electron ni red).
// Todo es local: no hay subida real. Un clip NUNCA se marca como publicado automáticamente.

export type Platform = 'tiktok' | 'shorts' | 'reels';
export const PLATFORMS: Platform[] = ['tiktok', 'shorts', 'reels'];

export const PLATFORM_LABELS: Record<Platform, string> = {
  tiktok: 'TikTok',
  shorts: 'YouTube Shorts',
  reels: 'Instagram Reels',
};

/** Límites prácticos de cada plataforma (aproximados; se avisan, no se bloquean). */
export const PLATFORM_LIMITS: Record<Platform, { title: number; description: number; hashtags: number; hasTitle: boolean }> = {
  tiktok: { title: 0, description: 2200, hashtags: 10, hasTitle: false },
  shorts: { title: 100, description: 5000, hashtags: 15, hasTitle: true },
  reels: { title: 0, description: 2200, hashtags: 30, hasTitle: false },
};

export interface PublishMeta {
  title: string;
  description: string;
  hashtags: string[];
}

export type PublishStatus = 'borrador' | 'listo' | 'programado' | 'publicado' | 'descartado';
export const STATUS_ORDER: PublishStatus[] = ['borrador', 'listo', 'programado', 'publicado', 'descartado'];
export const PUBLISH_STATUS_LABELS: Record<PublishStatus, string> = {
  borrador: 'Borrador',
  listo: 'Listo para publicar',
  programado: 'Programado (manual)',
  publicado: 'Publicado',
  descartado: 'Descartado',
};

export interface MetaVersion {
  at: string;
  source: 'ia' | 'manual' | 'restaurada';
  meta: PublishMeta;
  model?: string;
}

export interface PlatformEntry {
  meta: PublishMeta;
  status: PublishStatus;
  versions: MetaVersion[];
  /** Sólo lo fija el usuario al marcarlo como publicado. */
  publishedAt?: string;
  publishedUrl?: string;
  updatedAt: string;
}

export type ClipPublish = Partial<Record<Platform, PlatformEntry>>;
/** publish.json: jobId → clipId → plataforma. */
export type PublishData = Record<string, Record<string, ClipPublish>>;

export const MAX_VERSIONS = 20;
export const EMPTY_META: PublishMeta = { title: '', description: '', hashtags: [] };

/** «#Gaming, viral  #fyp» → ['#gaming', '#viral', '#fyp'] (sin duplicados, sin espacios ni símbolos raros). */
export function normalizeHashtags(input: string | string[]): string[] {
  const parts = (Array.isArray(input) ? input : input.split(/[\s,;]+/)).flatMap((p) => p.split(/(?=#)/));
  const out: string[] = [];
  for (const p of parts) {
    const t = p.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '').toLowerCase();
    if (t && !out.includes(`#${t}`)) out.push(`#${t}`);
  }
  return out;
}

export function cleanMeta(m: { title?: string; description?: string; hashtags?: string | string[] }): PublishMeta {
  return {
    title: (m.title ?? '').replace(/\s+/g, ' ').trim(),
    description: (m.description ?? '').replace(/\r\n/g, '\n').trim(),
    hashtags: normalizeHashtags(m.hashtags ?? []),
  };
}

/** Avisos de longitud/formato por plataforma (no bloquean el guardado). */
export function metaWarnings(p: Platform, m: PublishMeta): string[] {
  const l = PLATFORM_LIMITS[p];
  const w: string[] = [];
  if (l.hasTitle && !m.title) w.push('Falta el título.');
  if (l.hasTitle && m.title.length > l.title) w.push(`El título supera ${l.title} caracteres (${m.title.length}).`);
  const len = copyText(p, m).length;
  if (len > l.description) w.push(`El texto supera ${l.description} caracteres (${len}).`);
  if (m.hashtags.length > l.hashtags) w.push(`Demasiados hashtags: ${m.hashtags.length} (máx. recomendado ${l.hashtags}).`);
  if (!m.description && !m.title) w.push('El texto está vacío.');
  return w;
}

/** Texto listo para pegar en la plataforma. */
export function copyText(p: Platform, m: PublishMeta): string {
  const tags = m.hashtags.join(' ');
  const body = PLATFORM_LIMITS[p].hasTitle ? m.description : [m.title, m.description].filter(Boolean).join('\n\n');
  return [body, tags].filter(Boolean).join('\n\n');
}

/** Interpreta la respuesta JSON de la IA con tolerancia (campos sueltos o faltantes). */
export function parseAiMeta(raw: string): Partial<Record<Platform, PublishMeta>> {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return {};
    try {
      j = JSON.parse(m[0]);
    } catch {
      return {};
    }
  }
  const out: Partial<Record<Platform, PublishMeta>> = {};
  if (!j || typeof j !== 'object') return out;
  for (const p of PLATFORMS) {
    const v = (j as Record<string, unknown>)[p];
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const meta = cleanMeta({
      title: typeof o.title === 'string' ? o.title : '',
      description: typeof o.description === 'string' ? o.description : '',
      hashtags: Array.isArray(o.hashtags) ? o.hashtags.filter((x): x is string => typeof x === 'string') : typeof o.hashtags === 'string' ? o.hashtags : [],
    });
    if (meta.title || meta.description || meta.hashtags.length) out[p] = meta;
  }
  return out;
}

const sameMeta = (a: PublishMeta, b: PublishMeta) => a.title === b.title && a.description === b.description && a.hashtags.join(' ') === b.hashtags.join(' ');

/** Guarda una nueva versión (la vigente pasa al historial). No cambia el estado salvo «publicado», que vuelve a borrador si se edita. */
export function applyMeta(entry: PlatformEntry | undefined, meta: PublishMeta, source: MetaVersion['source'], now: string, model?: string): PlatformEntry {
  const m = cleanMeta(meta);
  const base: PlatformEntry = entry ?? { meta: EMPTY_META, status: 'borrador', versions: [], updatedAt: now };
  if (entry && sameMeta(entry.meta, m)) return entry;
  const v: MetaVersion = { at: now, source, meta: m, ...(model ? { model } : {}) };
  return { ...base, meta: m, versions: [v, ...base.versions].slice(0, MAX_VERSIONS), updatedAt: now };
}

/**
 * Cambio de estado SIEMPRE iniciado por el usuario. «publicado» exige confirmación explícita (confirmedByUser)
 * y guarda la fecha; salir de «publicado» borra la fecha y el enlace.
 */
export function applyStatus(entry: PlatformEntry, status: PublishStatus, now: string, opts: { confirmedByUser?: boolean; url?: string } = {}): PlatformEntry {
  if (status === 'publicado') {
    if (!opts.confirmedByUser) throw new Error('Marcar como publicado requiere confirmación del usuario.');
    const url = opts.url?.trim();
    if (url && !/^https:\/\/\S+$/i.test(url)) throw new Error('El enlace debe empezar por https://');
    return { ...entry, status, publishedAt: now, publishedUrl: url || undefined, updatedAt: now };
  }
  return { ...entry, status, publishedAt: undefined, publishedUrl: undefined, updatedAt: now };
}

export function restoreVersion(entry: PlatformEntry, index: number, now: string): PlatformEntry {
  const v = entry.versions[index];
  if (!v) throw new Error('Esa versión no existe.');
  return applyMeta(entry, v.meta, 'restaurada', now);
}

/** Resumen para la tarjeta: «TikTok: Listo · Shorts: Publicado». */
export function publishSummary(c: ClipPublish | undefined): { platform: Platform; status: PublishStatus }[] {
  return PLATFORMS.filter((p) => c?.[p]).map((p) => ({ platform: p, status: c![p]!.status }));
}

/** Prompt del sistema para generar metadatos en español, sin inventar hechos. */
export const PUBLISH_SYSTEM_PROMPT = [
  'Eres un editor de redes sociales. Escribes metadatos para un clip vertical corto.',
  'Responde SOLO con JSON con las claves tiktok, shorts y reels; cada una con title, description y hashtags (lista).',
  'Idioma: el mismo de la transcripción. No inventes datos que no estén en la transcripción. Sin emojis excesivos.',
  'TikTok: título vacío, descripción breve (máx. 150 caracteres) con gancho; 3-6 hashtags.',
  'YouTube Shorts: título de máx. 80 caracteres; descripción de 1-3 frases; 3-5 hashtags.',
  'Instagram Reels: título vacío; descripción de 1-3 frases con llamada a la acción; 5-10 hashtags.',
].join('\n');

export function publishUserPrompt(clip: { title: string; hook: string; reason: string }, transcript: string, sourceTitle?: string): string {
  return [
    sourceTitle ? `Vídeo original: ${sourceTitle}` : '',
    `Título del clip: ${clip.title}`,
    clip.hook ? `Gancho: ${clip.hook}` : '',
    clip.reason ? `Por qué es interesante: ${clip.reason}` : '',
    `Transcripción del clip:\n${transcript.slice(0, 4000) || '(sin transcripción)'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Esquema JSON (structured outputs de Ollama). */
export function publishSchema(): object {
  const meta = {
    type: 'object',
    properties: { title: { type: 'string' }, description: { type: 'string' }, hashtags: { type: 'array', items: { type: 'string' }, maxItems: 30 } },
    required: ['title', 'description', 'hashtags'],
  };
  return { type: 'object', properties: { tiktok: meta, shorts: meta, reels: meta }, required: ['tiktok', 'shorts', 'reels'] };
}

/** Estado de conexión de una plataforma (pantalla Conexiones). */
export interface ConnectionInfo {
  platform: Platform;
  name: string;
  state: 'manual' | 'no-disponible';
  detail: string;
  supportsDirectUpload: boolean;
}
