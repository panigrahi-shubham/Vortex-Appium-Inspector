// Finds the Android SDK so the Appium server Vortex starts can see it even when the terminal that launched
// Vortex has no ANDROID_HOME. Read-only: nothing is installed or changed on the computer.
//
// Order: ANDROID_HOME, ANDROID_SDK_ROOT, the SDK that contains the `adb` found on PATH, then the default
// install folder for the platform. A folder counts as an SDK only when it contains `platform-tools`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AndroidSdk {
  /** SDK folder, or null when none was found. */
  home: string | null;
  source: 'ANDROID_HOME' | 'ANDROID_SDK_ROOT' | 'adb on PATH' | 'default folder' | null;
  /** Full path of adb, when found. */
  adb: string | null;
}

export interface AndroidEnvDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
  home?: string;
}

const adbName = (platform: NodeJS.Platform) => (platform === 'win32' ? 'adb.exe' : 'adb');

export function findOnPath(file: string, deps: AndroidEnvDeps = {}): string | null {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? fs.existsSync;
  const sep = platform === 'win32' ? ';' : ':';
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  for (const dir of String(env.PATH ?? env.Path ?? '').split(sep)) {
    if (!dir) continue;
    const candidate = join(dir.replace(/^"|"$/g, ''), file);
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function detectAndroidSdk(deps: AndroidEnvDeps = {}): AndroidSdk {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? fs.existsSync;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const isSdk = (dir: string | undefined) => !!dir && exists(p.join(dir, 'platform-tools'));
  const adbIn = (dir: string) => {
    const adb = p.join(dir, 'platform-tools', adbName(platform));
    return exists(adb) ? adb : null;
  };
  const onPath = findOnPath(adbName(platform), deps);

  for (const key of ['ANDROID_HOME', 'ANDROID_SDK_ROOT'] as const) {
    if (isSdk(env[key])) return { home: env[key]!, source: key, adb: adbIn(env[key]!) ?? onPath };
  }
  if (onPath && p.basename(p.dirname(onPath)).toLowerCase() === 'platform-tools') {
    const home = p.dirname(p.dirname(onPath));
    return { home, source: 'adb on PATH', adb: onPath };
  }
  const userHome = deps.home ?? os.homedir();
  const defaults =
    platform === 'win32'
      ? [env.LOCALAPPDATA ? p.join(env.LOCALAPPDATA, 'Android', 'Sdk') : '', p.join(userHome, 'AppData', 'Local', 'Android', 'Sdk')]
      : platform === 'darwin'
        ? [p.join(userHome, 'Library', 'Android', 'sdk')]
        : [p.join(userHome, 'Android', 'Sdk')];
  for (const dir of defaults) if (isSdk(dir)) return { home: dir, source: 'default folder', adb: adbIn(dir) ?? onPath };
  return { home: null, source: null, adb: onPath };
}

/**
 * Environment for an Appium server started by Vortex. When the SDK was found but the variables are missing,
 * both are added (Appium accepts either); otherwise the environment is passed through unchanged.
 */
export function appiumChildEnv(deps: AndroidEnvDeps = {}): { env: NodeJS.ProcessEnv; note: string | null } {
  const env = { ...(deps.env ?? process.env) };
  const sdk = detectAndroidSdk(deps);
  if (!sdk.home || sdk.source === 'ANDROID_HOME' || sdk.source === 'ANDROID_SDK_ROOT') {
    // Appium accepts either name; mirror the one that is set so both tools and drivers agree.
    if (sdk.home && !env.ANDROID_HOME) env.ANDROID_HOME = sdk.home;
    if (sdk.home && !env.ANDROID_SDK_ROOT) env.ANDROID_SDK_ROOT = sdk.home;
    return { env, note: null };
  }
  env.ANDROID_HOME = sdk.home;
  env.ANDROID_SDK_ROOT = sdk.home;
  return { env, note: `ANDROID_HOME was not set; passing the Android SDK found at ${sdk.home} (${sdk.source}) to Appium` };
}
