import { describe, it, expect } from 'vitest';
import { countByFilter, filterJobs, fmtMs, renderCounter, simpleCause, stageEta, stageTimeline } from '../src/shared/jobView';
import type { Job, JobStatus } from '../src/shared/types';

const job = (id: string, status: JobStatus, extra: Partial<Job> = {}): Job => ({
  id,
  url: 'https://example.com/v',
  preset: 30,
  maxClips: 5,
  status,
  progress: 0,
  message: '',
  clips: [],
  createdAt: '2026-11-18T10:00:00Z',
  updatedAt: '2026-11-18T10:00:00Z',
  ...extra,
});

describe('historial y filtros', () => {
  const jobs = [job('a', 'queued'), job('b', 'transcribing'), job('c', 'completed'), job('d', 'failed'), job('e', 'cancelled'), job('f', 'completed')];
  it('separa activos y terminados', () => {
    expect(filterJobs(jobs, 'activos').map((j) => j.id)).toEqual(['a', 'b']);
    expect(filterJobs(jobs, 'completados').map((j) => j.id)).toEqual(['c', 'f']);
    expect(filterJobs(jobs, 'fallidos').map((j) => j.id)).toEqual(['d']);
    expect(filterJobs(jobs, 'cancelados').map((j) => j.id)).toEqual(['e']);
  });
  it('contadores por filtro', () => {
    expect(countByFilter(jobs)).toEqual({ activos: 2, completados: 2, fallidos: 1, cancelados: 1 });
  });
});

describe('línea de etapas, contadores y ETA', () => {
  const now = Date.parse('2026-11-18T10:10:00Z');
  it('marca hecho / en curso / pendiente y el tiempo de la etapa actual', () => {
    const j = job('a', 'transcribing', {
      stageStartedAt: '2026-11-18T10:08:00Z',
      detail: { phase: 'transcribing', audioDoneSec: 100, audioTotalSec: 400, elapsedSec: 120, device: 'cuda' },
      metrics: { stagesMs: { validating: 5000, downloading: 60000, extractingAudio: 4000 }, renderMsPerClip: [] },
    });
    const t = stageTimeline(j, now);
    const by = Object.fromEntries(t.map((s) => [s.key, s]));
    expect(by.downloading).toMatchObject({ state: 'hecho', elapsedMs: 60000 });
    expect(by['model-load'].state).toBe('hecho');
    expect(by.transcribing).toMatchObject({ state: 'en-curso', elapsedMs: 120000 });
    expect(by.rendering.state).toBe('pendiente');
  });
  it('muestra «Descargando modelo» sólo si hubo descarga', () => {
    const downloading = job('a', 'transcribing', { detail: { phase: 'downloadingModel', audioDoneSec: 0, audioTotalSec: 400, elapsedSec: 5, device: 'cuda' } });
    expect(stageTimeline(downloading, now).find((s) => s.key === 'model-download')?.state).toBe('en-curso');
    expect(stageTimeline(job('b', 'transcribing'), now).some((s) => s.key === 'model-download')).toBe(false);
  });
  it('validación vs obtención de metadata', () => {
    const t = stageTimeline(job('a', 'validating', { message: 'Consultando información del vídeo…' }), now);
    expect(t.find((s) => s.key === 'validating')?.state).toBe('hecho');
    expect(t.find((s) => s.key === 'metadata')?.state).toBe('en-curso');
  });
  it('trabajo completado: todo hecho y listo para exportar', () => {
    expect(stageTimeline(job('a', 'completed'), now).every((s) => s.state === 'hecho')).toBe(true);
  });
  it('contador de render «clip 7 de 20»', () => {
    expect(renderCounter(job('a', 'rendering', { message: 'Renderizando clip 7 de 20…' }))).toBe('clip 7 de 20');
    expect(renderCounter(job('a', 'analyzing', { message: 'clip 7 de 20' }))).toBeNull();
  });
  it('ETA sólo con muestra suficiente', () => {
    expect(stageEta(0.02, 60_000)).toBeNull();
    expect(stageEta(0.5, 5_000)).toBeNull();
    expect(stageEta(0.25, 60_000)).toBe(180_000);
    expect(stageEta(1, 60_000)).toBeNull();
  });
  it('formato de tiempos', () => {
    expect(fmtMs(45_000)).toBe('45 s');
    expect(fmtMs(125_000)).toBe('2 min 5 s');
    expect(fmtMs(3_900_000)).toBe('1 h 5 min');
    expect(fmtMs(undefined)).toBe('—');
  });
});

describe('errores con causa simple', () => {
  it.each([
    ['Whisper terminó sin generar un JSON válido; abre Configuración → Diagnóstico', /transcripción/],
    ['La descarga falló. YouTube ha pedido verificar que no eres un bot', /descargar el vídeo/],
    ['No hay espacio suficiente en disco', /espacio/],
    ['El trabajo se interrumpió porque la aplicación se cerró', /se cerró/],
    ['algo raro', /no pudo terminar/],
  ])('%s', (e, re) => expect(simpleCause(e)).toMatch(re));
});
