import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, net, protocol, shell } from 'electron';
import { buildAppPaths, isInside } from './paths';
import { event, initLogger, log } from './logger';
import { LEGACY_DIR_NAME, migrateLegacyData, migrationNotice, type MigrationReport } from './migration';
import { JobStore, SettingsStore, defaultSettings } from './store';
import { JobQueue } from './queue';
import { PublishStore } from './publishStore';
import { createPipeline, jobDir } from './pipeline';
import { probeGpu, resolveTools, type ResolvedTools } from './deps';
import type { GpuInfo } from '../shared/types';
import { emitJob, registerIpc } from './ipc';

const DEV_URL = process.env.VITE_DEV_SERVER_URL; // sólo en `npm run dev`
const isDev = !!DEV_URL && !app.isPackaged;

protocol.registerSchemesAsPrivileged([
  { scheme: 'clip', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();

const paths = buildAppPaths(app.getPath('userData'));
// Migración desde «ClipsVirales» (%APPDATA%\ClipsVirales) antes de abrir ajustes e historial.
// Nunca borra ni sobrescribe; si falla, se conservan ambas carpetas y se reintenta en el siguiente inicio.
let migration: MigrationReport | null = null;
try {
  migration = migrateLegacyData(path.join(app.getPath('appData'), LEGACY_DIR_NAME), paths.userData);
} catch (e) {
  migration = { status: 'failed', from: LEGACY_DIR_NAME, to: paths.userData, linked: 0, copied: 0, skippedExisting: 0, mergedJobs: 0, errors: [String(e)], at: new Date().toISOString() };
}
for (const d of [paths.jobsDir, paths.dataDir, paths.logsDir]) fs.mkdirSync(d, { recursive: true });
initLogger(paths.logsDir);
if (migration && migration.status !== 'none' && migration.status !== 'already') {
  const { errors, ...summary } = migration;
  log.info('Migración de datos desde ClipsVirales', { ...summary, errores: errors.length });
  for (const e of errors.slice(0, 20)) log.error(`Migración: ${e}`);
  event('migration', { ...summary, errors: errors.length });
}
let startupNotice = migration ? migrationNotice(migration) : null;

const settings = new SettingsStore(paths.dataDir, defaultSettings(path.join(app.getPath('videos'), 'Clip Clip')));
const jobs = new JobStore(paths.dataDir);
const publish = new PublishStore(paths.dataDir);
jobs.recoverInterrupted();

const resourcesDir = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources');
const bundledBin = path.join(resourcesDir, 'bin');
const probeScript = path.join(resourcesDir, 'python', 'probe.py');
const fasterScript = path.join(resourcesDir, 'python', 'fw_transcribe.py');
let tools: ResolvedTools = resolveTools(settings.get(), bundledBin);

// El diagnóstico de Python/Torch tarda unos segundos: se cachea y se refresca bajo demanda o al cambiar ajustes.
let gpuCache: Promise<GpuInfo> | null = null;
function gpuInfo(refresh = false): Promise<GpuInfo> {
  if (!gpuCache || refresh) {
    gpuCache = probeGpu(tools, settings.get(), probeScript, undefined, path.join(paths.dataDir, 'model-hashes.json')).catch((e) => {
      gpuCache = null;
      throw e;
    });
  }
  return gpuCache;
}

const queue = new JobQueue({
  get: (id) => jobs.get(id),
  put: (j) => jobs.put(j),
  emit: emitJob,
  concurrency: () => settings.get().maxConcurrentJobs,
  // Cada trabajo re-evalúa la GPU (por si se instaló Torch CUDA mientras la app estaba abierta).
  runner: createPipeline({ jobsDir: paths.jobsDir, settings: () => settings.get(), tools: () => tools, gpuInfo: () => gpuInfo(true), fasterScript, trash: (p) => shell.trashItem(p) }),
  logError: (m, e) => log.error(m, e),
});

const rendererIndex = path.join(__dirname, '..', '..', 'dist', 'renderer', 'index.html');
// Icono de la ventana y la barra de tareas (generado desde resources/brand/clip-clip-logo.png).
const appIcon = app.isPackaged ? path.join(process.resourcesPath, 'icons', 'logo-256.png') : path.join(app.getAppPath(), 'build', 'icons', 'logo-256.png');

function isTrustedSender(url: string): boolean {
  if (isDev && DEV_URL) return url.startsWith(DEV_URL);
  try {
    return new URL(url).protocol === 'file:' && path.resolve(decodeURIComponent(new URL(url).pathname).replace(/^\/(\w:)/, '$1')) === path.resolve(rendererIndex);
  } catch {
    return false;
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'Clip Clip',
    icon: appIcon,
    backgroundColor: '#0f1115',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  // Bloquea navegación y ventanas nuevas; los enlaces externos se abren en el navegador del sistema.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isTrustedSender(url)) e.preventDefault();
  });
  if (isDev) void win.loadURL(DEV_URL!);
  else void win.loadFile(rendererIndex);
}

app.whenReady().then(() => {
  // clip://job/<jobId>/<archivo.mp4> → sólo archivos .mp4 dentro de la carpeta de clips del trabajo
  protocol.handle('clip', (req) => {
    try {
      const u = new URL(req.url);
      const [jobId, file] = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      // clip://export/<jobId>/<clipId>: clip archivado (interno borrado al liberar espacio) → su export verificado.
      // La ruta sale de los datos guardados del trabajo, nunca de la URL.
      if (u.hostname === 'export') {
        const j = /^[a-z0-9-]{8,64}$/.test(jobId ?? '') ? jobs.get(jobId) : undefined;
        const c = j?.clips.find((x) => x.id === file);
        const exp = c?.exportedPath;
        if (!c || !exp || !/\.mp4$/i.test(exp) || !fs.existsSync(exp)) return new Response('Not found', { status: 404 });
        return net.fetch(pathToFileURL(exp).toString(), { headers: req.headers });
      }
      // clip://job/<id>/<clip.mp4>  ·  clip://frame/<id>/<fotograma.jpg> (vistas previas y referencia de facecam)
      const isFrame = u.hostname === 'frame';
      const okName = isFrame ? /^[\w.-]+\.jpg$/.test(file ?? '') : /^[\w.() -]+\.mp4$/.test(file ?? '');
      if ((u.hostname !== 'job' && !isFrame) || !/^[a-z0-9-]{8,64}$/.test(jobId ?? '') || !okName) {
        return new Response('Bad request', { status: 400 });
      }
      const clipsDir = path.join(jobDir(paths.jobsDir, jobId), isFrame ? 'frames' : 'clips');
      const full = path.join(clipsDir, file);
      if (!isInside(clipsDir, full) || !fs.existsSync(full)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(full).toString(), { headers: req.headers });
    } catch {
      return new Response('Error', { status: 500 });
    }
  });

  registerIpc({
    jobsDir: paths.jobsDir,
    isTrustedSender,
    settings,
    jobs,
    queue,
    tools: () => tools,
    gpuInfo,
    userDataDir: paths.userData,
    logsDir: paths.logsDir,
    probeScript,
    publish,
    // Aviso de una sola vez (p. ej. datos migrados): el renderer lo pide al arrancar.
    takeStartupNotice: () => {
      const n = startupNotice;
      startupNotice = null;
      return n;
    },
    onSettingsChanged: () => {
      tools = resolveTools(settings.get(), bundledBin);
      gpuCache = null;
    },
  });
  createWindow();
  log.info(`Clip Clip iniciado. Datos en ${paths.userData}`);
});

app.on('second-instance', () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (w) {
    if (w.isMinimized()) w.restore();
    w.focus();
  }
});

app.on('before-quit', () => {
  queue.cancelAll();
  jobs.flush();
});

app.on('window-all-closed', () => app.quit());
