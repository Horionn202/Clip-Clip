// Antes de borrar: Windows no deja mover un archivo que un <video> tiene abierto. Se pausan y se descargan todos
// los reproductores de la página. Devuelve una función que les vuelve a poner su fuente (a los que sigan en pantalla:
// los de clips borrados ya no existen), porque React no la restaura si la propiedad no cambia.
export function releaseMedia(): () => void {
  const released: { v: HTMLVideoElement; src: string }[] = [];
  for (const v of Array.from(document.querySelectorAll('video'))) {
    try {
      const src = v.getAttribute('src');
      v.pause();
      if (src) released.push({ v, src });
      v.removeAttribute('src');
      v.load();
    } catch {
      /* ignorar */
    }
  }
  return () => {
    for (const { v, src } of released) {
      if (!v.isConnected || v.getAttribute('src')) continue;
      v.setAttribute('src', src);
      v.load();
    }
  };
}
