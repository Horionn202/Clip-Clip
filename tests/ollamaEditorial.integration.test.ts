// Integración opcional: genera textos reales con Ollama local sobre un fixture. Ejecutar con:
// OLLAMA_TEST_MODEL=llama3.2:3b npx vitest run tests/ollamaEditorial.integration.test.ts
import { describe, it, expect } from 'vitest';
import { chatJson } from '../src/main/ollama';
import { buildEditorialContext, editorialSchema, generateEditorial, validateEditorial } from '../src/shared/editorial';

const model = process.env.OLLAMA_TEST_MODEL;
const TRANSCRIPT =
  'Vale, entro en el taller con el Porsche y me dicen que el motor está roto. El mecánico me cobra cinco mil dólares por la reparación. ' +
  'Le digo que es demasiado, que en otro taller me lo dejan por la mitad. Al final el Porsche sale del taller sin frenos y me estrello contra la valla. ' +
  'No me lo puedo creer, cinco mil dólares para esto. El Porsche está peor que antes.';

describe.skipIf(!model)('Ollama real: generador editorial', () => {
  it('devuelve textos válidos o un fallo controlado (nunca basura)', async () => {
    const ctx = buildEditorialContext(
      { title: 'clip_01 source.mp4', hook: 'URL de la imagen', reason: 'C:/jobs/x/frames/frame_0003.jpg', visual: { cls: 'facecam_inferior', confidence: 0.8 }, layout: 'game_top_cam_bottom' },
      TRANSCRIPT,
      { tone: 'divertido', niche: 'gaming' },
    );
    const out = await generateEditorial(ctx, (s, u) => chatJson('http://127.0.0.1:11434', model!, s, u, new AbortController().signal, { schema: editorialSchema(), numPredict: 1400, temperature: 0.5 }));
    console.log(JSON.stringify(out, null, 2));
    if (out.ok) expect(validateEditorial(out.result, ctx).filter((i) => i.code !== 'hashtags-cantidad')).toEqual([]);
  }, 300_000);
});
