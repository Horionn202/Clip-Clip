import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_VERSIONS, applyMeta, applyStatus, copyText, metaWarnings, normalizeHashtags, parseAiMeta, publishSchema, publishSummary, restoreVersion } from '../src/shared/publish';
import { PublishStore } from '../src/main/publishStore';
import { ADAPTERS, listConnections } from '../src/main/publishers';

const NOW = '2026-11-19T10:00:00.000Z';
const meta = (t = 'Título', d = 'Descripción', h = ['#a']) => ({ title: t, description: d, hashtags: h });

describe('hashtags y textos', () => {
  it('normaliza hashtags', () => {
    expect(normalizeHashtags('#Gaming, viral  #fyp #gaming ##Ñandú!')).toEqual(['#gaming', '#viral', '#fyp', '#ñandú']);
    expect(normalizeHashtags(['#a#b', 'c'])).toEqual(['#a', '#b', '#c']);
  });
  it('texto para copiar según plataforma', () => {
    expect(copyText('shorts', meta())).toBe('Descripción\n\n#a');
    expect(copyText('tiktok', meta())).toBe('Título\n\nDescripción\n\n#a');
  });
  it('avisos de límites', () => {
    expect(metaWarnings('shorts', meta('x'.repeat(101)))).toEqual(expect.arrayContaining([expect.stringMatching(/título supera 100/)]));
    expect(metaWarnings('shorts', meta(''))).toContain('Falta el título.');
    expect(metaWarnings('tiktok', meta('', 'd', Array.from({ length: 11 }, (_, i) => `#t${i}`)))[0]).toMatch(/Demasiados hashtags/);
    expect(metaWarnings('reels', meta('', 'ok'))).toEqual([]);
  });
});

describe('respuesta de la IA', () => {
  it('interpreta JSON válido y limpia campos', () => {
    const r = parseAiMeta(JSON.stringify({ tiktok: { title: '', description: ' hola ', hashtags: ['Fyp', '#fyp'] }, shorts: { title: 'T', description: 'D', hashtags: '#x #y' } }));
    expect(r.tiktok).toEqual({ title: '', description: 'hola', hashtags: ['#fyp'] });
    expect(r.shorts?.hashtags).toEqual(['#x', '#y']);
    expect(r.reels).toBeUndefined();
  });
  it('tolera texto alrededor y basura', () => {
    expect(parseAiMeta('Aquí tienes: {"reels":{"title":"","description":"d","hashtags":[]}} ¡listo!').reels?.description).toBe('d');
    expect(parseAiMeta('no es json')).toEqual({});
    expect(parseAiMeta('[1,2]')).toEqual({});
  });
  it('el esquema exige las 3 plataformas', () => {
    expect((publishSchema() as { required: string[] }).required).toEqual(['tiktok', 'shorts', 'reels']);
  });
});

describe('versiones y estados', () => {
  it('cada cambio crea versión; repetir lo mismo no', () => {
    const a = applyMeta(undefined, meta('A'), 'ia', NOW, 'qwen');
    expect(a.status).toBe('borrador');
    expect(a.versions).toHaveLength(1);
    expect(applyMeta(a, meta('A'), 'manual', NOW)).toBe(a);
    const b = applyMeta(a, meta('B'), 'manual', NOW);
    expect(b.versions.map((v) => v.meta.title)).toEqual(['B', 'A']);
    expect(restoreVersion(b, 1, NOW).meta.title).toBe('A');
    expect(() => restoreVersion(b, 9, NOW)).toThrow();
  });
  it('historial acotado', () => {
    let e = applyMeta(undefined, meta('0'), 'ia', NOW);
    for (let i = 1; i < MAX_VERSIONS + 5; i++) e = applyMeta(e, meta(String(i)), 'manual', NOW);
    expect(e.versions).toHaveLength(MAX_VERSIONS);
  });
  it('nunca se marca publicado sin confirmación del usuario', () => {
    const e = applyMeta(undefined, meta(), 'ia', NOW);
    expect(() => applyStatus(e, 'publicado', NOW)).toThrow(/confirmación/);
    const p = applyStatus(e, 'publicado', NOW, { confirmedByUser: true, url: 'https://tiktok.com/@x/video/1' });
    expect(p).toMatchObject({ status: 'publicado', publishedAt: NOW, publishedUrl: 'https://tiktok.com/@x/video/1' });
    expect(() => applyStatus(e, 'publicado', NOW, { confirmedByUser: true, url: 'javascript:alert(1)' })).toThrow();
    const back = applyStatus(p, 'listo', NOW);
    expect(back.publishedAt).toBeUndefined();
    expect(back.publishedUrl).toBeUndefined();
  });
  it('cambiar el texto de algo publicado lo devuelve a borrador', () => {
    const p = applyStatus(applyMeta(undefined, meta(), 'ia', NOW), 'publicado', NOW, { confirmedByUser: true, url: 'https://x.com/1' });
    const e = applyMeta(p, meta('otro'), 'manual', NOW);
    expect(e).toMatchObject({ status: 'borrador', publishedAt: undefined, publishedUrl: undefined });
    expect(applyMeta(p, meta(), 'manual', NOW).status).toBe('publicado');
  });
  it('generar con IA no cambia el estado', () => {
    const p = applyStatus(applyMeta(undefined, meta(), 'ia', NOW), 'listo', NOW);
    expect(applyMeta(p, meta('nuevo'), 'ia', NOW).status).toBe('listo');
  });
  it('resumen por plataforma', () => {
    const e = applyMeta(undefined, meta(), 'ia', NOW);
    expect(publishSummary({ shorts: e })).toEqual([{ platform: 'shorts', status: 'borrador' }]);
    expect(publishSummary(undefined)).toEqual([]);
  });
});

describe('almacén local', () => {
  it('persiste, recarga y borra por trabajo; tolera archivo corrupto', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pub-'));
    try {
      const s = new PublishStore(dir);
      s.put('job-1', 'c1', 'tiktok', applyMeta(undefined, meta(), 'ia', NOW));
      expect(new PublishStore(dir).get('job-1', 'c1', 'tiktok')?.meta.title).toBe('Título');
      s.deleteJob('job-1');
      expect(new PublishStore(dir).forJob('job-1')).toEqual({});
      fs.writeFileSync(path.join(dir, 'publish.json'), '{roto');
      expect(new PublishStore(dir).forJob('x')).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('conexiones', () => {
  it('todo manual y sin subida real', async () => {
    expect(listConnections().every((c) => c.state === 'manual' && !c.supportsDirectUpload)).toBe(true);
    await expect(ADAPTERS.tiktok.publish({ platform: 'tiktok', videoPath: 'x', meta: meta(), confirmedByUser: true })).rejects.toThrow(/no está disponible/);
  });
  it('no hay credenciales en el código de conexiones', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/main/publishers.ts'), 'utf8');
    expect(src).not.toMatch(/(client_secret|api[_-]?key|access_token)\s*[:=]/i);
  });
});
