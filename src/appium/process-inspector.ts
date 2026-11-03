// Reads process identity (start time + command line) and port ownership from the operating system.
//
// Ownership rule: a PID alone proves nothing (PIDs are reused) and a responding port proves nothing
// (anyone can listen on 4723). A process is "the one Vortex started" only when its PID, start time
// AND command line all match what was recorded at spawn time.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

export interface ProcessIdentity {
  pid: number;
  /** Opaque, platform-specific start marker. Compared for equality only. */
  startTime: string;
  commandLine: string;
}

export interface KillOptions {
  force: boolean;
  /** Also stop child processes (Appium spawns chromedriver and similar helpers). */
  tree: boolean;
}

export interface ProcessInspector {
  readonly platform: NodeJS.Platform;
  /** Identity of a running process, or null when no such process exists. */
  info(pid: number): Promise<ProcessIdentity | null>;
  /** PIDs listening on a TCP port, or null when the OS tool needed to find out is unavailable. */
  listeningPids(port: number): Promise<number[] | null>;
  kill(pid: number, opts: KillOptions): Promise<void>;
  /** True when nothing is listening on host:port (checked by trying to bind it). */
  isPortFree(host: string, port: number): Promise<boolean>;
}

export function assertPid(pid: unknown): number {
  if (!Number.isInteger(pid) || (pid as number) <= 0 || (pid as number) > 4_194_304) throw new Error(`invalid pid: ${String(pid)}`);
  return pid as number;
}

export function assertPort(port: unknown): number {
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) throw new Error(`invalid port: ${String(port)}`);
  return port as number;
}

/** Same process as recorded? PID, start time and command line must all match. */
export function sameProcess(recorded: ProcessIdentity, current: ProcessIdentity | null): boolean {
  return !!current && current.pid === recorded.pid && current.startTime === recorded.startTime && current.commandLine === recorded.commandLine;
}

type Exec = (file: string, args: string[], opts?: { timeoutMs?: number }) => Promise<string>;

const defaultExec: Exec = (file, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: opts.timeoutMs ?? 15_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(`${file} failed: ${(stderr || err.message).trim()}`), { code: (err as NodeJS.ErrnoException).code }));
      else resolve(stdout);
    });
  });

export function isPortFree(host: string, port: number): Promise<boolean> {
  assertPort(port);
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ host, port, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

// ---- Linux -------------------------------------------------------------------------------

/** Parses /proc/<pid>/stat. Field 22 (starttime, clock ticks since boot) never changes for a process. */
export function parseProcStat(stat: string): { state: string; startTicks: string } | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const rest = stat.slice(close + 2).split(' '); // rest[0] is field 3 (state)
  const startTicks = rest[19];
  if (!rest[0] || !startTicks) return null;
  return { state: rest[0], startTicks };
}

function linuxInspector(exec: Exec): ProcessInspector {
  return {
    platform: 'linux',
    async info(pid) {
      assertPid(pid);
      let stat: string;
      let cmd: string;
      try {
        stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      } catch {
        return null;
      }
      const s = parseProcStat(stat);
      if (!s || s.state === 'Z') return null; // a zombie has already exited
      return { pid, startTime: `ticks:${s.startTicks}`, commandLine: cmd.split('\0').filter(Boolean).join(' ') };
    },
    async listeningPids(port) {
      assertPort(port);
      try {
        const out = await exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
        return parsePidLines(out);
      } catch (e) {
        // lsof exits 1 when nothing matches; ENOENT means the tool is missing.
        return (e as { code?: unknown }).code === 'ENOENT' ? null : [];
      }
    },
    kill: (pid, opts) => posixKill(pid, opts),
    isPortFree,
  };
}

// ---- macOS -------------------------------------------------------------------------------

function darwinInspector(exec: Exec): ProcessInspector {
  return {
    platform: 'darwin',
    async info(pid) {
      assertPid(pid);
      try {
        const out = await exec('ps', ['-o', 'lstart=', '-o', 'command=', '-p', String(pid)]);
        const line = out.trim();
        if (!line) return null;
        return { pid, startTime: `lstart:${line.slice(0, 24).trim()}`, commandLine: line.slice(24).trim() };
      } catch {
        return null;
      }
    },
    async listeningPids(port) {
      assertPort(port);
      try {
        return parsePidLines(await exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']));
      } catch (e) {
        return (e as { code?: unknown }).code === 'ENOENT' ? null : [];
      }
    },
    kill: (pid, opts) => posixKill(pid, opts),
    isPortFree,
  };
}

async function posixKill(pid: number, { force, tree }: KillOptions): Promise<void> {
  assertPid(pid);
  const sig = force ? 'SIGKILL' : 'SIGTERM';
  if (tree) {
    try {
      process.kill(-pid, sig); // the process group created by spawn({ detached: true })
      return;
    } catch {
      // not a group leader: fall back to the single process
    }
  }
  try {
    process.kill(pid, sig);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
  }
}

// ---- Windows -----------------------------------------------------------------------------

const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

/** Parses the JSON printed by the Win32_Process query below. */
export function parseWindowsProcessJson(out: string, pid: number): ProcessIdentity | null {
  const s = out.trim();
  if (!s) return null;
  const o = JSON.parse(s) as { pid?: number; start?: string; cmd?: string | null };
  if (o.pid !== pid || !o.start) return null;
  return { pid, startTime: `utc:${o.start}`, commandLine: (o.cmd ?? '').trim() };
}

function windowsInspector(exec: Exec): ProcessInspector {
  return {
    platform: 'win32',
    async info(pid) {
      assertPid(pid); // pid is a validated integer, so building the script string is safe
      const script =
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
        `if ($p) { [pscustomobject]@{ pid = [int]$p.ProcessId; start = $p.CreationDate.ToUniversalTime().ToString('o'); cmd = $p.CommandLine } | ConvertTo-Json -Compress }`;
      try {
        return parseWindowsProcessJson(await exec('powershell.exe', [...PS, script]), pid);
      } catch {
        return null;
      }
    },
    async listeningPids(port) {
      assertPort(port);
      const script = `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`;
      try {
        return parsePidLines(await exec('powershell.exe', [...PS, script]));
      } catch {
        return null;
      }
    },
    async kill(pid, { force, tree }) {
      assertPid(pid);
      // Windows has no SIGTERM for console programs: taskkill without /F cannot stop them.
      // Callers clean up sessions first; termination itself is always forced here.
      void force;
      const args = ['/PID', String(pid), ...(tree ? ['/T'] : []), '/F'];
      try {
        await exec('taskkill', args);
      } catch (e) {
        if (!/not found|no running instance/i.test((e as Error).message)) throw e;
      }
    },
    isPortFree,
  };
}

export function parsePidLines(out: string): number[] {
  return [...new Set(out.split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0))];
}

export function createProcessInspector(platform: NodeJS.Platform = process.platform, exec: Exec = defaultExec): ProcessInspector {
  if (platform === 'win32') return windowsInspector(exec);
  if (platform === 'darwin') return darwinInspector(exec);
  return linuxInspector(exec);
}
