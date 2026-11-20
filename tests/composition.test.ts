import { describe, it, expect } from 'vitest';
import { autoComposition, clampRect, combineDetections, compositionErrors, compositionOf, cornerRect, iou, outputSize } from '../src/shared/composition';
import { layoutFilter, zoomRect } from '../src/main/layoutRender';
import { layoutInputFor } from '../src/main/clipRender';
import { applyClipPatch, differsFromRendered, renderedState } from '../src/shared/clipEdit';
import type { Clip } from '../src/shared/types';

const W = 1920;
const H = 1080;
const CAM = { x: 0.74, y: 0.66, w: 0.24, h: 0.3 }; // cámara abajo a la derecha
const clip = (extra: Partial<Clip> = {}): Clip => ({ id: 'c1', index: 1, start: 0, end: 30, title: 't', hook: '', reason: '', score: 80, file: '01.mp4', ...extra });

/** Extrae todos los crop=w:h:x:y del filtergraph. */
const crops = (f: string) => [...f.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)].map((m) => m.slice(1).map(Number));

describe('coordenadas normalizadas → filtros FFmpeg', () => {
  it('todos los recortes caben en el origen y son pares, en cada plantilla y aspecto', () => {
    for (const layout of ['gameplay_full', 'game_top_cam_bottom', 'cam_top_game_bottom', 'game_cam_float', 'split_horizontal', 'split_vertical', 'custom'] as const) {
      for (const a of ['9:16', '1:1', '16:9'] as const) {
        const f = layoutFilter({ layout, srcW: W, srcH: H, offsetX: 0, cam: CAM, out: outputSize(a), gameZoom: 1.5, camCrop: { x: 0.5, y: -0.5, zoom: 1.3 }, overlay: cornerRect('bottom-left', 0.4, 4 / 3, outputSize(a)) });
        for (const [cw, ch, cx, cy] of crops(f)) {
          expect(cx + cw).toBeLessThanOrEqual(W);
          expect(cy + ch).toBeLessThanOrEqual(H);
          expect(cw % 2 + ch % 2).toBe(0);
        }
        expect(f).toMatch(/\[v\]$/);
      }
    }
  });
  it('el tamaño de salida sigue al aspecto elegido', () => {
    expect(layoutFilter({ layout: 'gameplay_full', srcW: W, srcH: H, offsetX: 0, out: outputSize('1:1') })).toContain('scale=1080:1080');
    expect(layoutFilter({ layout: 'gameplay_full', srcW: W, srcH: H, offsetX: 0, out: outputSize('16:9') })).toContain('scale=1920:1080');
    const stacked = layoutFilter({ layout: 'game_top_cam_bottom', srcW: W, srcH: H, offsetX: 0, cam: CAM, out: outputSize('9:16') });
    expect(stacked).toContain('scale=1080:1216');
    expect(stacked).toContain('vstack');
  });
  it('la caja de la cámara se coloca donde dice la composición', () => {
    const f = layoutFilter({ layout: 'custom', srcW: W, srcH: H, offsetX: 0, cam: CAM, overlay: { x: 0.1, y: 0.5, w: 0.5, h: 0.2 } });
    expect(f).toContain('overlay=108:960');
  });
  it('zoom sin salir del fotograma', () => {
    const r = zoomRect({ x: 0, y: 0, w: 1000, h: 1000 }, 2, 1000, 1000, 1, 1);
    expect(r).toEqual({ x: 500, y: 500, w: 500, h: 500 });
    expect(zoomRect({ x: 0, y: 0, w: 1000, h: 1000 }, 9, 1000, 1000).w).toBe(250);
  });
  it('clip antiguo sin composición = mismo filtro que antes', () => {
    const old = clip({ layout: 'game_top_cam_bottom', camRect: CAM });
    expect(layoutFilter(layoutInputFor(old, W, H, 0))).toBe(layoutFilter({ layout: 'game_top_cam_bottom', srcW: W, srcH: H, offsetX: 0, cam: CAM }).replace(/overlay=[^[]*/, (m) => m));
  });
});

describe('detección robusta y fallback', () => {
  const det = (cam?: typeof CAM, confidence = 0.8, cls: 'facecam_inferior' | 'sin_facecam' | 'incierto' = 'facecam_inferior') => ({ cls, confidence, cam, engine: 'test' });
  it('elige la región que se repite y une los rectángulos coincidentes', () => {
    const r = combineDetections([det(CAM), det({ ...CAM, x: 0.73 }), det(CAM), det({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 })]);
    expect(r.cam!.x).toBeCloseTo(0.73, 2);
    expect(r.consistency).toBe(0.75);
    expect(r.confidence).toBeLessThan(0.8);
  });
  it('una cara que aparece una sola vez no es una facecam fiable', () => {
    const r = combineDetections([det(undefined, 0.2, 'sin_facecam'), det(undefined, 0.2, 'sin_facecam'), det(CAM, 0.9)]);
    expect(r.confidence).toBeLessThan(0.6);
    const comp = autoComposition('gameplay_full', r);
    expect(comp).toMatchObject({ template: 'gameplay_full', source: 'fallback', needsReview: true });
  });
  it('sin facecam: recorte seguro sin pedir revisión', () => {
    const r = combineDetections([det(undefined, 0.3, 'sin_facecam'), det(undefined, 0.4, 'sin_facecam')]);
    expect(r.cls).toBe('sin_facecam');
    expect(autoComposition('gameplay_full', r)).toMatchObject({ source: 'fallback', needsReview: false });
  });
  it('sin datos: incierto', () => {
    expect(combineDetections([]).cls).toBe('incierto');
  });
  it('iou y clampRect', () => {
    expect(iou(CAM, CAM)).toBeCloseTo(1);
    expect(clampRect({ x: 0.9, y: -0.2, w: 0.5, h: 0.01 })).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.05 });
  });
});

describe('edición no destructiva', () => {
  const ctx = (c: Clip) => ({ clips: [c], preset: 30 as const, sourceDuration: 120 });
  it('guardar una composición personalizada marca cambios y sincroniza layout/camRect', () => {
    const c = clip({ layout: 'gameplay_full', rendered: { start: 0, end: 30, layout: 'gameplay_full' } });
    const n = applyClipPatch('c1', { composition: { template: 'custom', facecamRect: CAM, overlayRect: { x: 0.1, y: 0.1, w: 0.4, h: 0.2 }, outputAspectRatio: '1:1' } }, ctx(c));
    expect(n).toMatchObject({ layout: 'custom', camRect: CAM, dirty: true });
    expect(n.composition).toMatchObject({ manualOverride: true, source: 'user-edited' });
    // Tras renderizar, deja de estar pendiente; volver a la automática lo vuelve a marcar.
    const rendered = { ...n, rendered: renderedState(n), dirty: false };
    expect(differsFromRendered(rendered, rendered.rendered!)).toBe(false);
    expect(applyClipPatch('c1', { composition: null }, ctx(rendered)).dirty).toBe(true);
  });
  it('rechaza una plantilla con cámara sin rectángulo', () => {
    expect(() => applyClipPatch('c1', { composition: { template: 'game_cam_float' } }, ctx(clip()))).toThrow(/cámara/);
    expect(compositionErrors(compositionOf({ composition: { template: 'custom' } }))).toHaveLength(1);
  });
  it('los subtítulos editados cuentan como cambio a renderizar', () => {
    const c = clip({ rendered: { start: 0, end: 30, layout: 'gameplay_full' } });
    const n = applyClipPatch('c1', { subtitleCues: [{ start: 0, end: 1, text: 'hola' }] }, ctx(c));
    expect(n.dirty).toBe(true);
    expect(n.subtitleCues).toEqual([{ start: 0, end: 1, text: 'hola' }]);
  });
  it('un desplazamiento 0 guardado en el clip manda sobre el ajuste global', () => {
    expect(layoutInputFor(clip({ composition: { template: 'gameplay_full', gameplayCrop: { x: 0, zoom: 1 }, manualOverride: true } }), W, H, 0.8).offsetX).toBe(0);
    // Composición automática: se respeta el ajuste global.
    expect(layoutInputFor(clip({ composition: autoComposition('gameplay_full', undefined) }), W, H, 0.8).offsetX).toBe(0.8);
    expect(layoutInputFor(clip(), W, H, 0.8).offsetX).toBe(0.8);
  });
  it('cambiar el tramo desplaza los subtítulos editados', () => {
    const c = clip({ start: 10, end: 40, subtitleCues: [{ start: 5, end: 6, text: 'hola' }, { start: 0.5, end: 1, text: 'fuera' }] });
    const n = applyClipPatch('c1', { start: 12, end: 42 }, { clips: [c], preset: 30, sourceDuration: 120 });
    expect(n.subtitleCues).toEqual([{ start: 3, end: 4, text: 'hola' }]);
  });
});
