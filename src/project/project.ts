// Project layout, generation for every selected framework/mode, and safe saving.
//
//   <out>/<module>/<case>/
//     recording.json                 the shared model (older versions kept in recording.history/)
//     vortex-manifest.json           every generated file with its SHA-256, mode and run target
//     appium/plain/test_<m>_<c>.py
//     appium/pom/{pytest.ini, conftest.py, pages/<m>_<c>_pages/, tests/test_<m>_<c>_pom.py}
//     assets/templates/              crops of unlabeled elements
//     reports/                       run reports
//
// Saving never silently destroys work:
//  - a file is replaced only when it is unchanged since Vortex generated it (checksum in the manifest);
//  - a file edited by hand (or not written by Vortex) is kept, and the new version is written next to it as
//    <file>.vortex-new for review, unless the user explicitly confirms replacing those exact files;
//  - generated files no longer produced are removed only if unchanged; edited ones are kept and reported;
//  - every write is atomic (temporary file + rename); paths are checked to stay inside the case folder.
//
// In Both mode the non-target variant's entry file gets a name the test runners do not discover
// (<case>.vortex-alt.ts, alt_test_*.py), so the same flow is never run twice by accident.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { generatePythonPlainFiles, generatePythonPom } from '../engines/appium/python-project.ts';
import type { Framework, GeneratedFile, GenerationIssue, Variant } from '../model/output.ts';
import { migrateRecording, RecordingError, toUiSteps, type Recording } from '../model/recording.ts';

export type Mode = 'plain' | 'pom' | 'both';

export interface CaseRef {
  module: string;
  case: string;
}

export interface BuildOptions {
  frameworks: Framework[];
  mode: Mode;
  /** The variant that runs by default in Both mode. */
  target: Variant;
  size: { width: number; height: number } | null;
}

export class ProjectError extends Error {
  code: string;
  httpStatus: number;
  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;

export function checkRef(ref: CaseRef): CaseRef {
  for (const [k, v] of [['module', ref.module], ['case', ref.case]] as const) {
    if (!SLUG.test(String(v ?? ''))) throw new ProjectError('BAD_NAME', 400, `Invalid ${k} name "${String(v)}": use lowercase letters, digits and dashes (max 60), starting with a letter or digit.`);
  }
  return ref;
}

export function caseDir(outDir: string, ref: CaseRef): string {
  checkRef(ref);
  const root = path.resolve(outDir);
  const dir = path.resolve(root, ref.module, ref.case);
  if (!dir.startsWith(root + path.sep)) throw new ProjectError('BAD_PATH', 400, 'The case folder must be inside the output folder.');
  return dir;
}

/** Entry-file name that test runners do not discover (Both mode, non-target variant). */
export function altName(p: string): string {
  const base = path.posix.basename(p);
  const dir = path.posix.dirname(p);
  if (/^test_.*\.py$/.test(base)) return `${dir}/alt_${base}`;
  return p;
}

export function buildCase(rec: Recording, ref: CaseRef, o: BuildOptions): { files: GeneratedFile[]; issues: GenerationIssue[]; target: Variant | null } {
  checkRef(ref);
  if (!o.frameworks.length) throw new ProjectError('NO_FRAMEWORK', 400, 'Choose at least one framework.');
  const variants: Variant[] = o.mode === 'both' ? ['plain', 'pom'] : [o.mode];
  const files: GeneratedFile[] = [];
  const issues: GenerationIssue[] = [];
  for (const fw of o.frameworks) {
    for (const v of variants) {
      if (fw !== 'appium') throw new ProjectError('BAD_FRAMEWORK', 400, 'Only Appium is supported.');
      const r = (v === 'plain' ? generatePythonPlainFiles : generatePythonPom)(rec, { moduleSlug: ref.module, caseSlug: ref.case, size: o.size });
      issues.push(...r.issues);
      files.push(...r.files);
    }
  }
  const target: Variant | null = o.mode === 'both' ? o.target : null;
  if (target) for (const f of files) if (f.role === 'entry' && f.variant !== target) f.path = altName(f.path);
  return { files: issues.length ? [] : files, issues, target: target ?? (o.mode as Variant) };
}

// ---- manifest --------------------------------------------------------------------------------

export interface ManifestEntry {
  sha256: string;
  framework?: Framework;
  variant?: Variant;
  role: 'entry' | 'support' | 'asset';
  /** Picked up by the framework's default test discovery. */
  discoverable?: boolean;
}

export interface Manifest {
  schema: 'vortex.manifest';
  version: 1;
  generator: string;
  recordingId: string;
  name: string;
  updatedAt: string;
  mode: Mode;
  target: Variant | null;
  frameworks: Framework[];
  files: Record<string, ManifestEntry>;
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

export function readManifest(dir: string): Manifest | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'vortex-manifest.json'), 'utf8')) as Manifest;
    return m.schema === 'vortex.manifest' ? m : null;
  } catch {
    return null;
  }
}

export function atomicWrite(file: string, data: Buffer | string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function inside(dir: string, rel: string): string {
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new ProjectError('BAD_PATH', 400, `Unsafe file path "${rel}".`);
  const abs = path.resolve(dir, rel);
  if (!abs.startsWith(dir + path.sep)) throw new ProjectError('BAD_PATH', 400, `Unsafe file path "${rel}".`);
  return abs;
}

const discoverable = (p: string) => /\.test\.ts$/.test(p) || /(^|\/)test_[^/]*\.py$/.test(p);

export interface SaveResult {
  caseDir: string;
  written: string[];
  unchanged: string[];
  /** Files edited since Vortex generated them (or not generated by Vortex): kept; the new version is in `newFile`. */
  conflicts: { path: string; newFile: string; reason: 'edited' | 'not-generated' }[];
  replaced: string[];
  removed: string[];
  keptStale: string[];
  recordingBackup: string | null;
}

export interface SaveInput {
  recording: Recording;
  files: GeneratedFile[];
  assets: { name: string; data: Buffer }[];
  mode: Mode;
  target: Variant | null;
  frameworks: Framework[];
  /** Paths the user explicitly confirmed may replace their edited versions. */
  replace?: string[];
  generator: string;
}

export function saveCase(outDir: string, ref: CaseRef, s: SaveInput): SaveResult {
  const dir = caseDir(outDir, ref);
  fs.mkdirSync(dir, { recursive: true });
  const old = readManifest(dir);
  const replace = new Set(s.replace ?? []);
  const res: SaveResult = { caseDir: dir, written: [], unchanged: [], conflicts: [], replaced: [], removed: [], keptStale: [], recordingBackup: null };
  const files: Record<string, ManifestEntry> = {};

  const items: { rel: string; data: Buffer; entry: Omit<ManifestEntry, 'sha256'> }[] = [
    ...s.files.map((f) => ({ rel: f.path, data: Buffer.from(f.content, 'utf8'), entry: { framework: f.framework, variant: f.variant, role: f.role, ...(f.role === 'entry' ? { discoverable: discoverable(f.path) } : {}) } })),
    ...s.assets.map((a) => {
      if (!/^[A-Za-z0-9_.-]{1,80}\.png$/.test(a.name)) throw new ProjectError('BAD_PATH', 400, `Unsafe asset name "${a.name}".`);
      return { rel: `assets/templates/${a.name}`, data: a.data, entry: { role: 'asset' as const } };
    }),
  ];
  for (const it of items) {
    const abs = inside(dir, it.rel);
    const h = sha(it.data);
    if (!fs.existsSync(abs)) {
      atomicWrite(abs, it.data);
      res.written.push(it.rel);
      files[it.rel] = { sha256: h, ...it.entry };
      continue;
    }
    const cur = sha(fs.readFileSync(abs));
    if (cur === h) {
      res.unchanged.push(it.rel);
      if (fs.existsSync(abs + '.vortex-new') && sha(fs.readFileSync(abs + '.vortex-new')) === h) fs.rmSync(abs + '.vortex-new');
      files[it.rel] = { sha256: h, ...it.entry };
      continue;
    }
    const prev = old?.files[it.rel];
    if ((prev && prev.sha256 === cur) || replace.has(it.rel)) {
      atomicWrite(abs, it.data);
      (prev && prev.sha256 === cur ? res.written : res.replaced).push(it.rel);
      files[it.rel] = { sha256: h, ...it.entry };
      const pending = abs + '.vortex-new';
      if (fs.existsSync(pending)) fs.rmSync(pending);
      continue;
    }
    // Edited by hand (or never generated by Vortex): keep it, put the new version next to it.
    const newRel = `${it.rel}.vortex-new`;
    atomicWrite(inside(dir, newRel), it.data);
    res.conflicts.push({ path: it.rel, newFile: newRel, reason: prev ? 'edited' : 'not-generated' });
    if (prev) files[it.rel] = prev; // still tracked with the checksum Vortex last wrote
  }

  // Generated files that are no longer produced (mode or framework changed, steps renamed, ...).
  for (const [rel, e] of Object.entries(old?.files ?? {})) {
    if (rel in files || items.some((i) => i.rel === rel)) continue;
    const abs = inside(dir, rel);
    if (!fs.existsSync(abs)) continue;
    if (sha(fs.readFileSync(abs)) === e.sha256) {
      fs.rmSync(abs);
      res.removed.push(rel);
      removeEmptyDirs(path.dirname(abs), dir);
    } else res.keptStale.push(rel);
  }

  // recording.json: previous versions are kept, never overwritten.
  const recFile = path.join(dir, 'recording.json');
  const recText = JSON.stringify(s.recording, null, 2) + '\n';
  if (fs.existsSync(recFile)) {
    const cur = fs.readFileSync(recFile, 'utf8');
    if (stripTimes(cur) !== stripTimes(recText)) {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
      const backup = `recording.history/recording-${stamp}.json`;
      let b = backup;
      for (let i = 2; fs.existsSync(path.join(dir, b)); i++) b = backup.replace('.json', `-${i}.json`);
      atomicWrite(path.join(dir, b), cur);
      res.recordingBackup = b;
      atomicWrite(recFile, recText);
    }
  } else atomicWrite(recFile, recText);

  const manifest: Manifest = {
    schema: 'vortex.manifest',
    version: 1,
    generator: s.generator,
    recordingId: s.recording.id,
    name: s.recording.name,
    updatedAt: new Date().toISOString(),
    mode: s.mode,
    target: s.target,
    frameworks: s.frameworks,
    files,
  };
  atomicWrite(path.join(dir, 'vortex-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return res;
}

const stripTimes = (t: string) => t.replace(/"(updatedAt|at)": "[^"]*"/g, '');

function removeEmptyDirs(from: string, stop: string) {
  let d = from;
  while (d.startsWith(stop + path.sep)) {
    try {
      if (fs.readdirSync(d).length) return;
      fs.rmdirSync(d);
    } catch {
      return;
    }
    d = path.dirname(d);
  }
}

// ---- reading ---------------------------------------------------------------------------------

export interface CaseInfo {
  module: string;
  case: string;
  name: string;
  updatedAt: string;
  mode: Mode;
  target: Variant | null;
  frameworks: Framework[];
  entries: { path: string; framework: Framework; variant: Variant; discoverable: boolean; exists: boolean }[];
  pendingReview: string[];
}

export function listProject(outDir: string): { modules: { module: string; cases: CaseInfo[] }[] } {
  const root = path.resolve(outDir);
  const modules: { module: string; cases: CaseInfo[] }[] = [];
  const dirs = (d: string) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true }).filter((x) => x.isDirectory() && SLUG.test(x.name)).map((x) => x.name).sort();
    } catch {
      return [];
    }
  };
  for (const m of dirs(root)) {
    const cases: CaseInfo[] = [];
    for (const c of dirs(path.join(root, m))) {
      const dir = path.join(root, m, c);
      const man = readManifest(dir);
      if (!man) continue;
      cases.push({
        module: m,
        case: c,
        name: man.name,
        updatedAt: man.updatedAt,
        mode: man.mode,
        target: man.target,
        frameworks: man.frameworks,
        entries: Object.entries(man.files)
          .filter(([, e]) => e.role === 'entry')
          .map(([p, e]) => ({ path: p, framework: e.framework!, variant: e.variant!, discoverable: !!e.discoverable, exists: fs.existsSync(path.join(dir, p)) })),
        pendingReview: Object.keys(man.files).filter((p) => fs.existsSync(path.join(dir, p + '.vortex-new'))),
      });
    }
    if (cases.length) modules.push({ module: m, cases });
  }
  return { modules };
}

export function readCaseRecording(outDir: string, ref: CaseRef) {
  const dir = caseDir(outDir, ref);
  const file = path.join(dir, 'recording.json');
  if (!fs.existsSync(file)) throw new ProjectError('NOT_FOUND', 404, `No recording.json in ${ref.module}/${ref.case}.`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new RecordingError(`recording.json is not valid JSON: ${(e as Error).message}`);
  }
  const rec = migrateRecording(raw);
  const assets: { name: string; dataUrl: string }[] = [];
  for (const e of rec.events) {
    if (!e.templateRef) continue;
    const f = path.join(dir, e.templateRef);
    if (e.templateRef.startsWith('assets/templates/') && fs.existsSync(f)) assets.push({ name: path.basename(f), dataUrl: 'data:image/png;base64,' + fs.readFileSync(f).toString('base64') });
  }
  return { recording: rec, steps: toUiSteps(rec), assets, manifest: readManifest(dir) };
}
