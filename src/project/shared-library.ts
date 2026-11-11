// The shared page library on disk: <output folder>/_shared/
//
//   vortex-library.json          what the library contains (pages, locator names, methods) and file checksums
//   pages/<app>_pages/*.py       the generated page classes, one package per app
//
// Names in the library never change once given, so a test saved earlier keeps working when a later test adds
// locators or methods to the same page. A page file edited by hand is never overwritten: the new version is
// written beside it as `.vortex-new`, and replay of shared-page tests is blocked until it is reviewed.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pyIdent, type SharedLibrary } from '../engines/appium/python-project.ts';
import { atomicWrite, type SharedOutput } from './project.ts';

interface AppLibrary extends SharedLibrary {
  /** sha256 of each generated file as Vortex last wrote it, keyed by path relative to _shared/. */
  files: Record<string, string>;
}
interface LibraryFile {
  schema: 'vortex.library';
  version: 1;
  apps: Record<string, AppLibrary>;
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const sharedRoot = (outDir: string) => path.join(path.resolve(outDir), '_shared');
const stateFile = (outDir: string) => path.join(sharedRoot(outDir), 'vortex-library.json');

function readState(outDir: string): LibraryFile {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(outDir), 'utf8')) as LibraryFile;
    if (raw.schema === 'vortex.library' && raw.version === 1 && raw.apps) return raw;
  } catch {
    /* none yet */
  }
  return { schema: 'vortex.library', version: 1, apps: {} };
}

/** The library for one app; empty (but named) when nothing was saved yet. */
export function readLibrary(outDir: string, appPackage: string): SharedLibrary {
  const app = readState(outDir).apps[appPackage];
  return app ? { pkgName: app.pkgName, web: app.web, pages: app.pages } : { pkgName: `${pyIdent(appPackage)}_pages`, web: false, pages: [] };
}

function inside(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || !abs.startsWith(root + path.sep)) throw new Error(`Unsafe shared file path "${rel}".`);
  return abs;
}

export function writeLibrary(outDir: string, appPackage: string, shared: SharedOutput): { written: string[]; conflicts: string[] } {
  const root = sharedRoot(outDir);
  const state = readState(outDir);
  const known = state.apps[appPackage]?.files ?? {};
  const files: Record<string, string> = { ...known };
  const written: string[] = [], conflicts: string[] = [];
  for (const f of shared.files) {
    const abs = inside(root, f.path);
    const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (current !== null && current !== f.content && known[f.path] !== sha(current)) {
      // Edited by hand (or not written by Vortex): keep it, and put the generated version beside it.
      atomicWrite(`${abs}.vortex-new`, f.content);
      conflicts.push(f.path);
      continue;
    }
    if (current !== f.content) {
      atomicWrite(abs, f.content);
      written.push(f.path);
    }
    fs.rmSync(`${abs}.vortex-new`, { force: true });
    files[f.path] = sha(f.content);
  }
  state.apps[appPackage] = { ...shared.library, files };
  atomicWrite(stateFile(outDir), JSON.stringify(state, null, 2) + '\n');
  return { written, conflicts };
}

/** Shared page files with a generated version waiting for review (relative to the output folder). */
export function pendingLibraryReview(outDir: string): string[] {
  const root = sharedRoot(outDir);
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.vortex-new')) out.push(path.relative(path.resolve(outDir), f).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out;
}
