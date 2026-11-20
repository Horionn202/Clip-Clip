import { describe, it, expect } from 'vitest';
import { lastStage, pipelineCards, retryOptions } from '../src/shared/jobView';
import { redactPaths } from '../src/renderer/components/PipelineCards';
import { whisperLang } from '../src/main/pipeline';
import { migrateSettings, defaultSettings } from '../src/main/store';
import type { Job } from '../src/shared/types';

const base = (p: Partial<Job>): Job => ({ id: 'j', url: 'u', preset: 30, maxClips: 5, status: 'queued', progress: 0, message: '', clips: [], createdAt: '2026-11-19T10:00:00Z', updatedAt: '2026-11-19T10:00:00Z', ...p }) as Job;
const states = (j: Job) => pipelineCards(j, Date.parse('2026-11-19T10:01:00Z')).map((c) => c.state);

describe('tarjetas del pipeline', () => {
  it('pendientes en gris, la actual activa con porcentaje y ETA, las anteriores completadas', () => {
    const j = base({ status: 'transcribing', stage: 'transcribing', progress: 0.4, stageStartedAt: '2026-11-19T10:00:00Z', detail: { phase: 'transcribing', audioDoneSec: 120, audioTotalSec: 300, etaSec: 90 } as Job['detail'] });
    expect(states(j)).toEqual(['completado', 'completado', 'completado', 'activo', 'pendiente', 'pendiente', 'pendiente', 'pendiente', 'pendiente']);
    const t = pipelineCards(j, Date.parse('2026-11-19T10:01:00Z'))[3];
    expect(t).toMatchObject({ percent: 40, elapsedMs: 60_000, etaMs: 90_000 });
    expect(t.facts[0]).toBe('2:00 de 5:00 de audio');
  });
  it('error sólo en el paso que falló (nunca rojo en los pendientes) y con su etapa para reintentar', () => {
    const j = base({ status: 'failed', stage: 'analyzing', error: 'Ollama no respondió' });
    const cards = pipelineCards(j, 0);
    expect(cards.filter((c) => c.state === 'error').map((c) => c.key)).toEqual(['analyzing']);
    expect(cards.find((c) => c.state === 'error')!.stage).toBe('analyzing');
    expect(cards.slice(5).every((c) => c.state === 'pendiente')).toBe(true);
  });
  it('cancelado en ámbar y completado en verde', () => {
    expect(states(base({ status: 'cancelled', stage: 'downloading' }))).toContain('cancelado');
    expect(new Set(states(base({ status: 'completed' })))).toEqual(new Set(['completado']));
  });
  it('trabajos antiguos sin «stage»: se deduce de las métricas', () => {
    expect(lastStage(base({ status: 'failed', metrics: { stagesMs: { validating: 1, downloading: 2 }, renderMsPerClip: [] } }))).toBe('downloading');
  });
  it('descarga: tamaño y velocidad desde el mensaje de yt-dlp', () => {
    const c = pipelineCards(base({ status: 'downloading', progress: 0.5, message: 'Descargando 50.0 % de 120.5MiB a 3.20MiB/s' }), 0)[1];
    expect(c.facts).toEqual(['Tamaño 120.5MiB', 'Velocidad 3.20MiB/s']);
  });
});

describe('idioma de transcripción', () => {
  it('español forzado por defecto; autodetección sólo si se elige', () => {
    expect(whisperLang('es')).toBe('es');
    expect(whisperLang('')).toBe('es');
    expect(whisperLang('auto')).toBe('');
    expect(defaultSettings('x').whisperLanguage).toBe('es');
    expect(migrateSettings(defaultSettings('x'), { whisperLanguage: '' }).whisperLanguage).toBe('es');
    expect(migrateSettings(defaultSettings('x'), { whisperLanguage: 'auto' }).whisperLanguage).toBe('auto');
  });
});

describe('reintentar desde un paso', () => {
  const j = (p: Partial<Job> = {}) => ({ clips: [], ...p }) as unknown as Job;
  it('sólo ofrece reutilizar lo que existe', () => {
    const o = retryOptions(j(), ['source.mp4', 'transcript.json']);
    expect(o.downloading.reuse).toEqual([]);
    expect(o.transcribing.reuse).toEqual(['source']);
    expect(o.analyzing.reuse).toEqual(['source', 'transcript']);
    expect(o.rendering.reuse).toEqual(['source', 'transcript']);
    expect(retryOptions(j({ clips: [{} as never], analysis: {} as never }), ['source.mp4', 'transcript.json']).rendering.reuse).toContain('clips');
  });
  it('bloque de directo: siempre con su vídeo; si ya no existe, la acción se desactiva con motivo', () => {
    expect(retryOptions(j({ localSource: 'x' }), ['source.mp4']).validating).toMatchObject({ ok: true, reuse: ['source'] });
    expect(retryOptions(j({ localSource: 'x' }), []).validating).toMatchObject({ ok: false, reason: expect.stringMatching(/ya no existe/) });
  });
  it('sin material: análisis y render desactivados con motivo', () => {
    expect(retryOptions(j(), []).rendering.ok).toBe(false);
    expect(retryOptions(j(), []).validating.ok).toBe(true);
  });
  it('los logs ocultan la carpeta personal', () => {
    expect(redactPaths(String.raw`falló C:\Users\Ana\AppData\x.json`)).toBe(String.raw`falló %USERPROFILE%\AppData\x.json`);
  });
});
