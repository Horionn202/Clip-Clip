import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { Modal } from '../src/renderer/components/Modal';
import { UNSAVED_MESSAGE, canClose, nextFocusIndex } from '../src/renderer/modalLogic';

// Entorno de tests sin DOM: se comprueba la lógica pura (foco, cierre) y el marcado renderizado.

describe('modal: foco atrapado y teclado', () => {
  it('Tab avanza y vuelve al primero; Shift+Tab retrocede y salta al último', () => {
    expect(nextFocusIndex(3, 0, false)).toBe(1);
    expect(nextFocusIndex(3, 2, false)).toBe(0);
    expect(nextFocusIndex(3, 0, true)).toBe(2);
    expect(nextFocusIndex(3, -1, false)).toBe(0);
    expect(nextFocusIndex(3, -1, true)).toBe(2);
    expect(nextFocusIndex(0, 0, false)).toBe(-1);
  });
  it('Escape/cerrar sin cambios cierra; con cambios pide confirmación', () => {
    const asked: string[] = [];
    expect(canClose(false, () => false)).toBe(true);
    expect(canClose(true, (m) => (asked.push(m), false))).toBe(false);
    expect(canClose(true, () => true)).toBe(true);
    expect(asked).toEqual([UNSAVED_MESSAGE]);
  });
});

describe('modal: marcado', () => {
  const render = (open: boolean) =>
    renderToStaticMarkup(createElement(Modal, { open, title: 'Preparar publicación', onClose: () => undefined, footer: createElement('button', null, 'Guardar') }, createElement('p', null, 'cuerpo')));
  it('abierto: cabecera con título y cerrar, cuerpo con scroll y pie fijo', () => {
    const html = render(true);
    expect(html).toMatch(/^<dialog[^>]*class="modal2 modal-md"/);
    expect(html).toContain('aria-modal="true"');
    expect(html).toMatch(/aria-labelledby="([^"]+)".*<h2 id="\1"/);
    expect(html).toContain('aria-label="Cerrar"');
    expect(html).toContain('<div class="modal-body"><p>cuerpo</p></div>');
    expect(html).toContain('<footer class="modal-foot"><button>Guardar</button></footer>');
  });
  it('cerrado: no renderiza contenido (no ocupa sitio en la página)', () => {
    const html = render(false);
    expect(html).not.toContain('cuerpo');
    expect(html).not.toContain('modal-foot');
  });
  it('el CSS bloquea el scroll de fondo, limita la altura y usa pantalla completa en pantallas estrechas', () => {
    const css = fs.readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');
    expect(css).toContain('body.modal-open{overflow:hidden}');
    expect(css).toMatch(/\.modal2\{[^}]*max-height:88vh[^}]*overflow:hidden/);
    expect(css).toMatch(/\.modal-body\{[^}]*overflow:auto/);
    expect(css).toMatch(/@media \(max-width:720px\)\{\.modal2[^}]*height:100vh/);
  });
  it('Publicar, editar clip, exportar, liberar espacio y errores usan el modal (no despliegan contenido en la página)', () => {
    const src = (f: string) => fs.readFileSync(path.join(__dirname, '../src/renderer/pages', f), 'utf8');
    expect(src('Publish.tsx')).toMatch(/<Modal[\s\S]*Copiar publicación completa/);
    expect(src('Publish.tsx')).not.toContain('PublishPanel');
    const results = src('Results.tsx');
    for (const m of ['PublishModal', 'EditClipModal', 'ExportConfirm']) expect(results).toContain(`<${m}`);
    expect(results).not.toContain('aria-expanded');
    expect(src('Storage.tsx')).toContain('<Modal');
    expect(src('Jobs.tsx')).not.toContain('window.confirm');
    expect(src('Jobs.tsx')).not.toContain('<details>');
  });
});
