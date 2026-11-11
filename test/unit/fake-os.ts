// A simulated operating system for server-manager tests: processes with identities, listening ports,
// kill behaviour and Appium /status answers, so ownership edge cases (PID reuse, crashes, stuck
// processes, foreign servers) can be produced on demand.

import { EventEmitter } from 'node:events';
import type { AppiumHttp, AppiumStatus } from '../../src/appium/appium-client.ts';
import type { KillOptions, ProcessIdentity, ProcessInspector } from '../../src/appium/process-inspector.ts';
import type { ChildLike, SpawnFn } from '../../src/appium/server-manager.ts';

export class FakeOS implements ProcessInspector {
  readonly platform: NodeJS.Platform;
  procs = new Map<number, ProcessIdentity>();
  /** port -> pid listening on it */
  ports = new Map<number, number>();
  /** port -> Appium /status answer (only for ports where an Appium server listens) */
  appium = new Map<number, AppiumStatus>();
  /** pids that ignore a non-forced kill */
  ignoreGraceful = new Set<number>();
  kills: { pid: number; opts: KillOptions }[] = [];
  deletedSessions: string[] = [];
  children = new Map<number, EventEmitter>();
  spawns: { file: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  /** How many upcoming info() calls answer "unknown" even though the process is alive (a blocked or slow lookup). */
  infoFailures = 0;
  /** When true, a spawned child ignores kill() (a process that cannot be ended). */
  childIgnoresKill = false;
  nextPid = 1000;
  tick = 0;
  /** what a freshly spawned Appium does: 'ready' | 'exit-immediately' | 'exit-during-startup' | 'never-ready' */
  spawnBehaviour: 'ready' | 'exit-immediately' | 'exit-during-startup' | 'never-ready' = 'ready';

  constructor(platform: NodeJS.Platform = 'linux') {
    this.platform = platform;
  }

  addProcess(cmd: string, port?: number, appiumVersion?: string): ProcessIdentity {
    const pid = this.nextPid++;
    const id = { pid, startTime: `t${++this.tick}`, commandLine: cmd };
    this.procs.set(pid, id);
    if (port) this.ports.set(port, pid);
    if (port && appiumVersion) this.appium.set(port, { ready: true, version: appiumVersion, message: 'ready' });
    return id;
  }

  /** The process dies (crash or kill). Its ports close and its child handle emits 'exit'. */
  exit(pid: number, code: number | null = 0, signal: NodeJS.Signals | null = null) {
    this.procs.delete(pid);
    for (const [port, p] of [...this.ports]) {
      if (p === pid) {
        this.ports.delete(port);
        this.appium.delete(port);
      }
    }
    this.children.get(pid)?.emit('exit', code, signal);
  }

  /** PID reuse: the old process is gone and an unrelated program now has the same PID. */
  reusePid(pid: number, cmd = 'C:\\Windows\\notepad.exe') {
    this.exit(pid);
    this.procs.set(pid, { pid, startTime: `t${++this.tick}`, commandLine: cmd });
  }

  // ---- ProcessInspector ----
  async info(pid: number) {
    if (this.infoFailures > 0 && this.procs.has(pid)) {
      this.infoFailures--;
      return null;
    }
    return this.procs.get(pid) ?? null;
  }
  async listeningPids(port: number) {
    const p = this.ports.get(port);
    return p ? [p] : [];
  }
  async kill(pid: number, opts: KillOptions) {
    this.kills.push({ pid, opts });
    if (!opts.force && this.ignoreGraceful.has(pid)) return;
    if (this.procs.has(pid)) this.exit(pid, null, opts.force ? 'SIGKILL' : 'SIGTERM');
  }
  async isPortFree(_host: string, port: number) {
    return !this.ports.has(port);
  }

  // ---- AppiumHttp ----
  http: AppiumHttp = {
    status: async (_host, port) => this.appium.get(port) ?? null,
    deleteSession: async (_host, _port, id) => {
      this.deletedSessions.push(id);
    },
  };

  // ---- spawn ----
  spawn: SpawnFn = (file, args, _logFd, env) => {
    this.spawns.push({ file, args, env });
    const port = Number(args[args.indexOf('--port') + 1]);
    const pid = this.nextPid++;
    const child = new EventEmitter() as EventEmitter & ChildLike;
    Object.assign(child, {
      pid,
      unref: () => {},
      kill: () => {
        if (this.childIgnoresKill) return false;
        this.exit(pid, null, 'SIGTERM');
        return true;
      },
    });
    this.children.set(pid, child);
    this.procs.set(pid, { pid, startTime: `t${++this.tick}`, commandLine: [file, ...args].join(' ') });
    const b = this.spawnBehaviour;
    if (b === 'exit-immediately') {
      this.procs.delete(pid);
      setImmediate(() => child.emit('exit', 1, null));
    } else {
      this.ports.set(port, pid);
      if (b === 'ready') setTimeout(() => this.procs.has(pid) && this.appium.set(port, { ready: true, version: '3.9.0', message: 'ready' }), 5);
      if (b === 'exit-during-startup') setTimeout(() => this.exit(pid, 1), 5);
    }
    return child;
  };
}
