import { describe, it, expect } from 'vitest';
import { AI_PROFILES, evaluateProfile, evaluateProfiles, placementFrom, placementLabel, recommendProfile, tokensPerSecond } from '../src/shared/aiProfiles';
import { MIN_WORDS_PER_SEC, diversityBonus, evaluateCandidate, selectRound, similarity, speechRate } from '../src/shared/selection';
import { parseNvidiaSmi } from '../src/main/transcribe';
import { goodClip, syntheticTranscript } from './fixtures';

const RAM_16 = 16 * 1024;

describe('perfiles de IA según VRAM/RAM', () => {
  it('hay tres perfiles con tamaño, memoria, calidad y velocidad', () => {
    expect(AI_PROFILES.map((p) => p.model)).toEqual(['qwen2.5:3b', 'qwen2.5:7b', 'llama3.1:8b']);
    for (const p of AI_PROFILES) expect(p.downloadGB && p.memoryGB && p.quality && p.speed).toBeTruthy();
  });
  it('GPU de 6 GB: 3B cabe en GPU; 7B y 8B parcialmente en CPU/RAM', () => {
    const f = Object.fromEntries(evaluateProfiles(6144, RAM_16).map((x) => [x.profile.id, x.fit]));
    expect(f).toEqual({ rapido: 'gpu', equilibrado: 'parcial', calidad: 'parcial' });
  });
  it('GPU de 12 GB: todos caben en GPU', () => {
    expect(evaluateProfiles(12288, RAM_16).every((x) => x.fit === 'gpu')).toBe(true);
  });
  it('sin GPU: CPU/RAM; con poca RAM: no cabe', () => {
    expect(evaluateProfile(AI_PROFILES[1], null, RAM_16).fit).toBe('cpu');
    expect(evaluateProfile(AI_PROFILES[2], null, 6 * 1024).fit).toBe('no-cabe');
  });
  it('recomienda 3B con 6 GB y 7B sólo si cabe entero en GPU; nunca 8B por defecto', () => {
    expect(recommendProfile(6144, RAM_16)).toBe('rapido');
    expect(recommendProfile(8192, RAM_16)).toBe('equilibrado');
    expect(recommendProfile(24576, 65536)).toBe('equilibrado');
    expect(recommendProfile(null, RAM_16)).toBe('rapido');
  });
});

describe('colocación real del modelo (/api/ps)', () => {
  it('no afirma GPU si parte del modelo está en CPU/RAM', () => {
    expect(placementFrom(3e9, 3e9).where).toBe('gpu');
    const p = placementFrom(6e9, 3.6e9);
    expect(p.where).toBe('parcial');
    expect(placementLabel(p)).toMatch(/60 % en GPU y el resto en CPU\/RAM/);
    expect(placementFrom(5e9, 0).where).toBe('cpu');
  });
  it('tokens por segundo a partir de las estadísticas de Ollama', () => {
    expect(tokensPerSecond(200, 2.5e9)).toBe(80);
    expect(tokensPerSecond(0, 0)).toBe(0);
  });
  it('nvidia-smi con memoria libre (4.ª columna)', () => {
    expect(parseNvidiaSmi('NVIDIA GeForce GTX 1660 SUPER, 6144, 616.64, 4904')).toMatchObject({ vramMB: 6144, freeMB: 4904 });
    expect(parseNvidiaSmi('GPU, 6144, 616.64')?.freeMB).toBeUndefined();
  });
});

describe('selección: ideas repetidas y diversidad temporal', () => {
  const { words } = syntheticTranscript(1200);
  it('rechaza una idea repetida con otras palabras', () => {
    const a = goodClip(0, 30, 0);
    const b = { ...goodClip(600, 30, 1), title: a.title, hook: a.hook };
    const r = selectRound([a, b], 2, { preset: 30, sourceDuration: 1200, words, taken: [] });
    expect(r.accepted).toHaveLength(1);
    expect(r.rejected.repetido).toBe(1);
    expect(similarity('Cómo ahorrar en la compra del mercado', 'Ahorrar en la compra del mercado fácil')).toBeGreaterThanOrEqual(0.6);
  });
  it('a igual puntuación prefiere un clip lejano a los ya elegidos', () => {
    const near = { ...goodClip(40, 30, 1), score: 80 };
    const far = { ...goodClip(900, 30, 2), score: 80 };
    const r = selectRound([near, far], 1, { preset: 30, sourceDuration: 1200, words, taken: [{ start: 0, end: 30 }] });
    expect(r.accepted[0].start).toBeGreaterThanOrEqual(890);
    expect(diversityBonus({ start: 900, end: 930 }, [{ start: 0, end: 30 }], 1200)).toBeGreaterThan(diversityBonus({ start: 40, end: 70 }, [{ start: 0, end: 30 }], 1200));
  });
});

describe('revisión Codex: tramos casi sin voz', () => {
  it('una sola palabra en 30 s se rechaza aunque sume bonus de claridad/duración', () => {
    const words = [{ start: 10, end: 10.5, text: ' hola' }];
    const ev = evaluateCandidate(
      { start: 0, end: 30, title: 'Un saludo inesperado al público', hook: 'Algo que nadie esperaba escuchar hoy', reason: 'Aporta un momento de sorpresa con contexto suficiente', score: 90 },
      { preset: 30, sourceDuration: 300, words, taken: [] },
    );
    expect(ev).toEqual({ ok: false, reason: 'poca_voz' });
    expect(speechRate(0, 30, words)).toBeLessThan(MIN_WORDS_PER_SEC);
  });
});
