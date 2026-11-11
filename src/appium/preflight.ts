// Setup check ("doctor"): everything a real-phone session needs, each with its state and the exact fix.
// Read-only. It never installs, changes or stops anything, and it never blocks Start by itself: it explains
// in advance what would otherwise surface later as a raw Appium error.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectAndroidSdk, findOnPath, type AndroidSdk } from './android-env.ts';
import type { AppiumInstall } from './appium-locator.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  id: 'node' | 'appium' | 'driver' | 'android-sdk' | 'adb' | 'java' | 'python' | 'device' | 'port';
  label: string;
  status: CheckStatus;
  detail: string;
  /** What to do, as a command or a short instruction. Empty when nothing is needed. */
  fix: string;
}

export interface PreflightReport {
  ok: boolean;
  /** True when at least one check makes a real-phone session impossible. */
  blocked: boolean;
  checks: Check[];
  at: string;
}

type Exec = (file: string, args: string[], timeoutMs?: number) => Promise<{ stdout: string; stderr: string }>;

export interface PreflightDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  exists?: (p: string) => boolean;
  readFile?: (p: string) => string;
  home?: string;
  projectRoot: string;
  exec?: Exec;
  locateAppium: () => Promise<AppiumInstall>;
  python: () => Promise<{ ok: boolean; version: string | null; problems: string[]; installCommand: string | null }>;
  devices: () => Promise<{ serial: string; state: string; model?: string | null }[]>;
  port: () => Promise<{ port: number; state: 'owned' | 'external' | 'free' | 'busy'; pids?: number[] | null; version?: string | null }>;
}

const defaultExec: Exec = (file, args, timeoutMs = 8_000) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().split(/\r?\n/)[0])) : resolve({ stdout, stderr })));
  });

const newer = (version: string, min: [number, number]) => {
  const [a, b] = version.split('.').map(Number);
  return a > min[0] || (a === min[0] && b >= min[1]);
};

/** Major version from `java -version` output: `version "17.0.9"` -> 17, `version "1.8.0_292"` -> 8. */
export function javaMajor(output: string): number | null {
  const m = /version "(\d+)(?:\.(\d+))?/.exec(output);
  if (!m) return null;
  const major = Number(m[1]);
  return major === 1 && m[2] ? Number(m[2]) : major;
}

export async function runPreflight(deps: PreflightDeps): Promise<PreflightReport> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? fs.existsSync;
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const exec = deps.exec ?? defaultExec;
  const home = deps.home ?? os.homedir();
  const p = platform === 'win32' ? path.win32 : path.posix;
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const guard = async (id: Check['id'], label: string, fn: () => Promise<Omit<Check, 'id' | 'label'>>) => {
    try {
      add({ id, label, ...(await fn()) });
    } catch (e) {
      add({ id, label, status: 'warn', detail: `Could not check: ${(e as Error).message}`, fix: '' });
    }
  };

  const node = deps.nodeVersion ?? process.versions.node;
  add({
    id: 'node',
    label: 'Node.js',
    status: newer(node, [24, 15]) ? 'ok' : newer(node, [22, 18]) ? 'warn' : 'fail',
    detail: `Node ${node}${newer(node, [24, 15]) ? '' : newer(node, [22, 18]) ? ' runs Vortex, but this edition is tested on 24.15 or newer' : ' is too old to run this edition'}`,
    fix: newer(node, [24, 15]) ? '' : 'Install Node.js 24 LTS (nodejs.org, or: winget install OpenJS.NodeJS.LTS)',
  });

  await guard('appium', 'Appium server', async () => {
    let appium: AppiumInstall;
    try {
      appium = await deps.locateAppium();
    } catch (e) {
      return { status: 'fail', detail: (e as Error).message.split('. ')[0] + '.', fix: 'npm install -g appium' };
    }
    const major = Number(appium.version.split('.')[0]);
    return { status: major === 2 || major === 3 ? 'ok' : 'warn', detail: `Appium ${appium.version} (${appium.source} install) at ${appium.entry}`, fix: major === 2 || major === 3 ? '' : 'This edition is checked with Appium 2.x and 3.x' };
  });

  await guard('driver', 'UiAutomator2 driver', async () => {
    const appiumHome = env.APPIUM_HOME || p.join(home, '.appium');
    const places = [p.join(appiumHome, 'node_modules', 'appium-uiautomator2-driver', 'package.json'), p.join(deps.projectRoot, 'node_modules', 'appium-uiautomator2-driver', 'package.json')];
    for (const file of places) {
      if (!exists(file)) continue;
      let version = 'unknown version';
      try {
        version = (JSON.parse(readFile(file)) as { version?: string }).version ?? version;
      } catch {
        /* keep "unknown version" */
      }
      return { status: 'ok', detail: `appium-uiautomator2-driver ${version} in ${p.dirname(p.dirname(p.dirname(file)))}`, fix: '' };
    }
    return { status: 'fail', detail: `Not found in ${appiumHome}. Attach would fail with "Could not find a driver for automationName UiAutomator2".`, fix: 'appium driver install uiautomator2' };
  });

  const sdk: AndroidSdk = detectAndroidSdk({ env, platform, exists, home });
  add({
    id: 'android-sdk',
    label: 'Android SDK',
    status: !sdk.home ? 'fail' : sdk.source === 'ANDROID_HOME' || sdk.source === 'ANDROID_SDK_ROOT' ? 'ok' : 'warn',
    detail: !sdk.home ? 'ANDROID_HOME is not set and no SDK was found in the usual places.' : sdk.source === 'ANDROID_HOME' || sdk.source === 'ANDROID_SDK_ROOT' ? `${sdk.source} = ${sdk.home}` : `ANDROID_HOME is not set. Found the SDK at ${sdk.home} (${sdk.source}); Vortex passes it to the Appium server it starts.`,
    fix: !sdk.home ? 'Install Android platform-tools (winget install Google.PlatformTools) and set ANDROID_HOME to the SDK folder' : sdk.source === 'ANDROID_HOME' || sdk.source === 'ANDROID_SDK_ROOT' ? '' : `Set it permanently: setx ANDROID_HOME "${sdk.home}"  (needed when you start Appium yourself or run pytest directly)`,
  });

  await guard('adb', 'adb', async () => {
    const adb = sdk.adb ?? findOnPath(platform === 'win32' ? 'adb.exe' : 'adb', { env, platform, exists });
    if (!adb) return { status: 'fail', detail: 'adb was not found on PATH or in the Android SDK.', fix: 'winget install Google.PlatformTools   (then open a new terminal)' };
    const out = await exec(adb, ['version']);
    return { status: 'ok', detail: `${out.stdout.split(/\r?\n/)[0].trim()} (${adb})`, fix: '' };
  });

  await guard('java', 'Java (JDK)', async () => {
    const javaHome = env.JAVA_HOME;
    const bin = javaHome ? p.join(javaHome, 'bin', platform === 'win32' ? 'java.exe' : 'java') : null;
    const java = bin && exists(bin) ? bin : findOnPath(platform === 'win32' ? 'java.exe' : 'java', { env, platform, exists });
    if (!java) return { status: 'fail', detail: javaHome ? `JAVA_HOME is ${javaHome} but no java was found there or on PATH.` : 'java was not found (JAVA_HOME is not set and java is not on PATH).', fix: 'Install a JDK 17 or newer (winget install EclipseAdoptium.Temurin.17.JDK) and set JAVA_HOME' };
    const out = await exec(java, ['-version']);
    const major = javaMajor(out.stderr + out.stdout);
    if (major === null) return { status: 'warn', detail: `Could not read the version of ${java}.`, fix: '' };
    return { status: major >= 17 ? (javaHome ? 'ok' : 'warn') : 'warn', detail: `Java ${major} (${java})${javaHome ? '' : '; JAVA_HOME is not set'}`, fix: major >= 17 ? (javaHome ? '' : 'Set JAVA_HOME to the JDK folder; the UiAutomator2 driver uses it to sign its helper apps') : 'Install a JDK 17 or newer and point JAVA_HOME to it' };
  });

  await guard('python', 'Python and packages', async () => {
    const py = await deps.python();
    return py.ok ? { status: 'ok', detail: `Python ${py.version} with pytest and Appium-Python-Client`, fix: '' } : { status: 'fail', detail: py.problems.join(' ') || 'Python was not found.', fix: py.installCommand ?? 'py -3 -m pip install -r requirements-appium.txt' };
  });

  await guard('device', 'Phone', async () => {
    const list = await deps.devices();
    const ready = list.filter((d) => d.state === 'device');
    if (ready.length) return { status: 'ok', detail: ready.map((d) => `${d.model || 'Android'} (${d.serial})`).join(', '), fix: '' };
    const unauthorized = list.find((d) => d.state === 'unauthorized');
    if (unauthorized) return { status: 'fail', detail: `${unauthorized.serial} is connected but not authorised.`, fix: 'Unlock the phone and accept "Allow USB debugging" (tick "Always allow")' };
    if (list.length) return { status: 'fail', detail: list.map((d) => `${d.serial} is ${d.state}`).join(', '), fix: 'Reconnect the cable; run: adb kill-server, then adb devices' };
    return { status: 'fail', detail: 'No phone is connected.', fix: 'Enable Developer options and USB debugging, connect the cable, choose File transfer mode' };
  });

  await guard('port', 'Appium port', async () => {
    const r = await deps.port();
    if (r.state === 'owned') return { status: 'ok', detail: `Vortex is running Appium on port ${r.port}.`, fix: '' };
    if (r.state === 'free') return { status: 'ok', detail: `Port ${r.port} is free.`, fix: '' };
    if (r.state === 'external') return { status: 'warn', detail: `An Appium server${r.version ? ` ${r.version}` : ''} that Vortex did not start is already on port ${r.port}.`, fix: 'Use "Connect existing", or stop that server and press Start Appium' };
    return { status: 'fail', detail: `Port ${r.port} is used by another program${r.pids?.length ? ` (PID ${r.pids.join(', ')})` : ''}.`, fix: 'Choose another port in Server & setup, or close that program' };
  });

  const blocked = checks.some((c) => c.status === 'fail');
  return { ok: checks.every((c) => c.status === 'ok'), blocked, checks, at: new Date().toISOString() };
}

/** Plain-text table for `npm run doctor`. */
export function formatPreflight(r: PreflightReport): string {
  const mark = { ok: '[ OK ]', warn: '[WARN]', fail: '[FAIL]' } as const;
  const lines = r.checks.map((c) => `${mark[c.status]} ${c.label.padEnd(22)} ${c.detail}${c.fix ? `\n       fix: ${c.fix}` : ''}`);
  lines.push('', r.blocked ? 'Some items need fixing before a real phone can be used.' : r.ok ? 'Everything needed for a real-phone session is in place.' : 'Ready, with warnings.');
  return lines.join('\n');
}
