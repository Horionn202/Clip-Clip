// Selección editorial: brief del vídeo, relevancia al tema, «hasta N», inicio en la frase gancho y edición temporal.
import { describe, it, expect } from 'vitest';
import { analyzeClips, type ChatFn } from '../src/main/analysis';
import { alignToHook, evaluateCandidate, selectRound, type TimedWord } from '../src/shared/selection';
import { editorialScore, fallbackBrief, parseBrief, qualitySummary, topicKeywords } from '../src/shared/editorialBrief';
import { adjustRange, applyClipPatch, snapTime } from '../src/shared/clipEdit';
import type { Clip } from '../src/shared/types';
import { goodClip, syntheticTranscript } from './fixtures';

const TITLE = 'MI PRIMERA CARRERA CON SÚPER COCHES EN GTA 6!!';

/** Transcripción escrita a mano: frases a ~2,5 palabras/s desde un segundo dado. */
function script(lines: [number, string][], end: number): { words: TimedWord[]; segments: TimedWord[] } {
  const words: TimedWord[] = [];
  const segments: TimedWord[] = [];
  const FILLER = ['Hoy hace mucho calor en la ciudad y espero a los demás.', 'Esto del inventario no lo entiendo nada de nada.', 'Me voy a comer algo que tengo hambre ahora mismo.', 'Pues nada, aquí seguimos dando vueltas por el mapa.'];
  const all = [...lines].sort((a, b) => a[0] - b[0]);
  let t = 0;
  let f = 0;
  const say = (text: string) => {
    const seg: TimedWord[] = [];
    for (const w of text.split(' ')) {
      seg.push({ start: Math.round(t * 100) / 100, end: Math.round((t + 0.36) * 100) / 100, text: ` ${w}` });
      t += 0.4;
    }
    words.push(...seg);
    segments.push({ start: seg[0].start, end: seg[seg.length - 1].end, text: seg.map((w) => w.text).join('') });
  };
  for (const [at, text] of all) {
    while (t + 5 <= at) say(FILLER[f++ % FILLER.length]);
    t = Math.max(t, at);
    say(text);
  }
  while (t + 5 <= end) say(FILLER[f++ % FILLER.length]);
  return { words, segments };
}

const RACE = [
  [1465, 'Voy completamente en cocao.'],
  [1505, 'Vale, carrera, gente.'],
  [1509, 'Mi primera carrera ahora sí, gente, mi primera carrera en GTA 6.'],
  [1516, 'Salimos, acelero con el súper coche y adelanto a dos coches en la curva.'],
  [1524, 'Voy primero en la carrera, no me lo creo, gente.'],
  [1532, 'Última curva y gano la carrera con el súper coche, increíble.'],
] as [number, string][];

const brief = fallbackBrief(TITLE);
const topic = { keywords: topicKeywords(brief, TITLE), brief, minScore: 70 };

describe('brief editorial', () => {
  it('valida el JSON del modelo y descarta lo inutilizable', () => {
    const ok = parseBrief(
      JSON.stringify({ tema_principal: 'Primera carrera con súper coches en GTA 6', subtemas: ['coches'], eventos_principales: [{ t: 1509, evento: 'Empieza la primera carrera' }, { t: 99999, evento: 'fuera del vídeo' }], palabras_clave: ['GTA 6', 'carrera'], promesa_titulo: 'Ver su primera carrera', momentos_promesa: [{ t: 1509, evento: 'Primera carrera' }] }),
      3829,
    );
    expect(ok?.mainTopic).toMatch(/carrera/);
    expect(ok?.keyEvents).toHaveLength(1); // el evento fuera del vídeo se descarta
    expect(ok?.keywords).toContain('carrera');
    expect(parseBrief('{"clips":[]}', 100)).toBeNull();
    expect(parseBrief('no es json', 100)).toBeNull();
  });
  it('el brief local usa las palabras con significado del título', () => {
    expect(topic.keywords).toEqual(expect.arrayContaining(['primera', 'carrera', 'coches', 'gta']));
    expect(topic.keywords).not.toContain('con');
  });
});

describe('caso real: «Mi primera carrera» en GTA 6', () => {
  const { words } = script(RACE, 1700);
  // Lo que devolvió el modelo: un tramo que empieza 44 s antes con una frase incidental como título y hook.
  const raw = { start: 1465, end: 1525, title: 'Voy completamente en cocao', hook: 'Voy completamente en cocao', reason: 'Momento de acción en la primera carrera del juego', score: 80, topic_relevance: 85, hook_strength: 70, payoff_strength: 85, self_contained: 75, moment_type: 'accion', why_selected: 'Empieza la carrera' };

  it('el clip empieza cerca de la frase de la carrera, no 44 s antes', () => {
    const ev = evaluateCandidate(raw, { preset: 60, sourceDuration: 1700, words, taken: [], topic });
    expect(ev.ok).toBe(true);
    if (!ev.ok) return;
    expect(ev.candidate.start).toBeGreaterThanOrEqual(1504);
    expect(ev.candidate.start).toBeLessThanOrEqual(1510);
    expect(ev.candidate.editorial?.aligned).toBe(true);
  });

  it('título y hook describen la carrera, no la frase incidental', () => {
    const ev = evaluateCandidate(raw, { preset: 60, sourceDuration: 1700, words, taken: [], topic });
    if (!ev.ok) throw new Error('rechazado');
    expect(ev.candidate.title).not.toMatch(/cocao/i);
    expect(ev.candidate.hook).not.toMatch(/cocao/i);
    expect(`${ev.candidate.title} ${ev.candidate.hook}`).toMatch(/carrera/i);
  });

  it('alignToHook no mueve un clip que ya abre con el tema', () => {
    expect(alignToHook(1509, 1569, words, topic.keywords).moved).toBe(false);
  });

  it('un momento sin relación con el tema no sale destacado aunque el modelo lo puntúe alto; el relleno explícito se descarta', () => {
    const filler = { ...raw, start: 600, end: 660, title: 'Hablando del calor en la ciudad', hook: 'Hoy hace mucho calor en la ciudad', topic_relevance: 80 };
    const ev = evaluateCandidate(filler, { preset: 60, sourceDuration: 1700, words, taken: [], topic });
    expect(ev.ok).toBe(true);
    if (ev.ok) expect(ev.candidate.editorial?.featured).toBe(false);
    const good = evaluateCandidate(raw, { preset: 60, sourceDuration: 1700, words, taken: [], topic });
    if (good.ok) expect(good.candidate.editorial?.featured).toBe(true);
    expect(evaluateCandidate({ ...raw, moment_type: 'relleno' }, { preset: 60, sourceDuration: 1700, words, taken: [], topic })).toEqual({ ok: false, reason: 'relleno' });
  });

  it('pedir 20 genera todos los momentos válidos y marca como destacados sólo los que superan el filtro', async () => {
    const strong = [200, 700, 1200, 1505];
    const SAY = [
      ['Arranca la carrera en el puerto con el súper coche rojo.', 'Salida limpia, adelanto a tres coches antes del puente.'],
      ['Segunda carrera por la autopista, el motor ruge muchísimo.', 'Choco contra un camión y pierdo dos puestos enteros.'],
      ['Carrera nocturna en GTA 6 bajo la lluvia del centro.', 'Derrapo en el túnel y recupero el liderato.'],
      ['Final de la carrera en la playa con todos los coches.', 'Cruzo la meta primero, gano el trofeo dorado.'],
    ];
    const lines: [number, string][] = strong.flatMap((t, i) => [
      [t, SAY[i][0]],
      [t + 8, SAY[i][1]],
    ]) as [number, string][];
    const { words: w, segments } = script(lines, 1700);
    const cand = (start: number, rel: number, i: number) => ({ start, end: start + 60, hook_start: start, title: ['Salida en el puerto', 'Choque en la autopista', 'Derrape nocturno en el túnel', 'Victoria en la playa', 'Paseo tranquilo', 'Menú de opciones'][Math.min(i, 5)] + (i >= 4 ? ` ${i}` : ''), hook: 'Frase de apertura del momento elegido', reason: 'Se ve una parte de la partida con algo de contexto', score: 75, topic_relevance: rel, hook_strength: 75, payoff_strength: 80, self_contained: 75, moment_type: 'accion', why_selected: 'Parte de la partida' });
    const raws = [...strong.map((t, i) => cand(t, 90, i)), ...Array.from({ length: 16 }, (_, k) => cand(80 + k * 75 + (strong.some((s) => Math.abs(s - (80 + k * 75)) < 70) ? 1000 : 0), 80, k + 10)).filter((c) => c.start < 1640)];
    const chat: ChatFn = async (_s, _u, _n, schema) => (schema ? JSON.stringify({ tema_principal: 'Primera carrera con súper coches en GTA 6', subtemas: [], eventos_principales: [], palabras_clave: ['carrera', 'gta 6', 'súper coche'], promesa_titulo: 'Ver la primera carrera', momentos_promesa: [] }) : JSON.stringify({ clips: raws }));
    const r = await analyzeClips({ segments, words: w, duration: 1700, preset: 60, userTarget: 20, chat, title: TITLE, minScore: 70 });
    const featured = r.clips.filter((c) => c.editorial?.featured);
    expect(r.clips.length).toBeGreaterThan(4); // los demás también se generan, sin estrella
    expect(featured.map((c) => Math.round(c.start / 100))).toEqual([2, 7, 12, 15]);
    expect(r.report.featured).toBe(4);
    expect(r.report.brief?.source).toBe('ia');
    expect(qualitySummary(r.clips.length, r.report.effectiveTarget, 4)).toMatch(/4 destacados/);
  });
});

describe('revisión Codex: transcripción sin tiempos por palabra', () => {
  it('no penaliza la relevancia cuando no hay palabras con las que contrastar', () => {
    const raw = { start: 100, end: 160, title: 'Salida de la primera carrera', hook: 'Empieza la primera carrera en GTA 6', reason: 'La carrera empieza y se ve la salida', score: 85, topic_relevance: 85, hook_strength: 85, payoff_strength: 85, self_contained: 85, moment_type: 'accion', why_selected: 'Salida' };
    const ev = evaluateCandidate(raw, { preset: 60, sourceDuration: 600, words: [], taken: [], topic });
    expect(ev.ok).toBe(true);
    if (ev.ok) {
      expect(ev.candidate.editorial?.topicRelevance).toBe(85);
      expect(ev.candidate.editorial?.featured).toBe(true);
    }
  });
});

describe('ranking', () => {
  it('la relevancia al tema es lo que más pesa', () => {
    const onTopic = editorialScore({ topicRelevance: 95, hookStrength: 60, payoffStrength: 60, selfContained: 60, local: 50 });
    const flashy = editorialScore({ topicRelevance: 20, hookStrength: 100, payoffStrength: 100, selfContained: 100, local: 100 });
    expect(onTopic).toBeGreaterThan(flashy);
  });
  it('la diversidad temporal no desplaza un candidato más fuerte que está cerca de otro', () => {
    const { words } = syntheticTranscript(1200);
    const near = { ...goodClip(40, 30, 1), score: 100 };
    const far = { ...goodClip(900, 30, 2), score: 0 };
    const r = selectRound([far, near], 1, { preset: 30, sourceDuration: 1200, words, taken: [{ start: 0, end: 30 }] });
    expect(r.accepted[0].start).toBeLessThan(100);
  });
});

describe('edición temporal del clip', () => {
  const words: TimedWord[] = Array.from({ length: 400 }, (_, i) => ({ start: i * 0.5, end: i * 0.5 + 0.4, text: ' palabra' }));
  const o = { preset: 30 as const, sourceDuration: 200, words, snap: true };
  it('ajusta al límite de palabra más cercano', () => {
    expect(snapTime(10.2, words, 'start')).toBe(10);
    expect(snapTime(10.2, words, 'end')).toBe(10.4);
    expect(snapTime(10.2, [], 'start')).toBe(10.2);
  });
  it('respeta la duración segura del preset y los límites del vídeo', () => {
    expect(adjustRange({ start: 50, end: 80 }, { edge: 'start', to: 70 }, o).start).toBeLessThanOrEqual(80 - 23);
    expect(adjustRange({ start: 50, end: 80 }, { edge: 'end', to: 200 }, o).end).toBeLessThanOrEqual(81);
    expect(adjustRange({ start: 2, end: 30 }, { edge: 'start', to: -15 }, o).start).toBe(0);
    expect(adjustRange({ start: 170, end: 199 }, { edge: 'end', to: 214 }, o).end).toBeLessThanOrEqual(200);
    const r = adjustRange({ start: 50, end: 75 }, { edge: 'start', to: 45.2 }, o);
    expect(r).toEqual({ start: 45, end: 75 }); // −5 s y ajuste a palabra
  });
  it('guardar un tramo nuevo marca el clip como pendiente de re-render', () => {
    const c: Clip = { id: 'a', index: 1, start: 50, end: 80, title: 'Título', hook: 'Hook', reason: 'r', score: 80, file: '01.mp4', rendered: { start: 50, end: 80, layout: 'gameplay_full' } };
    const next = applyClipPatch('a', { start: 45, end: 75 }, { clips: [c], preset: 30, sourceDuration: 200 });
    expect(next.dirty).toBe(true);
    const back = applyClipPatch('a', { start: 50, end: 80 }, { clips: [next], preset: 30, sourceDuration: 200 });
    expect(back.dirty).toBe(false);
  });
});
