import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// CSP estricta sólo en build de producción (el servidor de desarrollo de Vite necesita scripts inline para HMR).
const csp: Plugin = {
  name: 'inject-csp',
  apply: 'build',
  transformIndexHtml(html) {
    const policy =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: clip:; media-src clip:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
    return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
  },
};

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react(), csp],
  build: { outDir: resolve(__dirname, 'dist/renderer'), emptyOutDir: true },
  server: { port: 5183, strictPort: true, host: '127.0.0.1' },
});
