import { describe, it, expect } from 'vitest';
import { friendlyYtDlpError, isBotCheck } from '../src/main/ytdlp';

describe('errores de yt-dlp', () => {
  const bot = "ERROR: [youtube] 8rOANDroC0E: Sign in to confirm you’re not a bot. Use --cookies-from-browser";
  it('detecta la verificación anti-bot (con apóstrofo tipográfico o recto)', () => {
    expect(isBotCheck(bot)).toBe(true);
    expect(isBotCheck("Sign in to confirm you're not a bot")).toBe(true);
    expect(isBotCheck('ERROR: Private video')).toBe(false);
  });
  it.each([
    [bot, /bot/],
    ['ERROR: [youtube] x: Private video. Sign in if you\'ve been granted access', /privado/],
    ['ERROR: Sign in to confirm your age', /edad/],
    ['ERROR: Video unavailable', /no existe/i],
    ['ERROR: Unsupported URL: https://x.com', /no es válida/],
    ['getaddrinfo failed', /conexión/],
    ['algo raro', /pública y accesible/],
  ])('%s → mensaje claro', (stderr, re) => {
    expect(friendlyYtDlpError(stderr)).toMatch(re);
  });
});
