import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { locateTranscript, sanitizeArgs, tailLines, validateTranscriptJson } from '../src/main/transcriptOutput';
import { transcribe, type PipelineContext } from '../src/main/pipeline';
import type { RunResult } from '../src/main/proc';
import type { EnginePlan } from '../src/shared/types';

const VALID = JSON.stringify({ segments: [{ start: 0, end: 2.5, text: ' Hola mundo', words: [{ start: 0, end: 1, word: ' Hola' }] }] });

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-out-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('validación del JSON de Whisper', () => {
  it('acepta un JSON con segmentos y timestamps', () => {
    expect(validateTranscriptJson(VALID)).toEqual({ ok: true, segments: 1 });
  });
  it.each([
    ['{"segments": [', /no parseable/],
    ['{"text": "hola"}', /no tiene «segments»/],
    ['{"segments": []}', /no contiene segmentos/],
    ['{"segments": [{"start": "a", "end": 1, "text": "x"}]}', /marcas de tiempo inválidas/],
    ['{"segments": [{"start": 5, "end": 1, "text": "x"}]}', /marcas de tiempo inválidas/],
    ['{"segments": [{"start": 0, "end": 1, "text": "  "}]}', /no contienen texto/],
  ])('rechaza %s', (raw, re) => {
    const v = validateTranscriptJson(raw);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(re);
  });
});

describe('localizar la salida', () => {
  it('JSON inexistente → error con el nombre esperado', () => {
    expect(locateTranscript(dir, 'audio', Date.now())).toMatchObject({ ok: false, file: null, error: expect.stringMatching(/audio\.json/) });
  });
  it('JSON inválido → no es éxito', () => {
    fs.writeFileSync(path.join(dir, 'audio.json'), '{roto');
    expect(locateTranscript(dir, 'audio', Date.now() - 5000)).toMatchObject({ ok: false });
  });
  it('JSON sin segmentos → no es éxito', () => {
    fs.writeFileSync(path.join(dir, 'audio.json'), '{"segments": []}');
    expect(locateTranscript(dir, 'audio', Date.now() - 5000).error).toMatch(/no contiene segmentos/);
  });
  it('descubre un JSON válido con otro nombre generado en la carpeta', () => {
    fs.writeFileSync(path.join(dir, 'audio_es.json'), VALID);
    const r = locateTranscript(dir, 'audio', Date.now() - 5000);
    expect(r).toMatchObject({ ok: true, segments: 1 });
    expect(path.basename(r.file!)).toBe('audio_es.json');
  });
  it('ignora transcript.json y JSON antiguos', () => {
    fs.writeFileSync(path.join(dir, 'transcript.json'), VALID);
    const old = path.join(dir, 'viejo.json');
    fs.writeFileSync(old, VALID);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(old, past, past);
    expect(locateTranscript(dir, 'audio', Date.now() - 5000).ok).toBe(false);
  });
  it('logs: últimas líneas y argumentos sin rutas de usuario', () => {
    expect(tailLines('a\n\nb\nc', 2)).toEqual(['b', 'c']);
    expect(sanitizeArgs(['-m', 'whisper', 'C:\\Users\\Rafael\\jobs\\x\\audio.wav', '--model', 'medium'])).toEqual(['-m', 'whisper', '<audio.wav>', '--model', 'medium']);
  });
});

describe('transcripción: código 0 no basta', () => {
  const plan: EnginePlan = { engine: 'openai-whisper-cuda', device: 'cuda', model: 'medium', fp16: true, warnings: [] };
  const tools = { ffmpeg: 'f', ffprobe: 'p', ytDlp: 'y', whisper: 'C:/w/whisper.exe', ollama: null, python: 'C:/py/python.exe' };
  const mkCtx = (fake: (args: string[]) => RunResult): PipelineContext =>
    ({ jobsDir: dir, settings: () => ({}) as never, tools: () => tools, gpuInfo: async () => ({}) as never, fasterScript: 'fw.py', run: async (_c: string, a: string[]) => fake(a) }) as PipelineContext;
  const go = (ctx: PipelineContext) =>
    transcribe(ctx, tools, plan, path.join(dir, 'audio.wav'), dir, 'es', 120, false, false, new AbortController().signal, () => undefined, true);

  it('Whisper retorna código 0 pero no crea JSON → fallo con motivo claro', async () => {
    const r = await go(mkCtx(() => ({ code: 0, stdout: '', stderr: '' })));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/sin generar un JSON válido/);
    expect(r.speed).toBeUndefined(); // nunca una velocidad falsa
  });
  it('«Skipping … due to» (NaN en FP16) con código 0 → fallo detectado como de GPU', async () => {
    const r = await go(mkCtx(() => ({ code: 0, stdout: '', stderr: 'Skipping audio.wav due to ValueError: ... found invalid values: tensor([[nan, nan]])' })));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/omitió el audio/);
    expect(r.stderr).toMatch(/invalid values/);
  });
  it('sólo es éxito tras validar el contenido del JSON', async () => {
    const bad = await go(
      mkCtx(() => {
        fs.writeFileSync(path.join(dir, 'audio.json'), '{"segments": []}');
        return { code: 0, stdout: '', stderr: '' };
      }),
    );
    expect(bad.ok).toBe(false);
    const good = await go(
      mkCtx(() => {
        fs.writeFileSync(path.join(dir, 'audio.json'), VALID);
        return { code: 0, stdout: '[00:00.000 --> 00:02.500]  Hola mundo', stderr: '' };
      }),
    );
    expect(good).toMatchObject({ ok: true, exitCode: 0 });
    expect(path.basename(good.outFile)).toBe('audio.json');
  });
  it('se ejecuta con argumentos estructurados (python -m whisper, sin shell)', async () => {
    let seen: string[] = [];
    await go(
      mkCtx((a) => {
        seen = a;
        return { code: 0, stdout: '', stderr: '' };
      }),
    );
    expect(seen.slice(0, 2)).toEqual(['-m', 'whisper']);
    expect(seen).toContain('--fp16');
  });
});
