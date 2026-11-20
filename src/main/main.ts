import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, net, protocol, shell } from 'electron';
import { buildAppPaths, isInside } from './paths';
import { event, initLogger, log } from './logger';
import { legacyPaths } from './legacy';
import { JobStore, SettingsStore, defaultSettings } from './store';
import { JobQueue } from './queue';
import { PublishStore } from './publishStore';
import { createPipeline, jobDir, type PipelineContext } from './pipeline';
import { probeGpu, resolveTools, type ResolvedTools } from './deps';
import type { GpuInfo } from '../shared/types';
import { emitJob, registerIpc } from './ipc';

const DEV_URL = process.env.VITE_DEV_SERVER_URL; // sólo en `npm run dev`
const isDev = !!DEV_URL && !app.isPackaged;

protocol.registerSchemesAsPrivileged([
  { scheme: 'clip', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

// Sólo en desarrollo: carpeta de datos aislada para pruebas manuales (nunca en la app instalada).
// Va antes del bloqueo de instancia única: así una prueba aislada no choca con la app instalada abierta.
if (!app.isPackaged && process.env.CLIP_CLIP_DATA_DIR) app.setPath('userData', process.env.CLIP_CLIP_DATA_DIR);
if (!app.requestSingleInstanceLock()) app.quit();
const paths = buildAppPaths(app.getPath('userData'));
// Los datos de «ClipsVirales» ya no se migran en silencio: al abrir, el renderer pregunta (modal) qué hacer.
for (const d of [paths.jobsDir, paths.dataDir, paths.logsDir]) fs.mkdirSync(d, { recursive: true });
initLogger(paths.logsDir);
let startupNotice: { kind: 'info' | 'error'; text: string } | null = null;
const legacy = legacyPaths(app.getPath('appData'), process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'), app.getPath('videos'));

const defaults = () => defaultSettings(path.join(app.getPath('videos'), 'Clip Clip'));
const settings = new SettingsStore(paths.dataDir, defaults());
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

const pipelineCtx: PipelineContext = { jobsDir: paths.jobsDir, settings: () => settings.get(), tools: () => tools, gpuInfo: () => gpuInfo(true), fasterScript, trash: (p) => shell.trashItem(p) };
const queue = new JobQueue({
  get: (id) => jobs.get(id),
  put: (j) => jobs.put(j),
  emit: emitJob,
  concurrency: () => settings.get().maxConcurrentJobs,
  // Cada trabajo re-evalúa la GPU (por si se instaló Torch CUDA mientras la app estaba abierta).
  runner: createPipeline(pipelineCtx),
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
    pipelineCtx,
    onShutdown: (fn) => shutdownTasks.push(fn),
    legacy,
    installDir: path.dirname(app.getPath('exe')),
    appVersion: app.getVersion(),
    // Tras migrar datos antiguos se recargan historial y ajustes desde disco (sin reiniciar la app).
    reloadStores: () => {
      jobs.reload();
      // Trabajos importados a medias (cola o proceso) pasan a «fallido» para poder reintentarlos o borrarlos.
      jobs.recoverInterrupted();
      publish.reload();
      settings.reload(defaults());
      tools = resolveTools(settings.get(), bundledBin);
    },
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
  log.info(`Clip Clip ${app.getVersion()} iniciado. Datos en ${paths.userData}`);
});

app.on('second-instance', () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (w) {
    if (w.isMinimized()) w.restore();
    w.focus();
  }
});

const shutdownTasks: (() => void)[] = [];
app.on('before-quit', () => {
  for (const t of shutdownTasks) t();
  queue.cancelAll();
  jobs.flush();
});

app.on('window-all-closed', () => app.quit());
