#!/usr/bin/env node
// SÓLO PARA DESARROLLO. Limpia artefactos de compilación antiguos de release/ (instaladores, blockmaps,
// carpetas win-unpacked…). No toca código fuente, node_modules, datos de usuario (%APPDATA%) ni exports.
// Nunca se ejecuta automáticamente ni forma parte de la app instalada.
//
//   npm run clean:release            → muestra qué se borraría (simulación)
//   npm run clean:release -- --yes   → lo borra
//   añade --all para borrar también el instalador de la versión actual
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Qué entradas de release/ se borran. Pura (testeable). */
export function planReleaseCleanup(entries, version, all = false) {
  const keep = new Set(all ? [] : [`Clip-Clip-Setup-${version}.exe`, `Clip-Clip-Setup-${version}.exe.blockmap`, 'latest.yml']);
  return entries.filter((n) => !keep.has(n));
}

/** La carpeta a limpiar debe ser exactamente <repo>/release. */
export function assertReleaseDir(dir, repoRoot) {
  const d = path.resolve(dir);
  if (d !== path.join(path.resolve(repoRoot), 'release')) throw new Error(`Carpeta no permitida: ${d}`);
  return d;
}

function size(p) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(p).reduce((a, n) => a + size(path.join(p, n)), 0);
}

function main() {
  const args = new Set(process.argv.slice(2));
  const dir = assertReleaseDir(path.join(repo, 'release'), repo);
  if (!fs.existsSync(dir)) return console.log('No hay carpeta release/.');
  const { version } = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const del = planReleaseCleanup(fs.readdirSync(dir), version, args.has('--all'));
  let total = 0;
  for (const n of del) {
    const p = path.join(dir, n);
    const b = size(p);
    total += b;
    console.log(`${args.has('--yes') ? 'Borrando' : 'Se borraría'}: release/${n} (${(b / 1024 ** 2).toFixed(1)} MB)`);
    if (args.has('--yes')) fs.rmSync(p, { recursive: true, force: true });
  }
  console.log(`${del.length} elemento(s), ${(total / 1024 ** 3).toFixed(2)} GB.${args.has('--yes') ? '' : ' Simulación: usa --yes para borrar.'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
