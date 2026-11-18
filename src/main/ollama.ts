// Cliente HTTP mínimo para Ollama local (sin dependencias externas).
import type { PullProgress } from '../shared/types';
import { UserFacingError } from '../shared/validation';
import { CancelledError } from './proc';

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

export async function pullModel(host: string, model: string, onProgress: (p: PullProgress) => void): Promise<void> {
  assertLocal(host);
  const r = await fetch(`${host}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
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

export async function chatJson(host: string, model: string, system: string, user: string, signal: AbortSignal): Promise<string> {
  assertLocal(host);
  let r: Response;
  try {
    r = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15 * 60 * 1000)]),
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        options: { temperature: 0.3, num_ctx: 8192 },
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
  if (!r.ok) throw new UserFacingError(`Ollama respondió con error ${r.status}.`, await r.text().catch(() => ''));
  const j = (await r.json()) as { message?: { content?: string } };
  return j.message?.content ?? '';
}
