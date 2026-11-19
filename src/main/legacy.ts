// Datos e instalación de la versión anterior («ClipsVirales»). Windows la trata como otra aplicación,
// así que su instalación y sus datos quedan aparte. Aquí sólo se DETECTAN y, si el usuario lo elige en el
// modal, se migran (sin sobrescribir datos nuevos) y se envían a la Papelera tras verificar la migración.
// Nunca se toca nada fuera de las rutas conocidas de ClipsVirales; los exports antiguos no se borran.
import fs from 'node:fs';
import path from 'node:path';
import { LEGACY_DIR_NAME, MIGRATED_DIRS, migrateLegacyData, walk, type MigrationFs, type MigrationReport } from './migration';
import { isInside } from './paths';
import type { LegacyItem, LegacyMigrateResult, LegacyScan } from '../shared/types';

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
  deps.log('legado: migración', { modo: mode, estado: rep.status, enlazados: rep.linked, copiados: rep.copied, existentes: rep.skippedExisting, historial: rep.mergedJobs, errores: rep.errors.length });
  const result: LegacyMigrateResult = {
    ok: rep.errors.length === 0,
    migrated: { linked: rep.linked, copied: rep.copied, skippedExisting: rep.skippedExisting, mergedJobs: rep.mergedJobs },
    verified: false,
    trashed: [],
    freedBytes: 0,
    errors: [...rep.errors],
  };
  const v = fs.existsSync(lp.data) ? verifyMigration(lp.data, prot.userData) : { ok: true, missing: [] };
  result.verified = result.ok && v.ok;
  if (!v.ok) result.errors.push(...v.missing.map((m) => `no verificado: ${m}`));
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
  return result;
}
