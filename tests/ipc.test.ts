import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createJobSchema, settingsPatchSchema, rendererSettingsPatchSchema, renameClipSchema, idSchema, modelNameSchema, probeUrlSchema } from '../src/main/ipcSchemas';
import { isInside, resolveInside, assertId, validateExecutablePath } from '../src/main/paths';

const ok = { url: 'https://example.com/v/1', preset: 30, maxClips: 5, rightsConfirmed: true };

describe('IPC jobs:create', () => {
  it('acepta una petición válida', () => {
    expect(createJobSchema.parse(ok)).toMatchObject({ preset: 30, maxClips: 5 });
  });
  it.each([
    [{ ...ok, maxClips: 21 }],
    [{ ...ok, maxClips: 0 }],
    [{ ...ok, maxClips: '5' }],
    [{ ...ok, preset: 20 }],
    [{ ...ok, rightsConfirmed: false }],
    [{ ...ok, url: 'file:///etc/passwd' }],
    [{ ...ok, extra: 'x' }],
    [null],
    ['string'],
  ])('rechaza %j', (bad) => {
    expect(createJobSchema.safeParse(bad).success).toBe(false);
  });
});

describe('IPC settings', () => {
  it('sólo permite Ollama local', () => {
    expect(settingsPatchSchema.safeParse({ ollamaHost: 'http://127.0.0.1:11434' }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ ollamaHost: 'https://api.remote.ai' }).success).toBe(false);
  });
  it('rechaza claves desconocidas y tipos erróneos', () => {
    expect(settingsPatchSchema.safeParse({ hack: true }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ maxConcurrentJobs: 50 }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ ollamaModel: 'llama; rm -rf' }).success).toBe(false);
  });
  it('el renderer no puede fijar exportDir directamente', () => {
    expect(rendererSettingsPatchSchema.safeParse({ exportDir: 'C:\\Windows' }).success).toBe(false);
  });
  it('rutas de ejecutables deben ser absolutas y .exe', () => {
    expect(settingsPatchSchema.safeParse({ ffmpegPath: 'ffmpeg.exe' }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ ffmpegPath: '' }).success).toBe(true);
  });
  it('valida nombres de modelo, ids y títulos', () => {
    expect(modelNameSchema.safeParse('qwen2.5:7b').success).toBe(true);
    expect(modelNameSchema.safeParse('a b').success).toBe(false);
    expect(renameClipSchema.safeParse(['12345678-aaaa', '12345678-bbbb', '']).success).toBe(false);
    expect(idSchema.safeParse('../../etc').success).toBe(false);
  });
});

describe('IPC v0.2: GPU, sondeo de URL y descarga de modelos', () => {
  it('allowModelDownload sólo booleano', () => {
    expect(createJobSchema.safeParse({ ...ok, allowModelDownload: true }).success).toBe(true);
    expect(createJobSchema.safeParse({ ...ok, allowModelDownload: 'yes' }).success).toBe(false);
  });
  it('source:probe aplica la misma validación de URL', () => {
    expect(probeUrlSchema.safeParse('https://example.com/v/1').success).toBe(true);
    for (const bad of ['http://127.0.0.1/x', 'file:///C:/a.mp4', '--exec=calc', 42]) expect(probeUrlSchema.safeParse(bad).success).toBe(false);
  });
  it('pythonPath debe ser .exe absoluto; motor y precisión sólo valores conocidos', () => {
    expect(settingsPatchSchema.safeParse({ pythonPath: 'python' }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ pythonPath: 'C:\\Py\\python.exe' }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ transcriptionEngine: 'faster-whisper-cuda' }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ transcriptionEngine: 'rm -rf' }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ whisperPrecision: 'fp8' }).success).toBe(false);
  });
});

describe('rutas', () => {
  const root = path.resolve('C:/data/jobs');
  it('isInside detecta escapes', () => {
    expect(isInside(root, path.join(root, 'a', 'b.mp4'))).toBe(true);
    expect(isInside(root, path.join(root, '..', 'x'))).toBe(false);
    expect(isInside(root, path.resolve('C:/data/jobs2/x'))).toBe(false);
    expect(isInside(root, path.resolve('D:/other'))).toBe(false);
  });
  it('resolveInside lanza con traversal o bytes nulos', () => {
    expect(() => resolveInside(root, '../../Windows/system32')).toThrow();
    expect(() => resolveInside(root, 'a\0b')).toThrow();
    expect(resolveInside(root, 'job/clip.mp4')).toBe(path.join(root, 'job', 'clip.mp4'));
  });
  it('assertId', () => {
    expect(() => assertId('..\\..')).toThrow();
    expect(assertId('0f8fad5b-d9cb-469f-a165-70867728950e')).toBeTruthy();
  });
  it('validateExecutablePath', () => {
    expect(validateExecutablePath('')).toBe('');
    expect(() => validateExecutablePath('relative/ffmpeg.exe')).toThrow();
  });
});
