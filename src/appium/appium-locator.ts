// Finds the Appium entry script (appium/index.js) so the server can be started as `node index.js ...`.
// Starting node directly (instead of appium.cmd through a shell) means the PID Vortex records is the
// real Appium process, not a cmd.exe wrapper, which is what makes ownership checks reliable on Windows.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface AppiumInstall {
  entry: string;
  version: string;
  source: 'configured' | 'local' | 'global';
}

/** Accepts the package folder or its entry file. Returns null when it is not an Appium package. */
export function readAppiumPackage(p: string): { entry: string; version: string } | null {
  try {
    const abs = path.resolve(p);
    const dir = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string; bin?: string | Record<string, string> };
    if (pkg.name !== 'appium') return null;
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.appium;
    if (!bin) return null;
    const entry = path.join(dir, bin);
    if (!fs.statSync(abs).isDirectory() && path.resolve(entry) !== abs) return null;
    if (!fs.existsSync(entry)) return null;
    return { entry, version: pkg.version ?? 'unknown' };
  } catch {
    return null;
  }
}

function npmGlobalRoot(): Promise<string | null> {
  return new Promise((resolve) => {
    // Fixed arguments only; a shell is needed on Windows because npm is a .cmd file.
    execFile(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', windowsHide: true, timeout: 20_000, shell: process.platform === 'win32' }, (err, out) =>
      resolve(err ? null : out.trim() || null),
    );
  });
}

let globalCache: Promise<string | null> | undefined;

export async function locateAppium(configured: string, projectRoot: string): Promise<AppiumInstall> {
  if (configured) {
    const found = readAppiumPackage(configured);
    if (!found) throw new Error(`"${configured}" is not an Appium package or entry file (expected the appium folder or its index.js)`);
    return { ...found, source: 'configured' };
  }
  const local = readAppiumPackage(path.join(projectRoot, 'node_modules', 'appium'));
  if (local) return { ...local, source: 'local' };
  globalCache ??= npmGlobalRoot();
  const root = await globalCache;
  const global = root ? readAppiumPackage(path.join(root, 'appium')) : null;
  if (global) return { ...global, source: 'global' };
  throw new Error('Appium is not installed. Install it with `npm install -g appium@3.9.0` and the driver with `appium driver install uiautomator2`, or set the Appium path in Server settings.');
}
