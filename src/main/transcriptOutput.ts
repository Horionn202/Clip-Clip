// Localiza y valida el JSON que genera Whisper. Un código de salida 0 NO implica transcripción válida:
// el CLI de openai-whisper captura las excepciones («Skipping … due to …») y sale con 0 sin escribir nada.
import fs from 'node:fs';
import path from 'node:path';

export interface TranscriptCheck {
  ok: boolean;
  file: string | null;
  error?: string;
  segments?: number;
}

/** Valida contenido: JSON parseable, lista de segmentos no vacía y timestamps numéricos coherentes. */
export function validateTranscriptJson(raw: string): { ok: true; segments: number } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `JSON no parseable: ${(e as Error).message.slice(0, 200)}` };
  }
  const segs = (data as { segments?: unknown })?.segments;
  if (!Array.isArray(segs)) return { ok: false, error: 'El JSON no tiene «segments».' };
  if (segs.length === 0) return { ok: false, error: 'El JSON no contiene segmentos.' };
  let withText = 0;
  for (const s of segs) {
    const o = s as { start?: unknown; end?: unknown; text?: unknown };
    if (typeof o.start !== 'number' || typeof o.end !== 'number' || !Number.isFinite(o.start) || !Number.isFinite(o.end) || o.end < o.start) {
      return { ok: false, error: 'Hay segmentos con marcas de tiempo inválidas.' };
    }
    if (typeof o.text === 'string' && o.text.trim()) withText++;
  }
  if (withText === 0) return { ok: false, error: 'Los segmentos no contienen texto.' };
  return { ok: true, segments: segs.length };
}

/** Archivos que la app crea en la carpeta del trabajo y que nunca son la salida de Whisper. */
const NOT_OUTPUT = new Set(['transcript.json']);

/**
 * Busca la salida en `dir`: primero `<audioBase>.json` (nombre esperado del CLI) y después cualquier
 * .json creado/modificado desde `sinceMs` (por si el CLI cambia el nombre). Devuelve el primero válido.
 */
export function locateTranscript(dir: string, audioBase: string, sinceMs: number): TranscriptCheck {
  const expected = `${audioBase}.json`;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { ok: false, file: null, error: 'No se pudo leer la carpeta del trabajo.' };
  }
  const recent = names.filter((n) => {
    if (!n.toLowerCase().endsWith('.json') || NOT_OUTPUT.has(n) || n === expected) return false;
    try {
      return fs.statSync(path.join(dir, n)).mtimeMs >= sinceMs - 1000;
    } catch {
      return false;
    }
  });
  const candidates = [...(names.includes(expected) ? [expected] : []), ...recent];
  if (candidates.length === 0) return { ok: false, file: null, error: `No se creó ningún JSON (esperado: ${expected}).` };
  let lastError = '';
  for (const n of candidates) {
    const full = path.join(dir, n);
    let raw: string;
    try {
      raw = fs.readFileSync(full, 'utf8');
    } catch (e) {
      lastError = `No se pudo leer ${n}: ${(e as Error).message}`;
      continue;
    }
    const v = validateTranscriptJson(raw);
    if (v.ok) return { ok: true, file: full, segments: v.segments };
    lastError = `${n}: ${v.error}`;
  }
  return { ok: false, file: null, error: lastError };
}

/** Últimas `n` líneas no vacías (para logs). */
export function tailLines(text: string, n = 20): string[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-n)
    .map((l) => l.slice(0, 400));
}

/** Sustituye rutas absolutas por su nombre de archivo (no se registran rutas del usuario). */
export function sanitizeArgs(args: string[]): string[] {
  return args.map((a) => (/^[A-Za-z]:[\\/]|^\//.test(a) ? `<${path.basename(a)}>` : a));
}

export function listFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).slice(0, 50);
  } catch {
    return [];
  }
}
