// Integración real con FFmpeg: genera un vídeo sintético 16:9 y renderiza un clip 9:16 con subtítulos ASS.
// Se omite automáticamente si FFmpeg/FFprobe no están instalados.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findExecutable } from '../src/main/deps';
import { buildAss, centerCrop, renderArgs } from '../src/main/media';
import { runProcess } from '../src/main/proc';

const ffmpeg = findExecutable('ffmpeg', '', null);
const ffprobe = findExecutable('ffprobe', '', null);

describe.skipIf(!ffmpeg || !ffprobe)('render con FFmpeg', () => {
  it('produce un MP4 1080x1920 de la duración pedida', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-test-'));
    try {
      const src = path.join(dir, 'source con espacios.mp4');
      const gen = await runProcess(ffmpeg!, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=20', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', src], { timeoutMs: 120000 });
      expect(gen.code).toBe(0);
      fs.writeFileSync(path.join(dir, '01.ass'), buildAss([{ start: 5, end: 6, text: "Hola {\\b1} 'mundo'" }, { start: 6, end: 8, text: 'C:\\ruta: 100%' }], 5, 20));
      const r = await runProcess(ffmpeg!, renderArgs({ source: src, start: 5, end: 20, crop: centerCrop(0).compute(1280, 720), assFile: '01.ass', output: 'out.mp4' }), { cwd: dir, timeoutMs: 120000 });
      expect(r.code, r.stderr.slice(-800)).toBe(0);
      const p = await runProcess(ffprobe!, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', path.join(dir, 'out.mp4')]);
      const j = JSON.parse(p.stdout);
      expect(j.streams[0]).toMatchObject({ width: 1080, height: 1920 });
      expect(parseFloat(j.format.duration)).toBeCloseTo(15, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});
