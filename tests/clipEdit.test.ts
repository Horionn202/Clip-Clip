import { describe, it, expect } from 'vitest';
import { applyClipPatch, readyCount } from '../src/shared/clipEdit';
import { clipPatchSchema, normRectSchema } from '../src/main/ipcSchemas';
import type { Clip } from '../src/shared/types';

const mk = (id: string, index: number, start: number, extra: Partial<Clip> = {}): Clip => ({
  id,
  index,
  start,
  end: start + 30,
  title: `Clip ${index} sobre un tema`,
  hook: 'Frase de apertura del clip',
  reason: 'Razón concreta',
  score: 70,
  file: `0${index}.mp4`,
  ...extra,
});
const clips = [mk('aaaaaaaa-1', 1, 10), mk('bbbbbbbb-2', 2, 100), mk('cccccccc-3', 3, 200)];
const ctx = { clips, preset: 30 as const, sourceDuration: 600 };

describe('edición individual de un clip', () => {
  it('cambiar el título o el hook no obliga a re-renderizar', () => {
    const c = applyClipPatch('aaaaaaaa-1', { title: 'Nuevo título', hook: 'Otro gancho' }, ctx);
    expect(c).toMatchObject({ title: 'Nuevo título', hook: 'Otro gancho', dirty: false });
  });
  it('cambiar el rango marca el clip para re-renderizar', () => {
    expect(applyClipPatch('aaaaaaaa-1', { start: 12, end: 42 }, ctx)).toMatchObject({ start: 12, end: 42, dirty: true });
  });
  it.each([
    [{ start: 590, end: 620 }, /fuera del vídeo/],
    [{ start: 10, end: 20 }, /debe durar/],
    [{ start: 90, end: 120 }, /solapa con el clip 2/],
  ])('rechaza rangos inválidos %j', (p, re) => {
    expect(() => applyClipPatch('aaaaaaaa-1', p, ctx)).toThrow(re);
  });
  it('un layout con facecam exige el rectángulo; con él, marca re-render', () => {
    expect(() => applyClipPatch('aaaaaaaa-1', { layout: 'game_top_cam_bottom' }, ctx)).toThrow(/facecam/);
    const c = applyClipPatch('aaaaaaaa-1', { layout: 'game_top_cam_bottom', camRect: { x: 0.7, y: 0.6, w: 0.28, h: 0.36 } }, ctx);
    expect(c).toMatchObject({ layout: 'game_top_cam_bottom', dirty: true });
  });
  it('mover la facecam en un layout sin facecam no obliga a re-renderizar', () => {
    expect(applyClipPatch('aaaaaaaa-1', { camRect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }, ctx).dirty).toBe(false);
  });
  it('clip inexistente', () => {
    expect(() => applyClipPatch('zzzzzzzz-9', { title: 'x' }, ctx)).toThrow(/no existe/);
  });
  it('recuento real «listos»: excluye clips sin archivo o con cambios pendientes', () => {
    expect(readyCount([mk('a', 1, 0), mk('b', 2, 40, { dirty: true }), mk('c', 3, 80, { file: undefined })])).toEqual({ ready: 1, total: 3 });
  });
});

describe('IPC: validación de la edición de clips', () => {
  it('acepta un parche válido y rechaza claves o tipos desconocidos', () => {
    expect(clipPatchSchema.safeParse({ title: 'Hola', layout: 'no_facecam' }).success).toBe(true);
    expect(clipPatchSchema.safeParse({ layout: 'rm -rf' }).success).toBe(false);
    expect(clipPatchSchema.safeParse({ file: '../../x.mp4' }).success).toBe(false);
    expect(clipPatchSchema.safeParse({ start: 'diez' }).success).toBe(false);
    expect(clipPatchSchema.safeParse({ title: '' }).success).toBe(false);
  });
  it('rectángulo de facecam dentro de la imagen', () => {
    expect(normRectSchema.safeParse({ x: 0.7, y: 0.6, w: 0.28, h: 0.36 }).success).toBe(true);
    expect(normRectSchema.safeParse({ x: 0.9, y: 0.6, w: 0.28, h: 0.36 }).success).toBe(false);
    expect(normRectSchema.safeParse({ x: 0.1, y: 0.1, w: 0.2, h: 0.2, extra: 1 }).success).toBe(false);
  });
});
