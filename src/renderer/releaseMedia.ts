// Antes de borrar: Windows no deja mover un archivo que un <video> tiene abierto. Se pausan y se descargan todos
// los reproductores de la página (React vuelve a ponerles la fuente en el siguiente pintado si siguen existiendo).
export function releaseMedia(): void {
  for (const v of Array.from(document.querySelectorAll('video'))) {
    try {
      v.pause();
      v.removeAttribute('src');
      v.load();
    } catch {
      /* ignorar */
    }
  }
}
