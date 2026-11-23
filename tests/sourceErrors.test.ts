// Bloqueos de YouTube/yt-dlp: diagnóstico real, reintentos limitados, importar archivo local y actualización verificada.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BOT_RETRY_PLAN,
  FALLBACK_CLIENT_ARGS,
  SOURCE_ERROR_ACTIONS,
  botRetryMessage,
  classifySourceError,
  compareYtDlpVersions,
  describeSourceError,
  isRecentYtDlp,
  sha256For,
  technicalCommands,
  type SourceErrorKind,
} from '../src/shared/sourceErrors';
import { SourceError, displaySize, placeLocalSource, probeLocalVideo, readSourceInfo, reuseFirst, withBotRetries } from '../src/main/source';
import { installVerifiedYtDlp, latestYtDlpRelease, updateCheckFrom, type YtDlpRelease } from '../src/main/ytdlpUpdate';
import { prefillFromJob } from '../src/shared/homePrefill';
import { retryOptions } from '../src/shared/jobView';
import type { Diagnostics, Job } from '../src/shared/types';
import { missingDepMessage } from '../src/main/deps';

const NOW = new Date('2026-11-23T12:00:00Z');
const RECENT = '2026.10.26';
const OLD = '2025.06.30';
const BOT = 'ERROR: [youtube] 8rOANDroC0E: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.';

describe('diagnóstico real de cada error', () => {
  it.each([
    [BOT, 'bot'],
    ["ERROR: [youtube] x: Private video. Sign in if you've been granted access to this video", 'private'],
    ['ERROR: [youtube] x: Sign in to confirm your age. This video may be inappropriate for some users.', 'login'],
    ['ERROR: [youtube] x: Join this channel to get access to members-only content', 'login'],
    ['ERROR: [youtube] x: Video unavailable. This video has been removed by the uploader', 'unavailable'],
    ['ERROR: [youtube] x: The uploader has not made this video available in your country', 'unavailable'],
    ['ERROR: [youtube] zzzzzzzzzzz: This video is unavailable', 'unavailable'],
    ['ERROR: Unsupported URL: https://example.com/foo', 'invalid_url'],
    ['ERROR: [youtube] x: Incomplete YouTube ID abc', 'invalid_url'],
    ['ERROR: Unable to download webpage: <urlopen error [Errno 11001] getaddrinfo failed>', 'network'],
    ['ERROR: [youtube] x: nsig extraction failed: Some formats may be missing. Please report this issue on https://github.com/yt-dlp/yt-dlp/issues', 'outdated'],
    ['algo totalmente inesperado', 'unknown'],
  ] as [string, SourceErrorKind][])('%s → %s', (stderr, kind) => {
    expect(classifySourceError(stderr)).toBe(kind);
  });

  it('con yt-dlp reciente nunca recomienda actualizar ni muestra comandos en el mensaje', () => {
    for (const kind of ['bot', 'outdated', 'unknown', 'network', 'private'] as SourceErrorKind[]) {
      const d = describeSourceError({ kind, ytDlpVersion: RECENT, attempts: 3 }, NOW);
      expect(d.suggestUpdate, kind).toBe(false);
      expect(`${d.title} ${d.message}`, kind).not.toMatch(/winget|powershell|yt-dlp -U|pip /i);
    }
    expect(describeSourceError({ kind: 'bot', ytDlpVersion: RECENT, attempts: 3 }, NOW).message).toMatch(/2026\.10\.26.*actualizado.*no viene de la versión/);
  });

  it('con yt-dlp antiguo sí sugiere comprobar la actualización (sin comando en el mensaje)', () => {
    const d = describeSourceError({ kind: 'outdated', ytDlpVersion: OLD, attempts: 1 }, NOW);
    expect(d.suggestUpdate).toBe(true);
    expect(d.message).not.toMatch(/winget/);
    expect(isRecentYtDlp(RECENT, NOW)).toBe(true);
    expect(isRecentYtDlp(OLD, NOW)).toBe(false);
  });

  it('los comandos sólo existen para el diagnóstico avanzado, y el de actualizar sólo si la versión es antigua', () => {
    expect(technicalCommands({ kind: 'bot', ytDlpVersion: RECENT }, NOW).map((c) => c.command)).toEqual(['yt-dlp --version']);
    expect(technicalCommands({ kind: 'bot', ytDlpVersion: OLD }, NOW).map((c) => c.command)).toContain('winget upgrade yt-dlp.yt-dlp');
  });

  it('el modal de error ofrece las cuatro acciones', () => {
    expect(SOURCE_ERROR_ACTIONS.map((a) => a.label)).toEqual(['Reintentar más tarde', 'Cambiar URL', 'Importar archivo de video', 'Ver diagnóstico técnico']);
    expect(describeSourceError({ kind: 'bot', ytDlpVersion: RECENT, attempts: 3 }, NOW).title).toBe('YouTube no permitió descargar este video');
  });
});

describe('reintentos ante el bloqueo anti-bot', () => {
  const settings = { maxSourceMinutes: 180, maxDownloadMB: 4096 };
  const fakeRun = (responses: { code: number; stdout?: string; stderr?: string }[]) => {
    const calls: string[][] = [];
    const run = (async (_cmd: string, args: string[]) => {
      calls.push(args);
      const r = responses[Math.min(calls.length - 1, responses.length - 1)];
      return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }) as never;
    return { run, calls };
  };
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  beforeEach(() => void (waits.length = 0));

  it('reintenta como máximo 3 veces, con espera creciente, avisa y luego se detiene con el diagnóstico', async () => {
    const { run, calls } = fakeRun([{ code: 1, stderr: BOT }]);
    const msgs: string[] = [];
    const p = readSourceInfo('yt-dlp', 'https://youtu.be/x', settings, undefined, (n, of) => msgs.push(botRetryMessage(n, of)), { run, sleep, version: async () => RECENT });
    const e = (await p.catch((x) => x)) as SourceError;
    expect(e).toBeInstanceOf(SourceError);
    expect(calls).toHaveLength(3);
    expect(calls[0]).not.toContain('--extractor-args');
    expect(calls[1]).toEqual(expect.arrayContaining(FALLBACK_CLIENT_ARGS));
    expect(waits).toEqual(BOT_RETRY_PLAN.slice(1).map((s) => s.waitMs));
    expect(waits[1]).toBeGreaterThan(waits[0]);
    expect(msgs).toEqual(['YouTube limitó temporalmente la descarga. Reintentando método alternativo… (intento 2 de 3)', 'YouTube limitó temporalmente la descarga. Reintentando método alternativo… (intento 3 de 3)']);
    expect(e.failure).toMatchObject({ kind: 'bot', ytDlpVersion: RECENT, attempts: 3 });
    expect(e.failure.technical).toMatch(/not a bot/);
    expect(e.message).toMatch(/YouTube no permitió descargar este video/);
    expect(e.message).not.toMatch(/winget/);
  });

  it('si el método alternativo funciona, sigue con él', async () => {
    const { run } = fakeRun([{ code: 1, stderr: BOT }, { code: 0, stdout: JSON.stringify({ title: 'Vídeo', duration: 120 }) }]);
    const info = await readSourceInfo('yt-dlp', 'https://youtu.be/x', settings, undefined, undefined, { run, sleep });
    expect(info.clientArgs).toEqual(FALLBACK_CLIENT_ARGS);
    expect(waits).toHaveLength(1);
  });

  it('cualquier otro error no se reintenta', async () => {
    const { run, calls } = fakeRun([{ code: 1, stderr: 'ERROR: Private video' }]);
    const e = (await readSourceInfo('yt-dlp', 'https://youtu.be/x', settings, undefined, undefined, { run, sleep, version: async () => RECENT }).catch((x) => x)) as SourceError;
    expect(calls).toHaveLength(1);
    expect(waits).toHaveLength(0);
    expect(e.failure.kind).toBe('private');
  });

  it('revisión Codex: la descarga reutiliza su primer fallo una sola vez y después reintenta de verdad', async () => {
    // La lectura ya funcionó con el cliente alternativo; la descarga con ese cliente topa con el bloqueo.
    const first = { code: 1, stdout: '', stderr: BOT };
    const ran: string[][] = [];
    const download = async (args: string[]) => (ran.push(args), { code: 0, stdout: 'ok', stderr: '' });
    const r = await withBotRetries('yt-dlp', reuseFirst(first, download), { from: 1, sleep, version: async () => RECENT });
    expect(r.stdout).toBe('ok');
    expect(ran).toEqual([FALLBACK_CLIENT_ARGS]);
    expect(waits).toEqual([BOT_RETRY_PLAN[2].waitMs]);
  });
});

describe('archivo local', () => {
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-local-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ffprobe = (out: object, code = 0) => (async () => ({ code, stdout: JSON.stringify(out), stderr: code ? 'Invalid data found when processing input' : '' })) as never;
  const ok = { streams: [{ codec_type: 'video', width: 1920, height: 1080 }, { codec_type: 'audio' }], format: { duration: '954.5' } };

  it('lee un vídeo válido sin yt-dlp', async () => {
    const f = path.join(dir, 'Mi partida.MOV');
    fs.writeFileSync(f, 'x'.repeat(100));
    const v = await probeLocalVideo('ffprobe', f, { maxSourceMinutes: 180 }, ffprobe(ok));
    expect(v).toMatchObject({ name: 'Mi partida.MOV', title: 'Mi partida', duration: 954.5, width: 1920, height: 1080, sizeBytes: 100 });
  });

  it.each([
    ['sin audio', { ...ok, streams: [ok.streams[0]] }, /sonido/],
    ['sin imagen', { ...ok, streams: [ok.streams[1]] }, /imagen/],
    ['demasiado largo', { ...ok, format: { duration: String(181 * 60) } }, /180 minutos/],
  ])('rechaza un vídeo %s', async (_n, out, re) => {
    const f = path.join(dir, 'a.mp4');
    fs.writeFileSync(f, 'x');
    await expect(probeLocalVideo('ffprobe', f, { maxSourceMinutes: 180 }, ffprobe(out))).rejects.toThrow(re);
  });

  it('rechaza formatos no admitidos y archivos dañados', async () => {
    const txt = path.join(dir, 'a.avi');
    fs.writeFileSync(txt, 'x');
    await expect(probeLocalVideo('ffprobe', txt, { maxSourceMinutes: 180 }, ffprobe(ok))).rejects.toThrow(/MP4, MOV, MKV o WebM/);
    const bad = path.join(dir, 'b.webm');
    fs.writeFileSync(bad, 'x');
    await expect(probeLocalVideo('ffprobe', bad, { maxSourceMinutes: 180 }, ffprobe({}, 1))).rejects.toThrow(/dañado/);
  });

  it('revisión Codex: un vídeo vertical de móvil (rotación 90°) usa las medidas como se ve', async () => {
    expect(displaySize({ width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] })).toEqual({ width: 1080, height: 1920 });
    expect(displaySize({ width: 1920, height: 1080, tags: { rotate: '270' } })).toEqual({ width: 1080, height: 1920 });
    expect(displaySize({ width: 1920, height: 1080, side_data_list: [{ rotation: 180 }] })).toEqual({ width: 1920, height: 1080 });
    expect(displaySize({ width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 });
    const f = path.join(dir, 'movil.mov');
    fs.writeFileSync(f, 'x');
    const phone = { ...ok, streams: [{ codec_type: 'video', width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }, { codec_type: 'audio' }] };
    expect(await probeLocalVideo('ffprobe', f, { maxSourceMinutes: 180 }, ffprobe(phone))).toMatchObject({ width: 1080, height: 1920 });
  });

  it('enlaza el original en la carpeta del trabajo sin copiarlo ni tocarlo', () => {
    const f = path.join(dir, 'video.mkv');
    fs.writeFileSync(f, 'contenido original');
    const job = path.join(dir, 'job');
    fs.mkdirSync(job);
    const r = placeLocalSource(f, job);
    expect(r).toEqual({ path: path.join(job, 'source.mkv'), copied: false });
    expect(fs.statSync(f).nlink).toBe(2);
    fs.rmSync(r.path);
    expect(fs.readFileSync(f, 'utf8')).toBe('contenido original');
  });

  it('un trabajo de archivo local no exige yt-dlp; uno de URL sí', () => {
    const diag = { ok: false, items: [{ id: 'ytDlp', label: 'yt-dlp', ok: false, detail: 'No encontrado' }, { id: 'ffmpeg', label: 'FFmpeg', ok: true, detail: '' }] } as Diagnostics;
    expect(missingDepMessage(diag, { localSource: true })).toBeNull();
    expect(missingDepMessage(diag)).toMatch(/yt-dlp/);
  });

  it('un trabajo de archivo local se puede reintentar aunque no sea de un directo', () => {
    const job = { localSource: 'C:/v.mp4', localFile: true, clips: [] } as Pick<Job, 'localSource' | 'localFile' | 'clips' | 'analysis'>;
    expect(retryOptions(job, ['source.mp4']).validating.ok).toBe(true);
  });
});

describe('al fallar no se pierden URL ni ajustes', () => {
  const job = { url: 'https://www.youtube.com/watch?v=abc', preset: 45, maxClips: 15 } as Pick<Job, 'url' | 'preset' | 'maxClips' | 'localFile'>;
  it('«Cambiar URL» vuelve a Inicio con la URL, la duración y el máximo de clips', () => {
    expect(prefillFromJob(job, 'change-url', 7)).toEqual({ url: job.url, preset: 45, maxClips: 15, pickFile: false, nonce: 7 });
  });
  it('«Importar archivo» conserva duración y máximo y abre el selector', () => {
    expect(prefillFromJob(job, 'import-file', 8)).toMatchObject({ preset: 45, maxClips: 15, pickFile: true });
  });
  it('no rellena la URL con «local:…»', () => {
    expect(prefillFromJob({ ...job, url: 'local:video.mp4', localFile: true }, 'change-url').url).toBe('');
  });
});

describe('actualización de yt-dlp', () => {
  const tag = '2026.11.20';
  const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${tag}`;
  const bin = Buffer.from('binario oficial de prueba');
  const hash = crypto.createHash('sha256').update(bin).digest('hex');
  const rel: YtDlpRelease = { version: tag, notesUrl: '', exeUrl: `${base}/yt-dlp.exe`, sumsUrl: `${base}/SHA2-256SUMS` };
  const fetchOf = (sums: string, body = bin) =>
    (async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => (url.endsWith('SUMS') ? sums : ''),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    })) as never;
  let dir = '';
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-up-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('compara versiones y lee el hash oficial', () => {
    expect(compareYtDlpVersions('2026.11.20', '2026.10.26')).toBeGreaterThan(0);
    expect(compareYtDlpVersions('2026.10.26', '2026.10.26')).toBe(0);
    expect(updateCheckFrom(RECENT, rel).updateAvailable).toBe(true);
    expect(updateCheckFrom(tag, rel).updateAvailable).toBe(false);
    expect(sha256For(`${hash}  yt-dlp.exe\n${'0'.repeat(64)}  yt-dlp`, 'yt-dlp.exe')).toBe(hash);
  });

  it('sólo acepta el repositorio oficial', async () => {
    const api = async () => ({ ok: true, status: 200, json: async () => ({ tag_name: tag, assets: [{ name: 'yt-dlp.exe', browser_download_url: 'https://evil.example/yt-dlp.exe' }, { name: 'SHA2-256SUMS', browser_download_url: `${base}/SHA2-256SUMS` }] }), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) });
    await expect(latestYtDlpRelease(api as never)).rejects.toThrow(/repositorio oficial/);
    await expect(installVerifiedYtDlp({ ...rel, exeUrl: 'https://evil.example/yt-dlp.exe' }, dir, { fetchImpl: fetchOf('') })).rejects.toThrow(/repositorio oficial/);
  });

  it('no instala nada si el hash no coincide', async () => {
    await expect(installVerifiedYtDlp(rel, dir, { fetchImpl: fetchOf(`${'a'.repeat(64)}  yt-dlp.exe`), run: (async () => ({ code: 0, stdout: tag, stderr: '' })) as never })).rejects.toThrow(/hash oficial/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('con hash y versión correctos lo deja en la carpeta de la app', async () => {
    const out = await installVerifiedYtDlp(rel, dir, { fetchImpl: fetchOf(`${hash}  yt-dlp.exe`), run: (async () => ({ code: 0, stdout: `${tag}\n`, stderr: '' })) as never });
    expect(out).toBe(path.join(dir, 'yt-dlp.exe'));
    expect(fs.readFileSync(out)).toEqual(bin);
    expect(fs.readdirSync(dir)).toEqual(['yt-dlp.exe']);
  });

  it('no instala si el binario no responde con la versión esperada', async () => {
    await expect(installVerifiedYtDlp(rel, dir, { fetchImpl: fetchOf(`${hash}  yt-dlp.exe`), run: (async () => ({ code: 0, stdout: '2020.01.01', stderr: '' })) as never })).rejects.toThrow(/no responde/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
