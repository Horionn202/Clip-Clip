import { describe, it, expect } from 'vitest';
import { buildPlan, fallbackPlans, fp16Unsafe, isGpuFailure, openaiArgs, selectEngine, whisperSkipped, type SelectOptions } from '../src/main/transcribe';
import { engineLabel, estimateJob, estimateSpeed, humanDuration, LONG_VIDEO_SEC } from '../src/shared/estimates';
import type { Job } from '../src/shared/types';

const GTX = 'NVIDIA GeForce GTX 1660 SUPER';
const o = (x: Partial<SelectOptions> = {}): SelectOptions => ({
  choice: 'auto',
  model: 'turbo',
  precision: 'auto',
  vramMB: 6144,
  gpuName: GTX,
  avail: { 'faster-whisper-cuda': false, 'openai-whisper-cuda': true, 'openai-whisper-cpu': true },
  ...x,
});

describe('GTX 16xx: FP16 produce NaN → FP32 automático', () => {
  it('detecta GPUs con FP16 no fiable', () => {
    expect(fp16Unsafe(GTX)).toBe(true);
    expect(fp16Unsafe('NVIDIA GeForce GTX 1650')).toBe(true);
    expect(fp16Unsafe('NVIDIA GeForce RTX 3060')).toBe(false);
    expect(fp16Unsafe(null)).toBe(false);
  });
  it('en GTX 1660 con 6 GB: CUDA activo, medium (turbo no cabe con margen) y --fp16 False', () => {
    const p = selectEngine(o())!;
    expect(p).toMatchObject({ engine: 'openai-whisper-cuda', device: 'cuda', model: 'medium', fp16: false });
    expect(p.warnings.join(' ')).toMatch(/margen de seguridad/);
    expect(p.warnings.join(' ')).toMatch(/FP32/);
    const a = openaiArgs(p, 'a.wav', 'out', 'es');
    expect(a.join(' ')).toContain('--device cuda');
    expect(a.join(' ')).toContain('--fp16 False');
    expect(engineLabel(p)).toBe('GPU activa · modelo medium · CUDA (FP32)');
  });
  it('en una RTX con 6 GB se mantiene FP16', () => {
    expect(selectEngine(o({ gpuName: 'NVIDIA GeForce RTX 2060' }))!.fp16).toBe(true);
  });
  it('FP16 forzado por el usuario se respeta', () => {
    expect(selectEngine(o({ precision: 'fp16' }))!.fp16).toBe(true);
  });
  it('faster-whisper en GTX 16xx: sin float16', () => {
    const p = buildPlan('faster-whisper-cuda', o())!;
    expect(p.computeType).toMatch(/float32/);
    expect(p.fp16).toBe(false);
  });
  it('tras un fallo en FP16 el primer reintento es el mismo modelo en FP32', () => {
    const failed = selectEngine(o({ gpuName: 'RTX', model: 'medium' }))!;
    expect(failed.fp16).toBe(true);
    expect(fallbackPlans(failed, o({ gpuName: 'RTX', model: 'medium' }))[0]).toMatchObject({ engine: 'openai-whisper-cuda', model: 'medium', fp16: false });
  });
  it('detecta la salida «Skipping … nan» como fallo de GPU', () => {
    const err = 'Skipping audio.wav due to ValueError: Expected parameter logits ... found invalid values:\ntensor([[nan, nan]])';
    expect(isGpuFailure(err)).toBe(true);
    expect(whisperSkipped(err)).toMatch(/^ValueError/);
    expect(whisperSkipped('[00:01.000 --> 00:02.000] hola')).toBeNull();
  });
});

describe('duración y estimaciones', () => {
  it('formatea la duración del vídeo fuente en minutos', () => {
    expect(humanDuration(5881.24)).toBe('98 min 1 s');
    expect(humanDuration(45)).toBe('45 s');
    expect(humanDuration(420)).toBe('7 min');
  });
  it('vídeo de 98 min supera el umbral de confirmación', () => {
    expect(5881.24 > LONG_VIDEO_SEC).toBe(true);
  });
  it('estima disco y tiempo; prefiere la velocidad medida en trabajos anteriores', () => {
    const plan = selectEngine(o())!;
    const e = estimateJob(5881.24, 2_042_691_459, plan);
    expect(e.diskBytes).toBeGreaterThan(2_042_691_459 + 5881 * 32000);
    expect(e.speedMeasured).toBe(false);
    const past = { status: 'completed', metrics: { engine: plan.engine, whisperModel: 'medium', transcribeSpeed: 4, stagesMs: {}, renderMsPerClip: [] } } as unknown as Job;
    expect(estimateSpeed(plan, [past])).toEqual({ speed: 4, measured: true });
    // un trabajo fallido (p. ej. con velocidad falsa) no cuenta
    const failed = { ...past, status: 'failed', metrics: { ...past.metrics!, transcribeSpeed: 98 } } as Job;
    expect(estimateSpeed(plan, [failed]).measured).toBe(false);
  });
});

describe('revisión Codex: «Skipping» sólo como línea de diagnóstico', () => {
  it('no confunde texto transcrito con el diagnóstico del CLI', () => {
    expect(whisperSkipped('[00:01.000 --> 00:04.000]  Skipping breakfast due to a busy schedule')).toBeNull();
    expect(whisperSkipped('Skipping breakfast due to a busy schedule')).toBeNull();
    expect(whisperSkipped('Skipping C:\a b\audio.wav due to RuntimeError: CUDA out of memory')).toMatch(/^RuntimeError/);
  });
});
