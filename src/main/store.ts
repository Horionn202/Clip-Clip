import fs from 'node:fs';
import path from 'node:path';
import type { Job, Settings } from '../shared/types';
import { TERMINAL_STATUSES } from '../shared/types';

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Escritura atómica: archivo temporal + rename. */
function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function defaultSettings(exportDir: string): Settings {
  return {
    ollamaHost: 'http://127.0.0.1:11434',
    ollamaModel: 'llama3.2:3b',
    whisperModel: 'small',
    whisperLanguage: '',
    exportDir,
    ffmpegPath: '',
    ffprobePath: '',
    ytDlpPath: '',
    whisperPath: '',
    deleteSourceAfterCompletion: false,
    deleteTempAfterCompletion: true,
    maxConcurrentJobs: 1,
    maxSourceMinutes: 180,
    maxDownloadMB: 4096,
    minFreeDiskMB: 2048,
    cropOffsetX: 0,
    subtitleFontSize: 72,
    onboardingDone: false,
  };
}

export class SettingsStore {
  private file: string;
  private value: Settings;
  constructor(dataDir: string, defaults: Settings) {
    this.file = path.join(dataDir, 'settings.json');
    this.value = { ...defaults, ...readJson<Partial<Settings>>(this.file, {}) };
  }
  get(): Settings {
    return { ...this.value };
  }
  update(patch: Partial<Settings>): Settings {
    this.value = { ...this.value, ...patch };
    writeJson(this.file, this.value);
    return this.get();
  }
}

export class JobStore {
  private file: string;
  private jobs = new Map<string, Job>();
  private timer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'jobs.json');
    for (const j of readJson<Job[]>(this.file, [])) this.jobs.set(j.id, j);
  }

  /** Trabajos interrumpidos por un cierre de la app pasan a 'failed'. */
  recoverInterrupted(): void {
    for (const j of this.jobs.values()) {
      if (!TERMINAL_STATUSES.includes(j.status)) {
        j.status = 'failed';
        j.error = 'El trabajo se interrumpió porque la aplicación se cerró. Puedes crearlo de nuevo.';
        j.updatedAt = new Date().toISOString();
      }
    }
    this.flush();
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }
  put(job: Job): void {
    job.updatedAt = new Date().toISOString();
    this.jobs.set(job.id, job);
    this.scheduleFlush();
  }
  delete(id: string): void {
    this.jobs.delete(id);
    this.flush();
  }
  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 250);
  }
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    writeJson(this.file, this.list());
  }
}
