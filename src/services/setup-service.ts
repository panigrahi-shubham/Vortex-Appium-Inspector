// Setup check and server diagnostics: what a real-phone session needs on this computer, and the Appium log.

import { locateAppium } from '../appium/appium-locator.ts';
import { runPreflight } from '../appium/preflight.ts';
import type { ProcessInspector } from '../appium/process-inspector.ts';
import type { ServerManager } from '../appium/server-manager.ts';
import type { createDeviceManager } from '../devices/device-manager.ts';
import { detectPython } from '../engines/appium/python-env.ts';

export interface SetupDeps {
  root: string;
  manager: ServerManager;
  os: ProcessInspector;
  devices: ReturnType<typeof createDeviceManager>;
  /** True for the simulated device (`--mock`). */
  mock: () => boolean;
}

export class SetupService {
  readonly #d: SetupDeps;
  #python: { at: number; env: Awaited<ReturnType<typeof detectPython>> } | null = null;

  constructor(deps: SetupDeps) {
    this.#d = deps;
  }

  /** Python and its packages, cached for half a minute because detection starts processes. */
  async python() {
    if (!this.#python || Date.now() - this.#python.at > 30_000) this.#python = { at: Date.now(), env: await detectPython() };
    return this.#python.env;
  }

  async portState() {
    const { manager, os } = this.#d;
    const st = await manager.status(), { port, host } = manager.settings;
    if (st.server && st.server.state !== 'exited') return { port: st.server.port, state: st.server.ownership === 'vortex' ? ('owned' as const) : ('external' as const), version: st.server.version };
    if (st.detectedExternal) return { port, state: 'external' as const, version: st.detectedExternal.version };
    if (await os.isPortFree(host, port)) return { port, state: 'free' as const };
    return { port, state: 'busy' as const, pids: await os.listeningPids(port) };
  }

  preflight() {
    const { root, manager, devices, mock } = this.#d;
    return runPreflight({
      projectRoot: root,
      locateAppium: () => locateAppium(manager.settings.appiumPath || process.env.VORTEX_APPIUM_PATH || '', root),
      python: () => this.python(),
      devices: async () => (mock() ? [{ serial: 'mock-device', state: 'device', model: 'TradeHub simulated phone' }] : devices.list()),
      port: () => this.portState(),
    });
  }

  serverLogs(lines: unknown) {
    const n = Number(lines);
    return this.#d.manager.logs(Number.isInteger(n) && n > 0 && n <= 2000 ? n : 200);
  }
}
