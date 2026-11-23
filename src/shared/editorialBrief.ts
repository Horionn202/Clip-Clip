// Brief editorial del vídeo (primera pasada ligera de IA) y criterios de calidad de la selección. Puro.
// El brief dice DE QUÉ va el vídeo (título, tema, eventos) para que la selección busque momentos que cumplan
// la promesa del título en vez de repartir una cuota de clips por minutos.
import type { TimedWord } from './selection';

export type MomentType = 'revelacion' | 'accion' | 'reaccion' | 'humor' | 'logro' | 'conflicto' | 'explicacion' | 'relleno';
export const MOMENT_TYPES: MomentType[] = ['revelacion', 'accion', 'reaccion', 'humor', 'logro', 'conflicto', 'explicacion', 'relleno'];
export const MOMENT_LABELS: Record<MomentType, string> = {
  revelacion: 'Revelación',
  accion: 'Acción',
  reaccion: 'Reacción',
  humor: 'Humor',
  logro: 'Logro',
  conflicto: 'Conflicto',
  explicacion: 'Explicación',
  relleno: 'Relleno',
};

/** Calidad de la selección: cuánto busca la IA (no cambia el modelo ni descarga nada). */
export type SelectionQuality = 'rapida' | 'equilibrada' | 'estricta';
export const SELECTION_QUALITIES: SelectionQuality[] = ['rapida', 'equilibrada', 'estricta'];
export const QUALITY_PROFILES: Record<SelectionQuality, { label: string; note: string; fillRounds: number; chunkChars: number }> = {
  rapida: { label: 'Rápida', note: 'Una sola pasada sobre el vídeo.', fillRounds: 0, chunkChars: 12000 },
  equilibrada: { label: 'Equilibrada', note: 'Una pasada y una búsqueda extra en los tramos libres.', fillRounds: 1, chunkChars: 12000 },
  estricta: { label: 'Estricta', note: 'Análisis más profundo (fragmentos más pequeños y más búsquedas). Puede tardar bastante más.', fillRounds: 2, chunkChars: 7000 },
};
export const DEFAULT_SELECTION_QUALITY: SelectionQuality = 'equilibrada';
/** Puntuación editorial mínima (0–100) para marcar un clip como destacado. */
export const DEFAULT_MIN_CLIP_SCORE = 70;

export interface BriefEvent {
  /** Segundo aproximado del vídeo. */
  t: number;
  label: string;
}

export interface EditorialBrief {
  mainTopic: string;
  subtopics: string[];
  /** Eventos principales, ordenados por tiempo. */
  keyEvents: BriefEvent[];
  /** Palabras y entidades importantes (en minúsculas, sin tildes). */
  keywords: string[];
  /** Qué promete el título. */
  titlePromise: string;
  /** Momentos que cumplen esa promesa. */
  promiseMoments: BriefEvent[];
  /** 'ia' si lo generó el modelo; 'local' si se dedujo del título (la IA falló). */
  source: 'ia' | 'local';
}

const STOP = new Set(
  'que los las del con por para una uno unos unas como pero mas muy este esta esto estos estas ese esa eso aqui ahi alli hay ser son fue era sin sobre entre cuando donde todo toda todos todas nada algo cada porque tambien solo asi ya mis tus sus nos les the and for with you your this that from are was have has not but all his her its our out who what when why how video videos parte capitulo episodio nuevo nueva gente vale bueno pues vamos'.split(
    ' ',
  ),
);

/** Normaliza: minúsculas, sin tildes ni signos. */
export function normWords(s: string): string[] {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Palabras con significado (≥ 3 letras, sin vacías); los números sueltos sólo si van pegados a letras (p. ej. «gta6»). */
export function contentWords(s: string): string[] {
  return normWords(s).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
}

/** Palabras clave del tema: las del brief y las del título (sin duplicados). */
export function topicKeywords(brief: EditorialBrief | undefined, title: string): string[] {
  const out = new Set<string>(contentWords(title));
  if (brief) {
    for (const k of brief.keywords) for (const w of contentWords(k)) out.add(w);
    for (const w of contentWords(brief.mainTopic)) out.add(w);
  }
  return [...out].slice(0, 40);
}

/** Cuántas palabras clave distintas aparecen en el texto (con raíz: «carreras» cuenta como «carrera»). */
export function topicHits(text: string, keywords: string[]): number {
  if (!keywords.length) return 0;
  const ws = new Set(contentWords(text));
  let n = 0;
  for (const k of keywords) {
    const stem = k.length > 5 ? k.slice(0, k.length - 2) : k;
    if (ws.has(k) || [...ws].some((w) => w.length > 5 && w.startsWith(stem))) n++;
  }
  return n;
}

/** Relevancia local 0–100 del texto respecto al tema (sin IA): proporción de palabras clave del tema presentes. */
export function localTopicRelevance(text: string, keywords: string[]): number {
  if (!keywords.length) return 50;
  const need = Math.min(3, keywords.length);
  return Math.round(Math.min(1, topicHits(text, keywords) / need) * 100);
}

// ---- Brief: prompt, esquema y validación ----

export const BRIEF_SYSTEM_PROMPT = `Eres un editor jefe de vídeos cortos. Recibes el título, la descripción y la transcripción (resumida) de un vídeo.
Tu trabajo NO es elegir clips todavía: es entender de qué va el vídeo y qué promete el título.
Responde SÓLO con JSON válido con esta forma:
{"tema_principal":"...","subtemas":["..."],"eventos_principales":[{"t":<segundos>,"evento":"..."}],"palabras_clave":["..."],"promesa_titulo":"...","momentos_promesa":[{"t":<segundos>,"evento":"..."}]}
Reglas:
- tema_principal: una frase concreta (qué pasa en el vídeo), basada en el título y lo que se dice.
- eventos_principales: lo que REALMENTE ocurre, en orden, con el segundo aproximado en que empieza.
- palabras_clave: nombres, juegos, personas, objetos y acciones importantes (no palabras vacías).
- promesa_titulo: qué espera ver quien hace clic en el título.
- momentos_promesa: los momentos de la transcripción que cumplen esa promesa (con su segundo aproximado).
- No inventes nada que no esté en el título, la descripción o la transcripción.
- Escribe en el idioma del vídeo.`;

export function briefSchema(): object {
  const ev = { type: 'object', properties: { t: { type: 'number' }, evento: { type: 'string' } }, required: ['t', 'evento'] };
  return {
    type: 'object',
    properties: {
      tema_principal: { type: 'string' },
      subtemas: { type: 'array', maxItems: 6, items: { type: 'string' } },
      eventos_principales: { type: 'array', maxItems: 12, items: ev },
      palabras_clave: { type: 'array', maxItems: 15, items: { type: 'string' } },
      promesa_titulo: { type: 'string' },
      momentos_promesa: { type: 'array', maxItems: 8, items: ev },
    },
    required: ['tema_principal', 'subtemas', 'eventos_principales', 'palabras_clave', 'promesa_titulo', 'momentos_promesa'],
  };
}

/** Transcripción condensada (≤ maxChars) repartida por todo el vídeo, con marcas de tiempo. */
export function condensedTranscript(segments: TimedWord[], maxChars = 9000): string {
  const all = segments.map((g) => `[${Math.round(g.start)}] ${g.text.replace(/\s+/g, ' ').trim()}`);
  const total = all.reduce((a, l) => a + l.length + 1, 0);
  if (total <= maxChars) return all.join('\n');
  const step = total / maxChars;
  const out: string[] = [];
  let acc = 0;
  for (let i = 0; i < all.length; i++) {
    acc += 1;
    if (acc >= step) {
      out.push(all[i]);
      acc -= step;
    }
  }
  return out.join('\n').slice(0, maxChars);
}

export function briefUserPrompt(o: { title: string; description?: string; duration: number; segments: TimedWord[] }): string {
  return `TÍTULO DEL VÍDEO: ${o.title || '(sin título)'}
DESCRIPCIÓN: ${(o.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 800) || '(sin descripción)'}
DURACIÓN: ${Math.round(o.duration)} s

TRANSCRIPCIÓN (resumida, [segundo] texto):
${condensedTranscript(o.segments)}`;
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const events = (v: unknown, duration: number, max: number): BriefEvent[] =>
  (Array.isArray(v) ? v : [])
    .map((e) => {
      const r = (e ?? {}) as Record<string, unknown>;
      const t = typeof r.t === 'number' ? r.t : Number(r.t);
      return { t, label: str(r.evento ?? r.label ?? r.event, 140) };
    })
    .filter((e) => Number.isFinite(e.t) && e.t >= 0 && e.t <= duration + 1 && e.label.length >= 3)
    .sort((a, b) => a.t - b.t)
    .slice(0, max);

/** Valida el brief devuelto por la IA. null si no es utilizable (se usa el brief local). Nunca lanza. */
export function parseBrief(raw: string, duration: number): EditorialBrief | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      data = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  const mainTopic = str(r.tema_principal ?? r.mainTopic, 200);
  if (mainTopic.length < 6) return null;
  const list = (v: unknown, n: number, max: number) => (Array.isArray(v) ? v.map((x) => str(x, max)).filter((x) => x.length >= 2).slice(0, n) : []);
  return {
    mainTopic,
    subtopics: list(r.subtemas ?? r.subtopics, 6, 100),
    keyEvents: events(r.eventos_principales ?? r.keyEvents, duration, 12),
    keywords: [...new Set(list(r.palabras_clave ?? r.keywords, 15, 40).map((k) => normWords(k).join(' ')).filter((k) => k.length >= 3))],
    titlePromise: str(r.promesa_titulo ?? r.titlePromise, 200),
    promiseMoments: events(r.momentos_promesa ?? r.promiseMoments, duration, 8),
    source: 'ia',
  };
}

/** Brief mínimo deducido del título y la descripción (cuando la IA no devuelve uno válido). */
export function fallbackBrief(title: string, description?: string): EditorialBrief {
  const kws = [...new Set([...contentWords(title), ...contentWords(description ?? '').slice(0, 5)])].slice(0, 12);
  return { mainTopic: title || 'Vídeo', subtopics: [], keyEvents: [], keywords: kws, titlePromise: title, promiseMoments: [], source: 'local' };
}

/** Texto compacto del brief para las rondas de selección. */
export function briefForPrompt(title: string, b: EditorialBrief): string {
  const ev = (xs: BriefEvent[]) => xs.map((e) => `${Math.round(e.t)}s: ${e.label}`).join(' | ');
  return [
    `TÍTULO: ${title || '(sin título)'}`,
    `TEMA PRINCIPAL: ${b.mainTopic}`,
    b.titlePromise ? `PROMESA DEL TÍTULO: ${b.titlePromise}` : '',
    b.subtopics.length ? `SUBTEMAS: ${b.subtopics.join(', ')}` : '',
    b.keywords.length ? `PALABRAS CLAVE: ${b.keywords.join(', ')}` : '',
    b.keyEvents.length ? `EVENTOS POSIBLES (sin verificar, compruébalos en la transcripción): ${ev(b.keyEvents)}` : '',
    b.promiseMoments.length ? `MOMENTOS POSIBLES DE LA PROMESA (sin verificar): ${ev(b.promiseMoments)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Ponderación editorial (0–100): la relevancia al tema pesa más que nada. */
export function editorialScore(p: { topicRelevance: number; hookStrength: number; payoffStrength: number; selfContained: number; local: number }): number {
  const s = 0.45 * p.topicRelevance + 0.2 * p.hookStrength + 0.2 * p.payoffStrength + 0.1 * p.selfContained + 0.05 * p.local;
  return Math.round(Math.max(0, Math.min(100, s)));
}

/** Resumen: cuántos clips se generaron y cuántos son destacados (superan el filtro de calidad). */
export function qualitySummary(obtained: number, max: number, featured: number): string {
  const total = `${obtained} clip${obtained === 1 ? '' : 's'} generado${obtained === 1 ? '' : 's'} (hasta ${max})`;
  if (featured === 0) return `${total}. Ningún destacado verificado: quedan como otros momentos, revísalos antes de publicar.`;
  return `${total} · ${featured} ${featured === 1 ? 'destacado verificado' : 'destacados verificados'} con evidencia.`;
}
