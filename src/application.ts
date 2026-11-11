// The recorder as one object: it wires the services together and serialises everything that touches the phone.
//
//   SessionService   which phone and app are attached, and the current screen capture
//   LocatorService   ranking, verification and search of locators on that screen
//   ActionRunner     performs an action on the phone and records it as a step
//   RecordingStore   the steps being recorded, with autosave
//   ProjectService   generate, save, load, replay, shared pages, repair
//   SetupService     setup check, Python detection, Appium log
//
// Routes (src/server.ts) and tests talk to this class; the services do the work.

import path from 'node:path';
import { createAppiumHttp } from './appium/appium-client.ts';
import { locateAppium } from './appium/appium-locator.ts';
import { createProcessInspector } from './appium/process-inspector.ts';
import { ServerManager } from './appium/server-manager.ts';
import { createFileStateStore } from './appium/state-store.ts';
import { DeviceLeases } from './devices/device-lease.ts';
import { createDeviceManager } from './devices/device-manager.ts';
import { AppiumInspector } from './engines/appium/inspector.ts';
import { PytestRunner } from './engines/appium/pytest-runner.ts';
import { listProject } from './project/project.ts';
import { ActionRunner } from './services/action-runner.ts';
import { LocatorHistory } from './services/locator-history.ts';
import { LocatorService } from './services/locator-service.ts';
import { ProjectService } from './services/project-service.ts';
import { RecordingStore } from './services/recording-store.ts';
import { SessionService } from './services/session-service.ts';
import { SetupService } from './services/setup-service.ts';

export { assertPackage, problem, VERSION } from './services/problem.ts';
import { VERSION } from './services/problem.ts';

export class Application {
  readonly root: string;
  readonly outDir: string;
  readonly manager: ServerManager;
  readonly inspector: AppiumInspector;
  readonly leases = new DeviceLeases();
  readonly devices = createDeviceManager();
  readonly runner: PytestRunner;
  readonly recording: RecordingStore;
  readonly session: SessionService;
  readonly locators: LocatorService;
  readonly actions: ActionRunner;
  readonly project: ProjectService;
  readonly setup: SetupService;
  /** True for the simulated device (`--mock`): checks that need a real phone report that instead. */
  mock = false;
  #chain: Promise<unknown> = Promise.resolve();
  #listeners = new Set<() => void>();

  constructor(root: string, outDir = path.join(root, 'generated'), stateDir = path.join(root, '.vortex')) {
    this.root = root;
    this.outDir = path.resolve(outDir);
    const os = createProcessInspector();
    this.manager = new ServerManager({
      store: createFileStateStore(stateDir),
      inspector: os,
      http: createAppiumHttp(fetch, () => this.manager.settings.basePath),
      locate: (configured) => locateAppium(configured || process.env.VORTEX_APPIUM_PATH || '', root),
      log: (m) => {
        console.log('[appium]', m);
        this.changed(); // every manager notice is a change worth showing
      },
    });
    this.inspector = new AppiumInspector(this.manager, this.leases);
    this.setup = new SetupService({ root, manager: this.manager, os, devices: this.devices, mock: () => this.mock });
    this.runner = new PytestRunner({ manager: this.manager, leases: this.leases, runsDir: path.join(stateDir, 'runs'), python: () => this.setup.python() });
    this.recording = new RecordingStore(stateDir);
    const history = new LocatorHistory(stateDir);
    this.session = new SessionService({ inspector: this.inspector, runner: this.runner, recording: this.recording, onCapture: (ps) => this.locators.captures.add(ps), onTargetChange: () => this.locators.captures.reset() });
    this.locators = new LocatorService({ inspector: this.inspector, session: this.session, history, recording: this.recording });
    this.actions = new ActionRunner({ inspector: this.inspector, session: this.session, locators: this.locators, recording: this.recording });
    this.project = new ProjectService({ outDir: this.outDir, inspector: this.inspector, runner: this.runner, session: this.session, recording: this.recording, history });
  }

  async init() {
    await this.manager.init();
    this.manager.startWatchdog();
    this.recording.restore();
  }

  /** Everything that touches the phone or the recording runs one at a time, in arrival order. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(fn);
    this.#chain = next.catch(() => {});
    return next;
  }

  // ---- change notifications (live status in the browser) ---------------------------------------
  /** Registers a listener that is told when the server, session, recording or a run may have changed. */
  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }
  changed() {
    for (const fn of this.#listeners) {
      try {
        fn();
      } catch {
        /* a listener must never break the operation that notified it */
      }
    }
  }

  // ---- state other code reads directly ---------------------------------------------------------
  get steps() { return this.recording.steps; }
  get pkg() { return this.recording.pkg; }
  set pkg(v: string) { this.recording.pkg = v; }
  get recordingId() { return this.recording.recordingId; }
  get recordedSize() { return this.recording.recordedSize; }
  get restored() { return this.recording.restored; }
  get snapshot() { return this.session.snapshot; }
  set snapshot(v) { this.session.snapshot = v; }
  get serial() { return this.session.serial; }

  async status() {
    return {
      name: 'Vortex Appium Inspector',
      version: VERSION,
      mock: this.mock,
      restored: this.recording.restored,
      server: await this.manager.status(),
      session: this.inspector.status(),
      serial: this.session.serial,
      pkg: this.recording.pkg,
      steps: this.recording.steps,
      screen: this.session.snapshot,
      active: this.runner.active(),
      history: this.runner.history(),
      project: listProject(this.outDir),
    };
  }

  // ---- session and screen -----------------------------------------------------------------------
  start(serial: string, pkg: string) { return this.session.start(serial, pkg); }
  capture(autoWeb = true, preferredContext?: string) { return this.session.capture(autoWeb, preferredContext); }
  requireScreen(token: unknown) { return this.session.requireScreen(token); }

  // ---- locators ---------------------------------------------------------------------------------
  inspect(body: Record<string, unknown>) { return this.locators.inspect(body); }
  verifyOne(body: Record<string, unknown>) { return this.locators.verifyOne(body); }
  search(body: Record<string, unknown>) { return this.locators.search(body); }

  // ---- recording --------------------------------------------------------------------------------
  action(body: Record<string, unknown>) { return this.actions.run(body); }
  persist() { this.recording.persist(); }
  undo() { return this.recording.undo(); }
  clear() { return this.recording.clear(); }
  deleteStep(index: unknown) { return this.recording.deleteStep(index); }
  moveStep(from: unknown, to: unknown) { return this.recording.moveStep(from, to); }
  editStep(index: unknown, value: unknown) { return this.recording.editStep(index, value); }

  // ---- saved tests --------------------------------------------------------------------------------
  build(body: Record<string, unknown>) { return this.project.build(body); }
  save(body: Record<string, unknown>) { return this.project.save(body); }
  load(body: { module: unknown; case: unknown }) { return this.project.load(body); }
  run(body: { module: unknown; case: unknown }) { return this.project.run(body); }
  screenPage(body: Record<string, unknown>) { return this.project.screenPage(body); }
  repairSuggest(body: Record<string, unknown>) { return this.project.repairSuggest(body); }
  repairApply(body: Record<string, unknown>) { return this.project.repairApply(body); }

  // ---- setup ------------------------------------------------------------------------------------
  python() { return this.setup.python(); }
  portState() { return this.setup.portState(); }
  preflight() { return this.setup.preflight(); }
  serverLogs(lines: unknown) { return this.setup.serverLogs(lines); }

  async shutdown() {
    for (const run of this.runner.active()) {
      this.runner.cancel(run.id);
      await this.runner.wait(run.id);
    }
    await this.inspector.stop();
    await this.manager.shutdown();
  }
}
