// Verificador de destacados: sin cita real al principio del clip no hay estrella. Sin red.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeClips, type ChatFn } from '../src/main/analysis';
import { freeOtherModels } from '../src/main/ollama';
import { EDITORIAL_MODEL, appModels, verifierModel } from '../src/shared/aiProfiles';
import { fallbackBrief, topicKeywords } from '../src/shared/editorialBrief';
import {
  VERIFIER_SYSTEM_PROMPT,
  asOtherMoment,
  decide,
  editorialAfterEdit,
  evidenceMoments,
  isPreparation,
  isVerifiedHighlight,
  parseVerdict,
  promisedEventStart,
  saysStart,
  verifierUserPrompt,
  verifyHighlights,
  type HighlightContext,
  type Verdict,
} from '../src/shared/highlights';
import { evaluateCandidate, type Candidate, type TimedWord } from '../src/shared/selection';
import { applyClipPatch } from '../src/shared/clipEdit';
import { assertClipInvariants } from '../src/shared/validation';
import type { Clip } from '../src/shared/types';

const TITLE = 'MI PRIMERA VEZ JUGANDO CARRERAS DE MOTOS EN GTA 6';
const D = 900;
const START = 275;

/** Presentación, trayecto, preparativos y conversación → inicio explícito → carrera, choque y resultado. */
const EVENTS: [number, string][] = [
  [5, 'Bienvenidos, hoy vamos a jugar mi primera carrera de motos.'],
  [28, 'Bueno, vamos para el circuito, para jugar mi primera carrera de motos.'],
  [43, 'Estamos a cinco millas del circuito con la moto.'],
  [55, 'Mi primera vez jugando carreras de motos, vamos a ver.'],
  [110, 'Menudo choque con el coche de camino al circuito.'],
  [150, 'Ya llegamos al circuito, qué bonito es todo esto.'],
  [200, 'Voy a explorar carreras y elegir la moto que me llevo.'],
  [START, 'Nada más, empezó la carrera ya, la sensación es increíble.'],
  [340, 'Adelanto a dos motos en la curva y sigo en carrera.'],
  [420, 'Qué choque contra el muro, casi me caigo de la moto.'],
  [700, 'He ganado la carrera de motos, primera posición, chicos.'],
];

function transcript(): { words: TimedWord[]; segments: TimedWord[] } {
  const words: TimedWord[] = [];
  const segments: TimedWord[] = [];
  const say = (at: number, text: string) => {
    const ws = text.split(' ').map((w, i) => ({ start: at + i * 0.32, end: at + i * 0.32 + 0.28, text: ` ${w}` }));
    words.push(...ws);
    segments.push({ start: at, end: ws[ws.length - 1].end, text: ` ${text}` });
  };
  const talk = ['La verdad es que el paisaje se ve muy bonito por aquí.', 'Luego os cuento una cosa que me pasó ayer por la tarde.', 'Qué tranquilo está todo esto, me gusta mucho la luz.'];
  for (let t = 0; t < D - 5; t += 5) {
    const ev = EVENTS.find(([at]) => at === t) ?? EVENTS.find(([at]) => at > t && at < t + 5);
    say(ev ? ev[0] : t, ev ? ev[1] : talk[(t / 5) % talk.length]);
  }
  return { words, segments };
}

const { words, segments } = transcript();
const brief = fallbackBrief(TITLE);
const ctx: HighlightContext = { title: TITLE, brief, keywords: topicKeywords(brief, TITLE), segments, words, duration: D, preset: 60 };

const candidate = (start: number, title = 'Momento del vídeo de motos', hook = ''): Candidate => ({
  start,
  end: start + 60,
  title,
  hook,
  reason: 'Razón propuesta por la selección',
  llmScore: 90,
  localScore: 70,
  score: 90,
  editorial: { score: 90, featured: true, topicRelevance: 100, hookStrength: 80, payoffStrength: 80, selfContained: 80, why: 'Razón propuesta por la selección' },
});
const verdict = (p: Partial<Verdict> = {}): Verdict => ({
  approved: true,
  title: 'Inicio de la carrera de motos',
  hook: 'empezó la carrera ya',
  event: 'inicio_real',
  quote: 'empezó la carrera ya',
  evidenceStart: START,
  confidence: 92,
  reason: 'Se oye que la carrera empieza.',
  ...p,
});
const raw = (v: Verdict) =>
  JSON.stringify({ approved: v.approved, corrected_title: v.title, corrected_hook: v.hook, event_type: v.event, evidence_quote: v.quote, evidence_start: v.evidenceStart, confidence: v.confidence, reason: v.reason });

describe('evidencia real, no palabras sueltas', () => {
  it('reconoce los inicios equivalentes', () => {
    for (const s of ['Empieza la carrera', '¡Vamos a correr!', 'Mi primera carrera ahora sí, gente', 'Salimos', 'Nada más, empezó la carrera ya', 'Ahora sí empieza la carrera']) expect(saysStart(s, ctx.keywords), s).toBe(true);
  });
  it('futuro, trayecto, negación y keywords aisladas no son un inicio', () => {
    for (const s of ['moto carrera GTA', 'Vamos para el circuito para jugar mi primera carrera', 'Cuando empiece la carrera', 'Va a empezar la carrera', 'Salimos de casa', 'Empieza a llover', 'No ha empezado la carrera', 'Hoy vamos a correr']) expect(saysStart(s, ctx.keywords), s).toBe(false);
  });
  it('reconoce los preparativos', () => {
    expect(isPreparation('Bueno, vamos para el circuito como digo')).toBe(true);
    expect(isPreparation('Nada más, empezó la carrera ya')).toBe(false);
  });
  it('localiza cuándo empieza el evento del título', () => {
    expect(promisedEventStart(ctx)).toBe(START);
    expect(evidenceMoments(ctx).map((c) => c.start)).toContain(START);
  });
});

describe('reglas que el modelo no puede saltarse', () => {
  const early = candidate(28, 'Inicio de la carrera');
  const good = candidate(START);

  it('aprueba el inicio real con evidencia en los primeros 15 s', () => {
    const d = decide(verdict(), good, ctx);
    expect(d.kind).toBe('verified');
    if (d.kind === 'verified') {
      expect(d.evidence.text).toMatch(/empezó la carrera ya/i);
      expect(d.evidence.start - good.start).toBeLessThanOrEqual(15);
    }
  });

  it('el trayecto del segundo 28 no pasa aunque el modelo lo apruebe', () => {
    expect(decide(verdict({ quote: 'vamos para el circuito', confidence: 100 }), early, ctx).kind).toBe('rejected');
    expect(decide(verdict({ quote: 'para jugar mi primera carrera de motos', event: 'revelacion', title: 'Mi primera carrera de motos' }), early, ctx).kind).toBe('rejected');
  });

  it('un choque de camino, antes del evento del título, no es destacado', () => {
    expect(decide(verdict({ event: 'choque_accion', title: 'Menudo choque con el coche', quote: 'Menudo choque con el coche' }), candidate(110), ctx).kind).toBe('rejected');
  });

  it.each([
    ['sin cita', { quote: '' }],
    ['cita inventada', { quote: 'arranca la gran final mundial' }],
    ['confianza menor de 80', { confidence: 79 }],
    ['no aprobado', { approved: false }],
    ['sin motivo', { reason: '' }],
    ['introducción', { event: 'introduccion' }],
    ['preparación', { event: 'preparacion' }],
    ['desplazamiento', { event: 'desplazamiento' }],
    ['llegada', { event: 'llegada' }],
    ['contexto', { event: 'contexto' }],
    ['cita de una sola keyword', { quote: 'carrera' }],
  ] as [string, Partial<Verdict>][])('degrada: %s', (_name, p) => {
    expect(decide(verdict(p), good, ctx).kind).toBe('rejected');
  });

  it('una cita de fuera del clip no sirve', () => {
    expect(decide(verdict(), candidate(START + 65), ctx).kind).toBe('rejected');
  });

  it('la evidencia 40 s después mueve el inicio', () => {
    expect(decide(verdict(), candidate(START - 40), ctx)).toEqual({ kind: 'move', to: START });
  });

  it('caso real con llama: un título que habla del propio clip se sustituye por la frase real', () => {
    const d = decide(verdict({ title: 'El candidato empieza la carrera' }), good, ctx);
    if (d.kind !== 'verified') throw new Error(d.kind);
    expect(d.title).not.toMatch(/candidato/i);
    expect(d.title).toMatch(/empezó la carrera/i);
  });

  it('revisión Codex: una cita recortada no borra el «no» de su frase', () => {
    const neg: TimedWord[] = [];
    const say = (at: number, text: string) => text.split(' ').forEach((w, i) => neg.push({ start: at + i * 0.3, end: at + i * 0.3 + 0.25, text: ` ${w}` }));
    say(500, 'No he ganado la carrera de motos esta vez.');
    say(510, 'Ya me lo esperaba porque iba muy lento.');
    const segs = [
      { start: 500, end: 502.4, text: ' No he ganado la carrera de motos esta vez.' },
      { start: 510, end: 512.4, text: ' Ya me lo esperaba porque iba muy lento.' },
    ];
    const c2 = { ...ctx, words: [...words.filter((w) => w.start < 500 || w.start > 560), ...neg], segments: [...segments.filter((s) => s.start < 500 || s.start > 560), ...segs].sort((x, y) => x.start - y.start) };
    const v = verdict({ event: 'resultado', title: 'He ganado la carrera de motos', quote: 'he ganado la carrera de motos', evidenceStart: 500.3 });
    expect(decide(v, candidate(500), c2).kind).toBe('rejected');
  });

  it('revisión Codex: lo que se dice después del final del clip no cuenta como evidencia', () => {
    // Un solo segmento de Whisper de 0 a 25 s; el clip acaba en el 15 y la victoria se dice en el 20.
    const parts: [number, string][] = [[0, 'Seguimos en la carrera de motos'], [20, 'He ganado la carrera de motos']];
    const ws = parts.flatMap(([at, text]) => text.split(' ').map((w, i) => ({ start: at + i * 0.4, end: at + i * 0.4 + 0.3, text: ` ${w}` })));
    const c4 = { ...ctx, preset: 15 as const, duration: 60, words: ws, segments: [{ start: 0, end: 22.5, text: ' Seguimos en la carrera de motos y al final He ganado la carrera de motos' }] };
    const short = { ...candidate(0), end: 15 };
    const v = verdict({ event: 'accion_activa', title: 'Victoria en la carrera de motos', quote: 'Seguimos en la carrera de motos', evidenceStart: 0 });
    expect(decide(v, short, c4).kind).toBe('rejected');
    const prompt = verifierUserPrompt(short, c4);
    expect(prompt.split('DESPUÉS')[0].split('DURANTE')[1]).not.toMatch(/He ganado/);
    expect(prompt.split('DESPUÉS')[1]).toMatch(/He ganado/);
  });

  it('revisión Codex: un título de victoria no se verifica con una derrota (ni al revés)', () => {
    const loss: TimedWord[] = [];
    'He perdido la carrera de motos y he quedado último.'.split(' ').forEach((w, i) => loss.push({ start: 500 + i * 0.3, end: 500 + i * 0.3 + 0.25, text: ` ${w}` }));
    const seg = { start: 500, end: loss[loss.length - 1].end, text: ' He perdido la carrera de motos y he quedado último.' };
    const c2 = { ...ctx, words: [...words.filter((w) => w.start < 500 || w.start > 560), ...loss], segments: [...segments.filter((s) => s.start < 500 || s.start > 560), seg].sort((x, y) => x.start - y.start) };
    const quote = 'He perdido la carrera de motos y he quedado último';
    expect(decide(verdict({ event: 'resultado', title: 'Victoria en la carrera de motos', quote, evidenceStart: 500 }), candidate(500), c2).kind).toBe('rejected');
    expect(decide(verdict({ event: 'resultado', title: 'Pierdo la carrera de motos', quote, evidenceStart: 500 }), candidate(500), c2).kind).toBe('verified');
    expect(decide(verdict({ event: 'resultado', title: 'Pierdo la carrera de motos', quote: 'He ganado la carrera de motos', evidenceStart: 700 }), candidate(700), ctx).kind).toBe('rejected');
  });

  it('revisión Codex: dos destacados que se pisan unos milisegundos no pasan juntos el control del render', async () => {
    const twoWins = [...segments.filter((s) => s.start < 600 || s.start > 700)];
    const ws = [...words.filter((w) => w.start < 600 || w.start > 700)];
    const add = (at: number, text: string) => {
      const parts = text.split(' ').map((w, i) => ({ start: at + i * 0.3, end: at + i * 0.3 + 0.25, text: ` ${w}` }));
      ws.push(...parts);
      twoWins.push({ start: at, end: parts[parts.length - 1].end, text: ` ${text}` });
    };
    add(600, 'He ganado la carrera de motos en la playa.');
    add(659.98, 'He ganado la carrera de motos en el puerto.');
    const c3 = { ...ctx, words: ws.sort((x, y) => x.start - y.start), segments: twoWins.sort((x, y) => x.start - y.start) };
    const win = (start: number) => ({ ...candidate(start), end: start + 60 });
    const r = await verifyHighlights({
      selected: [win(600), win(659.98)],
      moments: [],
      context: c3,
      max: 5,
      model: EDITORIAL_MODEL,
      ask: async (_s, user) => {
        const at = Number(user.match(/CANDIDATO: de ([\d.]+)/)![1]);
        return raw(verdict({ event: 'resultado', title: 'He ganado la carrera de motos', quote: 'He ganado la carrera de motos', evidenceStart: at }));
      },
    });
    expect(r.verified).toHaveLength(1);
    expect(() => assertClipInvariants(r.verified, { preset: 60, maxClips: 5, sourceDuration: D })).not.toThrow();
  });

  it('un título que anuncia un resultado que no ocurre en el clip no pasa', () => {
    const c = candidate(340);
    expect(decide(verdict({ event: 'accion_activa', title: 'Victoria en la carrera de motos', quote: 'Adelanto a dos motos en la curva' }), c, ctx).kind).toBe('rejected');
  });

  it('acepta carrera activa, choque y resultado con su cita', () => {
    const ok = (start: number, p: Partial<Verdict>) => expect(decide(verdict(p), candidate(start), ctx).kind).toBe('verified');
    ok(340, { event: 'accion_activa', title: 'Adelanto a dos motos en la curva', quote: 'Adelanto a dos motos en la curva' });
    ok(420, { event: 'choque_accion', title: 'Choque contra el muro en moto', quote: 'Qué choque contra el muro' });
    ok(700, { event: 'resultado', title: 'He ganado la carrera de motos', quote: 'He ganado la carrera de motos' });
  });

  it('un JSON incompleto o fuera de rango no vale', () => {
    expect(parseVerdict(raw(verdict()))?.confidence).toBe(92);
    expect(parseVerdict('{"approved":true}')).toBeNull();
    expect(parseVerdict('no es json')).toBeNull();
    expect(parseVerdict(raw(verdict({ confidence: 140 })))).toBeNull();
    expect(parseVerdict(raw(verdict()).replace('true', '"true"'))).toBeNull();
  });

  it('el prompt lleva título, promesa, tramo, propuesta y 20 s antes y después', () => {
    const p = verifierUserPrompt(candidate(START, 'Título propuesto', 'Hook propuesto'), ctx);
    for (const s of [TITLE, 'PROMESA', '275.00 s a 335.00 s', 'Título propuesto', 'Hook propuesto', 'Razón propuesta', '[255.0]', '[275.0]', '[350.0]']) expect(p).toContain(s);
    expect(p).not.toContain('[250.0]');
    expect(p).not.toContain('[355.0]');
  });
});

describe('títulos de «Otros momentos»', () => {
  it('un tramo previo no puede titularse «Inicio de la carrera»', () => {
    const c = asOtherMoment(candidate(28, 'Inicio de la carrera'), ctx);
    expect(c.title).not.toMatch(/inicio/i);
    expect(c.editorial?.featured).toBe(false);
    expect(c.editorial?.topicRelevance).toBeLessThanOrEqual(60);
  });
  it('una etiqueta inventada del brief nunca se convierte en título', () => {
    const invented = { ...brief, keyEvents: [{ t: 28, label: 'Inicio de la carrera' }], promiseMoments: [{ t: 28, label: 'Inicio de la carrera' }] };
    const ev = evaluateCandidate(
      { start: 28, end: 88, title: 'Camino al sitio', hook: 'Bueno, vamos para allá', reason: 'Se dirige hacia el lugar del evento', score: 90 },
      { preset: 60, sourceDuration: D, words, taken: [], topic: { keywords: ctx.keywords, brief: invented, minScore: 70 } },
    );
    if (!ev.ok) throw new Error(ev.reason);
    expect(ev.candidate.title).not.toBe('Inicio de la carrera');
  });
});

describe('análisis completo: fase A + fase B', () => {
  const item = { start: 28, end: 88, title: 'Inicio de la carrera', hook: 'Vamos para el circuito', reason: 'Es el evento principal de la carrera', score: 95, topic_relevance: 100, hook_strength: 95, payoff_strength: 95, self_contained: 95, moment_type: 'revelacion', why_selected: 'Es el evento principal de la carrera' };
  const select = (clips: unknown[]): ChatFn => async (_s, _u, _n, schema) => JSON.stringify(schema ? {} : { clips });
  const run = (ask: (user: string) => string, o: { target?: number; clips?: unknown[]; words?: TimedWord[] } = {}) =>
    analyzeClips({
      segments,
      words: o.words ?? words,
      duration: D,
      preset: 60,
      userTarget: o.target ?? 12,
      title: TITLE,
      chat: select(o.clips ?? [item]),
      verifier: async () => ({
        model: EDITORIAL_MODEL,
        ask: async (system, user) => {
          expect(system).toBe(VERIFIER_SYSTEM_PROMPT);
          return ask(user);
        },
      }),
    });
  /** El peor modelo: lo aprueba todo con confianza 100 y cita la primera frase del candidato. */
  const yesMan = (user: string) => {
    const [, t, quote] = user.split('DURANTE')[1].match(/\[([\d.]+)\] (.*)/)!;
    return raw(verdict({ title: 'Inicio de la carrera', quote, hook: quote, evidenceStart: Number(t), confidence: 100 }));
  };

  it('caso real: el 28 no es destacado y el inicio real sí, con evidencia en sus primeros 15 s', async () => {
    const r = await run(yesMan);
    const stars = r.clips.filter((c) => c.editorial?.featured);
    expect(stars.map((c) => c.start)).toEqual([START]);
    expect(stars[0].editorial!.verification!.evidenceStart - stars[0].start).toBeLessThanOrEqual(15);
    for (const c of r.clips.filter((x) => x.start < START)) {
      expect(c.editorial?.featured).toBe(false);
      expect(c.title).not.toMatch(/inicio de la carrera/i);
    }
  });

  it('los destacados nunca llevan why_selected, cita o confianza vacíos', async () => {
    const stars = (await run(yesMan)).clips.filter((c) => c.editorial?.featured);
    expect(stars.length).toBeGreaterThan(0);
    for (const c of stars) {
      expect(c.editorial!.why).not.toBe('');
      expect(c.editorial!.verification!.quote).not.toBe('');
      expect(c.editorial!.verification!.confidence).toBeGreaterThanOrEqual(80);
      expect(isVerifiedHighlight(c.editorial)).toBe(true);
    }
  });

  it.each([
    ['sin evidencia', () => raw(verdict({ quote: '' }))],
    ['respuesta rota', () => 'no es json'],
    ['el verificador falla', () => { throw new Error('sin memoria'); }],
  ] as [string, () => string][])('%s: se degrada y los 12 clips siguen disponibles para render', async (_name, ask) => {
    const r = await run(ask);
    expect(r.clips).toHaveLength(12);
    expect(r.report.featured).toBe(0);
    expect(() => assertClipInvariants(r.clips, { preset: 60, maxClips: 12, sourceDuration: D })).not.toThrow();
  });

  it('con un destacado verificado se mantiene el máximo, sin solapes', async () => {
    const r = await run(yesMan);
    expect(r.clips).toHaveLength(12);
    expect(() => assertClipInvariants(r.clips, { preset: 60, maxClips: 12, sourceDuration: D })).not.toThrow();
  });

  it('con máximo 1 gana el verificado', async () => {
    const r = await run(yesMan, { target: 1 });
    expect(r.clips.map((c) => c.start)).toEqual([START]);
  });

  it('un aspirante 40 s antes se mueve y se vuelve a verificar con el tramo exacto', async () => {
    const asked: string[] = [];
    const r = await run(
      (user) => {
        asked.push(user);
        return raw(verdict());
      },
      { clips: [{ ...item, start: START - 40, end: START + 20, title: 'Paisaje bonito de camino', hook_start: START - 40 }] },
    );
    expect(asked.some((u) => u.includes('CANDIDATO: de 275.00 s'))).toBe(true);
    expect(r.clips.find((c) => c.editorial?.featured)?.start).toBe(START);
  });

  it('sin tiempos por palabra también comprueba la cita', async () => {
    const r = await run(yesMan, { words: [] });
    expect(r.clips.filter((c) => c.editorial?.featured).map((c) => c.start)).toEqual([START]);
  });

  it('si el modelo verificador no carga, no hay estrellas pero sí clips', async () => {
    const r = await analyzeClips({ segments, words, duration: D, preset: 60, userTarget: 12, title: TITLE, chat: select([item]), verifier: () => Promise.reject(new Error('no está descargado')) });
    expect(r.clips).toHaveLength(12);
    expect(r.report.featured).toBe(0);
  });

  it('cancelar durante la verificación cancela el análisis', async () => {
    const cancel = () => {
      throw Object.assign(new Error('cancelado'), { name: 'CancelledError' });
    };
    await expect(run(cancel)).rejects.toThrow('cancelado');
  });
});

describe('después de verificar', () => {
  const editorial = {
    ...candidate(START).editorial!,
    verification: { model: EDITORIAL_MODEL, confidence: 92, eventType: 'inicio_real' as const, quote: 'empezó la carrera ya', evidenceStart: 276, evidenceEnd: 278 },
  };
  const clip: Clip = { id: 'a', index: 1, start: START, end: START + 60, title: 'Inicio de la carrera', hook: 'h', reason: 'r', score: 90, editorial };
  const edit = { clips: [clip], preset: 60 as const, sourceDuration: D };

  it('mover el tramo fuera de la evidencia quita la estrella', () => {
    expect(isVerifiedHighlight(applyClipPatch('a', { start: 240, end: 300 }, edit).editorial)).toBe(false);
    expect(isVerifiedHighlight(applyClipPatch('a', { start: 270, end: 330 }, edit).editorial)).toBe(true);
  });
  it('un título editado que afirma otro evento quita la estrella', () => {
    expect(isVerifiedHighlight(editorialAfterEdit(editorial, clip, { ...clip, title: 'Victoria en la carrera' }))).toBe(false);
  });
  it('revisión Codex: cambiar el tema del título o quitar el evento también la quita; mayúsculas y signos no', () => {
    expect(isVerifiedHighlight(editorialAfterEdit(editorial, clip, { ...clip, title: 'Inicio de la carrera de coches' }))).toBe(false);
    expect(isVerifiedHighlight(editorialAfterEdit(editorial, clip, { ...clip, title: 'Un paseo por el puerto' }))).toBe(false);
    expect(isVerifiedHighlight(editorialAfterEdit(editorial, clip, { ...clip, title: '¡INICIO DE LA CARRERA!' }))).toBe(true);
  });
  it('un «destacado» de una versión anterior no cuenta como verificado', () => {
    expect(isVerifiedHighlight(candidate(28).editorial)).toBe(false);
  });
});

describe('modelo editorial', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('usa Qwen 2.5 7B sólo si está descargado', () => {
    expect(verifierModel(['llama3.2:3b', EDITORIAL_MODEL], 'llama3.2:3b')).toBe(EDITORIAL_MODEL);
    expect(verifierModel(['llama3.2:3b'], 'llama3.2:3b')).toBe('llama3.2:3b');
  });

  it('libera el modelo anterior de Clip Clip sin tocar los de otras apps', async () => {
    let loaded = ['llama3.2:3b', 'otra-app:latest'];
    vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
      if (url.endsWith('/api/ps')) return new Response(JSON.stringify({ models: loaded.map((name) => ({ name })) }));
      const { model } = JSON.parse(init!.body!) as { model: string };
      loaded = loaded.filter((m) => m !== model);
      return new Response('{}');
    });
    expect(await freeOtherModels('http://127.0.0.1:11434', appModels('llama3.2:3b'), EDITORIAL_MODEL)).toEqual(['llama3.2:3b']);
    expect(loaded).toEqual(['otra-app:latest']);
  });
});
