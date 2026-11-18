import { describe, it, expect } from 'vitest';
import {
  effectiveTarget,
  evaluateCandidate,
  feasibilityAdvice,
  feasibleMax,
  freeGaps,
  isGenericText,
  requiredDuration,
  resultSummary,
  selectRound,
} from '../src/shared/selection';
import { overlaps } from '../src/shared/validation';
import { goodClip, syntheticTranscript } from './fixtures';

describe('máximo teórico y meta efectiva', () => {
  it('vídeo de 421.86 s con preset 30 s → máximo 14; meta 5 se mantiene en 5', () => {
    expect(feasibleMax(421.86, 30)).toBe(14);
    expect(effectiveTarget(5, 421.86, 30)).toBe(5);
    expect(effectiveTarget(20, 421.86, 30)).toBe(14);
  });
  it('tope absoluto de 20 aunque el vídeo dé para más', () => {
    expect(feasibleMax(3600, 15)).toBe(20);
    expect(effectiveTarget(50, 3600, 15)).toBe(20);
  });
  it('20 clips de 30 s requieren al menos 600 s', () => {
    expect(requiredDuration(20, 30)).toBe(600);
    expect(feasibleMax(600, 30)).toBe(20);
    expect(feasibleMax(599, 30)).toBe(19);
  });
  it('vídeo más corto que un clip → 0 y recomendación', () => {
    expect(feasibleMax(20, 30)).toBe(0);
    expect(effectiveTarget(5, 20, 30)).toBe(0);
    expect(feasibilityAdvice(5, 20, 30)).toMatch(/preset más corto/);
    expect(feasibilityAdvice(20, 421.86, 30)).toMatch(/como máximo 14/);
    expect(feasibilityAdvice(5, 421.86, 30)).toBeNull();
  });
});

describe('validación de calidad de candidatos', () => {
  const { words } = syntheticTranscript(421.86);
  const o = { preset: 30 as const, sourceDuration: 421.86, words, taken: [] };

  it('acepta un candidato concreto y le da puntuación local', () => {
    const ev = evaluateCandidate(goodClip(40), o);
    expect(ev.ok).toBe(true);
    if (ev.ok) {
      expect(ev.candidate.localScore).toBeGreaterThan(0);
      expect(ev.candidate.end - ev.candidate.start).toBeLessThanOrEqual(31);
    }
  });
  it.each([
    [{ hook: 'frase gancho de apertura' }, 'placeholder'],
    [{ title: 'título corto y llamativo' }, 'placeholder'],
    [{ reason: '¿Por qué funciona?' }, 'razon'],
    [{ reason: 'por qué funciona' }, 'razon'],
    [{ title: 'Clip 3' }, 'titulo'],
    [{ title: '' }, 'titulo'],
    [{ reason: 'N/A' }, 'razon'],
  ])('rechaza texto genérico/plantilla %j', (patch, reason) => {
    const ev = evaluateCandidate({ ...goodClip(40), ...patch }, o);
    expect(ev).toEqual({ ok: false, reason });
  });
  it('repara un hook genérico o copiado del título con la frase real de apertura', () => {
    for (const hook of ['hook', '', 'Cómo resolver el problema número 1']) {
      const ev = evaluateCandidate({ ...goodClip(40), hook }, o);
      expect(ev.ok).toBe(true);
      if (ev.ok) expect(ev.candidate.hook).toMatch(/^Voz\d+/);
    }
  });
  it('sin transcripción no puede reparar el hook → lo rechaza', () => {
    expect(evaluateCandidate({ ...goodClip(40), hook: 'hook' }, { ...o, words: [] })).toEqual({ ok: false, reason: 'hook' });
  });
  it('rechaza timestamps imposibles', () => {
    expect(evaluateCandidate({ ...goodClip(40), start: 500, end: 530 }, o)).toEqual({ ok: false, reason: 'timestamps' });
    expect(evaluateCandidate({ ...goodClip(40), start: 50, end: 40 }, o)).toEqual({ ok: false, reason: 'timestamps' });
    expect(evaluateCandidate('x', o)).toEqual({ ok: false, reason: 'formato' });
  });
  it('rechaza solapes con clips ya elegidos', () => {
    const ev = evaluateCandidate(goodClip(50), { ...o, taken: [{ start: 40, end: 70 }] });
    expect(ev).toEqual({ ok: false, reason: 'solape' });
  });
  it('ignora scores fuera de rango (no dependen sólo del LLM)', () => {
    const ev = evaluateCandidate({ ...goodClip(40), score: 9999 }, o);
    expect(ev.ok && ev.candidate.llmScore).toBe(null);
  });
  it('rechaza tramos sin voz', () => {
    const ev = evaluateCandidate(goodClip(40), { ...o, words: words.filter((w) => w.start < 30) });
    expect(ev).toEqual({ ok: false, reason: 'poca_voz' });
  });
  it('isGenericText', () => {
    expect(isGenericText('Momento interesante', 6)).toBe(true);
    expect(isGenericText('Cómo ahorré 300 € en un mes', 6)).toBe(false);
  });
});

describe('selección por ronda', () => {
  const { words } = syntheticTranscript(421.86);
  it('elige sin solapes y respeta lo que falta', () => {
    const raws = [goodClip(0, 30, 0), goodClip(10, 30, 1), goodClip(100, 30, 2), goodClip(200, 30, 3)];
    const r = selectRound(raws, 2, { preset: 30, sourceDuration: 421.86, words, taken: [] });
    expect(r.accepted).toHaveLength(2);
    expect(overlaps(r.accepted[0], r.accepted[1])).toBe(false);
    expect((r.rejected.solape ?? 0) + (r.rejected.sobrante ?? 0)).toBeGreaterThan(0);
  });
  it('freeGaps devuelve sólo huecos del tamaño del preset', () => {
    expect(freeGaps([{ start: 10, end: 40 }, { start: 60, end: 90 }], 130, 30)).toEqual([{ start: 90, end: 130 }]);
  });
});

describe('mensaje final obtenidos/meta', () => {
  it('completo y parcial', () => {
    expect(resultSummary(5, 5)).toBe('5/5 clips generados');
    expect(resultSummary(3, 5)).toBe('3/5 clips generados: no se encontraron más momentos distintos que cumplan los criterios');
    expect(resultSummary(3, 5, 'otra causa')).toBe('3/5 clips generados: otra causa');
  });
});

describe('revisión Codex: sin recorte antes de puntuar', () => {
  it('un candidato mejor tras 100 peores sigue ganando', () => {
    const { words: w } = syntheticTranscript(5000);
    const weak = Array.from({ length: 100 }, (_, k) => ({ ...goodClip(k * 31, 30, k), score: 1, hook: 'Nada que ver con el contenido real del clip' }));
    const strong = { ...goodClip(4000, 30, 7), score: 100 };
    const r = selectRound([...weak, strong], 1, { preset: 30, sourceDuration: 5000, words: w, taken: [] });
    expect(r.accepted[0].start).toBeGreaterThanOrEqual(3990);
  });
});
