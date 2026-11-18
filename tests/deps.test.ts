import { describe, it, expect } from 'vitest';
import { runDiagnostics, missingDepMessage, findExecutable, type DiagnosticProbes, type ResolvedTools } from '../src/main/deps';
import { defaultSettings } from '../src/main/store';

const s = defaultSettings('C:/out');
const all: ResolvedTools = {
  ffmpeg: 'C:/b/ffmpeg.exe',
  ffprobe: 'C:/b/ffprobe.exe',
  ytDlp: 'C:/b/yt-dlp.exe',
  whisper: 'C:/b/whisper.exe',
  ollama: 'C:/b/ollama.exe',
};
const good: DiagnosticProbes = { version: async () => 'v1', ollamaModels: async () => ['llama3.2:3b'] };

describe('diagnóstico de dependencias', () => {
  it('todo OK', async () => {
    const d = await runDiagnostics(all, s, good);
    expect(d.ok).toBe(true);
    expect(missingDepMessage(d)).toBeNull();
  });
  it.each([
    ['ffmpeg', /FFmpeg/, /winget install Gyan.FFmpeg/],
    ['ytDlp', /yt-dlp/, /winget install yt-dlp/],
    ['whisper', /transcripción/, /pip install -U openai-whisper/],
    ['ollama', /Ollama instalado/, /ollama.com\/download/],
  ] as const)('falta %s → mensaje comprensible con instrucciones', async (key, label, help) => {
    const d = await runDiagnostics({ ...all, [key]: null }, s, good);
    expect(d.ok).toBe(false);
    const bad = d.items.find((i) => !i.ok)!;
    expect(bad.label).toMatch(label);
    expect(bad.help).toMatch(help);
    expect(missingDepMessage(d)).toMatch(/Faltan dependencias/);
  });
  it('servicio Ollama caído y modelo no descargado', async () => {
    const d = await runDiagnostics(all, s, { ...good, ollamaModels: async () => null });
    expect(d.items.find((i) => i.id === 'ollamaService')!.help).toMatch(/ollama serve/);
    const d2 = await runDiagnostics(all, s, { ...good, ollamaModels: async () => ['otro:1b'] });
    const m = d2.items.find((i) => i.id === 'ollamaModel')!;
    expect(m.ok).toBe(false);
    expect(m.help).toMatch(/ollama pull llama3.2:3b/);
  });
  it('ejecutable que no responde', async () => {
    const d = await runDiagnostics(all, s, { ...good, version: async (exe) => (exe.includes('ffprobe') ? null : 'v') });
    expect(d.items.find((i) => i.id === 'ffprobe')!.detail).toMatch(/No responde/);
  });
  it('findExecutable devuelve null si no existe', () => {
    expect(findExecutable('ffmpeg', 'C:/no/existe/ffmpeg.exe', null)).toBeNull();
    expect(findExecutable('ffmpeg', '', null, { PATH: '' })).toBeNull();
  });
});
