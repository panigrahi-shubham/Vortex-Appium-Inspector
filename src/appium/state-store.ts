// Persists server-manager state (owned-server records and settings) so ownership survives a recorder crash.
// Writes are atomic: write a temp file, then rename over the old one.

import fs from 'node:fs';
import path from 'node:path';
import type { ProcessIdentity } from './process-inspector.ts';

export const STATE_VERSION = 1;

export interface OwnedServerRecord {
  id: string;
  host: string;
  port: number;
  pid: number;
  identity: ProcessIdentity;
  appiumEntry: string;
  appiumVersion: string;
  logFile: string;
  startedAt: string;
  /** Random id of the recorder process that started the server. */
  startedBy: string;
}

export interface ServerSettings {
  host: string;
  port: number;
  /** Keep an owned server running between test runs (sessions are still cleaned up after each run). */
  keepWarm: boolean;
  /** Stop the owned server when the recorder exits. When false, the server is adopted again on the next start. */
  stopOwnedOnExit: boolean;
  serverStartupTimeoutMs: number;
  sessionStartupTimeoutMs: number;
  /** Appium newCommandTimeout for sessions Vortex creates (seconds). */
  sessionIdleTimeoutSec: number;
  stopGraceMs: number;
  /** Path to appium's index.js. Empty = auto-detect. */
  appiumPath: string;
  /** Chromedriver for WebView contexts: an executable, or a folder of versioned executables. Empty = Appium's own. */
  chromedriverExecutable: string;
  chromedriverExecutableDir: string;
  /** URL prefix of the Appium server: "/" (Appium 2 and 3 default) or for example "/wd/hub" (Appium 1 style). */
  basePath: string;
  /** Start a Vortex-owned server again when it stops unexpectedly (at most 3 attempts). Never applies to external servers. */
  autoRestart: boolean;
}

export interface PersistedState {
  version: number;
  settings: ServerSettings;
  owned: OwnedServerRecord[];
}

export const DEFAULT_SETTINGS: ServerSettings = {
  host: '127.0.0.1',
  port: 4723,
  keepWarm: true,
  stopOwnedOnExit: true,
  serverStartupTimeoutMs: 60_000,
  sessionStartupTimeoutMs: 120_000,
  sessionIdleTimeoutSec: 300,
  stopGraceMs: 8_000,
  appiumPath: '',
  chromedriverExecutable: '',
  chromedriverExecutableDir: '',
  basePath: '/',
  autoRestart: false,
};

export interface StateStore {
  load(): { state: PersistedState; warning: string | null };
  save(state: PersistedState): void;
  readonly dir: string;
}

export function createFileStateStore(dir: string): StateStore {
  const file = path.join(dir, 'server-manager.json');
  return {
    dir,
    load() {
      const fresh: PersistedState = { version: STATE_VERSION, settings: { ...DEFAULT_SETTINGS }, owned: [] };
      if (!fs.existsSync(file)) return { state: fresh, warning: null };
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<PersistedState>;
        if (raw.version !== STATE_VERSION) throw new Error(`unsupported state version ${String(raw.version)}`);
        return {
          state: { version: STATE_VERSION, settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) }, owned: Array.isArray(raw.owned) ? raw.owned : [] },
          warning: null,
        };
      } catch (e) {
        // Keep the unreadable file for inspection instead of silently overwriting it.
        const keep = `${file}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(file, keep);
        } catch {
          /* ignore */
        }
        return { state: fresh, warning: `server-manager state was unreadable (${(e as Error).message}); moved to ${keep}` };
      }
    },
    save(state) {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, file);
    },
  };
}

export function createMemoryStateStore(initial?: PersistedState): StateStore & { current: PersistedState } {
  const s = {
    dir: '(memory)',
    current: initial ?? { version: STATE_VERSION, settings: { ...DEFAULT_SETTINGS }, owned: [] },
    load() {
      return { state: structuredClone(s.current), warning: null };
    },
    save(state: PersistedState) {
      s.current = structuredClone(state);
    },
  };
  return s;
}
