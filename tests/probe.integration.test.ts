// Integración con resources/python/probe.py en cachés aisladas (no toca las del usuario).
// Se omite si no hay Python con openai-whisper.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findExecutable } from '../src/main/deps';
import { runProcess } from '../src/main/proc';

const python = findExecutable('python', '', null);
const hasWhisper = !!python && spawnSync(python, ['-c', 'import whisper'], { windowsHide: true }).status === 0;
const script = path.join(__dirname, '..', 'resources', 'python', 'probe.py');

describe.skipIf(!hasWhisper)('probe.py: modelos en caché', () => {
  it('no da por descargado un .pt parcial ni un snapshot con descargas a medias', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-probe-'));
    try {
      const snap = path.join(dir, 'hf', 'models--Systran--faster-whisper-small');
      fs.mkdirSync(path.join(dir, 'whisper'), { recursive: true });
      fs.mkdirSync(path.join(snap, 'snapshots', 'abc'), { recursive: true });
      fs.mkdirSync(path.join(snap, 'blobs'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'whisper', 'small.pt'), Buffer.alloc(2_000_000)); // descarga cortada
      fs.writeFileSync(path.join(snap, 'snapshots', 'abc', 'model.bin'), '');
      fs.writeFileSync(path.join(snap, 'blobs', 'x.incomplete'), '');
      const env = { XDG_CACHE_HOME: dir, HF_HUB_CACHE: path.join(dir, 'hf'), PYTHONUTF8: '1' };

      const r1 = await runProcess(python!, [script, path.join(dir, 'memo.json')], { env, timeoutMs: 120000 });
      const p1 = JSON.parse(r1.stdout.trim().split(/\r?\n/).pop()!);
      expect(p1.cache_openai).toEqual([]);
      expect(p1.cache_faster).toEqual([]);

      fs.unlinkSync(path.join(snap, 'blobs', 'x.incomplete'));
      const r2 = await runProcess(python!, [script], { env, timeoutMs: 120000 });
      expect(JSON.parse(r2.stdout.trim().split(/\r?\n/).pop()!).cache_faster).toEqual(['models--Systran--faster-whisper-small']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180000);
});
