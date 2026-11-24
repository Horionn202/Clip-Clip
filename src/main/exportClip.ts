// Copia de un clip renderizado a la carpeta de exportación (o a una subcarpeta como «Destacados»).
// Es la ÚNICA copia que se hace: dentro de los datos de la app cada clip existe una sola vez; un destacado es una
// marca sobre ese mismo clip, nunca otro MP4.
import fs from 'node:fs';
import path from 'node:path';
import type { Clip } from '../shared/types';
import { UserFacingError } from '../shared/validation';
import { isInside } from './paths';

export function uniquePath(dir: string, file: string): string {
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  let p = path.join(dir, file);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

/** Copia el MP4 del clip a `exportDir[/subfolder]` sin sobrescribir nada y devuelve la ruta creada. */
export function copyClipOut(o: { jobsDir: string; clipsDir: string; clip: Pick<Clip, 'file' | 'archived' | 'dirty' | 'index' | 'exportedPath'>; exportDir: string; subfolder?: 'Destacados' }): string {
  const { clip } = o;
  if (!clip.file) throw new UserFacingError('El clip no está renderizado.');
  if (clip.archived) throw new UserFacingError('Este clip está archivado: ya está exportado en ' + (clip.exportedPath ?? 'tu carpeta de exportación') + '.');
  if (clip.dirty) throw new UserFacingError(`El clip ${clip.index} tiene cambios sin renderizar: vuelve a renderizarlo antes de exportarlo.`);
  const src = path.join(o.clipsDir, clip.file);
  if (!isInside(o.clipsDir, src) || !fs.existsSync(src)) throw new UserFacingError('No se encuentra el archivo del clip.');
  const dir = o.subfolder ? path.join(o.exportDir, o.subfolder) : o.exportDir;
  // Los exports nunca van dentro de los datos internos (no se duplica nada en %APPDATA%/Clip Clip/jobs).
  if (isInside(o.jobsDir, dir)) throw new UserFacingError('La carpeta de exportación no puede estar dentro de los datos internos de la app.');
  fs.mkdirSync(dir, { recursive: true });
  const dest = uniquePath(dir, clip.file);
  fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL); // nunca sobrescribe archivos del usuario
  return dest;
}
