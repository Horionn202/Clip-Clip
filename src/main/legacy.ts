// Datos e instalación de la versión anterior («ClipsVirales»). Windows la trata como otra aplicación,
// así que su instalación y sus datos quedan aparte. Aquí sólo se DETECTAN y, si el usuario lo elige en el
// modal, se migran (sin sobrescribir datos nuevos) y se envían a la Papelera tras verificar la migración.
// Nunca se toca nada fuera de las rutas conocidas de ClipsVirales; los exports antiguos no se borran.
import fs from 'node:fs';
import path from 'node:path';
import { LEGACY_DIR_NAME, MARKER, MIGRATED_DIRS, migrateLegacyData, walk, type MigrationFs, type MigrationReport } from './migration';
import { classify } from '../shared/storage';
import { isInside } from './paths';
import type { LegacyCheck, LegacyFreeResult, LegacyItem, LegacyMigrateResult, LegacyRepairResult, LegacyScan, MigrationState, MissingCategory } from '../shared/types';

export interface LegacyPaths {
  /** %APPDATA%\ClipsVirales */
  data: string;
  /** %LOCALAPPDATA%\Programs\ClipsVirales */
  install: string;
  /** Vídeos\ClipsVirales */
  exports: string;
}

export function legacyPaths(appData: string, localAppData: string, videos: string): LegacyPaths {
  return {
    data: path.join(appData, LEGACY_DIR_NAME),
    install: path.join(localAppData, 'Programs', LEGACY_DIR_NAME),
    exports: path.join(videos, LEGACY_DIR_NAME),
  };
}

/** Rutas que nunca se pueden enviar a la Papelera aunque coincidan (datos, instalación y exports actuales). */
export interface Protected {
  userData: string;
  installDir: string;
  exportDir: string;
  /** Rutas en uso por la configuración actual (p. ej. Python con CUDA dentro de la carpeta antigua). */
  inUse: string[];
}

export function dirSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          total += fs.statSync(p).size;
        } catch {
          /* ignorar */
        }
      }
    }
  }
  return total;
}

const STATE = path.join('data', 'legacy-state.json');
interface LegacyState {
  dismissed?: boolean;
  lastResult?: LegacyMigrateResult;
}
export function readState(userData: string): LegacyState {
  try {
    return JSON.parse(fs.readFileSync(path.join(userData, STATE), 'utf8')) as LegacyState;
  } catch {
    return {};
  }
}
export function writeState(userData: string, s: LegacyState): void {
  fs.mkdirSync(path.join(userData, 'data'), { recursive: true });
  fs.writeFileSync(path.join(userData, STATE), JSON.stringify(s, null, 2), 'utf8');
}

export function scanLegacy(lp: LegacyPaths, userData: string, size: (p: string) => number = dirSize): LegacyScan {
  const items: LegacyItem[] = [];
  for (const kind of ['data', 'install', 'exports'] as const) {
    const p = lp[kind];
    if (path.resolve(p) === path.resolve(userData)) continue;
    if (fs.existsSync(p)) items.push({ kind, path: p, bytes: size(p) });
  }
  const st = readState(userData);
  return {
    found: items.some((i) => i.kind !== 'exports'),
    items,
    totalBytes: items.filter((i) => i.kind !== 'exports').reduce((a, i) => a + i.bytes, 0),
    dismissed: !!st.dismissed,
    migrated: fs.existsSync(path.join(userData, 'data', 'migration-clipsvirales.json')),
  };
}

/** Comprueba que todo lo migrable del origen está en el destino (por ruta y, para jobs.json, por id). */
export function verifyMigration(oldDir: string, newDir: string): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  const errs: string[] = [];
  for (const top of MIGRATED_DIRS) {
    for (const rel of walk(path.join(oldDir, top), errs)) {
      if (!fs.existsSync(path.join(newDir, top, rel))) missing.push(path.join(top, rel));
    }
  }
  try {
    const ids = (f: string) => new Set((JSON.parse(fs.readFileSync(f, 'utf8')) as { id: string }[]).map((j) => j.id));
    const oldJobs = path.join(oldDir, 'data', 'jobs.json');
    if (fs.existsSync(oldJobs)) {
      const n = ids(path.join(newDir, 'data', 'jobs.json'));
      for (const id of ids(oldJobs)) if (!n.has(id)) missing.push(`historial: ${id}`);
    }
  } catch (e) {
    missing.push(`historial: ${(e as Error).message}`);
  }
  try {
    const oldPub = path.join(oldDir, 'data', 'publish.json');
    if (fs.existsSync(oldPub)) {
      const n = JSON.parse(fs.readFileSync(path.join(newDir, 'data', 'publish.json'), 'utf8')) as Record<string, unknown>;
      for (const k of Object.keys(JSON.parse(fs.readFileSync(oldPub, 'utf8')) as Record<string, unknown>)) if (!(k in n)) missing.push(`publicación: ${k}`);
    }
  } catch (e) {
    missing.push(`publicación: ${(e as Error).message}`);
  }
  return { ok: missing.length === 0 && errs.length === 0, missing: [...missing, ...errs].slice(0, 50) };
}

/**
 * Qué se puede enviar a la Papelera: la carpeta de datos y la instalación antiguas (nunca los exports).
 * Si la configuración actual usa algo de dentro (p. ej. el Python con CUDA en python-env), esa carpeta
 * se conserva y se envían sólo las demás subcarpetas.
 */
export function trashPlan(lp: LegacyPaths, prot: Protected): { paths: string[]; kept: string[] } {
  const paths: string[] = [];
  const kept: string[] = [];
  const forbidden = [prot.userData, prot.installDir, prot.exportDir].filter(Boolean);
  const clash = (p: string) => forbidden.some((f) => isInside(p, f) || isInside(f, p));
  for (const root of [lp.data, lp.install]) {
    if (!fs.existsSync(root)) continue;
    // Doble comprobación: el nombre de la carpeta debe ser exactamente el de la versión antigua.
    if (path.basename(root) !== LEGACY_DIR_NAME || clash(root)) {
      kept.push(root);
      continue;
    }
    const used = prot.inUse.filter((u) => u && isInside(root, u));
    if (!used.length) {
      paths.push(root);
      continue;
    }
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      const p = path.join(root, e.name);
      if (used.some((u) => isInside(p, u))) kept.push(p);
      else paths.push(p);
    }
  }
  return { paths, kept };
}

/** Rutas en uso según un settings.json (ejecutables y carpeta de exportación). */
export function settingsProtections(file: string): { inUse: string[]; exportDir?: string } {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const keys = ['pythonPath', 'whisperPath', 'gpuVerifiedPython', 'ffmpegPath', 'ffprobePath', 'ytDlpPath'];
    return { inUse: keys.map((k) => s[k]).filter((v): v is string => typeof v === 'string' && v.length > 0), exportDir: typeof s.exportDir === 'string' ? s.exportDir : undefined };
  } catch {
    return { inUse: [] };
  }
}

export interface MigrateDeps {
  trash: (p: string) => Promise<void>;
  size?: (p: string) => number;
  io?: MigrationFs;
  log: (msg: string, extra?: unknown) => void;
  /** Se llama JUSTO después de migrar (síncrono, antes de cualquier espera): recarga los almacenes en memoria
   *  para que ninguna escritura posterior pise los datos fusionados en disco. */
  afterMigrate?: () => void;
}

/**
 * «keep»: migra y conserva la copia antigua. «free»: migra, verifica y, sólo si la verificación pasa,
 * envía la copia antigua a la Papelera. Un fallo nunca borra el origen.
 */
export async function runLegacyMigration(mode: 'keep' | 'free', lp: LegacyPaths, prot: Protected, deps: MigrateDeps): Promise<LegacyMigrateResult> {
  const size = deps.size ?? dirSize;
  let rep: MigrationReport;
  try {
    rep = migrateLegacyData(lp.data, prot.userData, deps.io);
  } catch (e) {
    rep = { status: 'failed', from: lp.data, to: prot.userData, linked: 0, copied: 0, skippedExisting: 0, mergedJobs: 0, errors: [String(e)], at: new Date().toISOString() };
  }
  try {
    deps.afterMigrate?.();
  } catch (e) {
    rep.errors.push(`recarga: ${(e as Error).message}`);
  }
  deps.log('legado: migración', { modo: mode, estado: rep.status, enlazados: rep.linked, copiados: rep.copied, existentes: rep.skippedExisting, historial: rep.mergedJobs, errores: rep.errors.length });
  const result: LegacyMigrateResult = {
    ok: rep.errors.length === 0,
    migrated: { linked: rep.linked, copied: rep.copied, skippedExisting: rep.skippedExisting, mergedJobs: rep.mergedJobs },
    verified: false,
    trashed: [],
    freedBytes: 0,
    errors: [...rep.errors],
  };
  // Verificación detallada: lo borrado a propósito en Clip Clip no cuenta como faltante (no bloquea nada).
  const cm = fs.existsSync(lp.data) ? classifyMissing(lp.data, prot.userData) : { missing: [], intentional: 0, readErrors: [] };
  const v = { ok: cm.missing.length === 0 && cm.readErrors.length === 0, missing: [...cm.readErrors, ...cm.missing.map((m) => m.rel)] };
  result.verified = result.ok && v.ok;
  if (!v.ok) {
    writeMarker(prot.userData, { state: cm.readErrors.length ? 'partial' : 'needs_repair' });
    result.errors.push(`Faltan ${cm.missing.length} archivos en Clip Clip${cm.readErrors.length ? ` y ${cm.readErrors.length} carpetas no se pudieron leer` : ''}: abre «Datos de ClipsVirales» para repararlo.`);
  } else if (fs.existsSync(path.join(prot.userData, MARKER))) writeMarker(prot.userData, { state: 'verified' });
  if (mode === 'keep') return result;
  if (!result.verified) {
    deps.log('legado: no se libera espacio porque la migración no se pudo verificar', { faltan: v.missing.length });
    result.ok = false;
    return result;
  }
  // Las protecciones se calculan con los ajustes EFECTIVOS tras migrar (y los antiguos): si apuntan a python-env
  // u otra ruta dentro de ClipsVirales, esa parte se conserva aunque los ajustes en memoria fueran los predeterminados.
  const after = settingsProtections(path.join(prot.userData, 'data', 'settings.json'));
  const old = settingsProtections(path.join(lp.data, 'data', 'settings.json'));
  const extraExports = [after.exportDir, old.exportDir].filter((x): x is string => !!x);
  const plan = trashPlan(lp, { ...prot, inUse: [...prot.inUse, ...after.inUse, ...old.inUse, ...extraExports] });
  for (const k of plan.kept) deps.log('legado: se conserva (en uso o protegido)', { ruta: k });
  for (const p of plan.paths) {
    const bytes = size(p);
    try {
      await deps.trash(p);
      result.trashed.push({ path: p, bytes });
      result.freedBytes += bytes;
      deps.log('legado: enviado a la Papelera', { ruta: p, bytes });
    } catch (e) {
      result.errors.push(`${p}: no se pudo enviar a la Papelera (${(e as Error).message})`.slice(0, 300));
      deps.log('legado: error al enviar a la Papelera', { ruta: p, error: (e as Error).message });
    }
  }
  result.ok = result.errors.length === 0;
  if (result.ok && result.trashed.some((t) => isInside(lp.data, t.path))) writeMarker(prot.userData, { state: 'legacy_trashed' });
  return result;
}

/**
 * Bytes que de verdad se liberan al borrar una carpeta: un archivo con enlace duro en Clip Clip (nlink > 1) comparte el
 * espacio con la copia nueva, así que borrar la antigua no lo libera.
 */
export function uniqueSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let st: fs.Stats;
    try {
      st = fs.statSync(d);
    } catch {
      continue;
    }
    if (st.isFile()) {
      if (st.nlink <= 1) total += st.size;
      continue;
    }
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(d);
    } catch {
      continue;
    }
    for (const e of entries) stack.push(path.join(d, e));
  }
  return total;
}

// ======================================================================================================
// Verificación detallada, reparación y liberación por partes (ADR 0009)
// ======================================================================================================

interface MarkerData {
  state?: MigrationState;
  [k: string]: unknown;
}
export function readMarker(userData: string): MarkerData | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(userData, MARKER), 'utf8')) as MarkerData;
  } catch {
    return fs.existsSync(path.join(userData, MARKER)) ? {} : null;
  }
}
export function writeMarker(userData: string, patch: MarkerData): void {
  const cur = readMarker(userData) ?? {};
  fs.mkdirSync(path.join(userData, 'data'), { recursive: true });
  fs.writeFileSync(path.join(userData, MARKER), JSON.stringify({ ...cur, ...patch, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
}

interface NewJob {
  id: string;
  sourceCleaned?: boolean;
  tempCleaned?: boolean;
  clips?: { file?: string; archived?: boolean }[];
}

function readJson<T>(f: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Qué trabajos antiguos se migraron: la lista del marcador; en marcadores antiguos sin lista, los creados antes de
 * la fecha de la migración (lo creado después en la versión anterior nunca se migró).
 */
export function migratedJobsOf(oldDir: string, newDir: string): (id: string) => boolean {
  const m = readMarker(newDir);
  if (Array.isArray(m?.migratedJobIds)) {
    const set = new Set((m!.migratedJobIds as unknown[]).filter((x): x is string => typeof x === 'string'));
    return (id) => set.has(id);
  }
  const at = typeof m?.at === 'string' ? Date.parse(m.at) : NaN;
  if (!Number.isFinite(at)) return () => false;
  const created = new Map((readJson<{ id: string; createdAt?: string }[]>(path.join(oldDir, 'data', 'jobs.json')) ?? []).map((j) => [j.id, j.createdAt ? Date.parse(j.createdAt) : NaN]));
  return (id) => {
    const c = created.get(id);
    return c !== undefined && Number.isFinite(c) && c <= at;
  };
}

/** ¿La migración del historial terminó de verdad? (marcador escrito por una migración sin errores). */
export function historyMigrated(newDir: string): boolean {
  const m = readMarker(newDir);
  if (!m) return false;
  return m.status === 'migrated' || m.status === 'none' || m.historyComplete === true;
}

function categoryOf(rel: string): MissingCategory {
  const r = rel.replace(/\\/g, '/');
  if (!r.startsWith('jobs/')) return 'data';
  const inJob = r.split('/').slice(2).join('/');
  const c = classify(inJob);
  if (c === 'source') return 'source';
  if (c === 'audio') return 'audio';
  if (c === 'internalClip') return 'internalClip';
  if (c === 'transcript') return 'transcript';
  if (c === 'frames' || c === 'temp') return 'frames';
  return 'data';
}

/**
 * Qué falta en Clip Clip respecto a la copia antigua, separando lo que hace falta de lo que se borró A PROPÓSITO
 * en Clip Clip después de migrar (un trabajo eliminado o su espacio liberado): eso no se «repara».
 */
export function classifyMissing(oldDir: string, newDir: string): { missing: { rel: string; category: MissingCategory }[]; intentional: number; readErrors: string[] } {
  const readErrors: string[] = [];
  // Sólo una migración que TERMINÓ (historial fusionado sin errores) permite tratar lo ausente como borrado a propósito.
  // Un marcador de reparación o de error no prueba nada: los trabajos que falten siguen contando como faltantes.
  const migratedBefore = historyMigrated(newDir);
  // Sólo un trabajo que SE MIGRÓ y ya no está en Clip Clip se borró a propósito. Uno creado en la versión anterior
  // después de migrar nunca llegó: cuenta como faltante.
  const wasMigrated = migratedJobsOf(oldDir, newDir);
  const newJobsFile = path.join(newDir, 'data', 'jobs.json');
  const parsedNew = readJson<NewJob[]>(newJobsFile);
  if (fs.existsSync(newJobsFile) && !Array.isArray(parsedNew)) readErrors.push('data/jobs.json de Clip Clip: no se pudo leer el historial actual (no se libera nada hasta que se pueda comprobar)');
  const newJobs = new Map((Array.isArray(parsedNew) ? parsedNew : []).map((j) => [j.id, j]));
  const missing: { rel: string; category: MissingCategory }[] = [];
  let intentional = 0;
  for (const top of MIGRATED_DIRS) {
    for (const rel of walk(path.join(oldDir, top), readErrors)) {
      const relPath = path.join(top, rel);
      if (fs.existsSync(path.join(newDir, relPath))) continue;
      if (top === 'logs') continue; // los registros antiguos no hacen falta para usar Clip Clip
      if (top === 'jobs') {
        const parts = rel.split(/[\\/]/);
        const job = newJobs.get(parts[0]);
        const inJob = parts.slice(1).join('/');
        const kind = classify(inJob);
        const cleaned =
          (!job && migratedBefore && wasMigrated(parts[0])) || // trabajo migrado y eliminado después en Clip Clip
          (!!job && kind === 'source' && !!job.sourceCleaned) ||
          (!!job && (kind === 'audio' || kind === 'frames' || kind === 'temp') && !!job.tempCleaned) ||
          (!!job && kind === 'internalClip' && !!job.clips?.some((c) => c.archived && inJob === `clips/${c.file}`));
        if (cleaned) {
          intentional++;
          continue;
        }
      }
      missing.push({ rel: relPath.replace(/\\/g, '/'), category: categoryOf(relPath) });
    }
  }
  // Historial: un trabajo antiguo que no está en el nuevo sólo falta si nunca se migró (si no, se eliminó a propósito).
  const oldJobsFile = path.join(oldDir, 'data', 'jobs.json');
  const parsedOld = readJson<{ id: string }[]>(oldJobsFile);
  if (fs.existsSync(oldJobsFile) && !Array.isArray(parsedOld)) readErrors.push('data/jobs.json antiguo: no se pudo leer el historial de la versión anterior (no se libera nada hasta que se pueda comprobar)');
  const oldJobs = Array.isArray(parsedOld) ? parsedOld : [];
  for (const j of oldJobs) {
    if (!j || newJobs.has(j.id)) continue;
    if (migratedBefore && wasMigrated(j.id)) intentional++;
    else missing.push({ rel: `historial:${j.id}`, category: 'data' });
  }
  // Publicación: cada entrada antigua debe estar en Clip Clip (salvo la de un trabajo borrado a propósito).
  const oldPubFile = path.join(oldDir, 'data', 'publish.json');
  if (fs.existsSync(oldPubFile)) {
    const oldPub = readJson<Record<string, unknown>>(oldPubFile);
    const newPubFile = path.join(newDir, 'data', 'publish.json');
    const newPub = fs.existsSync(newPubFile) ? readJson<Record<string, unknown>>(newPubFile) : {};
    if (!oldPub || typeof oldPub !== 'object') readErrors.push('data/publish.json antiguo: no se pudo leer');
    else if (!newPub || typeof newPub !== 'object') readErrors.push('data/publish.json de Clip Clip: no se pudo leer');
    else
      for (const k of Object.keys(oldPub)) {
        if (k in newPub) continue;
        if (migratedBefore && !newJobs.has(k) && wasMigrated(k)) intentional++;
        else missing.push({ rel: `publicacion:${k}`, category: 'data' });
      }
  }
  return { missing, intentional, readErrors };
}

/** Protecciones efectivas: ajustes actuales y antiguos (Python/CUDA, ejecutables y carpetas de exportación). */
function effectiveProtections(lp: LegacyPaths, prot: Protected): Protected {
  const after = settingsProtections(path.join(prot.userData, 'data', 'settings.json'));
  const old = settingsProtections(path.join(lp.data, 'data', 'settings.json'));
  const extraExports = [after.exportDir, old.exportDir].filter((x): x is string => !!x);
  return { ...prot, inUse: [...prot.inUse, ...after.inUse, ...old.inUse, ...extraExports] };
}

/** Plan de Papelera de UNA raíz (datos o instalación), con las protecciones aplicadas. */
function rootPlan(root: string, lp: LegacyPaths, eff: Protected): { paths: string[]; kept: string[] } {
  const only = { data: root === lp.data ? lp.data : path.join(lp.data, '__no__'), install: root === lp.install ? lp.install : path.join(lp.install, '__no__'), exports: lp.exports };
  const plan = trashPlan(only, eff);
  return { paths: plan.paths.filter((p) => isInside(root, p)), kept: plan.kept.filter((k) => isInside(root, k)) };
}

export function checkLegacy(lp: LegacyPaths, prot: Protected, size: (p: string) => number = dirSize): LegacyCheck {
  const byCategory: Record<MissingCategory, number> = { source: 0, audio: 0, internalClip: 0, frames: 0, transcript: 0, data: 0 };
  const marker = readMarker(prot.userData);
  const out: LegacyCheck = { state: 'none', missing: [], missingTotal: 0, byCategory, intentional: 0, readErrors: [], canFreeData: false, dataFreeableBytes: 0 };
  const eff = effectiveProtections(lp, prot);
  if (fs.existsSync(lp.data) && path.resolve(lp.data) !== path.resolve(prot.userData)) {
    out.data = { path: lp.data, bytes: size(lp.data) };
    const c = classifyMissing(lp.data, prot.userData);
    for (const m of c.missing) byCategory[m.category]++;
    out.missing = c.missing.slice(0, 500);
    out.missingTotal = c.missing.length;
    out.intentional = c.intentional;
    out.readErrors = c.readErrors;
    out.dataFreeableBytes = rootPlan(lp.data, lp, eff).paths.reduce((a, p) => a + (size === dirSize ? uniqueSize(p) : size(p)), 0);
  }
  if (fs.existsSync(lp.install)) {
    const plan = rootPlan(lp.install, lp, eff);
    out.install = { path: lp.install, bytes: size(lp.install), freeableBytes: plan.paths.reduce((a, p) => a + size(p), 0), keptInUse: plan.kept };
  }
  if (fs.existsSync(lp.exports) && !isInside(lp.exports, prot.exportDir) && !isInside(prot.exportDir, lp.exports)) out.exports = { path: lp.exports, bytes: size(lp.exports) };
  if (!out.data) out.state = marker ? 'legacy_trashed' : 'none';
  else if (out.readErrors.length) out.state = 'partial';
  else if (out.missingTotal > 0) out.state = marker ? 'needs_repair' : 'none';
  else out.state = marker ? 'verified' : 'none';
  out.canFreeData = !!out.data && out.state === 'verified';
  return out;
}

/**
 * Reparación: copia (o enlaza) SÓLO lo que falta y hace falta; nunca sobrescribe nada del directorio nuevo ni
 * resucita trabajos borrados a propósito. Después verifica y guarda el estado en el marcador.
 */
export function repairLegacy(lp: LegacyPaths, prot: Protected, io?: MigrationFs, size: (p: string) => number = dirSize): LegacyRepairResult {
  const before = classifyMissing(lp.data, prot.userData);
  // Trabajos que ya contaban como migrados ANTES de reparar (lista del marcador o, en marcadores antiguos, por fecha):
  // se conservan en la lista explícita para que lo borrado a propósito no vuelva a contar como faltante.
  const wasMigrated = migratedJobsOf(lp.data, prot.userData);
  const preIds = (readJson<{ id: string }[]>(path.join(lp.data, 'data', 'jobs.json')) ?? []).map((j) => j.id).filter((id) => wasMigrated(id));
  if (before.readErrors.length) return { linked: 0, copied: 0, copiedBytes: 0, skippedExisting: 0, errors: before.readErrors, check: checkLegacy(lp, prot, size) };
  const only = new Set(before.missing.filter((m) => !m.rel.startsWith('historial:') && !m.rel.startsWith('publicacion:')).map((m) => path.join(...m.rel.split('/'))));
  if (before.missing.some((m) => m.rel.startsWith('publicacion:'))) only.add(path.join('data', 'publish.json'));
  // El historial sólo se vuelve a fusionar si faltan trabajos que nunca se migraron.
  if (before.missing.some((m) => m.rel.startsWith('historial:'))) only.add(path.join('data', 'jobs.json'));
  let copiedBytes = 0;
  const countingIo: MigrationFs = {
    link: io?.link ?? ((s, d) => fs.linkSync(s, d)),
    copy: (s, d) => {
      (io?.copy ?? ((a: string, b: string) => fs.copyFileSync(a, b, fs.constants.COPYFILE_EXCL)))(s, d);
      try {
        copiedBytes += fs.statSync(d).size;
      } catch {
        /* ignorar */
      }
    },
  };
  const wanted = new Set(before.missing.filter((m) => m.rel.startsWith('historial:') || m.rel.startsWith('publicacion:')).map((m) => m.rel.slice(m.rel.indexOf(':') + 1)));
  const rep = only.size ? migrateLegacyData(lp.data, prot.userData, countingIo, { repair: true, only, keepEntry: (id) => wanted.has(id) }) : null;
  const check = checkLegacy(lp, prot, size);
  const nowIds = new Set((readJson<{ id: string }[]>(path.join(prot.userData, 'data', 'jobs.json')) ?? []).map((j) => j.id));
  const prevIds = [...(Array.isArray(readMarker(prot.userData)?.migratedJobIds) ? (readMarker(prot.userData)!.migratedJobIds as string[]) : []), ...preIds];
  const oldIds = (readJson<{ id: string }[]>(path.join(lp.data, 'data', 'jobs.json')) ?? []).map((j) => j.id);
  const migratedJobIds = [...new Set([...prevIds, ...oldIds.filter((id) => nowIds.has(id))])];
  writeMarker(prot.userData, { state: check.state === 'verified' ? 'verified' : 'repaired', migratedJobIds, ...(check.state === 'verified' ? { historyComplete: true } : {}), lastRepair: { linked: rep?.linked ?? 0, copied: rep?.copied ?? 0, copiedBytes, errors: rep?.errors.length ?? 0 } });
  return { linked: rep?.linked ?? 0, copied: rep?.copied ?? 0, copiedBytes, skippedExisting: rep?.skippedExisting ?? 0, errors: rep?.errors ?? [], check };
}

/**
 * Envía a la Papelera una parte de la versión anterior. Las rutas salen de la configuración (nunca del renderer),
 * deben llamarse exactamente «ClipsVirales» y no pueden coincidir con las de Clip Clip ni con nada en uso.
 * «data» sólo con la migración verificada; «install» y «exports» son independientes. Si la Papelera falla, no se
 * borra nada de forma permanente.
 */
export async function freeLegacy(
  target: 'data' | 'install' | 'exports',
  lp: LegacyPaths,
  prot: Protected,
  deps: { trash: (p: string) => Promise<void>; size?: (p: string) => number; log: (m: string, x?: unknown) => void },
): Promise<LegacyFreeResult> {
  const size = deps.size ?? dirSize;
  const res: LegacyFreeResult = { target, trashed: [], freedBytes: 0, kept: [], errors: [] };
  const root = target === 'data' ? lp.data : target === 'install' ? lp.install : lp.exports;
  if (!path.isAbsolute(root) || path.basename(root) !== LEGACY_DIR_NAME || !fs.existsSync(root)) throw new Error('La carpeta de la versión anterior no existe o no es válida.');
  if ([prot.userData, prot.installDir].some((f) => f && (isInside(root, f) || isInside(f, root)))) throw new Error('Esa carpeta es de Clip Clip: no se toca.');
  const eff = effectiveProtections(lp, prot);
  let paths: string[];
  if (target === 'data') {
    const c = checkLegacy(lp, prot, size);
    if (!c.canFreeData) throw new Error(c.readErrors.length ? 'No se pudieron leer todas las carpetas antiguas: no se borra nada.' : `Faltan ${c.missingTotal} archivos en Clip Clip: repara la migración antes de liberar los datos antiguos.`);
    const plan = rootPlan(lp.data, lp, eff);
    paths = plan.paths;
    res.kept = plan.kept;
  } else if (target === 'install') {
    const plan = rootPlan(lp.install, lp, eff);
    paths = plan.paths;
    res.kept = plan.kept;
  } else {
    // Exports antiguos: nunca la carpeta de exportación actual ni algo que la contenga o esté en uso.
    // Sólo cuenta lo que Clip Clip usa HOY (su carpeta de exportación y sus ejecutables); la carpeta de exportación de la
    // versión anterior es precisamente lo que se quiere liberar.
    const current = [...prot.inUse, ...settingsProtections(path.join(prot.userData, 'data', 'settings.json')).inUse];
    const curExport = settingsProtections(path.join(prot.userData, 'data', 'settings.json')).exportDir;
    if ([prot.exportDir, curExport].some((d) => d && (isInside(root, d) || isInside(d, root))) || current.some((u) => u && isInside(root, u))) throw new Error('Esa carpeta es la de exportación actual o está en uso: no se toca.');
    paths = [root];
  }
  for (const p of paths) {
    // Lo enlazado con Clip Clip no libera espacio al borrarse: se informa sólo lo que de verdad se recupera.
    const bytes = deps.size ? size(p) : uniqueSize(p);
    try {
      await deps.trash(p);
      res.trashed.push({ path: p, bytes });
      res.freedBytes += bytes;
      deps.log('legado: enviado a la Papelera', { destino: target, ruta: p, bytes });
    } catch (e) {
      // Sin borrado permanente de respaldo: se queda donde está y se puede reintentar.
      res.errors.push(`${p}: no se pudo enviar a la Papelera (${(e as Error).message})`.slice(0, 300));
    }
  }
  if (target === 'data' && !res.errors.length) writeMarker(prot.userData, { state: 'legacy_trashed' });
  return res;
}
