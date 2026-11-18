// Cliente HTTP mínimo para Ollama local (sin dependencias externas).
import type { PullProgress } from '../shared/types';
import { UserFacingError } from '../shared/validation';
import { CancelledError } from './proc';
import { placementFrom, tokensPerSecond, type BenchmarkResult, type Placement } from '../shared/aiProfiles';

function assertLocal(host: string): void {
  const u = new URL(host);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new UserFacingError('Ollama debe ejecutarse en local.');
}

export async function listModels(host: string, timeoutMs = 5000): Promise<string[]> {
  assertLocal(host);
  const r = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`Ollama /api/tags ${r.status}`);
  const j = (await r.json()) as { models?: { name: string }[] };
  return (j.models ?? []).map((m) => m.name);
}

/** Dónde está cargado el modelo según /api/ps (size vs size_vram). null si no está cargado. */
export async function modelPlacement(host: string, model: string): Promise<Placement | null> {
  try {
    assertLocal(host);
    const r = await fetch(`${host}/api/ps`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { models?: { name: string; model?: string; size?: number; size_vram?: number }[] };
    const m = (j.models ?? []).find((x) => x.name === model || x.model === model || x.name === `${model}:latest`);
    return m && m.size ? placementFrom(m.size, m.size_vram ?? 0) : null;
  } catch {
    return null;
  }
}

/** Benchmark corto: prompt estructurado pequeño, mide tokens/s y dónde quedó cargado el modelo. */
export async function benchmarkModel(host: string, model: string, signal: AbortSignal): Promise<BenchmarkResult> {
  assertLocal(host);
  const t0 = Date.now();
  let r: Response;
  try {
    r = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(5 * 60 * 1000)]),
      body: JSON.stringify({
        model,
        stream: false,
        format: clipsSchema(2),
        keep_alive: '1m',
        options: { temperature: 0, num_ctx: 8192, num_predict: 200 },
        messages: [
          { role: 'system', content: 'Responde sólo JSON.' },
          {
            role: 'user',
            content:
              'Transcripción: [0.0-30.0] Hoy os enseño tres trucos para ahorrar en la compra. [30.0-60.0] El primero es hacer una lista y no salirse de ella. Devuelve 2 clips con start, end, title, hook, reason y score.',
          },
        ],
      }),
    });
  } catch (e) {
    if (signal.aborted) throw new CancelledError();
    throw new UserFacingError('No se pudo contactar con Ollama para el benchmark.', String(e));
  }
  if (r.status === 404) throw new UserFacingError(`El modelo «${model}» no está descargado.`);
  if (!r.ok) throw new UserFacingError(`Ollama respondió con error ${r.status}.`);
  const j = (await r.json()) as { message?: { content?: string }; eval_count?: number; eval_duration?: number; load_duration?: number };
  let validJson = false;
  try {
    validJson = Array.isArray((JSON.parse(j.message?.content ?? '') as { clips?: unknown }).clips);
  } catch {
    validJson = false;
  }
  const placement = (await modelPlacement(host, model)) ?? undefined;
  // Libera la VRAM tras medir: el modelo del benchmark puede no ser el del próximo trabajo.
  await unloadModel(host, model);
  return {
    model,
    tokensPerSec: tokensPerSecond(j.eval_count ?? 0, j.eval_duration ?? 0),
    loadSec: Math.round(((j.load_duration ?? 0) / 1e9) * 10) / 10,
    totalSec: Math.round((Date.now() - t0) / 100) / 10,
    placement,
    validJson,
    at: new Date().toISOString(),
  };
}

export async function pullModel(host: string, model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void> {
  assertLocal(host);
  const r = await fetch(`${host}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
    signal,
  });
  if (!r.ok || !r.body) throw new UserFacingError(`No se pudo descargar el modelo (${r.status}).`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const l of lines) {
      if (!l.trim()) continue;
      const ev = JSON.parse(l) as { status?: string; completed?: number; total?: number; error?: string };
      if (ev.error) throw new UserFacingError(`Ollama: ${ev.error}`);
      onProgress({ model, status: ev.status ?? '', completed: ev.completed, total: ev.total, done: ev.status === 'success' });
    }
  }
}

export async function chatJson(host: string, model: string, system: string, user: string, signal: AbortSignal, opts: ChatOptions = {}): Promise<string> {
  assertLocal(host);
  let r: Response;
  // stream:true → las cabeceras llegan enseguida (evita el límite de 5 min de cabeceras de fetch);
  // format con esquema JSON + num_predict acotan la salida y evitan generaciones desbocadas.
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 6 * 60 * 1000);
  try {
    r = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.any([signal, timeout]),
      body: JSON.stringify({
        model,
        stream: true,
        format: opts.maxItems ? clipsSchema(opts.maxItems) : 'json',
        keep_alive: '5m',
        options: { temperature: 0.3, num_ctx: 8192, num_predict: opts.numPredict ?? 2048 },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
  } catch (e) {
    if (signal.aborted) throw new CancelledError();
    throw new UserFacingError('No se pudo contactar con Ollama. Comprueba que el servicio está abierto.', String(e));
  }
  if (r.status === 404) throw new UserFacingError(`El modelo «${model}» no está descargado en Ollama.`);
  if (!r.ok || !r.body) throw new UserFacingError(`Ollama respondió con error ${r.status}.`, await r.text().catch(() => ''));
  let content = '';
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) {
        if (!l.trim()) continue;
        const ev = JSON.parse(l) as { message?: { content?: string }; error?: string };
        if (ev.error) throw new UserFacingError(`Ollama: ${ev.error}`);
        content += ev.message?.content ?? '';
      }
    }
  } catch (e) {
    if (signal.aborted) throw new CancelledError();
    if (timeout.aborted) throw new UserFacingError('Ollama tardó demasiado en responder.', content.slice(0, 500));
    throw e;
  }
  return content;
}

export interface ChatOptions {
  /** Si se indica, se usa salida estructurada con este máximo de clips. */
  maxItems?: number;
  numPredict?: number;
  timeoutMs?: number;
}

/** Esquema JSON (structured outputs de Ollama) para la lista de clips. */
export function clipsSchema(maxItems: number): object {
  return {
    type: 'object',
    properties: {
      clips: {
        type: 'array',
        maxItems,
        items: {
          type: 'object',
          properties: {
            start: { type: 'number' },
            end: { type: 'number' },
            title: { type: 'string' },
            hook: { type: 'string' },
            reason: { type: 'string' },
            score: { type: 'number' },
          },
          required: ['start', 'end', 'title', 'hook', 'reason', 'score'],
        },
      },
    },
    required: ['clips'],
  };
}

/** Libera el modelo de la VRAM (keep_alive: 0) para dejar sitio a Whisper en GPU. No falla si Ollama no responde. */
export async function unloadModel(host: string, model: string): Promise<boolean> {
  try {
    assertLocal(host);
    const r = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ model, keep_alive: 0 }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
