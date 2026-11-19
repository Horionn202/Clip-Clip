import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deletePublishedExports, exportBlocker, findPublishedExports, markExportDeleted, publishedPlatforms, recoverableBytes } from '../src/main/publishedExports';
import { legacyPaths, readState, runLegacyMigration, scanLegacy, trashPlan, verifyMigration } from '../src/main/legacy';
import { JobStore, SettingsStore, defaultSettings } from '../src/main/store';
import { PublishStore } from '../src/main/publishStore';
import { applyMeta, applyStatus, type ClipPublish } from '../src/shared/publish';
// @ts-expect-error módulo .mjs sin tipos
import { assertReleaseDir, planReleaseCleanup } from '../scripts/clean-release.mjs';
import type { Clip, Job } from '../src/shared/types';

let root: string;
const w = (p: string, content = 'x') => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-legacy-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const NOW = '2026-11-19T10:00:00.000Z';
const entry = (status: 'borrador' | 'listo' | 'publicado') => {
  const e = applyMeta(undefined, { title: 'T', description: 'D', hashtags: ['#a'] }, 'manual', NOW);
  return status === 'publicado' ? applyStatus(e, 'publicado', NOW, { confirmedByUser: true }) : applyStatus(e, status, NOW);
};
const clip = (id: string, exportedPath?: string): Clip => ({ id, index: 1, start: 0, end: 30, title: `Clip ${id}`, hook: '', reason: '', score: 80, file: '01.mp4', exportedPath });
const job = (clips: Clip[], status: Job['status'] = 'completed'): Job =>
  ({ id: 'job-00000001', url: 'u', preset: 30, maxClips: 3, status, progress: 1, message: '', clips, createdAt: NOW, updatedAt: NOW }) as Job;

describe('exports publicados', () => {
  it('sólo cuenta como publicado si ninguna plataforma está pendiente', () => {
    expect(publishedPlatforms({ tiktok: entry('publicado') })).toEqual(['tiktok']);
    expect(publishedPlatforms({ tiktok: entry('publicado'), shorts: entry('listo') })).toEqual([]);
    expect(publishedPlatforms({ tiktok: entry('publicado'), reels: entry('borrador') })).toEqual([]);
    expect(publishedPlatforms({ tiktok: entry('borrador') })).toEqual([]);
    expect(publishedPlatforms({ tiktok: entry('publicado'), reels: entry('publicado') }, ['reels'])).toEqual(['reels']);
    expect(publishedPlatforms(undefined)).toEqual([]);
  });
  it('lista los publicados con tamaño recuperable y nunca los pendientes', () => {
    const exp = path.join(root, 'Videos', 'Clip Clip');
    const jobs = path.join(root, 'jobs');
    w(path.join(exp, 'a.mp4'), '12345');
    w(path.join(exp, 'b.mp4'), '123');
    w(path.join(exp, 'c.mp4'), '1');
    const j = job([clip('c-00000001', path.join(exp, 'a.mp4')), clip('c-00000002', path.join(exp, 'b.mp4')), clip('c-00000003', path.join(exp, 'c.mp4'))]);
    const pub: Record<string, ClipPublish> = { 'c-00000001': { tiktok: entry('publicado') }, 'c-00000002': { tiktok: entry('borrador') }, 'c-00000003': { shorts: entry('listo') } };
    const list = findPublishedExports([j], () => pub, exp, jobs);
    expect(list.map((x) => x.clipId)).toEqual(['c-00000001']);
    expect(recoverableBytes(list)).toBe(5);
    // Trabajo en curso: nada.
    expect(findPublishedExports([{ ...j, status: 'rendering' }], () => pub, exp, jobs)).toEqual([]);
  });
  it('sólo rutas permitidas: MP4 dentro de la carpeta de exportación', () => {
    const exp = path.join(root, 'exp');
    const jobsDir = path.join(root, 'jobs');
    const j = job([]);
    expect(exportBlocker(j, clip('a', path.join(root, 'otra', 'x.mp4')), exp, jobsDir)).toMatch(/fuera/);
    expect(exportBlocker(j, clip('a', path.join(exp, 'x.txt')), exp, jobsDir)).toMatch(/MP4/);
    expect(exportBlocker(j, clip('a', path.join(exp, '..', 'x.mp4')), exp, jobsDir)).toMatch(/fuera/);
    expect(exportBlocker(j, clip('a', path.join(jobsDir, 'x.mp4')), jobsDir, jobsDir)).toMatch(/trabajos/);
    expect(exportBlocker(j, clip('a', path.join(exp, 'x.mp4')), exp, jobsDir)).toBeNull();
  });
  it('borra sólo lo que sigue cumpliendo las condiciones, a la Papelera, y registra cada paso', async () => {
    const trashed: string[] = [];
    const logs: string[] = [];
    const current = () => [{ jobId: 'j', clipId: 'ok', title: 't', path: '/e/ok.mp4', name: 'ok.mp4', bytes: 10, platforms: ['tiktok' as const] }];
    const r = await deletePublishedExports(
      [
        { jobId: 'j', clipId: 'ok' },
        { jobId: 'j', clipId: 'pendiente' },
      ],
      current,
      async (p) => void trashed.push(p),
      (m) => logs.push(m),
    );
    expect(trashed).toEqual(['/e/ok.mp4']);
    expect(r.freedBytes).toBe(10);
    expect(r.errors.map((e) => e.clipId)).toEqual(['pendiente']);
    expect(logs).toContain('exports publicados: enviado a la Papelera');
    expect(logs).toContain('exports publicados: omitido');
  });
  it('si la Papelera falla, el archivo se conserva', async () => {
    const r = await deletePublishedExports([{ jobId: 'j', clipId: 'ok' }], () => [{ jobId: 'j', clipId: 'ok', title: 't', path: '/e/ok.mp4', name: 'ok.mp4', bytes: 10, platforms: ['tiktok'] }], async () => {
      throw new Error('sin papelera');
    }, () => undefined);
    expect(r.deleted).toEqual([]);
    expect(r.errors[0].message).toMatch(/Papelera/);
  });
  it('marcar export eliminado conserva título y metadata', () => {
    const c = { ...clip('a', '/e/a.mp4'), exportVerified: true };
    const m = markExportDeleted(c, NOW);
    expect(m).toMatchObject({ title: 'Clip a', exportedPath: undefined, exportVerified: false, exportDeletedAfterPublish: NOW });
  });
});

describe('migración desde ClipsVirales', () => {
  const setup = () => {
    const lp = legacyPaths(path.join(root, 'Roaming'), path.join(root, 'Local'), path.join(root, 'Videos'));
    const userData = path.join(root, 'Roaming', 'Clip Clip');
    w(path.join(lp.data, 'data', 'settings.json'), '{"ollamaModel":"viejo"}');
    w(path.join(lp.data, 'data', 'jobs.json'), JSON.stringify([{ id: 'old-1' }]));
    w(path.join(lp.data, 'jobs', 'old-1', 'clips', '01.mp4'), 'v');
    w(path.join(lp.data, 'python-env', 'Scripts', 'python.exe'), 'py');
    w(path.join(lp.install, 'ClipsVirales.exe'), 'exe');
    w(path.join(lp.exports, 'viejo.mp4'), 'exp');
    const prot = { userData, installDir: path.join(root, 'Local', 'Programs', 'Clip Clip'), exportDir: path.join(root, 'Videos', 'Clip Clip'), inUse: [] as string[] };
    return { lp, userData, prot };
  };

  it('detecta datos, instalación y exports antiguos con su tamaño', () => {
    const { lp, userData } = setup();
    const s = scanLegacy(lp, userData);
    expect(s.found).toBe(true);
    expect(s.items.map((i) => i.kind)).toEqual(['data', 'install', 'exports']);
    expect(s.totalBytes).toBeGreaterThan(0);
    expect(s.migrated).toBe(false);
    expect(scanLegacy(legacyPaths(path.join(root, 'x'), path.join(root, 'y'), path.join(root, 'z')), userData).found).toBe(false);
  });

  it('«conservar copia»: migra sin sobrescribir datos nuevos ni tocar el origen', async () => {
    const { lp, userData, prot } = setup();
    w(path.join(userData, 'data', 'settings.json'), '{"ollamaModel":"nuevo"}');
    w(path.join(userData, 'data', 'jobs.json'), JSON.stringify([{ id: 'new-1' }]));
    const trashed: string[] = [];
    const r = await runLegacyMigration('keep', lp, prot, { trash: async (p) => void trashed.push(p), log: () => undefined });
    expect(r).toMatchObject({ ok: true, verified: true, trashed: [] });
    expect(fs.readFileSync(path.join(userData, 'data', 'settings.json'), 'utf8')).toContain('nuevo');
    expect(JSON.parse(fs.readFileSync(path.join(userData, 'data', 'jobs.json'), 'utf8')).map((j: { id: string }) => j.id)).toEqual(['new-1', 'old-1']);
    expect(fs.existsSync(lp.data)).toBe(true);
    expect(trashed).toEqual([]);
  });

  it('«liberar espacio»: verifica y envía datos e instalación a la Papelera, nunca los exports', async () => {
    const { lp, prot } = setup();
    const trashed: string[] = [];
    const logs: string[] = [];
    const r = await runLegacyMigration('free', lp, prot, { trash: async (p) => void trashed.push(p), log: (m) => logs.push(m) });
    expect(r.verified).toBe(true);
    expect(trashed).toEqual([lp.data, lp.install]);
    expect(r.freedBytes).toBeGreaterThan(0);
    expect(trashed).not.toContain(lp.exports);
    expect(logs).toEqual(expect.arrayContaining(['legado: migración', 'legado: enviado a la Papelera']));
  });

  it('conserva el Python en uso dentro de la carpeta antigua', () => {
    const { lp, prot } = setup();
    const plan = trashPlan(lp, { ...prot, inUse: [path.join(lp.data, 'python-env', 'Scripts', 'python.exe')] });
    expect(plan.kept).toEqual([path.join(lp.data, 'python-env')]);
    expect(plan.paths).toEqual(expect.arrayContaining([path.join(lp.data, 'data'), path.join(lp.data, 'jobs'), lp.install]));
    expect(plan.paths).not.toContain(lp.data);
  });

  it('nunca envía a la Papelera rutas protegidas (datos o instalación actuales)', () => {
    const { lp, prot } = setup();
    expect(trashPlan(lp, { ...prot, userData: path.join(lp.data, 'sub') }).paths).not.toContain(lp.data);
    expect(trashPlan(lp, { ...prot, installDir: lp.install }).kept).toContain(lp.install);
  });

  it('si la migración falla o no se verifica, no se borra nada', async () => {
    const { lp, prot } = setup();
    const trashed: string[] = [];
    const r = await runLegacyMigration('free', lp, prot, {
      trash: async (p) => void trashed.push(p),
      log: () => undefined,
      io: {
        link: () => {
          throw new Error('no');
        },
        copy: () => {
          throw new Error('disco lleno');
        },
      },
    });
    expect(r.ok).toBe(false);
    expect(r.verified).toBe(false);
    expect(trashed).toEqual([]);
    expect(fs.existsSync(path.join(lp.data, 'jobs', 'old-1', 'clips', '01.mp4'))).toBe(true);
  });

  it('protege el python-env referenciado por los ajustes antiguos migrados aunque los actuales sean los predeterminados', async () => {
    const { lp, prot } = setup();
    const py = path.join(lp.data, 'python-env', 'Scripts', 'python.exe');
    w(path.join(lp.data, 'data', 'settings.json'), JSON.stringify({ pythonPath: py }));
    const trashed: string[] = [];
    const r = await runLegacyMigration('free', lp, prot, { trash: async (p) => void trashed.push(p), log: () => undefined });
    expect(r.verified).toBe(true);
    expect(trashed).not.toContain(lp.data);
    expect(trashed.some((t) => py.startsWith(t))).toBe(false);
    expect(fs.existsSync(py)).toBe(true);
  });

  it('las publicaciones migradas se ven tras recargar y no se pisan', () => {
    const dir = path.join(root, 'pubmig');
    const s = new PublishStore(dir);
    w(path.join(dir, 'publish.json'), JSON.stringify({ old: { c: { tiktok: entry('publicado') } } }));
    s.reload();
    s.put('nuevo', 'c', 'tiktok', entry('borrador'));
    const again = new PublishStore(dir);
    expect(again.get('old', 'c', 'tiktok')?.status).toBe('publicado');
    expect(again.get('nuevo', 'c', 'tiktok')?.status).toBe('borrador');
  });

  it('fusiona publish.json por trabajo y lo verifica antes de liberar espacio', async () => {
    const { lp, userData, prot } = setup();
    w(path.join(lp.data, 'data', 'publish.json'), JSON.stringify({ 'old-1': { c: {} } }));
    w(path.join(userData, 'data', 'publish.json'), JSON.stringify({ 'new-1': { c: {} } }));
    const r = await runLegacyMigration('free', lp, prot, { trash: async () => undefined, log: () => undefined });
    expect(r.verified).toBe(true);
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(userData, 'data', 'publish.json'), 'utf8'))).sort()).toEqual(['new-1', 'old-1']);
  });

  it('verificación detecta lo que falta', () => {
    const { lp, userData } = setup();
    expect(verifyMigration(lp.data, userData).ok).toBe(false);
  });

  it('el estado «ignorar» se guarda', () => {
    expect(readState(path.join(root, 'nada'))).toEqual({});
  });
});

describe('actualización: datos de usuario y configuración del instalador', () => {
  it('recargar los almacenes tras migrar conserva lo existente', () => {
    const dir = path.join(root, 'data');
    const jobs = new JobStore(dir);
    jobs.put(job([]));
    jobs.flush();
    const settings = new SettingsStore(dir, defaultSettings(path.join(root, 'exp')));
    settings.update({ ollamaModel: 'mio' });
    w(path.join(dir, 'jobs.json'), JSON.stringify([...JSON.parse(fs.readFileSync(path.join(dir, 'jobs.json'), 'utf8')), { ...job([]), id: 'job-00000002' }]));
    jobs.reload();
    settings.reload(defaultSettings(path.join(root, 'exp')));
    expect(jobs.list().map((j) => j.id).sort()).toEqual(['job-00000001', 'job-00000002']);
    expect(settings.get().ollamaModel).toBe('mio');
    expect(settings.get().deleteExportsAfterPublish).toBe(false);
  });
  it('appId, nombre y accesos estables; la desinstalación/actualización conserva %APPDATA%', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    expect(pkg.build.appId).toBe('com.clipclip.desktop');
    expect(pkg.build.productName).toBe('Clip Clip');
    expect(pkg.build.nsis.shortcutName).toBe('Clip Clip');
    expect(pkg.build.nsis.uninstallDisplayName).toBe('Clip Clip');
    expect(pkg.build.nsis.deleteAppDataOnUninstall).toBe(false);
    expect(pkg.build.nsis.perMachine).toBe(false);
  });
  it('los metadatos de publicación persisten por clip y plataforma (con CTA y variantes)', () => {
    const dir = path.join(root, 'pub');
    const s = new PublishStore(dir);
    s.put('j', 'c1', 'tiktok', applyMeta(undefined, { title: '', description: 'a', hashtags: ['#x'], cta: '¿Y tú?' }, 'manual', NOW));
    s.put('j', 'c1', 'shorts', applyMeta(undefined, { title: 'T', description: 'b', hashtags: [] }, 'manual', NOW));
    s.putEditorial('j', 'c1', { tone: 'cercano', variants: [{ title: 'T', reason: 'r' }] });
    const again = new PublishStore(dir);
    expect(again.get('j', 'c1', 'tiktok')?.meta.cta).toBe('¿Y tú?');
    expect(again.get('j', 'c1', 'shorts')?.meta.title).toBe('T');
    expect(again.get('j', 'c2', 'tiktok')).toBeUndefined();
    expect(again.editorial('j', 'c1')).toMatchObject({ tone: 'cercano', variants: [{ title: 'T' }] });
  });
});

describe('limpieza de release/ (sólo desarrollo)', () => {
  it('conserva el instalador actual y borra lo antiguo; --all borra todo', () => {
    const entries = ['ClipsVirales-Setup-0.1.0.exe', 'Clip-Clip-Setup-0.1.0.exe', 'Clip-Clip-Setup-0.1.0.exe.blockmap', 'win-unpacked', 'builder-debug.yml'];
    expect(planReleaseCleanup(entries, '0.1.0')).toEqual(['ClipsVirales-Setup-0.1.0.exe', 'win-unpacked', 'builder-debug.yml']);
    expect(planReleaseCleanup(entries, '0.1.0', true)).toEqual(entries);
  });
  it('sólo permite <repo>/release', () => {
    expect(() => assertReleaseDir(path.join(root, 'src'), root)).toThrow();
    expect(() => assertReleaseDir(path.join(root, 'node_modules'), root)).toThrow();
    expect(assertReleaseDir(path.join(root, 'release'), root)).toBe(path.join(root, 'release'));
  });
});

describe('exports publicados: re-export durante el lote', () => {
  it('omite el clip si su export actual ya no es el confirmado', async () => {
    const trashed: string[] = [];
    const r = await deletePublishedExports([{ jobId: 'j', clipId: 'c', path: '/e/viejo.mp4' }], () => [{ jobId: 'j', clipId: 'c', title: 't', path: '/e/nuevo.mp4', name: 'nuevo.mp4', bytes: 1, platforms: ['tiktok'] }], async (p) => void trashed.push(p), () => undefined);
    expect(trashed).toEqual([]);
    expect(r.errors).toHaveLength(1);
  });
});

describe('migración: recarga antes de esperar a la Papelera', () => {
  it('afterMigrate se llama antes del primer envío a la Papelera', async () => {
    const lp = legacyPaths(path.join(root, 'R'), path.join(root, 'L'), path.join(root, 'V'));
    w(path.join(lp.data, 'data', 'jobs.json'), JSON.stringify([{ id: 'old-1' }]));
    const order: string[] = [];
    await runLegacyMigration('free', lp, { userData: path.join(root, 'R', 'Clip Clip'), installDir: path.join(root, 'L', 'cc'), exportDir: path.join(root, 'V', 'cc'), inUse: [] }, {
      trash: async () => void order.push('trash'),
      afterMigrate: () => void order.push('reload'),
      log: () => undefined,
    });
    expect(order[0]).toBe('reload');
    expect(order).toContain('trash');
  });
});
