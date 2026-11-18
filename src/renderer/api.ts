import type { ClipsApi } from '../shared/types';

declare global {
  interface Window {
    clipsApi: ClipsApi;
  }
}

export const api = (): ClipsApi => window.clipsApi;

/** Extrae el mensaje legible de un error IPC ("Error invoking remote method 'x': Error: msg"). */
export function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
