// Appium server lifecycle with strict ownership rules.
//
//  - Vortex stops only servers it started itself, and only after re-checking that the PID still belongs to
//    the same process (PID + start time + command line). A responding port never proves ownership.
//  - External servers can be connected to and disconnected from, never stopped.
//  - A server cannot be stopped (or its sessions removed) while a test run depends on it, unless the caller
//    explicitly asks for "cancel run -> clean up sessions -> stop".
//  - If an owned server dies, every run that depends on it is failed immediately instead of hanging.
//  - State is persisted, so a server left running after a recorder crash is recognised (and can be stopped) later.

import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { compatibility, type AppiumHttp, SESSION_ID } from './appium-client.ts';
import type { AppiumInstall } from './appium-locator.ts';
import { tailLog } from './log-file.ts';
import { assertPort, sameProcess, type ProcessIdentity, type ProcessInspector } from './process-inspector.ts';
import { RunRegistry } from './run-registry.ts';
import type { OwnedServerRecord, PersistedState, ServerSettings, StateStore } from './state-store.ts';

export type Ownership = 'vortex' | 'external';
export type ServerState = 'starting' | 'running' | 'unhealthy' | 'stopping' | 'exited' | 'unreachable';

export class ManagerError extends Error {
  code: string;
  httpStatus: number;
  details: Record<string, unknown>;
  constructor(code: string, httpStatus: number, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export interface ChildLike {
  pid?: number;
  on(event: 'exit', fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  unref(): void;
}

export type SpawnFn = (file: string, args: string[], logFd: number) => ChildLike;

export interface StepResult {
  step: string;
  ok: boolean;
  detail: string;
}

export interface ActionReport {
  ok: boolean;
  steps: StepResult[];
}

interface ActiveServer {
  id: string;
  ownership: Ownership;
  host: string;
  port: number;
  pid: number | null;
  /** 'spawned' = Vortex started it; 'recovered' = re-verified from the state file; 'os-lookup' = informational only. */
  pidSource: 'spawned' | 'recovered' | 'os-lookup' | null;
  identity: ProcessIdentity | null;
  state: ServerState;
  version: string | null;
  startedAt: string | null;
  logFile: string | null;
  exit: { code: number | null; signal: string | null; at: string; failedRuns: string[] } | null;
  failedHealthChecks: number;
}

export interface ManagerDeps {
  store: StateStore;
  inspector: ProcessInspector;
  http: AppiumHttp;
  locate: (configuredPath: string) => Promise<AppiumInstall>;
  spawn?: SpawnFn;
  runs?: RunRegistry;
  logDir?: string;
  nodePath?: string;
  pollMs?: number;
  log?: (msg: string) => void;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function assertHost(host: unknown, { loopbackOnly }: { loopbackOnly: boolean }): string {
  const h = String(host ?? '').trim();
  if (loopbackOnly && !LOOPBACK.has(h)) throw new ManagerError('HOST_NOT_ALLOWED', 400, `Vortex only starts servers on this computer (127.0.0.1, localhost or ::1), not "${h}".`);
  if (!(LOOPBACK.has(h) || IPV4.test(h) || HOSTNAME.test(h))) throw new ManagerError('INVALID_HOST', 400, `"${h}" is not a valid host name or IPv4 address.`);
  return h;
}

const defaultSpawn: SpawnFn = (file, args, logFd) =>
  // detached: Appium gets its own process group, so the whole tree can be stopped together and the
  // server can outlive the recorder when "stop on exit" is off (it is adopted again on the next start).
  nodeSpawn(file, args, { stdio: ['ignore', logFd, logFd], detached: true, windowsHide: true });

export class ServerManager {
  readonly runs: RunRegistry;
  #deps: Required<Omit<ManagerDeps, 'runs'>>;
  #state: PersistedState;
  #active: ActiveServer | null = null;
  #sessions = new Map<string, Set<string>>();
  #notices: string[] = [];
  #chain: Promise<unknown> = Promise.resolve();
  #stoppingIds = new Set<string>();
  #watchdog: NodeJS.Timeout | null = null;
  readonly instanceId = randomUUID();

  constructor(deps: ManagerDeps) {
    this.runs = deps.runs ?? new RunRegistry();
    this.#deps = {
      spawn: defaultSpawn,
      logDir: path.join(deps.store.dir, 'logs'),
      nodePath: process.execPath,
      pollMs: 200,
      log: () => {},
      ...deps,
    } as Required<Omit<ManagerDeps, 'runs'>>;
    const { state, warning } = deps.store.load();
    this.#state = state;
    if (warning) this.#notice(warning);
  }

  get settings(): ServerSettings {
    return { ...this.#state.settings };
  }

  #notice(msg: string) {
    this.#deps.log(msg);
    this.#notices.push(`${new Date().toISOString()} ${msg}`);
    if (this.#notices.length > 20) this.#notices.shift();
  }

  #persist() {
    this.#deps.store.save(this.#state);
  }

  /** Mutating operations run one at a time, so start/stop/restart can never interleave. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.#chain.then(fn, fn);
    this.#chain = job.catch(() => {});
    return job;
  }

  // ---- crash recovery ------------------------------------------------------------------------

  /** Re-checks every owned server recorded by an earlier recorder process. Never kills anything. */
  init(): Promise<StepResult[]> {
    return this.#serial(async () => {
      const report: StepResult[] = [];
      const keep: OwnedServerRecord[] = [];
      for (const rec of this.#state.owned) {
        const current = await this.#deps.inspector.info(rec.pid);
        if (!current) {
          report.push({ step: `recover ${rec.host}:${rec.port}`, ok: true, detail: `PID ${rec.pid} is no longer running; stale record removed` });
          continue;
        }
        if (!sameProcess(rec.identity, current)) {
          report.push({ step: `recover ${rec.host}:${rec.port}`, ok: true, detail: `PID ${rec.pid} now belongs to a different process; stale record removed and that process left alone` });
          continue;
        }
        keep.push(rec);
        if (this.#active) {
          report.push({ step: `recover ${rec.host}:${rec.port}`, ok: false, detail: `another owned server is already active; PID ${rec.pid} kept on record so it can be stopped later` });
          continue;
        }
        const st = await this.#deps.http.status(rec.host, rec.port);
        this.#active = {
          id: rec.id,
          ownership: 'vortex',
          host: rec.host,
          port: rec.port,
          pid: rec.pid,
          pidSource: 'recovered',
          identity: rec.identity,
          state: st?.ready ? 'running' : 'unhealthy',
          version: st?.version ?? rec.appiumVersion,
          startedAt: rec.startedAt,
          logFile: rec.logFile,
          exit: null,
          failedHealthChecks: 0,
        };
        report.push({
          step: `recover ${rec.host}:${rec.port}`,
          ok: true,
          detail: st?.ready ? `Vortex-owned server (PID ${rec.pid}) is still running and was adopted` : `Vortex-owned process (PID ${rec.pid}) is alive but not answering; you can Stop or Restart it`,
        });
      }
      if (keep.length !== this.#state.owned.length) {
        this.#state.owned = keep;
        this.#persist();
      }
      report.forEach((r) => this.#notice(r.detail));
      return report;
    });
  }

  // ---- status --------------------------------------------------------------------------------

  async status() {
    const s = this.settings;
    let detected: { host: string; port: number; version: string | null } | null = null;
    if (this.#active) await this.checkHealth({ minIntervalMs: 2_000 });
    else {
      const st = await this.#deps.http.status(s.host, s.port, 1_500);
      if (st) detected = { host: s.host, port: s.port, version: st.version };
    }
    const a = this.#active;
    return {
      connected: !!a,
      server: a && {
        id: a.id,
        ownership: a.ownership,
        state: a.state,
        host: a.host,
        port: a.port,
        pid: a.pid,
        pidSource: a.pidSource,
        version: a.version,
        compatible: compatibility(a.version),
        startedAt: a.startedAt,
        recovered: a.pidSource === 'recovered',
        exit: a.exit,
        canStop: a.ownership === 'vortex' && !['exited', 'stopping'].includes(a.state),
      },
      detectedExternal: detected,
      sessions: a ? [...(this.#sessions.get(a.id) ?? [])] : [],
      sessionListNote: 'Only sessions created by Vortex are listed. Appium hides other sessions unless its insecure "session_discovery" feature is enabled.',
      runs: this.runs.all(),
      ownedRecords: this.#state.owned.map((r) => ({ host: r.host, port: r.port, pid: r.pid, startedAt: r.startedAt })),
      settings: s,
      notices: [...this.#notices],
    };
  }

  #lastHealthAt = 0;

  /** Health check (also run by the watchdog). Fails dependent runs when the server is gone. */
  async checkHealth(opts: { minIntervalMs?: number } = {}): Promise<void> {
    const a = this.#active;
    if (!a || a.state === 'exited' || a.state === 'stopping' || a.state === 'starting') return;
    // UI polling and the watchdog both call this; one check every couple of seconds is enough
    // (every /status call also shows up as a line in the Appium log).
    if (opts.minIntervalMs && Date.now() - this.#lastHealthAt < opts.minIntervalMs) return;
    this.#lastHealthAt = Date.now();
    if (a.ownership === 'vortex' && a.identity) {
      const cur = await this.#deps.inspector.info(a.identity.pid);
      if (!sameProcess(a.identity, cur)) {
        if (this.#active === a && !this.#stoppingIds.has(a.id)) this.#markExited(a, null, null, 'the Vortex-owned Appium process is no longer running');
        return;
      }
    }
    const st = await this.#deps.http.status(a.host, a.port);
    if (st?.ready) {
      a.state = 'running';
      a.version = st.version ?? a.version;
      a.failedHealthChecks = 0;
      return;
    }
    a.failedHealthChecks++;
    if (a.ownership === 'external') {
      a.state = 'unreachable';
      if (a.failedHealthChecks >= 2) {
        const failed = this.runs.failFor(a.id, `external Appium server ${a.host}:${a.port} stopped answering`);
        if (failed.length) this.#notice(`external server ${a.host}:${a.port} stopped answering; failed runs: ${failed.join(', ')}`);
      }
    } else a.state = 'unhealthy';
  }

  startWatchdog(intervalMs = 5_000) {
    this.stopWatchdog();
    this.#watchdog = setInterval(() => void this.checkHealth({ minIntervalMs: 2_000 }).catch(() => {}), intervalMs);
    this.#watchdog.unref();
  }

  stopWatchdog() {
    if (this.#watchdog) clearInterval(this.#watchdog);
    this.#watchdog = null;
  }

  logs(maxLines = 200): { file: string | null; lines: string[] } {
    const file = this.#active?.logFile ?? null;
    return { file, lines: file ? tailLog(file, maxLines) : [] };
  }

  // ---- start ---------------------------------------------------------------------------------

  start(opts: { host?: string; port?: number } = {}) {
    return this.#serial(() => this.#start(opts));
  }

  async #start(opts: { host?: string; port?: number }) {
    const s = this.settings;
    const host = assertHost(opts.host ?? s.host, { loopbackOnly: true });
    const port = assertPort(opts.port ?? s.port);
    const a = this.#active;
    if (a && a.state !== 'exited') {
      if (a.ownership === 'external') throw new ManagerError('EXTERNAL_CONNECTED', 409, `Connected to an external server on ${a.host}:${a.port}. Disconnect first.`);
      if (a.state === 'running' && a.host === host && a.port === port) return { reused: true, status: await this.status() };
      throw new ManagerError('OWNED_SERVER_ACTIVE', 409, `Vortex already runs a server on ${a.host}:${a.port} (${a.state}). Use Restart or Stop.`);
    }
    const existing = await this.#deps.http.status(host, port);
    if (existing) {
      throw new ManagerError('PORT_HAS_EXTERNAL_APPIUM', 409, `An Appium server${existing.version ? ` ${existing.version}` : ''} is already running on ${host}:${port}, and Vortex did not start it. Use Connect Existing to work with it.`, { host, port });
    }
    if (!(await this.#deps.inspector.isPortFree(host, port))) {
      const pids = await this.#deps.inspector.listeningPids(port);
      throw new ManagerError('PORT_IN_USE', 409, `Port ${port} is used by another program${pids?.length ? ` (PID ${pids.join(', ')})` : ''}. Choose another port in Server settings.`, { port, pids });
    }

    const install = await this.#deps.locate(s.appiumPath).catch((e: Error) => {
      throw new ManagerError('APPIUM_NOT_FOUND', 400, e.message);
    });
    const id = randomUUID();
    fs.mkdirSync(this.#deps.logDir, { recursive: true });
    const logFile = path.join(this.#deps.logDir, `appium-${new Date().toISOString().replace(/[:.]/g, '-')}-${port}.log`);
    const fd = fs.openSync(logFile, 'a');
    const args = [install.entry, '--address', host, '--port', String(port), '--log-no-colors', '--log-timestamp'];
    let child: ChildLike;
    let spawnError: Error | null = null;
    let exited: { code: number | null; signal: string | null } | null = null;
    try {
      child = this.#deps.spawn(this.#deps.nodePath, args, fd);
    } finally {
      fs.closeSync(fd); // the child keeps its own copy of the descriptor
    }
    child.on('error', (e) => (spawnError = e));
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      this.#onOwnedExit(id, code, signal);
    });
    if (!child.pid) {
      await sleep(50);
      throw new ManagerError('SPAWN_FAILED', 500, `Could not start Appium: ${(spawnError as Error | null)?.message ?? 'no process id'}`);
    }
    if (this.settings.stopOwnedOnExit === false) child.unref();

    // Record the identity immediately, so even a crash during startup leaves a verifiable record.
    let identity: ProcessIdentity | null = null;
    for (let i = 0; i < 25 && !identity && !exited; i++) {
      identity = await this.#deps.inspector.info(child.pid);
      if (!identity) await sleep(this.#deps.pollMs);
    }
    if (!identity) {
      throw new ManagerError('STARTUP_FAILED', 500, `Appium exited immediately${exited ? ` (exit code ${(exited as { code: number | null }).code})` : ''}.`, { log: tailLog(logFile, 40) });
    }
    const rec: OwnedServerRecord = { id, host, port, pid: child.pid, identity, appiumEntry: install.entry, appiumVersion: install.version, logFile, startedAt: new Date().toISOString(), startedBy: this.instanceId };
    this.#state.owned.push(rec);
    this.#persist();
    this.#active = { id, ownership: 'vortex', host, port, pid: child.pid, pidSource: 'spawned', identity, state: 'starting', version: install.version, startedAt: rec.startedAt, logFile, exit: null, failedHealthChecks: 0 };

    const deadline = Date.now() + this.settings.serverStartupTimeoutMs;
    for (;;) {
      if (exited) {
        throw new ManagerError('STARTUP_FAILED', 500, `Appium exited during startup (exit code ${(exited as { code: number | null }).code}). See the log below.`, { log: tailLog(logFile, 40) });
      }
      const st = await this.#deps.http.status(host, port, 1_000);
      if (st?.ready) {
        this.#active.state = 'running';
        this.#active.version = st.version ?? install.version;
        this.#notice(`started Appium ${this.#active.version} on ${host}:${port} (PID ${child.pid}, ${install.source} install)`);
        return { reused: false, status: await this.status() };
      }
      if (Date.now() > deadline) {
        const stopReport = await this.#stopOwned(this.#active, { reason: 'startup timeout' });
        throw new ManagerError('STARTUP_TIMEOUT', 504, `Appium did not become ready within ${this.settings.serverStartupTimeoutMs / 1000} s and was stopped.`, { log: tailLog(logFile, 40), stop: stopReport });
      }
      await sleep(Math.max(this.#deps.pollMs, 250));
    }
  }

  #onOwnedExit(id: string, code: number | null, signal: NodeJS.Signals | null) {
    if (this.#stoppingIds.has(id)) return; // an intentional stop handles its own bookkeeping
    const a = this.#active;
    this.#state.owned = this.#state.owned.filter((r) => r.id !== id);
    this.#persist();
    if (a && a.id === id) this.#markExited(a, code, signal, `Vortex-owned Appium server exited unexpectedly (code ${code}, signal ${signal ?? 'none'})`);
  }

  #markExited(a: ActiveServer, code: number | null, signal: string | null, reason: string) {
    const failedRuns = this.runs.failFor(a.id, reason);
    a.state = 'exited';
    a.exit = { code, signal, at: new Date().toISOString(), failedRuns };
    this.#state.owned = this.#state.owned.filter((r) => r.id !== a.id);
    this.#persist();
    this.#sessions.delete(a.id);
    this.#notice(`${reason}${failedRuns.length ? `; failed runs: ${failedRuns.join(', ')}` : ''}`);
  }

  // ---- connect / disconnect --------------------------------------------------------------------

  connectExisting(opts: { host?: string; port?: number }) {
    return this.#serial(async () => {
      const host = assertHost(opts.host ?? '127.0.0.1', { loopbackOnly: false });
      const port = assertPort(opts.port ?? 4723);
      if (this.#active && this.#active.state !== 'exited') {
        throw new ManagerError('ALREADY_CONNECTED', 409, `Already connected to ${this.#active.host}:${this.#active.port}. Disconnect (or stop the Vortex server) first.`);
      }
      const st = await this.#deps.http.status(host, port);
      if (!st) throw new ManagerError('NOT_APPIUM', 502, `No Appium server answered at http://${host}:${port}/status.`);
      // A server Vortex started earlier is still Vortex-owned, but only if its process identity checks out.
      for (const rec of this.#state.owned) {
        if (rec.port !== port || !(LOOPBACK.has(host) && LOOPBACK.has(rec.host))) continue;
        if (sameProcess(rec.identity, await this.#deps.inspector.info(rec.pid))) {
          this.#active = { id: rec.id, ownership: 'vortex', host: rec.host, port, pid: rec.pid, pidSource: 'recovered', identity: rec.identity, state: st.ready ? 'running' : 'unhealthy', version: st.version, startedAt: rec.startedAt, logFile: rec.logFile, exit: null, failedHealthChecks: 0 };
          return { ownership: 'vortex' as Ownership, status: await this.status() };
        }
      }
      const pids = LOOPBACK.has(host) ? await this.#deps.inspector.listeningPids(port) : null;
      this.#active = { id: randomUUID(), ownership: 'external', host, port, pid: pids?.length === 1 ? pids[0] : null, pidSource: pids?.length === 1 ? 'os-lookup' : null, identity: null, state: st.ready ? 'running' : 'unhealthy', version: st.version, startedAt: null, logFile: null, exit: null, failedHealthChecks: 0 };
      this.#notice(`connected to external Appium ${st.version ?? ''} on ${host}:${port}`);
      return { ownership: 'external' as Ownership, status: await this.status() };
    });
  }

  disconnect() {
    return this.#serial(async () => {
      const a = this.#active;
      if (!a) throw new ManagerError('NOT_CONNECTED', 409, 'No server is connected.');
      if (a.ownership === 'vortex' && a.state !== 'exited') {
        throw new ManagerError('OWNED_USE_STOP', 409, 'Vortex started this server. Use Stop Owned Server (or keep it running).');
      }
      const runs = this.runs.activeFor(a.id);
      if (runs.length) throw new ManagerError('RUN_ACTIVE', 409, 'A test run is using this server. Cancel it first.', { runs });
      this.#active = null;
      this.#sessions.delete(a.id);
      return { ok: true };
    });
  }

  // ---- sessions --------------------------------------------------------------------------------

  /** Called by the Appium adapter (Milestone 2) for every session it creates. */
  trackSession(sessionId: string) {
    const a = this.#active;
    if (!a) throw new ManagerError('NOT_CONNECTED', 409, 'No server is connected.');
    if (!SESSION_ID.test(sessionId)) throw new ManagerError('INVALID_SESSION', 400, 'invalid session id');
    if (!this.#sessions.has(a.id)) this.#sessions.set(a.id, new Set());
    this.#sessions.get(a.id)!.add(sessionId);
  }

  untrackSession(sessionId: string) {
    for (const set of this.#sessions.values()) set.delete(sessionId);
  }

  /** The connected server, if it is usable for new sessions. */
  endpoint(): { serverId: string; url: string; ownership: Ownership } | null {
    const a = this.#active;
    if (!a || a.state !== 'running') return null;
    const host = a.host.includes(':') ? `[${a.host}]` : a.host;
    return { serverId: a.id, url: `http://${host}:${a.port}`, ownership: a.ownership };
  }

  /** Deletes specific Vortex sessions (for example the ones a finished test run left behind). 404 counts as already closed. */
  endSessions(ids: string[]): Promise<StepResult[]> {
    return this.#serial(async () => {
      const a = this.#active;
      const out: StepResult[] = [];
      for (const sid of ids) {
        if (!SESSION_ID.test(sid)) continue;
        if (!a || a.state === 'exited') {
          out.push({ step: `delete session ${sid}`, ok: true, detail: 'server is gone, so the session is gone too' });
          this.untrackSession(sid);
          continue;
        }
        try {
          await this.#deps.http.deleteSession(a.host, a.port, sid);
          out.push({ step: `delete session ${sid}`, ok: true, detail: 'closed (or was already closed)' });
          this.untrackSession(sid);
        } catch (e) {
          out.push({ step: `delete session ${sid}`, ok: false, detail: (e as Error).message });
        }
      }
      return out;
    });
  }

  cleanupSessions(opts: { cancelActiveRuns?: boolean } = {}) {
    return this.#serial(async () => {
      const a = this.#active;
      if (!a) throw new ManagerError('NOT_CONNECTED', 409, 'No server is connected.');
      const steps: StepResult[] = [];
      const runs = this.runs.activeFor(a.id);
      if (runs.length && !opts.cancelActiveRuns) throw new ManagerError('RUN_ACTIVE', 409, 'A test run is using these sessions. Cancel the run first.', { runs, next: ['cancel-runs', 'cleanup-sessions'] });
      if (runs.length) steps.push(...(await this.#cancelRuns(a)));
      steps.push(...(await this.#deleteSessions(a)));
      return { ok: steps.every((x) => x.ok), steps };
    });
  }

  async #cancelRuns(a: ActiveServer): Promise<StepResult[]> {
    const res = await this.runs.cancelFor(a.id, 15_000);
    return res.map((r) => ({ step: `cancel run ${r.id}`, ok: r.ok, detail: r.detail }));
  }

  async #deleteSessions(a: ActiveServer): Promise<StepResult[]> {
    const ids = [...(this.#sessions.get(a.id) ?? [])];
    if (!ids.length) return [{ step: 'clean up Vortex sessions', ok: true, detail: 'no Vortex sessions open' }];
    const out: StepResult[] = [];
    for (const sid of ids) {
      try {
        await this.#deps.http.deleteSession(a.host, a.port, sid);
        this.#sessions.get(a.id)?.delete(sid);
        out.push({ step: `delete session ${sid}`, ok: true, detail: 'deleted' });
      } catch (e) {
        out.push({ step: `delete session ${sid}`, ok: false, detail: (e as Error).message });
      }
    }
    return out;
  }

  // ---- stop / restart ----------------------------------------------------------------------

  stop(opts: { cancelActiveRuns?: boolean } = {}) {
    return this.#serial(() => this.#stopActive(opts));
  }

  async #stopActive(opts: { cancelActiveRuns?: boolean }): Promise<ActionReport> {
    const a = this.#active;
    if (!a) throw new ManagerError('NOT_CONNECTED', 409, 'No server is connected.');
    if (a.ownership === 'external') {
      throw new ManagerError('EXTERNAL_SERVER', 403, `Vortex did not start the server on ${a.host}:${a.port}, so it will not stop it. Use Disconnect, or stop it in the tool that started it.`);
    }
    if (a.state === 'exited') {
      this.#active = null;
      return { ok: true, steps: [{ step: 'stop', ok: true, detail: 'the server had already exited' }] };
    }
    const runs = this.runs.activeFor(a.id);
    if (runs.length && !opts.cancelActiveRuns) {
      throw new ManagerError('RUN_ACTIVE', 409, `${runs.length} test run(s) are using this server. Cancel Run -> Clean up Session -> Stop Server is required.`, { runs, next: ['cancel-runs', 'cleanup-sessions', 'stop-server'] });
    }
    const steps: StepResult[] = [];
    if (runs.length) steps.push(...(await this.#cancelRuns(a)));
    if (steps.some((s) => !s.ok)) {
      steps.push({ step: 'stop server', ok: false, detail: 'not stopped because a run could not be cancelled' });
      return { ok: false, steps };
    }
    steps.push(...(await this.#deleteSessions(a)));
    const r = await this.#stopOwned(a, { reason: 'requested' });
    return { ok: steps.every((x) => x.ok) && r.ok, steps: [...steps, ...r.steps] };
  }

  async #stopOwned(a: ActiveServer, { reason }: { reason: string }): Promise<ActionReport> {
    const steps: StepResult[] = [];
    const rec = this.#state.owned.find((r) => r.id === a.id);
    const identity = a.identity ?? rec?.identity ?? null;
    if (!identity) {
      steps.push({ step: 'verify ownership', ok: false, detail: 'no recorded process identity; nothing was killed' });
      return { ok: false, steps };
    }
    this.#stoppingIds.add(a.id);
    a.state = 'stopping';
    try {
      const cur = await this.#deps.inspector.info(identity.pid);
      if (!cur) {
        steps.push({ step: 'verify ownership', ok: true, detail: `PID ${identity.pid} had already exited` });
      } else if (!sameProcess(identity, cur)) {
        steps.push({ step: 'verify ownership', ok: false, detail: `PID ${identity.pid} now belongs to a different process; it was NOT stopped` });
        this.#forget(a);
        return { ok: false, steps };
      } else {
        steps.push({ step: 'verify ownership', ok: true, detail: `PID ${identity.pid} is the Appium process Vortex started (start time and command line match)` });
        const graceful = this.#deps.inspector.platform !== 'win32';
        await this.#deps.inspector.kill(identity.pid, { force: false, tree: true });
        let gone = await this.#waitGone(identity, this.settings.stopGraceMs);
        steps.push({
          step: graceful ? 'graceful stop (SIGTERM)' : 'stop (taskkill /T /F)',
          ok: gone,
          detail: gone ? 'process exited' : `still running after ${this.settings.stopGraceMs} ms`,
        });
        if (!gone) {
          await this.#deps.inspector.kill(identity.pid, { force: true, tree: true });
          gone = await this.#waitGone(identity, 5_000);
          steps.push({ step: 'forced stop', ok: gone, detail: gone ? 'process exited' : 'process is still running; stop it manually' });
          if (!gone) {
            a.state = 'unhealthy';
            return { ok: false, steps };
          }
        }
      }
      steps.push(await this.#confirmPortReleased(a.host, a.port, identity.pid));
      const failed = this.runs.failFor(a.id, `Appium server stopped (${reason})`);
      if (failed.length) steps.push({ step: 'fail dependent runs', ok: true, detail: failed.join(', ') });
      this.#forget(a);
      this.#notice(`stopped Vortex-owned Appium on ${a.host}:${a.port} (${reason})`);
      return { ok: steps.every((s) => s.ok), steps };
    } finally {
      this.#stoppingIds.delete(a.id);
    }
  }

  #forget(a: ActiveServer) {
    this.#state.owned = this.#state.owned.filter((r) => r.id !== a.id);
    this.#persist();
    this.#sessions.delete(a.id);
    if (this.#active === a) this.#active = null;
  }

  async #waitGone(identity: ProcessIdentity, ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    for (;;) {
      if (!sameProcess(identity, await this.#deps.inspector.info(identity.pid))) return true;
      if (Date.now() > end) return false;
      await sleep(this.#deps.pollMs);
    }
  }

  async #confirmPortReleased(host: string, port: number, pid: number): Promise<StepResult> {
    const end = Date.now() + 3_000;
    for (;;) {
      if (await this.#deps.inspector.isPortFree(host, port)) return { step: 'confirm port released', ok: true, detail: `${host}:${port} is free` };
      if (Date.now() > end) break;
      await sleep(this.#deps.pollMs);
    }
    const pids = await this.#deps.inspector.listeningPids(port);
    if (pids?.includes(pid)) return { step: 'confirm port released', ok: false, detail: `port ${port} is still held by the stopped PID ${pid}` };
    return {
      step: 'confirm port released',
      ok: true,
      detail: `the Vortex process no longer holds port ${port}; it is now used by ${pids?.length ? `PID ${pids.join(', ')} (not Vortex)` : 'another program'}`,
    };
  }

  restart(opts: { cancelActiveRuns?: boolean } = {}) {
    return this.#serial(async () => {
      const a = this.#active;
      if (!a) throw new ManagerError('NOT_CONNECTED', 409, 'No server is connected.');
      if (a.ownership !== 'vortex') throw new ManagerError('EXTERNAL_SERVER', 403, 'Only a server Vortex started can be restarted by Vortex.');
      const { host, port } = a;
      const stopped = await this.#stopActive(opts);
      if (!stopped.ok) return { ok: false, stop: stopped, start: null };
      const started = await this.#start({ host, port });
      return { ok: true, stop: stopped, start: started };
    });
  }

  // ---- settings and shutdown -------------------------------------------------------------------

  updateSettings(patch: Partial<ServerSettings>) {
    return this.#serial(async () => {
      const s = { ...this.#state.settings };
      const num = (k: keyof ServerSettings, min: number, max: number) => {
        if (patch[k] === undefined) return;
        const v = Number(patch[k]);
        if (!Number.isInteger(v) || v < min || v > max) throw new ManagerError('INVALID_SETTING', 400, `${k} must be a whole number from ${min} to ${max}`);
        (s as Record<string, unknown>)[k] = v;
      };
      const bool = (k: keyof ServerSettings) => {
        if (patch[k] === undefined) return;
        if (typeof patch[k] !== 'boolean') throw new ManagerError('INVALID_SETTING', 400, `${k} must be true or false`);
        (s as Record<string, unknown>)[k] = patch[k];
      };
      if (patch.host !== undefined) s.host = assertHost(patch.host, { loopbackOnly: true });
      num('port', 1024, 65535);
      num('serverStartupTimeoutMs', 5_000, 600_000);
      num('sessionStartupTimeoutMs', 10_000, 900_000);
      num('sessionIdleTimeoutSec', 30, 86_400);
      num('stopGraceMs', 1_000, 60_000);
      bool('keepWarm');
      bool('stopOwnedOnExit');
      if (patch.appiumPath !== undefined) {
        const p = String(patch.appiumPath).trim();
        if (p && !path.isAbsolute(p)) throw new ManagerError('INVALID_SETTING', 400, 'Appium path must be an absolute path');
        s.appiumPath = p;
      }
      for (const k of ['chromedriverExecutable', 'chromedriverExecutableDir'] as const) {
        if (patch[k] === undefined) continue;
        const p = String(patch[k]).trim();
        if (p && !path.isAbsolute(p)) throw new ManagerError('INVALID_SETTING', 400, `${k} must be an absolute path`);
        s[k] = p;
      }
      this.#state.settings = s;
      this.#persist();
      return this.settings;
    });
  }

  /** Called when the recorder exits. Stops the owned server only if configured to. */
  shutdown(): Promise<ActionReport | null> {
    return this.#serial(async () => {
      this.stopWatchdog();
      const a = this.#active;
      if (!a || a.ownership !== 'vortex' || a.state === 'exited') return null;
      if (!this.settings.stopOwnedOnExit) {
        this.#notice(`leaving Vortex-owned Appium running on ${a.host}:${a.port} (PID ${a.pid}); it will be adopted on the next start`);
        return null;
      }
      return this.#stopActive({ cancelActiveRuns: true });
    });
  }
}
