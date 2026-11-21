// Migración reparable de ClipsVirales → Clip Clip: estados, reparación de faltantes, liberación por partes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkLegacy, freeLegacy, readMarker, repairLegacy, runLegacyMigration, type LegacyPaths, type Protected } from '../src/main/legacy';
import { MARKER } from '../src/main/migration';

let root = '';
let lp: LegacyPaths;
let prot: Protected;
const w = (p: string, data: string | Buffer = 'x') => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, data));
const old = (rel: string, data: string | Buffer = 'x') => w(path.join(lp.data, rel), data);
const neu = (rel: string, data: string | Buffer = 'x') => w(path.join(prot.userData, rel), data);
const marker = (state?: string) => neu(MARKER, JSON.stringify({ status: 'migrated', ...(state ? { state } : {}) }));
const trashed: string[] = [];
const trash = async (p: string) => {
  trashed.push(p);
  fs.rmSync(p, { recursive: true, force: true });
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-legrep-'));
  lp = { data: path.join(root, 'Roaming', 'ClipsVirales'), install: path.join(root, 'Local', 'Programs', 'ClipsVirales'), exports: path.join(root, 'Videos', 'ClipsVirales') };
  prot = { userData: path.join(root, 'Roaming', 'Clip Clip'), installDir: path.join(root, 'Local', 'Programs', 'Clip Clip'), exportDir: path.join(root, 'Videos', 'Clip Clip'), inUse: [] };
  trashed.length = 0;
  // Datos antiguos: historial con un trabajo y sus archivos.
  old('data/jobs.json', JSON.stringify([{ id: 'job-000001' }]));
  old('data/settings.json', '{}');
  old('jobs/job-000001/source.mp4', Buffer.alloc(1000));
  old('jobs/job-000001/audio.wav', Buffer.alloc(500));
  old('jobs/job-000001/clips/01_a.mp4', Buffer.alloc(200));
  old('jobs/job-000001/frames/01.jpg', Buffer.alloc(50));
  old('jobs/job-000001/transcript.json', '{}');
  w(path.join(lp.install, 'ClipsVirales.exe'), Buffer.alloc(357));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const migrateAll = () => {
  neu('data/jobs.json', JSON.stringify([{ id: 'job-000001', clips: [{ file: '01_a.mp4' }] }]));
  neu('data/settings.json', '{}');
  for (const rel of ['source.mp4', 'audio.wav', 'clips/01_a.mp4', 'frames/01.jpg', 'transcript.json']) neu(`jobs/job-000001/${rel}`, 'y');
};

describe('migración reparable', () => {
  it('1. marcador + todo presente → verificada y se puede liberar la copia antigua', async () => {
    migrateAll();
    marker();
    const c = checkLegacy(lp, prot);
    expect(c.state).toBe('verified');
    expect(c.canFreeData).toBe(true);
    const r = await freeLegacy('data', lp, prot, { trash, log: () => undefined });
    expect(r.errors).toEqual([]);
    expect(fs.existsSync(lp.data)).toBe(false);
    expect(readMarker(prot.userData)?.state).toBe('legacy_trashed');
  });

  it('2. marcador + archivos faltantes → needs_repair, repara sólo lo que falta, verifica y entonces permite liberar', async () => {
    neu('data/jobs.json', JSON.stringify([{ id: 'job-000001', clips: [{ file: '01_a.mp4' }] }]));
    neu('data/settings.json', '{"nuevo":true}');
    neu('jobs/job-000001/transcript.json', '{"nuevo":true}');
    marker();
    const c = checkLegacy(lp, prot);
    expect(c.state).toBe('needs_repair');
    expect(c.byCategory).toMatchObject({ source: 1, audio: 1, internalClip: 1, frames: 1, transcript: 0 });
    expect(c.canFreeData).toBe(false);
    await expect(freeLegacy('data', lp, prot, { trash, log: () => undefined })).rejects.toThrow(/repara la migración/);
    const r = repairLegacy(lp, prot);
    expect(r.linked + r.copied).toBe(4);
    expect(r.check.state).toBe('verified');
    expect(r.check.canFreeData).toBe(true);
    expect(readMarker(prot.userData)?.state).toBe('verified');
    // 5. Lo que ya existía en Clip Clip no se sobrescribe.
    expect(fs.readFileSync(path.join(prot.userData, 'data/settings.json'), 'utf8')).toBe('{"nuevo":true}');
    expect(fs.readFileSync(path.join(prot.userData, 'jobs/job-000001/transcript.json'), 'utf8')).toBe('{"nuevo":true}');
  });

  it('3. con enlaces duros disponibles: no se duplica el espacio de los vídeos y el audio', () => {
    neu('data/jobs.json', JSON.stringify([{ id: 'job-000001' }]));
    marker();
    const r = repairLegacy(lp, prot);
    expect(r.linked).toBe(3); // source.mp4, audio.wav, clips/01_a.mp4
    expect(r.copiedBytes).toBeLessThan(1000); // sólo los pequeños (frames) se copian
    const a = fs.statSync(path.join(lp.data, 'jobs/job-000001/source.mp4'));
    const b = fs.statSync(path.join(prot.userData, 'jobs/job-000001/source.mp4'));
    expect(b.ino).toBe(a.ino); // mismo archivo en disco
    // Lo enlazado comparte espacio con Clip Clip: liberar la copia antigua no lo recupera y no se promete.
    expect(r.check.dataFreeableBytes).toBeLessThan(1000);
  });

  it('4. sin enlaces duros: copia correctamente e informa del impacto en disco', () => {
    neu('data/jobs.json', JSON.stringify([{ id: 'job-000001' }]));
    marker();
    const r = repairLegacy(lp, prot, {
      link: () => {
        throw new Error('EXDEV: otro disco');
      },
      copy: (s, d) => fs.copyFileSync(s, d, fs.constants.COPYFILE_EXCL),
    });
    expect(r.linked).toBe(0);
    expect(r.copied).toBe(6); // vídeo, audio, clip, frame, transcripción y settings.json
    expect(r.copiedBytes).toBe(1000 + 500 + 200 + 50 + 2 + 2);
    expect(r.check.state).toBe('verified');
  });

  it('lo borrado a propósito en Clip Clip (trabajo eliminado o espacio liberado) no se «repara» ni bloquea', async () => {
    // Trabajo 1 sigue pero se liberó su vídeo fuente y sus temporales; trabajo 2 se eliminó en Clip Clip.
    old('data/jobs.json', JSON.stringify([{ id: 'job-000001' }, { id: 'job-000002' }]));
    old('jobs/job-000002/source.mp4', Buffer.alloc(300));
    neu('data/jobs.json', JSON.stringify([{ id: 'job-000001', sourceCleaned: true, tempCleaned: true, clips: [{ file: '01_a.mp4' }] }]));
    neu('data/settings.json', '{}');
    neu('jobs/job-000001/clips/01_a.mp4', 'y');
    neu('jobs/job-000001/transcript.json', '{}');
    marker();
    const c = checkLegacy(lp, prot);
    expect(c.missingTotal).toBe(0);
    expect(c.intentional).toBeGreaterThanOrEqual(4); // source, audio, frames del 1 + el trabajo 2 (archivos e historial)
    expect(c.state).toBe('verified');
    const r = repairLegacy(lp, prot);
    expect(r.linked + r.copied).toBe(0);
    expect(fs.existsSync(path.join(prot.userData, 'jobs/job-000002'))).toBe(false); // no resucita lo borrado
  });

  it('6. instalación antigua segura con datos sin verificar → se puede liberar SÓLO la instalación', async () => {
    marker(); // faltan archivos: datos bloqueados
    expect(checkLegacy(lp, prot).canFreeData).toBe(false);
    const r = await freeLegacy('install', lp, prot, { trash, log: () => undefined });
    expect(r.freedBytes).toBe(357);
    expect(fs.existsSync(lp.install)).toBe(false);
    expect(fs.existsSync(lp.data)).toBe(true); // los datos antiguos se conservan
  });

  it('7. Python/CUDA todavía referenciado desde la ruta antigua: no se borra', async () => {
    migrateAll();
    marker();
    w(path.join(lp.data, 'python-env', 'Scripts', 'python.exe'), 'py');
    neu('data/settings.json', JSON.stringify({ pythonPath: path.join(lp.data, 'python-env', 'Scripts', 'python.exe') }));
    const r = await freeLegacy('data', lp, prot, { trash, log: () => undefined });
    expect(fs.existsSync(path.join(lp.data, 'python-env', 'Scripts', 'python.exe'))).toBe(true);
    expect(r.kept.some((k) => k.endsWith('python-env'))).toBe(true);
    expect(fs.existsSync(path.join(lp.data, 'jobs'))).toBe(false);
  });

  it('8. si la Papelera falla: no se borra nada para siempre y se puede reintentar', async () => {
    migrateAll();
    marker();
    const r = await freeLegacy('data', lp, prot, {
      trash: async () => {
        throw new Error('Papelera no disponible');
      },
      log: () => undefined,
    });
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.freedBytes).toBe(0);
    expect(fs.existsSync(path.join(lp.data, 'jobs/job-000001/source.mp4'))).toBe(true);
    expect(readMarker(prot.userData)?.state).not.toBe('legacy_trashed');
    // Reintento con la Papelera disponible.
    const again = await freeLegacy('data', lp, prot, { trash, log: () => undefined });
    expect(again.errors).toEqual([]);
  });

  it('exports antiguos: sólo con petición explícita y nunca si son la carpeta de exportación actual', async () => {
    w(path.join(lp.exports, 'viejo.mp4'), Buffer.alloc(80));
    expect(checkLegacy(lp, prot).exports?.bytes).toBe(80);
    await expect(freeLegacy('exports', lp, { ...prot, exportDir: lp.exports }, { trash, log: () => undefined })).rejects.toThrow(/exportación actual/);
    const r = await freeLegacy('exports', lp, prot, { trash, log: () => undefined });
    expect(r.freedBytes).toBe(80);
  });

  it('error de lectura: estado parcial, se explica qué carpeta y no se libera nada', () => {
    migrateAll();
    marker();
    const unreadable = path.join(lp.data, 'jobs', 'job-000001', 'frames');
    const orig = fs.readdirSync;
    (fs as unknown as { readdirSync: typeof fs.readdirSync }).readdirSync = ((p: fs.PathLike, o?: unknown) => {
      if (path.resolve(String(p)) === path.resolve(unreadable)) {
        const e = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
        e.code = 'EPERM';
        throw e;
      }
      return (orig as (p: fs.PathLike, o?: unknown) => unknown)(p, o);
    }) as typeof fs.readdirSync;
    try {
      const c = checkLegacy(lp, prot);
      expect(c.state).toBe('partial');
      expect(c.readErrors[0]).toMatch(/frames/);
      expect(c.canFreeData).toBe(false);
    } finally {
      (fs as unknown as { readdirSync: typeof fs.readdirSync }).readdirSync = orig;
    }
  });

  it('caso real: el flujo «Migrar y liberar» con marcador previo ya no se queda atascado (pide reparar, no 50 avisos)', async () => {
    neu('data/jobs.json', JSON.stringify([{ id: 'job-000001' }]));
    marker();
    const res = await runLegacyMigration('free', lp, prot, { trash, log: () => undefined });
    expect(res.verified).toBe(false);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatch(/Faltan 6 archivos.*repararlo/);
    expect(readMarker(prot.userData)?.state).toBe('needs_repair');
    expect(fs.existsSync(lp.data)).toBe(true);
  });
});
