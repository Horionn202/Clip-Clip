// Almacén local de metadatos de publicación (data/publish.json). Separado de jobs.json: no altera trabajos existentes.
import fs from 'node:fs';
import path from 'node:path';
import type { ClipPublish, Platform, PlatformEntry, PublishData } from '../shared/publish';

export class PublishStore {
  private file: string;
  private data: PublishData;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'publish.json');
    this.data = PublishStore.read(this.file);
  }

  private static read(file: string): PublishData {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      return j && typeof j === 'object' && !Array.isArray(j) ? (j as PublishData) : {};
    } catch {
      return {};
    }
  }

  forJob(jobId: string): Record<string, ClipPublish> {
    return this.data[jobId] ?? {};
  }

  get(jobId: string, clipId: string, p: Platform): PlatformEntry | undefined {
    return this.data[jobId]?.[clipId]?.[p];
  }

  put(jobId: string, clipId: string, p: Platform, entry: PlatformEntry): void {
    const job = (this.data[jobId] ??= {});
    const clip = (job[clipId] ??= {});
    clip[p] = entry;
    this.flush();
  }

  /** Al borrar un trabajo se borran también sus metadatos de publicación. */
  deleteJob(jobId: string): void {
    if (!(jobId in this.data)) return;
    delete this.data[jobId];
    this.flush();
  }

  private flush(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}
