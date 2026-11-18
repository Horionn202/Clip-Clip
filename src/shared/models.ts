import type { EngineId } from './types';

/** Nombre del archivo/carpeta en caché de cada motor (según el código oficial de openai-whisper y faster-whisper). */
export function cacheKey(engine: EngineId, model: string): string {
  if (engine === 'faster-whisper-cuda') {
    const map: Record<string, string> = {
      turbo: 'models--mobiuslabsgmbh--faster-whisper-large-v3-turbo',
      large: 'models--Systran--faster-whisper-large-v3',
    };
    return map[model] ?? `models--Systran--faster-whisper-${model}`;
  }
  const map: Record<string, string> = { turbo: 'large-v3-turbo.pt', large: 'large-v3.pt' };
  return map[model] ?? `${model}.pt`;
}

export function isModelCached(engine: EngineId, model: string, cached: { openai: string[]; faster: string[] }): boolean {
  return (engine === 'faster-whisper-cuda' ? cached.faster : cached.openai).includes(cacheKey(engine, model));
}
