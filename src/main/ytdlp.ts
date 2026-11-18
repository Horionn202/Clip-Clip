// Interpretación de errores de yt-dlp y estrategia de reintento (puro y testeable).

/** YouTube a veces exige "confirmar que no eres un bot" según la IP; el cliente mweb suele evitarlo sin cookies. */
export const FALLBACK_CLIENT_ARGS = ['--extractor-args', 'youtube:player_client=mweb'];

export function isBotCheck(stderr: string): boolean {
  return /confirm you.{0,3}re not a bot/i.test(stderr);
}

/** Traduce el stderr de yt-dlp a un mensaje claro en español. */
export function friendlyYtDlpError(stderr: string): string {
  const s = stderr;
  if (isBotCheck(s)) {
    return 'YouTube ha pedido verificar que no eres un bot y la descarga sin sesión no fue posible. Espera unos minutos, prueba otra red o actualiza yt-dlp («winget upgrade yt-dlp.yt-dlp»).';
  }
  if (/Private video/i.test(s)) return 'El vídeo es privado; la app sólo procesa contenido público.';
  if (/confirm your age|age.restricted|inappropriate for some users/i.test(s)) {
    return 'El vídeo tiene restricción de edad y requiere iniciar sesión; la app no usa cuentas ni cookies.';
  }
  if (/members.only|Join this channel/i.test(s)) return 'El vídeo es sólo para miembros del canal.';
  if (/not available in your country|geo.?restrict/i.test(s)) return 'El vídeo no está disponible en tu país.';
  if (/Video unavailable|has been removed|does not exist|404/i.test(s)) return 'El vídeo no existe o ya no está disponible.';
  if (/Unsupported URL/i.test(s)) return 'Esa web no está soportada por yt-dlp.';
  if (/getaddrinfo|Network is unreachable|timed out|Connection (refused|reset)/i.test(s)) {
    return 'No hay conexión con el sitio del vídeo. Revisa tu conexión a internet.';
  }
  if (/Requested format is not available/i.test(s)) return 'No hay un formato de vídeo descargable para esta URL.';
  return 'No se pudo leer la información del vídeo. Comprueba que la URL es pública y accesible.';
}
