// Generador editorial de «Publicar». Puro (sin Electron ni red): construye un contexto LIMPIO para la IA,
// valida lo que devuelve y decide si se regenera o se pide edición manual. Nunca recibe datos técnicos
// (URL, rutas, nombres de archivo, IDs, timestamps, logs ni metadata de render).
import { PLATFORMS, PLATFORM_LIMITS, cleanMeta, normalizeHashtags, type Platform, type PublishMeta } from './publish';

export type Tone = 'neutro' | 'cercano' | 'informativo' | 'divertido' | 'serio';
export const TONES: Tone[] = ['neutro', 'cercano', 'informativo', 'divertido', 'serio'];
export const TONE_LABELS: Record<Tone, string> = { neutro: 'Neutro', cercano: 'Cercano', informativo: 'Informativo', divertido: 'Divertido', serio: 'Serio' };

export const NICHES = ['', 'gaming', 'educación', 'humor', 'tecnología', 'deporte', 'cocina', 'música', 'viajes', 'motor', 'finanzas', 'entrevista', 'vlog'] as const;

/** Etiquetas visuales semánticas permitidas (nunca nombres de frame ni rutas). */
export type VisualTag = 'gameplay' | 'persona hablando' | 'reacción' | 'facecam' | 'coche' | 'escena nocturna';

/** Lo ÚNICO que ve la IA. Separado de los contextos de render, visual crudo y almacenamiento. */
export interface EditorialContext {
  transcript: string;
  summary: string;
  topic: string;
  language: string;
  tone: Tone;
  niche: string;
  hook: string;
  entities: string[];
  visualTags: VisualTag[];
}

export interface EditorialOptions {
  tone?: Tone;
  niche?: string;
  language?: string;
}

// ---------- Filtros de datos técnicos ----------

const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|net|org|io|tv|es|gg|ly|be)\b(?:\/\S*)?/gi;
const PATH_RE = /\b[a-z]:[\\/]\S*|(?:^|\s)(?:\.{0,2}\/)?(?:[\w.-]+\/){1,}[\w.-]+|\\\\\S+|\/jobs\/\S*/gi;
const FILE_RE = /\b[\w.-]+\.(?:mp4|mkv|webm|mov|wav|mp3|png|jpe?g|webp|gif|json|srt|vtt|log|txt|ass)\b/gi;
const ID_RE = /\b(?:clip|frame|job|source|thumb)[_-]?\d+\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{16,}\b/gi;
const ID_TEST = new RegExp(ID_RE.source, 'i');
const TIME_RE = /\b\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?\b|\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g;

/** Quita URL, rutas, nombres de archivo, IDs y timestamps de un texto que va a la IA. */
export function stripTechnical(s: string): string {
  return s
    .replace(URL_RE, ' ')
    .replace(FILE_RE, ' ')
    .replace(PATH_RE, ' ')
    .replace(ID_RE, ' ')
    .replace(TIME_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Palabras técnicas que nunca deben ser fuente de un texto generado. */
const TECH_WORDS = /\b(?:imagen|im[aá]genes|url|urls|frame|frames|fotograma|archivo|fichero|clip_\w*|source|thumbnail|miniatura|render|timestamp|path|ruta)\b/i;
/** Frases vacías o de plantilla. */
const PLACEHOLDERS = [
  /momento emotivo/i,
  /¿?\s*por qu[eé] funciona\s*\??/i,
  /sin t[ií]tulo/i,
  /\bcap[ií]tulo\s*\d+\b/i,
  /\bt[ií]tulo del clip\b/i,
  /\blorem ipsum\b/i,
  /\[[^\]]*\]|\{\{[^}]*\}\}|<[^>]+>/,
  /\b(?:placeholder|tu texto aqu[ií]|insertar|n\/a)\b/i,
];
/** Hashtags genéricos que no se ponen por defecto. */
export const BANNED_TAGS = ['#fyp', '#foryou', '#foryoupage', '#parati', '#viral', '#trending', '#tendencia', '#xyzbca'];

export type IssueCode = 'url' | 'tecnico' | 'generico' | 'comillas' | 'vacio' | 'hashtag-invalido' | 'hashtag-generico' | 'hashtag-irrelevante' | 'hashtags-cantidad' | 'longitud' | 'inventado' | 'repite-titulo' | 'copia';

export interface Issue {
  field: 'title' | 'description' | 'hashtags' | 'cta';
  code: IssueCode;
  message: string;
  platform?: Platform;
}

export const ISSUE_TEXT: Record<IssueCode, string> = {
  url: 'Contiene una URL técnica',
  tecnico: 'Contiene texto técnico (archivo, imagen, frame…)',
  generico: 'Título demasiado genérico',
  comillas: 'No pongas comillas alrededor de todo el texto',
  vacio: 'Falta el texto',
  'hashtag-invalido': 'Hashtag con formato no válido',
  'hashtag-generico': 'Hashtag genérico (#fyp, #viral…)',
  'hashtag-irrelevante': 'Hashtag poco relevante',
  'hashtags-cantidad': 'Usa entre 3 y 6 hashtags',
  longitud: 'Supera el límite de la plataforma',
  inventado: 'Menciona algo que no aparece en el clip',
  'repite-titulo': 'La descripción repite el título',
  copia: 'Copia la transcripción literalmente; resume el momento',
};

const hasUrlOrPath = (s: string) => /https?:|www\.|\.com\b|[a-z]:\\|\/jobs\/|\.(?:mp4|png|jpe?g|webm|mov)\b/i.test(s);

export function textIssues(field: 'title' | 'description' | 'cta', s: string, platform?: Platform): Issue[] {
  const out: Issue[] = [];
  const t = s.trim();
  const add = (code: IssueCode) => out.push({ field, code, message: ISSUE_TEXT[code], platform });
  if (!t) return out;
  if (hasUrlOrPath(t)) add('url');
  else if (TECH_WORDS.test(t) || ID_TEST.test(t)) add('tecnico');
  if (PLACEHOLDERS.some((r) => r.test(t))) add('generico');
  if (/^\s*["«“'].*["»”']\s*$/s.test(t) && t.length > 2) add('comillas');
  return out;
}

/** Palabras con contenido (minúsculas, sin tildes) para medir relevancia. */
export function keywords(s: string): Set<string> {
  const STOP = new Set('el la los las un una unos unas de del al y o que en con por para es son se su sus lo como mas pero muy ya no si yo tu te me mi le les nos este esta esto eso esa ese hay fue ser the and for you this that with are was'.split(' '));
  return new Set(
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

/** Un hashtag es relevante si comparte raíz con alguna palabra del contexto (o es el nicho/plataforma elegidos). */
export function tagRelevant(tag: string, ctxWords: Set<string>, allowedBroad: Set<string>): boolean {
  const t = fold(tag.replace(/^#/, ''));
  if (allowedBroad.has(t)) return true;
  for (const w of ctxWords) {
    const stem = w.slice(0, Math.max(4, Math.min(w.length, 6)));
    if (t.includes(stem) || (t.length >= 4 && w.includes(t))) return true;
  }
  return false;
}

const tagWords = (ctx: EditorialContext) => keywords([ctx.transcript, ctx.summary, ctx.topic, ctx.hook, ...ctx.entities, ...ctx.visualTags].join(' '));
const broadTags = (ctx: EditorialContext) => new Set([fold(ctx.niche), 'gaming', 'shorts', 'reels', 'tiktok', 'videojuegos'].filter(Boolean));

/** Motivo por el que un hashtag sobra (o null si vale). `broad` indica que es un hashtag amplio de nicho/plataforma. */
export function tagProblem(tag: string, words: Set<string>, broad: Set<string>): 'hashtag-invalido' | 'hashtag-generico' | 'hashtag-irrelevante' | 'broad' | null {
  const t = tag.toLowerCase();
  if (!/^#[\p{L}\p{N}_]{2,40}$/u.test(tag) || hasUrlOrPath(tag) || /(?:url|imagen|frame|archivo|clip_|source|capitulo\d|mp4|png|jpg)/i.test(fold(tag))) return 'hashtag-invalido';
  if (BANNED_TAGS.includes(t)) return 'hashtag-generico';
  if (broad.has(fold(t.slice(1)))) return 'broad';
  return tagRelevant(t, words, broad) ? null : 'hashtag-irrelevante';
}

export function hashtagIssues(tags: string[], ctx: EditorialContext, platform?: Platform): Issue[] {
  const out: Issue[] = [];
  const add = (code: IssueCode, extra = '') => out.push({ field: 'hashtags', code, message: ISSUE_TEXT[code] + extra, platform });
  if (tags.length < 3 || tags.length > 6) add('hashtags-cantidad');
  const words = tagWords(ctx);
  const broad = broadTags(ctx);
  let broadUsed = 0;
  const seen = new Set<string>();
  for (const tag of tags) {
    const t = tag.toLowerCase();
    const pr = tagProblem(tag, words, broad);
    if (seen.has(t)) add('hashtag-invalido', `: ${tag} repetido`);
    else if (pr === 'broad') {
      if (++broadUsed > 1) add('hashtag-irrelevante', `: ${tag}`);
    } else if (pr) add(pr, `: ${tag}`);
    seen.add(t);
  }
  return out;
}

// ---------- Contexto editorial ----------

const sentence = (s: string, max: number) => {
  const t = stripTechnical(s);
  return t.length <= max ? t : `${t.slice(0, max).replace(/\s+\S*$/, '')}…`;
};

/** Nombres propios repetidos en la transcripción (≥2 apariciones, no al inicio de frase). */
export function extractEntities(transcript: string, max = 6): string[] {
  const counts = new Map<string, number>();
  const re = /(?<![.!?¿¡]\s)(?<=\s)(\p{Lu}[\p{L}\d]{2,}(?:\s\p{Lu}[\p{L}\d]+)?)/gu;
  for (const m of stripTechnical(transcript).matchAll(re)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([w, n]) => n >= 2 && !TECH_WORDS.test(w))
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([w]) => w);
}

/** Traduce el análisis visual (clase de layout) a etiquetas semánticas; sin confianza suficiente, nada. */
export function visualTagsFrom(v: { cls: string; confidence: number } | undefined, layout?: string): VisualTag[] {
  const tags = new Set<VisualTag>();
  if (v && v.confidence >= 0.6) {
    if (v.cls.startsWith('facecam_')) {
      tags.add('facecam');
      tags.add('gameplay');
    }
    if (v.cls === 'pantalla_completa') tags.add('persona hablando');
  }
  if (layout && layout !== 'gameplay_full' && layout !== 'no_facecam') tags.add('facecam');
  return [...tags];
}

/** Lenguaje probable a partir de la transcripción (es/en/pt). */
export function guessLanguage(text: string, fallback = 'el mismo de la transcripción'): string {
  const w = ` ${fold(text)} `;
  const score = (list: string[]) => list.reduce((n, x) => n + (w.split(` ${x} `).length - 1), 0);
  const s = { es: score(['que', 'de', 'el', 'y', 'es', 'por', 'pero', 'esto']), en: score(['the', 'and', 'is', 'you', 'that', 'this', 'what']), pt: score(['que', 'nao', 'voce', 'uma', 'isso', 'com']) };
  const best = (Object.entries(s) as [string, number][]).sort((a, b) => b[1] - a[1])[0];
  // Sólo se fija el idioma si la detección es clara; si no, se pide el mismo idioma de la transcripción (fr, de…).
  return best[1] >= 3 && best[1] >= 2 * (Object.values(s).sort((a, b) => b - a)[1] ?? 0) ? best[0] : fallback;
}

/**
 * Construye el contexto editorial a partir del clip. Sólo pasan textos útiles y ya saneados:
 * el título y el gancho que propuso el análisis se usan como resumen/tema, nunca el nombre del vídeo ni rutas.
 */
export function buildEditorialContext(
  clip: { title: string; hook: string; reason: string; visual?: { cls: string; confidence: number }; layout?: string },
  transcript: string,
  opts: EditorialOptions = {},
): EditorialContext {
  const tx = sentence(transcript, 4000);
  const cleanOrEmpty = (s: string, max: number) => {
    const t = sentence(s, max);
    return textIssues('title', t).length ? '' : t;
  };
  return {
    transcript: tx,
    summary: cleanOrEmpty(clip.reason, 300),
    topic: cleanOrEmpty(clip.title, 120),
    language: opts.language || guessLanguage(tx),
    tone: opts.tone ?? 'neutro',
    niche: stripTechnical(opts.niche ?? '').slice(0, 40),
    hook: cleanOrEmpty(clip.hook, 200),
    entities: extractEntities(tx),
    visualTags: visualTagsFrom(clip.visual, clip.layout),
  };
}

/** Hay contexto suficiente para escribir algo concreto (si no, se pide edición manual). */
export function hasEnoughContext(ctx: EditorialContext): boolean {
  return keywords(ctx.transcript).size >= 8 || keywords(`${ctx.summary} ${ctx.topic} ${ctx.hook}`).size >= 4;
}

// ---------- Reglas de plataforma (configurables; consejos, no garantías) ----------

export interface PlatformGuide {
  summary: string;
  tips: string[];
  /** Instrucciones para la IA. */
  prompt: string;
}

/** Longitud recomendada de la descripción generada (configurable; más corta que el límite duro). */
export const DESCRIPTION_TARGET: Record<Platform, number> = { tiktok: 220, shorts: 300, reels: 400 };

/** true si `text` contiene un tramo de ≥ n palabras seguidas copiado de la transcripción. */
export function copiesTranscript(text: string, transcript: string, n = 12): boolean {
  const norm = (s: string) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const t = norm(text);
  if (t.length < n) return false;
  const tx = ` ${norm(transcript).join(' ')} `;
  for (let i = 0; i + n <= t.length; i++) if (tx.includes(` ${t.slice(i, i + n).join(' ')} `)) return true;
  return false;
}

export const PLATFORM_GUIDES: Record<Platform, PlatformGuide> = {
  tiktok: {
    summary: 'Texto corto con contexto y pocos hashtags relevantes.',
    tips: ['Unos pocos hashtags relacionados con el contenido; no hace falta #FYP.', 'El texto acompaña al vídeo: una o dos frases claras.', 'Evita prometer resultados o engañar sobre el contenido.'],
    prompt: 'Sin título. Descripción de 1-2 frases (máx. 150 caracteres) que añada contexto real. 3-5 hashtags específicos.',
  },
  shorts: {
    summary: 'Título preciso y breve; descripción corta; hashtags relacionados.',
    tips: ['El título debe describir lo que se ve, sin exagerar.', 'Los hashtags deben estar relacionados con el vídeo; muchos hashtags se consideran spam.', 'Metadatos engañosos van contra las normas de YouTube.'],
    prompt: 'Título de máx. 70 caracteres. Descripción de 1-3 frases que no repita el título. 3-5 hashtags relacionados.',
  },
  reels: {
    summary: 'Caption natural con contexto y hashtags relevantes.',
    tips: ['Escribe como hablarías a tu audiencia: natural y concreto.', 'Hashtags relevantes al tema, no listas largas genéricas.', 'Una llamada a la acción opcional y natural.'],
    prompt: 'Sin título. Caption de 1-3 frases natural, con CTA opcional al final. 3-6 hashtags relevantes.',
  },
};

// ---------- Prompts y respuesta ----------

export interface TitleVariant {
  title: string;
  reason: string;
}
export interface PlatformDraft extends PublishMeta {
  cta: string;
}
export interface EditorialResult {
  variants: TitleVariant[];
  platforms: Partial<Record<Platform, PlatformDraft>>;
}

export const EDITORIAL_SYSTEM_PROMPT = [
  'Eres editor de redes sociales. Escribes el texto de publicación de UN clip vertical corto, como lo haría una persona profesional.',
  'Usa SOLO los hechos del contexto (transcripción, resumen, entidades, etiquetas visuales). No inventes nombres, datos, capítulos ni lugares.',
  'Prohibido: URL, rutas, nombres de archivo, IDs, las palabras «imagen», «URL», «frame», «archivo», «capítulo N», «momento emotivo», «¿por qué funciona?», placeholders y comillas alrededor de todo el texto.',
  'No uses #fyp, #foryou, #viral ni #trending. Hashtags: 3-6, en minúsculas, sin espacios, relacionados directamente con lo que se dice o se ve; como mucho uno amplio de nicho.',
  'No prometas alcance, viralidad ni resultados. Sin clickbait falso. Pocos o ningún emoji.',
  'Títulos: 3 variantes cortas, claras y precisas que describan el momento real; cada una con una razón breve de por qué representa el clip.',
  'Descripción: resume con tus palabras (NO copies frases de la transcripción), añade contexto que no repita el título y suena natural para vídeo vertical. CTA opcional y natural (puede ir vacía).',
  'No exageres ni dramatices lo que no se dice en el clip.',
  'Si el contexto es insuficiente, escribe textos neutros y descriptivos en vez de inventar.',
  'Responde SOLO con JSON según el esquema.',
].join('\n');

/** Prompt de usuario: un JSON con el contexto editorial (y nada más). */
export function editorialUserPrompt(ctx: EditorialContext, feedback: string[] = []): string {
  const rules = PLATFORMS.map((p) => `- ${p}: ${PLATFORM_GUIDES[p].prompt}`).join('\n');
  return [
    `Idioma de salida: ${ctx.language}. Tono: ${ctx.tone}.${ctx.niche ? ` Nicho: ${ctx.niche}.` : ''}`,
    `Reglas por plataforma:\n${rules}`,
    `Contexto del clip (JSON):\n${JSON.stringify({ transcripcion: ctx.transcript || '(sin transcripción)', resumen: ctx.summary, tema: ctx.topic, gancho: ctx.hook, entidades: ctx.entities, visual: ctx.visualTags })}`,
    feedback.length ? `Tu respuesta anterior se rechazó por:\n${feedback.map((f) => `- ${f}`).join('\n')}\nCorrígelo.` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function editorialSchema(): object {
  const plat = {
    type: 'object',
    properties: { description: { type: 'string' }, hashtags: { type: 'array', items: { type: 'string' }, maxItems: 6 }, cta: { type: 'string' } },
    required: ['description', 'hashtags', 'cta'],
  };
  return {
    type: 'object',
    properties: {
      titles: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'object', properties: { title: { type: 'string' }, reason: { type: 'string' } }, required: ['title', 'reason'] } },
      tiktok: plat,
      shorts: plat,
      reels: plat,
    },
    required: ['titles', 'tiktok', 'shorts', 'reels'],
  };
}

const unquote = (s: string) => s.trim().replace(/^["«“'](.*)["»”']$/s, '$1').trim();

export function parseEditorial(raw: string): EditorialResult {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    try {
      j = m ? JSON.parse(m[0]) : null;
    } catch {
      j = null;
    }
  }
  const res: EditorialResult = { variants: [], platforms: {} };
  if (!j || typeof j !== 'object' || Array.isArray(j)) return res;
  const o = j as Record<string, unknown>;
  if (Array.isArray(o.titles)) {
    for (const t of o.titles) {
      if (t && typeof t === 'object' && typeof (t as TitleVariant).title === 'string') {
        const title = unquote((t as TitleVariant).title).replace(/\s+/g, ' ');
        if (title) res.variants.push({ title, reason: typeof (t as TitleVariant).reason === 'string' ? (t as TitleVariant).reason.trim() : '' });
      }
    }
  }
  for (const p of PLATFORMS) {
    const v = o[p];
    if (!v || typeof v !== 'object') continue;
    const x = v as Record<string, unknown>;
    const m = cleanMeta({
      title: '',
      description: typeof x.description === 'string' ? unquote(x.description) : '',
      hashtags: Array.isArray(x.hashtags) ? x.hashtags.filter((h): h is string => typeof h === 'string') : typeof x.hashtags === 'string' ? x.hashtags : [],
    });
    res.platforms[p] = { ...m, cta: typeof x.cta === 'string' ? unquote(x.cta) : '' };
  }
  return res;
}

/** Todos los problemas de una respuesta. Una respuesta válida no tiene ninguno. */
export function validateEditorial(r: EditorialResult, ctx: EditorialContext): Issue[] {
  const issues: Issue[] = [];
  if (r.variants.length === 0) issues.push({ field: 'title', code: 'vacio', message: 'No hay variantes de título' });
  for (const v of r.variants) {
    issues.push(...textIssues('title', v.title));
    if (v.title.length > 100) issues.push({ field: 'title', code: 'longitud', message: ISSUE_TEXT.longitud });
  }
  for (const p of PLATFORMS) {
    const d = r.platforms[p];
    if (!d || !d.description) {
      issues.push({ field: 'description', code: 'vacio', message: ISSUE_TEXT.vacio, platform: p });
      continue;
    }
    issues.push(...textIssues('description', d.description, p), ...textIssues('cta', d.cta, p), ...hashtagIssues(d.hashtags, ctx, p));
    if (r.variants.some((v) => fold(v.title) === fold(d.description))) issues.push({ field: 'description', code: 'repite-titulo', message: ISSUE_TEXT['repite-titulo'], platform: p });
    if (d.description.length > Math.min(PLATFORM_LIMITS[p].description, DESCRIPTION_TARGET[p])) issues.push({ field: 'description', code: 'longitud', message: `${ISSUE_TEXT.longitud} (máx. ${DESCRIPTION_TARGET[p]} caracteres)`, platform: p });
    if (copiesTranscript(d.description, ctx.transcript)) issues.push({ field: 'description', code: 'copia', message: ISSUE_TEXT.copia, platform: p });
  }
  return issues;
}

export const describeIssues = (issues: Issue[]) => [...new Set(issues.map((i) => `${i.platform ? `${i.platform}: ` : ''}${i.field} — ${i.message}`))].slice(0, 12);

/** Quita lo inservible de una respuesta casi válida: hashtags genéricos/irrelevantes/inválidos y variantes técnicas. */
export function salvage(r: EditorialResult, ctx: EditorialContext): EditorialResult {
  const variants = r.variants.filter((v) => textIssues('title', v.title).length === 0);
  const platforms: EditorialResult['platforms'] = {};
  for (const p of PLATFORMS) {
    const d = r.platforms[p];
    if (!d) continue;
    const words = tagWords(ctx);
    const broad = broadTags(ctx);
    let broadUsed = 0;
    const tags = normalizeHashtags(d.hashtags).filter((t) => {
      const pr = tagProblem(t, words, broad);
      return pr === null || (pr === 'broad' && ++broadUsed === 1);
    });
    platforms[p] = { ...d, hashtags: tags.slice(0, 6), cta: textIssues('cta', d.cta).length ? '' : d.cta };
  }
  return { variants, platforms };
}

export type GenerateOutcome =
  | { ok: true; result: EditorialResult; attempts: number; repaired: boolean }
  | { ok: false; reason: 'contexto' | 'invalido'; issues: string[]; attempts: number };

/**
 * Genera con validación: 1) intento; 2) si falla, regenera con feedback concreto; 3) si vuelve a fallar,
 * intenta salvar quitando lo inválido; si aún así no es válido, devuelve fallo (el editor queda vacío). Nunca guarda basura.
 */
export async function generateEditorial(ctx: EditorialContext, ask: (system: string, user: string) => Promise<string>): Promise<GenerateOutcome> {
  if (!hasEnoughContext(ctx)) return { ok: false, reason: 'contexto', issues: ['La IA necesita más contexto; edita manualmente'], attempts: 0 };
  let feedback: string[] = [];
  let last: EditorialResult = { variants: [], platforms: {} };
  for (let attempt = 1; attempt <= 2; attempt++) {
    last = parseEditorial(await ask(EDITORIAL_SYSTEM_PROMPT, editorialUserPrompt(ctx, feedback)));
    const issues = validateEditorial(last, ctx);
    if (issues.length === 0) return { ok: true, result: last, attempts: attempt, repaired: false };
    feedback = describeIssues(issues);
  }
  const fixed = salvage(last, ctx);
  // Lo único que se tolera tras salvar es que queden menos hashtags de los ideales (se avisa en el editor).
  const rest = validateEditorial(fixed, ctx).filter((i) => i.code !== 'hashtags-cantidad');
  if (rest.length === 0 && fixed.variants.length > 0) return { ok: true, result: fixed, attempts: 2, repaired: true };
  return { ok: false, reason: 'invalido', issues: feedback, attempts: 2 };
}

/** Avisos en línea para lo que el usuario está editando (las palabras técnicas escritas a mano sólo avisan). */
export function liveIssues(p: Platform, m: PublishMeta & { cta?: string }, ctx?: EditorialContext): Issue[] {
  const out = [...textIssues('title', m.title, p), ...textIssues('description', m.description, p), ...textIssues('cta', m.cta ?? '', p)];
  if (ctx && m.hashtags.length) out.push(...hashtagIssues(m.hashtags, ctx, p));
  return out;
}
