// Comprobación y actualización de yt-dlp SÓLO desde el repositorio oficial y con el hash publicado.
// Nunca se ejecuta un instalador ni se toca la copia instalada por el usuario (p. ej. con winget): la versión
// verificada se guarda aparte, en los datos de la app, y se usa sólo si el usuario lo confirma.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { UserFacingError } from '../shared/validation';
import { YTDLP_OFFICIAL_DOWNLOAD, YTDLP_RELEASES_API, compareYtDlpVersions, sha256For } from '../shared/sourceErrors';
import { runProcess } from './proc';

export const YTDLP_ASSET = 'yt-dlp.exe';
const SUMS_ASSET = 'SHA2-256SUMS';

export interface YtDlpRelease {
  version: string;
  publishedAt?: string;
  notesUrl: string;
  exeUrl: string;
  sumsUrl: string;
}

export interface YtDlpUpdateCheck {
  installed?: string;
  latest: string;
  publishedAt?: string;
  notesUrl: string;
  updateAvailable: boolean;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;

/** Última versión publicada en el repositorio oficial (sólo lee, no descarga binarios). */
export async function latestYtDlpRelease(fetchImpl: FetchLike = fetch as unknown as FetchLike, signal?: AbortSignal): Promise<YtDlpRelease> {
  let r;
  try {
    r = await fetchImpl(YTDLP_RELEASES_API, { signal: signal ?? AbortSignal.timeout(20_000), headers: { accept: 'application/vnd.github+json', 'user-agent': 'clip-clip-desktop' } });
  } catch (e) {
    throw new UserFacingError('No se pudo consultar la última versión de yt-dlp. Revisa tu conexión.', String(e));
  }
  if (!r.ok) throw new UserFacingError(`GitHub respondió con error ${r.status} al consultar yt-dlp. Inténtalo más tarde.`);
  const j = (await r.json()) as { tag_name?: string; published_at?: string; html_url?: string; assets?: { name: string; browser_download_url: string }[] };
  const asset = (n: string) => j.assets?.find((a) => a.name === n)?.browser_download_url ?? '';
  const exeUrl = asset(YTDLP_ASSET);
  const sumsUrl = asset(SUMS_ASSET);
  if (!j.tag_name || !/^\d{4}\.\d{1,2}\.\d{1,2}(\.\d+)?$/.test(j.tag_name)) throw new UserFacingError('La respuesta de GitHub no tiene una versión de yt-dlp válida.');
  if (!YTDLP_OFFICIAL_DOWNLOAD.test(exeUrl) || !YTDLP_OFFICIAL_DOWNLOAD.test(sumsUrl)) throw new UserFacingError('La descarga no procede del repositorio oficial de yt-dlp: no se usará.');
  return { version: j.tag_name, publishedAt: j.published_at, notesUrl: j.html_url ?? `https://github.com/yt-dlp/yt-dlp/releases/tag/${j.tag_name}`, exeUrl, sumsUrl };
}

export function updateCheckFrom(installed: string | undefined, rel: YtDlpRelease): YtDlpUpdateCheck {
  return { installed, latest: rel.version, publishedAt: rel.publishedAt, notesUrl: rel.notesUrl, updateAvailable: !installed || compareYtDlpVersions(rel.version, installed) > 0 };
}

/**
 * Descarga yt-dlp.exe y su SHA2-256SUMS del repositorio oficial, comprueba el hash, comprueba que el binario
 * responde con la versión esperada y sólo entonces lo coloca en `toolsDir`. Devuelve la ruta final.
 */
export async function installVerifiedYtDlp(
  rel: YtDlpRelease,
  toolsDir: string,
  o: { fetchImpl?: FetchLike; run?: typeof runProcess; signal?: AbortSignal } = {},
): Promise<string> {
  const f = o.fetchImpl ?? (fetch as unknown as FetchLike);
  if (!YTDLP_OFFICIAL_DOWNLOAD.test(rel.exeUrl) || !YTDLP_OFFICIAL_DOWNLOAD.test(rel.sumsUrl)) throw new UserFacingError('La descarga no procede del repositorio oficial de yt-dlp: no se usará.');
  const get = async (url: string) => {
    const r = await f(url, { signal: o.signal ?? AbortSignal.timeout(5 * 60_000), headers: { 'user-agent': 'clip-clip-desktop' } }).catch((e: unknown) => {
      throw new UserFacingError('No se pudo descargar la actualización de yt-dlp. Revisa tu conexión.', String(e));
    });
    if (!r.ok) throw new UserFacingError(`La descarga de yt-dlp falló (error ${r.status}).`);
    return r;
  };
  const expected = sha256For(await (await get(rel.sumsUrl)).text(), YTDLP_ASSET);
  if (!expected) throw new UserFacingError('La lista de hashes oficial no incluye yt-dlp.exe: no se instalará nada.');
  const bin = Buffer.from(await (await get(rel.exeUrl)).arrayBuffer());
  const got = crypto.createHash('sha256').update(bin).digest('hex');
  if (got !== expected) throw new UserFacingError('El archivo descargado no coincide con el hash oficial publicado: no se instalará.', `esperado ${expected}, obtenido ${got}`);

  fs.mkdirSync(toolsDir, { recursive: true });
  const tmp = path.join(toolsDir, `yt-dlp.${process.pid}.${Date.now()}.tmp.exe`);
  const final = path.join(toolsDir, YTDLP_ASSET);
  fs.writeFileSync(tmp, bin);
  try {
    const v = await (o.run ?? runProcess)(tmp, ['--version'], { timeoutMs: 30_000 });
    if (v.code !== 0 || compareYtDlpVersions(v.stdout.trim(), rel.version) !== 0) throw new UserFacingError('La versión descargada no responde como se esperaba: no se instalará.', v.stderr || v.stdout);
    fs.renameSync(tmp, final);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return final;
}
