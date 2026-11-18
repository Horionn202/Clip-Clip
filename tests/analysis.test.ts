import { describe, it, expect } from 'vitest';
import { analyzeClips, type ChatFn } from '../src/main/analysis';
import { overlaps } from '../src/shared/validation';
import { goodClip, syntheticTranscript } from './fixtures';

const D = 421.86;
const { words, segments } = syntheticTranscript(D);

function scripted(responses: unknown[]): { chat: ChatFn; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    chat: async (_s, user) => {
      calls.push(user);
      const r = responses[Math.min(calls.length - 1, responses.length - 1)];
      return typeof r === 'string' ? r : JSON.stringify(r);
    },
  };
}

const base = { segments, words, duration: D, preset: 30 as const };

describe('análisis por rondas', () => {
  it('pide la meta exacta en la primera ronda', async () => {
    const { chat, calls } = scripted([{ clips: [0, 60, 120, 180, 240].map((s, i) => goodClip(s, 30, i)) }]);
    const r = await analyzeClips({ ...base, userTarget: 5, chat });
    expect(calls[0]).toMatch(/Genera exactamente 5 candidatos/);
    expect(r.clips).toHaveLength(5);
    expect(r.report).toMatchObject({ target: 5, feasibleMax: 14, effectiveTarget: 5, obtained: 5 });
    expect(r.report.partialReason).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('reintenta cuando la primera ronda devuelve menos de la meta (1 de 5 → 5 de 5)', async () => {
    const { chat, calls } = scripted([
      { clips: [goodClip(30, 30, 0)] },
      { clips: [100, 160, 220, 280].map((s, i) => goodClip(s, 30, i + 1)) },
    ]);
    const r = await analyzeClips({ ...base, userTarget: 5, chat });
    expect(r.clips).toHaveLength(5);
    expect(calls[1]).toMatch(/Faltan 4/);
    expect(calls[1]).toMatch(/30\.0-60\.0/); // envía los intervalos ya elegidos
    expect(r.report.rounds.map((x) => x.accepted)).toEqual([1, 4]);
    for (let i = 1; i < r.clips.length; i++) expect(overlaps(r.clips[i - 1], r.clips[i])).toBe(false);
  });

  it('descarta placeholders y repetidos y lo registra por ronda', async () => {
    const { chat } = scripted([
      { clips: [goodClip(0, 30, 0), { ...goodClip(100, 30, 1), hook: 'frase gancho de apertura' }, { ...goodClip(200, 30, 2), reason: '¿Por qué funciona?' }] },
      { clips: [goodClip(5, 30, 0)] }, // solapa con el ya elegido
    ]);
    const r = await analyzeClips({ ...base, userTarget: 3, chat });
    expect(r.report.rounds[0].rejected).toMatchObject({ placeholder: 1, razon: 1 });
    expect(r.report.rounds[1].rejected).toMatchObject({ solape: 1 });
    expect(r.report.obtained).toBe(1);
    expect(r.report.rejected).toBe(3);
  });

  it('termina de forma segura si no aparecen más clips (sin bucles)', async () => {
    const { chat, calls } = scripted([{ clips: [goodClip(0, 30, 0)] }, { clips: [] }]);
    const r = await analyzeClips({ ...base, userTarget: 5, chat, maxFillRounds: 3 });
    expect(r.clips).toHaveLength(1);
    expect(calls).toHaveLength(2); // se detiene tras una ronda sin aportes
    expect(r.report.partialReason).toMatch(/no se encontraron más momentos/);
  });

  it('limita las rondas aunque el modelo siga aportando de uno en uno', async () => {
    let i = 0;
    const chat: ChatFn = async () => JSON.stringify({ clips: [goodClip(i * 40, 30, i++)] });
    const r = await analyzeClips({ ...base, userTarget: 10, chat, maxFillRounds: 3 });
    expect(r.report.rounds).toHaveLength(4);
    expect(r.clips).toHaveLength(4);
  });

  it('un fallo de conexión en una ronda no tumba el análisis', async () => {
    let n = 0;
    const chat: ChatFn = async () => {
      n++;
      if (n === 1) return JSON.stringify({ clips: [goodClip(0, 30, 0)] });
      throw new Error('Ollama tardó demasiado en responder.');
    };
    const r = await analyzeClips({ ...base, userTarget: 3, chat, maxFillRounds: 1 });
    expect(r.clips).toHaveLength(1);
    expect(r.report.rounds[1].failed).toBe(true);
  });

  it('Ollama caído en todas las rondas → mensaje claro con la causa', async () => {
    const chat: ChatFn = async () => {
      throw new Error('No se pudo contactar con Ollama. Comprueba que el servicio está abierto.');
    };
    await expect(analyzeClips({ ...base, userTarget: 3, chat })).rejects.toThrow(/No se pudo contactar con Ollama/);
  });

  it('pasa a la IA el máximo de elementos para la salida estructurada', async () => {
    const seen: number[] = [];
    const chat: ChatFn = async (_s, _u, maxItems) => {
      seen.push(maxItems);
      return JSON.stringify({ clips: [0, 60, 120, 180, 240].map((s, i) => goodClip(s, 30, i)) });
    };
    await analyzeClips({ ...base, userTarget: 5, chat });
    expect(seen[0]).toBe(7);
  });

  it('JSON inválido en todas las rondas → error claro', async () => {
    const { chat } = scripted(['esto no es json']);
    await expect(analyzeClips({ ...base, userTarget: 5, chat })).rejects.toThrow(/respuestas no válidas/);
  });

  it('nunca supera 20 aunque el modelo devuelva 40', async () => {
    const long = syntheticTranscript(1500);
    const { chat } = scripted([{ clips: Array.from({ length: 40 }, (_, k) => goodClip(k * 35, 30, k)) }]);
    const r = await analyzeClips({ segments: long.segments, words: long.words, duration: 1500, preset: 30, userTarget: 20, chat });
    expect(r.clips.length).toBeLessThanOrEqual(20);
  });

  it('se puede cancelar entre rondas', async () => {
    const { chat } = scripted([{ clips: [goodClip(0, 30, 0)] }]);
    let n = 0;
    await expect(
      analyzeClips({
        ...base,
        userTarget: 5,
        chat,
        checkCancelled: () => {
          if (n++ > 0) throw new Error('cancelado');
        },
      }),
    ).rejects.toThrow('cancelado');
  });
});
