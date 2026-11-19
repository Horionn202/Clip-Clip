// Preload aislado (sandbox): expone una API mínima y tipada. Sin acceso a Node en el renderer.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ClipsApi, Job, PullProgress } from '../shared/types';
import type { SetupState } from '../shared/gpuSetup';

const subscribe = <T>(channel: 'job:update' | 'ollama:pullProgress' | 'gpu:setupProgress', cb: (v: T) => void) => {
  const listener = (_e: IpcRendererEvent, v: T) => cb(v);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
};

const api: ClipsApi = {
  checkDeps: () => ipcRenderer.invoke('deps:check'),
  getPublish: (jobId) => ipcRenderer.invoke('publish:get', String(jobId)),
  generatePublish: (jobId, clipId) => ipcRenderer.invoke('publish:generate', String(jobId), String(clipId)),
  savePublish: (jobId, clipId, platform, meta) => ipcRenderer.invoke('publish:save', String(jobId), String(clipId), String(platform), meta),
  restorePublish: (jobId, clipId, platform, index) => ipcRenderer.invoke('publish:restore', String(jobId), String(clipId), String(platform), Number(index)),
  setPublishStatus: (jobId, clipId, platform, status, url) => ipcRenderer.invoke('publish:setStatus', String(jobId), String(clipId), String(platform), String(status), url ?? null),
  copyPublish: (jobId, clipId, platform) => ipcRenderer.invoke('publish:copy', String(jobId), String(clipId), String(platform)),
  revealClipVideo: (jobId, clipId) => ipcRenderer.invoke('publish:revealVideo', String(jobId), String(clipId)),
  publishConnections: () => ipcRenderer.invoke('publish:connections'),
  analyzeStorage: (opts, jobId) => ipcRenderer.invoke('storage:analyze', opts ?? null, jobId ?? null),
  cleanStorage: (opts, jobId) => ipcRenderer.invoke('storage:clean', opts, jobId ?? null),
  startupNotice: () => ipcRenderer.invoke('app:startupNotice'),
  probeUrl: (url) => ipcRenderer.invoke('source:probe', String(url)),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  chooseExportDir: () => ipcRenderer.invoke('settings:chooseExportDir'),
  listOllamaModels: () => ipcRenderer.invoke('ollama:list'),
  pullOllamaModel: (name) => ipcRenderer.invoke('ollama:pull', String(name)),
  cancelOllamaPull: () => ipcRenderer.invoke('ollama:pullCancel'),
  benchmarkModel: (name) => ipcRenderer.invoke('ollama:benchmark', String(name)),
  createJob: (req) => ipcRenderer.invoke('jobs:create', req),
  listJobs: () => ipcRenderer.invoke('jobs:list'),
  cancelJob: (id) => ipcRenderer.invoke('jobs:cancel', String(id)),
  retryJob: (id) => ipcRenderer.invoke('jobs:retry', String(id)),
  deleteJob: (id) => ipcRenderer.invoke('jobs:delete', String(id)),
  renameClip: (jobId, clipId, title) => ipcRenderer.invoke('clips:rename', String(jobId), String(clipId), String(title)),
  updateClip: (jobId, clipId, patch) => ipcRenderer.invoke('clips:update', String(jobId), String(clipId), patch),
  rerenderClip: (jobId, clipId) => ipcRenderer.invoke('clips:rerender', String(jobId), String(clipId)),
  previewLayout: (jobId, clipId, layout, camRect, range) => ipcRenderer.invoke('clips:preview', String(jobId), String(clipId), String(layout), camRect, range ?? null),
  exportClip: (jobId, clipId) => ipcRenderer.invoke('clips:export', String(jobId), String(clipId)),
  exportAll: (jobId) => ipcRenderer.invoke('clips:exportAll', String(jobId)),
  openJobFolder: (jobId) => ipcRenderer.invoke('shell:openJobFolder', String(jobId)),
  openExportFolder: () => ipcRenderer.invoke('shell:openExportFolder'),
  onJobUpdate: (cb) => subscribe<Job>('job:update', cb),
  onPullProgress: (cb) => subscribe<PullProgress>('ollama:pullProgress', cb),
  onGpuSetup: (cb) => subscribe<SetupState>('gpu:setupProgress', cb),
  gpuSetupInfo: () => ipcRenderer.invoke('gpu:setupInfo'),
  startGpuSetup: (mode) => ipcRenderer.invoke('gpu:setupStart', mode === 'verify' ? 'verify' : 'install'),
  cancelGpuSetup: () => ipcRenderer.invoke('gpu:setupCancel'),
  useCpuEngine: () => ipcRenderer.invoke('gpu:useCpu'),
  useSystemPython: () => ipcRenderer.invoke('gpu:useSystemPython'),
};

contextBridge.exposeInMainWorld('clipsApi', api);
