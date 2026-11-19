import { describe, it, expect } from 'vitest';
import {
  buildEditorialContext,
  editorialUserPrompt,
  generateEditorial,
  hashtagIssues,
  hasEnoughContext,
  parseEditorial,
  salvage,
  stripTechnical,
  textIssues,
  validateEditorial,
  type EditorialContext,
} from '../src/shared/editorial';
import { copyText } from '../src/shared/publish';

// Fixture: clip real de gameplay con facecam (transcripción de ejemplo, sin datos técnicos).
const TRANSCRIPT =
  'Vale, entro en el taller con el Porsche y me dicen que el motor está roto. El mecánico me cobra cinco mil dólares por la reparación. ' +
  'Le digo que es demasiado, que en otro taller me lo dejan por la mitad. Al final el Porsche sale del taller sin frenos y me estrello contra la valla. ' +
  'No me lo puedo creer, cinco mil dólares para esto. El Porsche está peor que antes.';
const CLIP = {
  title: 'El mecánico arregla el Porsche y sale sin frenos',
  hook: 'Pagó cinco mil dólares y el coche salió sin frenos',
  reason: 'Situación absurda con remate claro: tras pagar la reparación el coche choca al salir del taller',
  visual: { cls: 'facecam_inferior', confidence: 0.8 },
  layout: 'game_top_cam_bottom',
};
const ctx = (): EditorialContext => buildEditorialContext(CLIP, TRANSCRIPT, { tone: 'divertido', niche: 'gaming' });

// Respuesta «basura» como la observada (antes del cambio).
const BAD = JSON.stringify({
  titles: [
    { title: '¡La abuela de la imagen!', reason: '' },
    { title: 'Capítulo 1 GTA 6', reason: '' },
    { title: 'Momento emotivo', reason: '' },
  ],
  tiktok: { description: '«La abuela de la imagen»', hashtags: ['#Capitulo1', '#GT6', '#URLDeLaImagen', '#MomentoEmotivo'], cta: '' },
  shorts: { description: 'Mira la URL de la imagen: https://x.com/a.png', hashtags: ['#fyp', '#viral'], cta: '' },
  reels: { description: 'source.mp4 clip_01', hashtags: ['#trending'], cta: '' },
});
// Respuesta buena (después).
const GOOD = JSON.stringify({
  titles: [
    { title: 'Pago 5.000 $ al mecánico y el Porsche sale sin frenos', reason: 'Resume el giro del clip: la reparación cara que acaba en choque.' },
    { title: 'El peor taller del juego', reason: 'Refleja la queja del jugador sobre el taller.' },
    { title: 'Reparación de lujo, choque inmediato', reason: 'Describe el remate: sale del taller y se estrella.' },
  ],
  tiktok: { description: 'Cinco mil dólares de reparación y el Porsche sale del taller directo a la valla.', hashtags: ['#porsche', '#taller', '#mecanico', '#gaming'], cta: '' },
  shorts: { description: 'El mecánico cobra una fortuna por arreglar el motor… y el coche sale sin frenos.', hashtags: ['#porsche', '#taller', '#reparacion'], cta: '' },
  reels: { description: 'Cuando pagas el doble por la reparación y el coche sale peor que antes.', hashtags: ['#porsche', '#mecanico', '#taller', '#frenos'], cta: '¿Te ha pasado algo así?' },
});

describe('contexto editorial limpio', () => {
  it('el prompt no recibe URL, rutas, IDs, nombres de archivo ni timestamps', () => {
    const dirty = {
      title: 'clip_01 source.mp4',
      hook: 'Mira https://cdn.example.com/frame_003.png',
      reason: 'C:\\Users\\x\\AppData\\Roaming\\Clip Clip\\jobs\\abc\\frames\\frame_0001.jpg',
    };
    const c = buildEditorialContext(dirty, `${TRANSCRIPT} www.example.com /jobs/123/clips/clip_02.mp4 00:01:23.500 9f8e7d6c-1234-4abc-9def-001122334455`);
    const prompt = editorialUserPrompt(c);
    for (const bad of ['http', 'www.', '.com', 'C:\\', '/jobs/', '.mp4', '.png', '.jpg', 'clip_0', 'frame_', 'source', '00:01:23', '9f8e7d6c']) expect(prompt).not.toContain(bad);
    expect(c.topic).toBe('');
    expect(c.hook).toBe('Mira');
    expect(prompt).toContain('Porsche');
  });
  it('etiquetas visuales semánticas y entidades de la transcripción', () => {
    const c = ctx();
    expect(c.visualTags).toEqual(expect.arrayContaining(['facecam', 'gameplay']));
    expect(c.entities).toContain('Porsche');
    expect(c.language).toBe('es');
    expect(buildEditorialContext({ ...CLIP, visual: { cls: 'facecam_inferior', confidence: 0.2 }, layout: undefined }, TRANSCRIPT).visualTags).toEqual([]);
  });
  it('stripTechnical quita lo técnico y conserva el texto', () => {
    expect(stripTechnical('Hola https://a.com/x y C:\\a\\b.mp4 en 01:02 con clip_3')).toBe('Hola y en con');
  });
  it('sin contexto suficiente no se llama a la IA', async () => {
    let called = false;
    const out = await generateEditorial(buildEditorialContext({ title: '', hook: '', reason: '' }, 'eh vale'), async () => ((called = true), GOOD));
    expect(out).toMatchObject({ ok: false, reason: 'contexto' });
    expect(called).toBe(false);
    expect(hasEnoughContext(ctx())).toBe(true);
  });
});

describe('filtros de rechazo', () => {
  it('URL, ruta y nombre de archivo', () => {
    for (const s of ['Mira https://a.b', 'en www.algo.es', 'web.com', 'C:\\Users\\x', 'ver /jobs/12', 'vídeo.mp4', 'foto.png', 'cap.jpg']) expect(textIssues('title', s).map((i) => i.code)).toContain('url');
  });
  it('palabras técnicas', () => {
    for (const s of ['¡La abuela de la imagen!', 'URL del vídeo', 'Un frame épico', 'El archivo final', 'source del clip']) expect(textIssues('description', s).map((i) => i.code)).toContain('tecnico');
  });
  it('placeholders y genericidad', () => {
    for (const s of ['Momento emotivo', '¿Por qué funciona?', 'Sin título', 'capítulo 1 GTA 6', 'Título del clip', '[TÍTULO]']) expect(textIssues('title', s).map((i) => i.code)).toContain('generico');
  });
  it('comillas alrededor de todo el texto', () => {
    expect(textIssues('description', '«La abuela»').map((i) => i.code)).toContain('comillas');
    expect(textIssues('title', 'Pago 5.000 $ y sale sin frenos')).toEqual([]);
  });
  it('hashtags: válidos, relevantes, sin repetir ni genéricos', () => {
    expect(hashtagIssues(['#porsche', '#taller', '#mecanico'], ctx())).toEqual([]);
    const codes = (t: string[]) => hashtagIssues(t, ctx()).map((i) => i.code);
    expect(codes(['#porsche', '#porsche', '#taller'])).toContain('hashtag-invalido');
    expect(codes(['#porsche', '#taller', '#fyp'])).toContain('hashtag-generico');
    expect(codes(['#porsche', '#taller', '#urldelaimagen'])).toContain('hashtag-invalido');
    expect(codes(['#porsche', '#taller', '#capitulo1'])).toContain('hashtag-invalido');
    expect(codes(['#porsche', '#taller', '#recetas'])).toContain('hashtag-irrelevante');
    expect(codes(['#porsche'])).toContain('hashtags-cantidad');
    expect(codes(['#porsche', '#taller', '#gaming', '#tiktok'])).toContain('hashtag-irrelevante');
  });
});

describe('generación con validación', () => {
  it('ANTES: la respuesta basura se rechaza entera', () => {
    const codes = new Set(validateEditorial(parseEditorial(BAD), ctx()).map((i) => i.code));
    for (const c of ['tecnico', 'generico', 'url', 'hashtag-generico', 'hashtag-invalido']) expect(codes).toContain(c);
  });
  it('DESPUÉS: la respuesta buena pasa', () => {
    const r = parseEditorial(GOOD);
    expect(validateEditorial(r, ctx())).toEqual([]);
    expect(r.variants).toHaveLength(3);
    expect(r.variants[0].reason).toMatch(/reparación/);
    expect(copyText('reels', { title: '', ...r.platforms.reels! })).toBe('Cuando pagas el doble por la reparación y el coche sale peor que antes. ¿Te ha pasado algo así?\n\n#porsche #mecanico #taller #frenos');
  });
  it('regenera con feedback concreto tras un resultado inválido', async () => {
    const prompts: string[] = [];
    const out = await generateEditorial(ctx(), async (_s, u) => (prompts.push(u), prompts.length === 1 ? BAD : GOOD));
    expect(out).toMatchObject({ ok: true, attempts: 2, repaired: false });
    expect(prompts[0]).not.toMatch(/rechazó/);
    expect(prompts[1]).toMatch(/rechazó/);
    expect(prompts[1]).toMatch(/texto técnico|genérico/);
  });
  it('si vuelve a fallar, no guarda nada (edición manual)', async () => {
    const out = await generateEditorial(ctx(), async () => BAD);
    expect(out).toMatchObject({ ok: false, reason: 'invalido', attempts: 2 });
    if (!out.ok) expect(out.issues.length).toBeGreaterThan(0);
  });
  it('JSON roto dos veces → fallo controlado', async () => {
    expect((await generateEditorial(ctx(), async () => 'no es json')).ok).toBe(false);
  });
  it('salvage quita hashtags malos sin tocar el texto bueno', () => {
    const r = parseEditorial(GOOD);
    r.platforms.tiktok!.hashtags.push('#fyp', '#urldelaimagen');
    expect(salvage(r, ctx()).platforms.tiktok!.hashtags).toEqual(['#porsche', '#taller', '#mecanico', '#gaming']);
  });
  it('rechaza descripciones que copian la transcripción o son demasiado largas', () => {
    const r = parseEditorial(GOOD);
    r.platforms.tiktok!.description = TRANSCRIPT.slice(0, 200);
    const codes = validateEditorial(r, ctx()).filter((i) => i.platform === 'tiktok').map((i) => i.code);
    expect(codes).toContain('copia');
    r.platforms.tiktok!.description = 'Reparación carísima del Porsche. '.repeat(10);
    expect(validateEditorial(r, ctx()).map((i) => i.code)).toContain('longitud');
  });
  it('quita las comillas que envuelven todo', () => {
    expect(parseEditorial(JSON.stringify({ titles: [{ title: '"Hola"', reason: '' }] })).variants[0].title).toBe('Hola');
  });
});
