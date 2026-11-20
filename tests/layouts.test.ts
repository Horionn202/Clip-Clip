import { describe, it, expect } from 'vitest';
import { decideLayout, validRect, AUTO_CONFIDENCE, type VisualResult } from '../src/shared/layouts';
import { classify, frameEdgeAnalyzer, ANALYSIS_W, ANALYSIS_H, type GrayFrame } from '../src/main/visual';
import { CAM_H, GAME_H, OUT_H, blurFor, camChain, coverRect, fitAspect, gameplayCrop, layoutFilter, layoutRenderArgs } from '../src/main/layoutRender';

// Generador determinista (sin Math.random) para fixtures reproducibles.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Fotogramas sintéticos: «gameplay» que cambia en cada fotograma y, opcionalmente, una facecam con marco fijo. */
function frames(opts: { cam?: { x0: number; y0: number; x1: number; y1: number }; n?: number; still?: boolean }): GrayFrame[] {
  const out: GrayFrame[] = [];
  const W = ANALYSIS_W;
  const H = ANALYSIS_H;
  for (let k = 0; k < (opts.n ?? 6); k++) {
    const r = rng(opts.still ? 1 : k + 1);
    const d = new Uint8Array(W * H);
    for (let i = 0; i < d.length; i++) d[i] = 60 + Math.floor(r() * 120);
    const c = opts.cam;
    if (c) {
      for (let y = c.y0; y <= c.y1; y++)
        for (let x = c.x0; x <= c.x1; x++) {
          const border = x === c.x0 || x === c.x1 || y === c.y0 || y === c.y1;
          d[y * W + x] = border ? 255 : 90 + Math.floor(r() * 40); // marco blanco fijo; cara «cambiante»
        }
    }
    out.push({ w: W, h: H, data: d });
  }
  return out;
}

describe('análisis visual (motor sin dependencias)', () => {
  it('detecta una facecam abajo a la derecha con confianza', () => {
    const r = frameEdgeAnalyzer.analyze(frames({ cam: { x0: 110, y0: 55, x1: 154, y1: 86 } }));
    expect(r.cls).toBe('facecam_inferior');
    expect(r.confidence).toBeGreaterThanOrEqual(AUTO_CONFIDENCE);
    expect(r.cam!.x).toBeCloseTo(110 / ANALYSIS_W, 1);
    expect(r.cam!.y).toBeCloseTo(55 / ANALYSIS_H, 1);
  });
  it('detecta una facecam arriba a la izquierda', () => {
    const r = frameEdgeAnalyzer.analyze(frames({ cam: { x0: 4, y0: 3, x1: 50, y1: 32 } }));
    expect(r.cls).toBe('facecam_superior');
  });
  it('sin marco fijo → sin facecam o incierto, nunca un layout con facecam', () => {
    const r = frameEdgeAnalyzer.analyze(frames({}));
    expect(['sin_facecam', 'incierto']).toContain(r.cls);
    expect(decideLayout('auto', r).layout).toBe('gameplay_full');
  });
  it('imagen fija o muy pocos fotogramas → incierto', () => {
    expect(frameEdgeAnalyzer.analyze(frames({ still: true })).cls).toBe('incierto');
    expect(frameEdgeAnalyzer.analyze(frames({ n: 2 })).cls).toBe('incierto');
  });
  it('clasifica posiciones', () => {
    expect(classify({ x: 0.7, y: 0.4, w: 0.25, h: 0.2 })).toBe('facecam_derecha');
    expect(classify({ x: 0.05, y: 0.4, w: 0.25, h: 0.2 })).toBe('facecam_izquierda');
    expect(classify({ x: 0, y: 0, w: 0.9, h: 0.9 })).toBe('pantalla_completa');
  });
});

describe('decisión de layout (fallback seguro)', () => {
  const cam = { x: 0.7, y: 0.6, w: 0.28, h: 0.35 };
  const sure: VisualResult = { cls: 'facecam_inferior', confidence: 0.8, cam, engine: 't' };
  const unsure: VisualResult = { ...sure, confidence: 0.4 };
  it('auto + confianza alta → cámara arriba y gameplay abajo (como un Short), esté donde esté la cámara', () => {
    expect(decideLayout('auto', sure).layout).toBe('cam_top_game_bottom');
    expect(decideLayout('auto', { ...sure, cls: 'facecam_superior' }).layout).toBe('cam_top_game_bottom');
  });
  it('auto + poca confianza → gameplay completo con sugerencia (no decide solo)', () => {
    expect(decideLayout('auto', unsure)).toMatchObject({ layout: 'gameplay_full', suggestion: 'cam_top_game_bottom' });
    expect(decideLayout('auto', undefined).layout).toBe('gameplay_full');
  });
  it('preferencia con facecam sin rectángulo → recorte seguro y sugerencia', () => {
    expect(decideLayout('game_cam_float', undefined)).toMatchObject({ layout: 'gameplay_full', suggestion: 'game_cam_float' });
    expect(decideLayout('no_facecam', undefined).layout).toBe('no_facecam');
  });
  it('valida rectángulos normalizados', () => {
    expect(validRect(cam)).toBe(true);
    expect(validRect({ x: 0.9, y: 0, w: 0.2, h: 0.2 })).toBe(false);
    expect(validRect({ x: -0.1, y: 0, w: 0.2, h: 0.2 })).toBe(false);
    expect(validRect({ x: 0, y: 0, w: 0.01, h: 0.2 })).toBe(false);
    expect(validRect('x')).toBe(false);
  });
});

describe('LayoutStrategy: recortes y filtergraph', () => {
  const W = 1920;
  const H = 1080;
  const cam = { x: 0.72, y: 0.62, w: 0.26, h: 0.34 };
  it('los layouts apilados suman 1920 px y el reparto es fijo', () => {
    expect(GAME_H + CAM_H).toBe(OUT_H);
    const f = layoutFilter({ layout: 'game_top_cam_bottom', srcW: W, srcH: H, offsetX: 0, sourceCam: cam });
    expect(f).toContain(`scale=1080:${GAME_H}`);
    expect(f).toContain(`scale=1080:${CAM_H}`);
    expect(f).toContain('[g][c]vstack=inputs=2[v]');
    expect(layoutFilter({ layout: 'cam_top_game_bottom', srcW: W, srcH: H, offsetX: 0, sourceCam: cam })).toContain('[c][g]vstack');
  });
  it('el recorte de la facecam mantiene la cámara entera, el aspecto y queda dentro del fotograma', () => {
    const r = fitAspect({ x: 0.72 * W, y: 0.62 * H, w: 0.26 * W, h: 0.34 * H }, 1080 / CAM_H, W, H);
    expect(r.x + r.w).toBeLessThanOrEqual(W);
    expect(r.y + r.h).toBeLessThanOrEqual(H);
    expect(r.w % 2 + r.h % 2).toBe(0);
    expect(r.w / r.h).toBeCloseTo(1080 / CAM_H, 1);
  });
  it('el gameplay se aparta de la facecam cuando es posible', () => {
    const camPx = { x: 0.72 * W, y: 0.62 * H, w: 0.26 * W, h: 0.34 * H };
    const g = gameplayCrop(1080 / GAME_H, W, H, 0, camPx);
    expect(g.x + g.w).toBeLessThanOrEqual(camPx.x + 1);
  });
  it('sin facecam: el vídeo entero sobre fondo difuminado (no se oculta contenido)', () => {
    const f = layoutFilter({ layout: 'no_facecam', srcW: W, srcH: H, offsetX: 0 });
    expect(f).toContain('boxblur');
    expect(f).toContain('scale=1080:1920:force_original_aspect_ratio=decrease');
  });
  it('un layout con facecam sin rectángulo falla en vez de inventar una posición', () => {
    expect(() => layoutFilter({ layout: 'game_cam_float', srcW: W, srcH: H, offsetX: 0 })).toThrow();
  });
  it('argumentos: subtítulos por nombre seguro y audio opcional', () => {
    const a = layoutRenderArgs({ source: 's.mp4', start: 1, end: 31, filter: '[0:v]null[v]', assFile: '01.ass', output: 'o.mp4' });
    expect(a).toContain('[0:v]null[v];[v]ass=01.ass[vout]');
    expect(a).toContain('0:a?');
    expect(() => layoutRenderArgs({ source: 's', start: 0, end: 1, filter: '', assFile: "x';.ass", output: 'o' })).toThrow();
  });
});

describe('facecam: cover (por defecto) y contain a partir de sourceFacecamRect', () => {
  it('cover: el recorte tiene exactamente el aspecto del panel (sin deformar) y está dentro de la selección', () => {
    const sel = { x: 1440, y: 700, w: 400, h: 300 };
    for (const [tw, th] of [[1080, CAM_H], [1080, 1080], [400, 600]]) {
      const r = coverRect(sel, tw / th, 1920, 1080);
      expect(Math.abs(r.w / r.h / (tw / th) - 1)).toBeLessThan(0.02);
      expect(r.x).toBeGreaterThanOrEqual(sel.x);
      expect(r.y).toBeGreaterThanOrEqual(sel.y);
      expect(r.x + r.w).toBeLessThanOrEqual(sel.x + sel.w);
      expect(r.y + r.h).toBeLessThanOrEqual(sel.y + sel.h);
      expect(r.w % 2 + r.h % 2 + r.x % 2 + r.y % 2).toBe(0);
    }
  });
  it('cover: nunca pad ni barras; el filtro sólo recorta y escala', () => {
    const chain = camChain({ x: 1440, y: 700, w: 400, h: 300 }, 1080, CAM_H, 1920, 1080);
    expect(chain).toMatch(/^\[csrc\]crop=\d+:\d+:\d+:\d+,scale=1080:768:flags=lanczos,setsar=1\[c\]$/);
    expect(chain).not.toContain('pad=');
  });
  it('cover: zoom y encuadre se aplican dentro de la selección sin salir de ella', () => {
    const sel = { x: 1000, y: 500, w: 800, h: 450 };
    const c0 = coverRect(sel, 1, 1920, 1080);
    const z2 = coverRect(sel, 1, 1920, 1080, { x: 0, y: 0, zoom: 2 });
    expect(z2.w).toBeLessThan(c0.w);
    const left = coverRect(sel, 1, 1920, 1080, { x: -1, y: 0, zoom: 1 });
    const right = coverRect(sel, 1, 1920, 1080, { x: 1, y: 0, zoom: 1 });
    // Encuadre al extremo: pegado al borde de la selección (menos el 1 % de margen de limpieza).
    expect(left.x).toBeLessThanOrEqual(sel.x + sel.w * 0.01 + 2);
    expect(right.x + right.w).toBeGreaterThanOrEqual(sel.x + sel.w * 0.99 - 2);
    expect(left.x).toBeGreaterThanOrEqual(sel.x);
    expect(right.x + right.w).toBeLessThanOrEqual(sel.x + sel.w);
    const down = coverRect(sel, 1, 1920, 1080, { x: 0, y: 1, zoom: 2 });
    expect(down.y + down.h).toBeLessThanOrEqual(sel.y + sel.h);
  });
  it('contain: cámara completa sobre fondo desenfocado de la propia cámara (nunca pad negro)', () => {
    const chain = camChain({ x: 100, y: 500, w: 500, h: 800 }, 1080, CAM_H, 1080, 1920, 'csrc', 'c', 'contain');
    expect(chain).toContain('crop=500:800:100:500');
    expect(chain).toContain('boxblur');
    expect(chain).toContain('force_original_aspect_ratio=decrease');
    expect(chain).not.toContain('color=black');
  });
  it('revisión Codex: el desenfoque de contain nunca supera lo que admite un panel pequeño', () => {
    // Panel mínimo permitido (5 % de 1080 = 54 px): croma de 27 px → radio máximo 13.
    expect(blurFor(54, 40)).toBe('boxblur=luma_radius=18:luma_power=2:chroma_radius=9:chroma_power=2');
    expect(blurFor(1080, 768)).toBe('boxblur=luma_radius=18:luma_power=2:chroma_radius=18:chroma_power=2');
    expect(blurFor(6, 6)).toBe('boxblur=luma_radius=2:luma_power=2:chroma_radius=0:chroma_power=2');
    expect(camChain({ x: 1440, y: 700, w: 400, h: 300 }, 54, 60, 1920, 1080, 'csrc', 'cam', 'contain')).toContain('chroma_radius=12');
  });
  it('una selección que se sale del fotograma se limita a él', () => {
    // Se limita al fotograma (1800+120 = 1920, 1000+80 = 1080) y nunca lo sobrepasa.
    const m = camChain({ x: 1800, y: 1000, w: 400, h: 300 }, 120, 80, 1920, 1080).match(/crop=(\d+):(\d+):(\d+):(\d+)/)!.slice(1).map(Number);
    expect(m[2]).toBeGreaterThanOrEqual(1800);
    expect(m[0] + m[2]).toBeLessThanOrEqual(1920);
    expect(m[1] + m[3]).toBeLessThanOrEqual(1080);
  });
  it('sourceFacecamRect (origen) y outputFacecamRect (salida) son independientes', () => {
    const base = { layout: 'custom' as const, srcW: 1920, srcH: 1080, offsetX: 0, sourceCam: { x: 0.75, y: 0.65, w: 0.2, h: 0.28 } };
    const a = layoutFilter({ ...base, outputCam: { x: 0.05, y: 0.1, w: 0.5, h: 0.3 } });
    const b = layoutFilter({ ...base, outputCam: { x: 0.4, y: 0.5, w: 0.5, h: 0.3 } });
    // Mover la cámara en la salida no cambia qué se recorta del original…
    const srcCrop = (f: string) => f.match(/\[csrc\]crop=[^,]+/)![0];
    expect(srcCrop(a)).toBe(srcCrop(b));
    // …sólo dónde se superpone.
    expect(a.match(/overlay=\d+:\d+/)![0]).not.toBe(b.match(/overlay=\d+:\d+/)![0]);
  });
  it('«Personalizado» por defecto sin facecam detectada cae al recorte seguro', () => {
    expect(decideLayout('custom', undefined).layout).toBe('gameplay_full');
  });
});
