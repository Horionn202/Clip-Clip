import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MARKER, mergeJobs, migrateLegacyData, migrationNotice, walk } from '../src/main/migration';

let root: string;
let oldDir: string;
let newDir: string;
const w = (base: string, rel: string, content: string) => {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};
const r = (base: string, rel: string) => fs.readFileSync(path.join(base, rel), 'utf8');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-migr-'));
  oldDir = path.join(root, 'ClipsVirales');
  newDir = path.join(root, 'Clip Clip');
  w(oldDir, 'data/settings.json', '{"ollamaModel":"llama3.2:3b","exportDir":"C:/Videos/ClipsVirales"}');
  w(oldDir, 'data/jobs.json', JSON.stringify([{ id: 'job-1' }, { id: 'job-2' }]));
  w(oldDir, 'jobs/job-1/clips/01_a.mp4', 'video-1');
  w(oldDir, 'jobs/job-1/transcript.json', '{"segments":[]}');
  w(oldDir, 'logs/app.log', 'antiguo');
  w(oldDir, 'python-env/Scripts/python.exe', 'no-se-migra');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('migración ClipsVirales → Clip Clip', () => {
  it('sin datos antiguos no hace nada', () => {
    expect(migrateLegacyData(path.join(root, 'no-existe'), newDir).status).toBe('none');
  });
  it('traslada ajustes, historial, trabajos y logs sin borrar el origen', () => {
    const rep = migrateLegacyData(oldDir, newDir);
    expect(rep.status).toBe('migrated');
    expect(r(newDir, 'data/settings.json')).toContain('llama3.2:3b');
    expect(JSON.parse(r(newDir, 'data/jobs.json'))).toHaveLength(2);
    expect(r(newDir, 'jobs/job-1/clips/01_a.mp4')).toBe('video-1');
    expect(r(newDir, 'logs/app.log')).toBe('antiguo');
    // el origen sigue intacto
    expect(r(oldDir, 'jobs/job-1/clips/01_a.mp4')).toBe('video-1');
    expect(fs.existsSync(path.join(oldDir, 'data/settings.json'))).toBe(true);
    // el entorno Python no se duplica
    expect(fs.existsSync(path.join(newDir, 'python-env'))).toBe(false);
    expect(rep.linked + rep.copied).toBe(5);
    expect(migrationNotice(rep)?.kind).toBe('info');
  });
  it('no sobrescribe datos ya existentes en el nuevo directorio y fusiona el historial', () => {
    w(newDir, 'data/settings.json', '{"ollamaModel":"qwen2.5:3b"}');
    w(newDir, 'data/jobs.json', JSON.stringify([{ id: 'job-2', nuevo: true }, { id: 'job-3' }]));
    const rep = migrateLegacyData(oldDir, newDir);
    expect(r(newDir, 'data/settings.json')).toContain('qwen2.5:3b');
    const jobs = JSON.parse(r(newDir, 'data/jobs.json'));
    expect(jobs.map((j: { id: string }) => j.id).sort()).toEqual(['job-1', 'job-2', 'job-3']);
    expect(jobs.find((j: { id: string; nuevo?: boolean }) => j.id === 'job-2').nuevo).toBe(true);
    expect(rep.mergedJobs).toBe(1);
    expect(rep.skippedExisting).toBe(1);
  });
  it('se hace una sola vez (marcador) y queda registrada', () => {
    migrateLegacyData(oldDir, newDir);
    expect(JSON.parse(r(newDir, MARKER)).status).toBe('migrated');
    expect(migrateLegacyData(oldDir, newDir).status).toBe('already');
  });
  it('si el enlace duro no es posible, copia', () => {
    const rep = migrateLegacyData(oldDir, newDir, {
      link: () => {
        throw new Error('EXDEV');
      },
      copy: (s, d) => fs.copyFileSync(s, d),
    });
    expect(rep.copied).toBe(5);
    expect(rep.linked).toBe(0);
  });
  it('si falla, conserva ambos directorios, no marca como hecha y avisa con diagnóstico', () => {
    let n = 0;
    const rep = migrateLegacyData(oldDir, newDir, {
      link: () => {
        throw new Error('EXDEV');
      },
      copy: (s, d) => {
        if (n++ === 1) throw new Error('EACCES: acceso denegado');
        fs.copyFileSync(s, d);
      },
    });
    expect(rep.status).toBe('partial');
    expect(rep.errors[0]).toMatch(/EACCES/);
    expect(fs.existsSync(path.join(newDir, MARKER))).toBe(false);
    expect(fs.existsSync(path.join(oldDir, 'data/settings.json'))).toBe(true);
    expect(migrationNotice(rep)).toMatchObject({ kind: 'error' });
    // el reintento completa lo que faltaba sin repetir lo ya migrado
    const again = migrateLegacyData(oldDir, newDir);
    expect(again.status).toBe('migrated');
    expect(again.skippedExisting).toBeGreaterThan(0);
  });
  it('mergeJobs: el nuevo gana en conflicto', () => {
    expect(mergeJobs([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }])).toEqual({ jobs: [{ id: 'a' }, { id: 'b' }], added: 1 });
  });
});

describe('migración: el origen no cambia después', () => {
  it('sólo enlaza vídeos de trabajos; ajustes y logs se copian (escribir en el nuevo no toca el antiguo)', () => {
    const rep = migrateLegacyData(oldDir, newDir);
    expect(rep.linked).toBe(1); // el .mp4
    expect(rep.copied).toBe(4);
    fs.appendFileSync(path.join(newDir, 'logs/app.log'), ' + nuevo');
    expect(r(oldDir, 'logs/app.log')).toBe('antiguo');
  });
});

describe('revisión Codex: errores al leer carpetas', () => {
  it('una carpeta ilegible (EACCES) no se da por migrada: no hay marcador y se avisa', () => {
    const errors: string[] = [];
    const denied = (p: string) => {
      if (p.includes('jobs')) throw Object.assign(new Error('EACCES: acceso denegado'), { code: 'EACCES' });
      return fs.readdirSync(p, { withFileTypes: true });
    };
    expect(walk(path.join(oldDir, 'jobs'), errors, '', denied)).toEqual([]);
    expect(errors[0]).toMatch(/EACCES/);
    // una carpeta inexistente sí se ignora
    const none: string[] = [];
    expect(walk(path.join(oldDir, 'no-existe'), none)).toEqual([]);
    expect(none).toEqual([]);
  });
});
