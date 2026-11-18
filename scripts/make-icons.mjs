// Genera los iconos de Clip Clip a partir del logo oficial (resources/brand/clip-clip-logo.png) sin modificarlo:
// sólo recorta un cuadrado centrado en el símbolo y lo escala. Salida (no versionada):
//   build/icon.ico            → icono multi-tamaño (16, 24, 32, 48, 64, 128, 256) para Windows / instalador / accesos directos
//   build/icons/logo-<n>.png  → PNG cuadrados para la ventana, la pantalla de carga y la interfaz
// Requiere FFmpeg/FFprobe (los mismos que usa la app).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'resources', 'brand', 'clip-clip-logo.png');
const OUT = path.join(root, 'build');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_SIZES = [...ICO_SIZES, 512];

function tool(name) {
  const local = path.join(root, 'resources', 'bin', `${name}.exe`);
  return fs.existsSync(local) ? local : name;
}
function run(cmd, args) {
  const r = spawnSync(tool(cmd), args, { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} falló: ${r.stderr?.toString().slice(-400)}`);
  return r.stdout;
}

/** Recorte cuadrado alrededor del símbolo (píxeles con brillo apreciable), con margen para conservar el halo. */
export function squareCrop(gray, w, h, srcW, srcH, threshold = 70, margin = 1.3) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (gray[y * w + x] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error('No se encontró el símbolo en el logo.');
  const sx = srcW / w;
  const sy = srcH / h;
  const cx = ((x0 + x1 + 1) / 2) * sx;
  const cy = ((y0 + y1 + 1) / 2) * sy;
  let side = Math.max((x1 - x0 + 1) * sx, (y1 - y0 + 1) * sy) * margin;
  side = Math.min(side, srcW, srcH);
  const x = Math.round(Math.min(Math.max(0, cx - side / 2), srcW - side));
  const y = Math.round(Math.min(Math.max(0, cy - side / 2), srcH - side));
  const s = Math.floor(side / 2) * 2;
  return { x, y, s };
}

/** Empaqueta PNGs en un .ico (entradas PNG, válido en Windows Vista y posteriores). */
export function packIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...images.map((i) => i.data)]);
}

function main() {
  if (!fs.existsSync(SRC)) throw new Error(`Falta el logo oficial: ${SRC}`);
  const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', SRC]).toString());
  const { width: srcW, height: srcH } = probe.streams[0];
  const aw = 192;
  const ah = Math.round((aw * srcH) / srcW);
  const gray = run('ffmpeg', ['-v', 'error', '-i', SRC, '-vf', `scale=${aw}:${ah},format=gray`, '-f', 'rawvideo', '-']);
  const { x, y, s } = squareCrop(gray, aw, ah, srcW, srcH);
  fs.mkdirSync(path.join(OUT, 'icons'), { recursive: true });
  const pngs = {};
  for (const size of PNG_SIZES) {
    const file = path.join(OUT, 'icons', `logo-${size}.png`);
    run('ffmpeg', ['-v', 'error', '-y', '-i', SRC, '-vf', `crop=${s}:${s}:${x}:${y},scale=${size}:${size}:flags=lanczos,format=rgba`, '-frames:v', '1', file]);
    pngs[size] = fs.readFileSync(file);
  }
  fs.writeFileSync(path.join(OUT, 'icon.ico'), packIco(ICO_SIZES.map((size) => ({ size, data: pngs[size] }))));
  // Copia para la interfaz (sidebar y pantalla de carga): 128 px, nítido en pantallas HiDPI a 32–64 px.
  const assets = path.join(root, 'src', 'renderer', 'assets');
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, 'logo-128.png'), pngs[128]);
  console.log(`[iconos] recorte ${s}×${s} en (${x}, ${y}) de ${srcW}×${srcH} → build/icon.ico (${ICO_SIZES.join(', ')} px) y build/icons/*.png`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
