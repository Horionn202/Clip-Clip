import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, net, protocol, shell } from 'electron';
import { buildAppPaths, isInside } from './paths';
import { initLogger, log } from './logger';
import { JobStore, SettingsStore, defaultSettings } from './store';
import { JobQueue } from './queue';
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
for (const d of [paths.jobsDir, paths.dataDir, paths.logsDir]) fs.mkdirSync(d, { recursive: true });
initLogger(paths.logsDir);

const settings = new SettingsStore(paths.dataDir, defaultSettings(path.join(app.getPath('videos'), 'ClipsVirales')));
const jobs = new JobStore(paths.dataDir);
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
  runner: createPipeline({ jobsDir: paths.jobsDir, settings: () => settings.get(), tools: () => tools, gpuInfo: () => gpuInfo(true), fasterScript }),
  logError: (m, e) => log.error(m, e),
});

const rendererIndex = path.join(__dirname, '..', '..', 'dist', 'renderer', 'index.html');

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
    title: 'ClipsVirales',
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
      if (u.hostname !== 'job' || !/^[a-z0-9-]{8,64}$/.test(jobId ?? '') || !/^[\w.() -]+\.mp4$/.test(file ?? '')) {
        return new Response('Bad request', { status: 400 });
      }
      const clipsDir = path.join(jobDir(paths.jobsDir, jobId), 'clips');
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
    onSettingsChanged: () => {
      tools = resolveTools(settings.get(), bundledBin);
      gpuCache = null;
    },
  });
  createWindow();
  log.info(`ClipsVirales iniciado. Datos en ${paths.userData}`);
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
