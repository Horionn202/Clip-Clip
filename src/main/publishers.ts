// Conexiones con plataformas: sólo interfaces y el modo manual. NO hay subida real ni credenciales en el repositorio.
//
// Diseño para el futuro:
//  - Cada plataforma implementa PublisherAdapter.
//  - Los tokens OAuth se guardarían cifrados con el almacén seguro del sistema (Electron safeStorage → DPAPI en Windows),
//    nunca en JSON plano ni en el repositorio.
//  - publish() sólo podría llamarse tras una confirmación explícita del usuario para ESE clip y ESA plataforma.
import type { ConnectionInfo, Platform, PublishMeta } from '../shared/publish';
export type { ConnectionInfo };
import { PLATFORM_LABELS } from '../shared/publish';


export interface PublishRequest {
  platform: Platform;
  videoPath: string;
  meta: PublishMeta;
  /** Debe ser true: confirmación explícita del usuario para este clip. */
  confirmedByUser: true;
}

export interface PublisherAdapter {
  readonly platform: Platform;
  info(): ConnectionInfo;
  /** Subida real. Ningún adaptador actual la implementa. */
  publish(req: PublishRequest): Promise<{ url?: string }>;
}

class NotImplementedError extends Error {}

/** Modo manual: el usuario copia el texto, abre la carpeta y sube el vídeo él mismo. */
class ManualAdapter implements PublisherAdapter {
  constructor(readonly platform: Platform) {}
  info(): ConnectionInfo {
    return {
      platform: this.platform,
      name: PLATFORM_LABELS[this.platform],
      state: 'manual',
      detail: 'Publicación manual: copia el texto y sube el vídeo exportado desde la app o la web de la plataforma.',
      supportsDirectUpload: false,
    };
  }
  async publish(): Promise<{ url?: string }> {
    throw new NotImplementedError('La subida directa no está disponible. Publica manualmente y marca el clip como publicado.');
  }
}

export const ADAPTERS: Record<Platform, PublisherAdapter> = {
  tiktok: new ManualAdapter('tiktok'),
  shorts: new ManualAdapter('shorts'),
  reels: new ManualAdapter('reels'),
};

export function listConnections(): ConnectionInfo[] {
  return Object.values(ADAPTERS).map((a) => a.info());
}
