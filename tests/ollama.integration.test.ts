// Integración opcional con Ollama local. Ejecutar con: OLLAMA_TEST_MODEL=llama3.2:latest npm test
import { describe, it, expect } from 'vitest';
import { chatJson } from '../src/main/ollama';
import { normalizeCandidates, parseModelResponse } from '../src/shared/validation';

const model = process.env.OLLAMA_TEST_MODEL;

describe.skipIf(!model)('Ollama real', () => {
  it('devuelve candidatos que pasan la normalización', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `[${(i * 10).toFixed(1)}-${(i * 10 + 10).toFixed(1)}] Frase número ${i} sobre cómo ahorrar dinero en casa con un truco ${i % 3 === 0 ? 'sorprendente' : 'sencillo'}.`);
    const raw = await chatJson(
      'http://127.0.0.1:11434',
      model!,
      'Responde SÓLO JSON: {"clips":[{"start":0,"end":30,"title":"","hook":"","reason":"","score":0}]}',
      `Duración 400 s. Elige 3 clips de unos 30 s.\n${lines.join('\n')}`,
      new AbortController().signal,
    );
    const r = normalizeCandidates(parseModelResponse(raw), { preset: 30, maxClips: 3, sourceDuration: 400 });
    expect(r.clips.length).toBeLessThanOrEqual(3);
    for (const c of r.clips) expect(c.end - c.start).toBeLessThanOrEqual(31);
  }, 300000);
});
