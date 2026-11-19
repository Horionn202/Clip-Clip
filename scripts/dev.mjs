// Desarrollo: compila main/preload, arranca Vite y lanza Electron apuntando al servidor de desarrollo.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'vite';
import electronPath from 'electron';

// Iconos y logo de la interfaz (generados desde resources/brand/clip-clip-logo.png; no versionados).
const icons = spawnSync(process.execPath, ['scripts/make-icons.mjs'], { stdio: 'inherit' });
if (icons.status !== 0) process.exit(icons.status ?? 1);

const tsc = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.node.json'], { stdio: 'inherit' });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`[dev] Vite en ${url}`);

const child = spawn(electronPath, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, VITE_DEV_SERVER_URL: url } });
child.on('close', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
