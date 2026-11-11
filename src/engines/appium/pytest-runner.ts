// Runs saved Appium Python tests with pytest.
//
//  - Only saved files inside the tests folder can run (never unsaved preview code).
//  - The device is leased for the run; the Appium server is protected by the run registry.
//  - Live output, cancel, timeout. Success only when pytest exited 0 AND JUnit reports at least one test
//    and no failures or errors ("the process started" is never success).
//  - Import/collection errors, zero tests collected and automation failures are reported separately.
//  - Sessions the run opened are closed afterwards, even after a cancel or crash.
//  - Every run gets its own report folder; history is never overwritten.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from '../../appium/log-file.ts';
import { createProcessInspector, type ProcessInspector } from '../../appium/process-inspector.ts';
import type { ServerManager, StepResult } from '../../appium/server-manager.ts';
import type { DeviceLeases } from '../../devices/device-lease.ts';
import type { PythonEnv } from './python-env.ts';
import { RunIndex } from '../run-index.ts';
import { journalBegin, journalEnd } from '../run-journal.ts';
import { diagnoseFailure, type FailureDiagnosis } from '../../reports/diagnosis.ts';
import { maskSecrets } from '../../reports/secrets.ts';
import type { ReliabilitySettings } from '../../reliability.ts';

export const PLUGIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'python');

export type RunStatus = 'starting' | 'running' | 'passed' | 'skipped' | 'failed' | 'error' | 'no-tests' | 'cancelled' | 'timeout';
export type ErrorCategory = 'import-or-syntax' | 'automation' | 'server-lost' | 'pytest-internal' | 'usage' | null;

export interface RunResult {
  /** A deliberately partial run, never evidence that later steps passed. */
  stopAfterStep?: number;
  status: RunStatus;
  category: ErrorCategory;
  summary: string;
  exitCode: number | null;
  signal: string | null;
  tests: { total: number; failures: number; errors: number; skipped: number } | null;
  failed: { test: string; message: string; step: string | null; details: string; diagnosis?: FailureDiagnosis }[];
  artifacts: { type: string; test?: string; file?: string; error?: string }[];
  /** Time to create the Appium session (driver fixture), when the plugin measured it. */
  sessionStartupMs?: number | null;
  cleanup: StepResult[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export class RunError extends Error {
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

interface Run {
  id: string;
  /** false: kept out of the run history (benchmark iterations) */
  record: boolean;
  /** First test file (kept for compatibility); `files` lists all of them. */
  file: string;
  files: string[];
  cwd: string;
  label: string;
  dir: string;
  serial: string;
  status: RunStatus;
  output: string;
  outputOffset: number; // characters dropped from the front when the buffer is trimmed
  child: ChildProcess | null;
  cancelRequested: boolean;
  timedOut: boolean;
  serverLost: string | null;
  result: RunResult | null;
  startedAt: string;
  done: Promise<RunResult>;
  /** Resolves when pytest has exited (before cleanup), so a cancel requested by the Server Manager can
   *  continue without waiting for session cleanup, which itself goes through the Server Manager. */
  exited: Promise<void>;
}

export interface RunnerDeps {
  manager: ServerManager;
  leases: DeviceLeases;
  runsDir: string;
  python: () => Promise<PythonEnv>;
  inspector?: ProcessInspector;
  pluginDir?: string;
  maxOutputChars?: number;
  /** Run history index (default: <runsDir>/index.jsonl). */
  index?: RunIndex;
}

// ---- JUnit ---------------------------------------------------------------------------------

const ent = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()],
);

export function parseJunit(xml: string) {
  let total = 0, failures = 0, errors = 0, skipped = 0;
  for (const m of xml.matchAll(/<testsuite\b([^>]*)>/g)) {
    const a = (k: string) => Number(new RegExp(`\\b${k}="(\\d+)"`).exec(m[1])?.[1] ?? 0);
    total += a('tests');
    failures += a('failures');
    errors += a('errors');
    skipped += a('skipped');
  }
  const failed: { test: string; message: string; text: string; kind: 'failure' | 'error' }[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = m[1];
    const name = ent(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? '');
    const cls = ent(/\bclassname="([^"]*)"/.exec(attrs)?.[1] ?? '');
    const inner = m[2] ?? '';
    const f = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(inner);
    if (f) failed.push({ test: cls ? `${cls}.${name}` : name, kind: f[1] as 'failure' | 'error', message: ent(/\bmessage="([^"]*)"/.exec(f[2])?.[1] ?? ''), text: ent(f[3] ?? '') });
  }
  return { total, failures, errors, skipped, failed };
}

/** The "# N. Tap ..." comment above the failing line of the test file, from a pytest traceback. */
export function failedStep(fileText: string, fileName: string, traceback: string): string | null {
  const lines = fileText.split(/\r?\n/);
  const re = new RegExp(`${fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+):`, 'g');
  const testStart = lines.findIndex((l) => /^def test_/.test(l));
  if (testStart < 0) return null;
  // Failures usually surface inside a helper (find, wait_count, ...) defined above the test function;
  // the recorded step is the last traceback frame that lies inside the test function itself.
  let lineNo: number | null = null;
  for (const m of traceback.matchAll(re)) if (Number(m[1]) - 1 > testStart) lineNo = Number(m[1]);
  if (!lineNo) return null; // failed in a fixture or helper only, not in a recorded step
  for (let i = lineNo - 1; i > testStart; i--) {
    const m = /^\s+# (\d+\. .*)$/.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

const PY_FRAME = /([^\s"'<>]*?((?:alt_)?test_[A-Za-z0-9_]+\.py)):(\d+):/g;

/** Failed recorded step for a failure in any of the run's files (the traceback names the file). */
export function failedStepIn(cwd: string, files: string[], traceback: string): string | null {
  const byBase = new Map(files.map((f) => [path.basename(f), f]));
  let last: string | null = null;
  for (const m of traceback.matchAll(PY_FRAME)) {
    const abs = path.isAbsolute(m[1]) ? m[1] : path.resolve(cwd, m[1]);
    const f = files.includes(abs) ? abs : byBase.get(m[2]);
    if (f) last = f;
  }
  if (!last) return null;
  try {
    return failedStep(fs.readFileSync(last, 'utf8'), path.basename(last), traceback);
  } catch {
    return null;
  }
}

// ---- runner --------------------------------------------------------------------------------

/** Files the generated code writes itself: WebView DOM at failure, screenshot checkpoints. */
export function extraArtifacts(dir: string): { type: string; file: string }[] {
  try {
    return fs.readdirSync(dir).flatMap((f) => (/^failure-dom-[\w.-]+\.html$/.test(f) ? [{ type: 'dom', file: f }] : /^checkpoint-[\w.-]+\.png$/.test(f) ? [{ type: 'checkpoint', file: f }] : []));
  } catch {
    return [];
  }
}

export class PytestRunner {
  #runs = new Map<string, Run>();
  #pkg = new Map<string, string>();
  #d: Required<RunnerDeps>;

  constructor(deps: RunnerDeps) {
    this.#d = { inspector: createProcessInspector(), pluginDir: PLUGIN_DIR, maxOutputChars: 2_000_000, index: new RunIndex(path.join(deps.runsDir, 'index.jsonl')), ...deps } as Required<RunnerDeps>;
  }

  /** Validates a test file or folder for a run: inside `testsDir`, saved, and a Python test (or a folder of them). */
  static resolveTarget(testsDir: string, target: string): string {
    const root = path.resolve(testsDir);
    const abs = path.resolve(root, target);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new RunError('OUTSIDE_TESTS_DIR', 400, 'Only tests saved in the tests folder can be run.');
    if (!/^(alt_)?test_[A-Za-z0-9_]+\.py$/.test(path.basename(abs))) throw new RunError('NOT_A_TEST_FILE', 400, 'Only saved Python test files named test_*.py can be run.');
    if (!fs.existsSync(abs)) throw new RunError('NOT_SAVED', 404, `${path.basename(abs)} is not saved. Save the test first; Vortex only runs saved code.`);
    return abs;
  }

  /** Validates that `file` is a saved Python test inside `testsDir`. */
  static resolveTestFile(testsDir: string, file: string): string {
    const root = path.resolve(testsDir);
    const abs = path.resolve(root, file);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new RunError('OUTSIDE_TESTS_DIR', 400, 'Only tests saved in the tests folder can be run.');
    if (!/^test_[A-Za-z0-9_]+\.py$/.test(path.basename(abs))) throw new RunError('NOT_A_TEST_FILE', 400, 'Only saved Python test files named test_*.py can be run.');
    if (!fs.existsSync(abs)) throw new RunError('NOT_SAVED', 404, `${path.basename(abs)} is not saved. Save the test first; Vortex only runs saved code.`);
    return abs;
  }

  async start(o: { testsDir: string; file?: string; files?: string[]; serial: string | null; appPackage: string; timeoutMs: number; reportDir?: string; label?: string; allowAutomationSwitch?: boolean; stopAfterStep?: number; reliability?: ReliabilitySettings; /** false = not added to the run history (benchmark iterations) */ record?: boolean }): Promise<{ id: string }> {
    const files = o.files?.length ? o.files.map((f) => PytestRunner.resolveTarget(o.testsDir, f)) : [PytestRunner.resolveTestFile(o.testsDir, o.file ?? '')];
    const file = files[0];
    // One file: run from its folder (as before). Several: from the tests folder, so pytest's root is their common parent.
    const cwd = files.length === 1 ? path.dirname(file) : path.resolve(o.testsDir);
    if (!o.serial) throw new RunError('NO_DEVICE', 409, 'No device is selected. Connect the phone and refresh the screen first.');
    const env = await this.#d.python();
    if (!env.ok || !env.command) throw new RunError('PYTHON_NOT_READY', 409, env.problems.join(' '), { installCommand: env.installCommand });
    const ep = this.#d.manager.endpoint();
    if (!ep) throw new RunError('NO_SERVER', 409, 'No running Appium server. Start or connect one in the Server Manager first.');

    const id = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}-${randomUUID().slice(0, 6)}`;
    const baseLabel = o.label ?? (files.length === 1 ? path.basename(file, '.py') : `${files.length} Python tests`);
    const label = o.stopAfterStep ? `${baseLabel} (partial through step ${o.stopAfterStep})` : baseLabel;
    const release = this.#d.leases.acquire(o.serial, { kind: 'run', id, label });
    const dir = o.reportDir ? path.join(o.reportDir, `${id}-appium`) : path.join(this.#d.runsDir, `${id}-${label.replace(/[^A-Za-z0-9_.-]+/g, '_')}`.slice(0, 120));
    fs.mkdirSync(dir, { recursive: true });

    const startedAt = new Date().toISOString();
    let resolveDone!: (r: RunResult) => void;
    let resolveExited!: () => void;
    const run: Run = {
      id, record: o.record !== false, file, files, cwd, label, dir, serial: o.serial, status: 'starting', output: '', outputOffset: 0, child: null,
      cancelRequested: false, timedOut: false, serverLost: null, result: null, startedAt,
      done: new Promise<RunResult>((r) => (resolveDone = r)),
      exited: new Promise<void>((r) => (resolveExited = r)),
    };
    this.#runs.set(id, run);
    this.#pkg.set(id, o.appPackage);

    const handle = this.#d.manager.runs.register({
      id, serverId: ep.serverId, label, startedAt,
      cancel: async () => {
        this.cancel(id);
        await run.exited;
      },
      onServerLost: (reason) => {
        run.serverLost = reason;
        this.#kill(run, true);
      },
    });

    const args = [...env.command.args, '-m', 'pytest', ...files, '-p', 'vortex_pytest_plugin', '-p', 'no:cacheprovider', '-rA', '--color=no', '-o', 'console_output_style=classic', `--junitxml=${path.join(dir, 'junit.xml')}`];
    const childEnv = {
      ...process.env,
      PYTHONPATH: [this.#d.pluginDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      PYTHONUNBUFFERED: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONIOENCODING: 'utf-8',
      APPIUM_URL: ep.url,
      ANDROID_UDID: o.serial,
      APP_PACKAGE: o.appPackage,
      VORTEX_ARTIFACTS: dir,
      VORTEX_IDLE_TIMEOUT: String(this.#d.manager.settings.sessionIdleTimeoutSec),
      VORTEX_STOP_AFTER_STEP: String(o.stopAfterStep || 0),
      ...(o.reliability ? { VORTEX_STABLE_MS: String(o.reliability.stableMs), VORTEX_MAX_SCROLLS: String(o.reliability.maxScrolls), VORTEX_TIMEOUT: process.env.VORTEX_TIMEOUT || String(o.reliability.timeoutSec) } : {}),
      // WebView steps: the Chromedriver chosen in Server settings (empty = Appium's own)
      ...(this.#d.manager.settings.chromedriverExecutable ? { CHROMEDRIVER_EXECUTABLE: this.#d.manager.settings.chromedriverExecutable } : {}),
      ...(this.#d.manager.settings.chromedriverExecutableDir ? { CHROMEDRIVER_DIR: this.#d.manager.settings.chromedriverExecutableDir } : {}),
    };
    this.#append(run, `$ ${[env.command.file, ...args].join(' ')}\n`);

    let child: ChildProcess;
    try {
      child = spawn(env.command.file, args, { cwd, env: childEnv, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      handle.complete();
      release();
      this.#runs.delete(id);
      resolveExited();
      throw new RunError('SPAWN_FAILED', 500, `Could not start pytest: ${(e as Error).message}`);
    }
    run.child = child;
    run.status = 'running';
    const pid = child.pid;
    void (async () => journalBegin(this.#d.runsDir, { id, engine: 'appium', label, dir, serial: o.serial!, startedAt, process: pid ? await this.#d.inspector.info(pid).catch(() => null) : null }))();
    child.stdout!.on('data', (b: Buffer) => this.#append(run, b.toString('utf8')));
    child.stderr!.on('data', (b: Buffer) => this.#append(run, b.toString('utf8')));

    const timer = setTimeout(() => {
      run.timedOut = true;
      this.#append(run, `\n[vortex] timeout after ${Math.round(o.timeoutMs / 1000)} s: stopping the run\n`);
      this.#kill(run, false);
    }, o.timeoutMs);
    const poll = setInterval(() => this.#trackSessions(run), 1_000);

    const finish = async (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
      clearTimeout(timer);
      clearInterval(poll);
      this.#trackSessions(run);
      resolveExited();
      if (spawnError) this.#append(run, `\n[vortex] ${spawnError.message}\n`);
      const result = await this.#finish(run, code, signal, startedAt, spawnError);
      if (o.stopAfterStep) {
        result.stopAfterStep = o.stopAfterStep;
        result.summary = `Checkpoint playback through step ${o.stopAfterStep} (partial run): ${result.summary}`;
      }
      handle.complete();
      release();
      // Keep-warm off: a Vortex-owned server is stopped after the run (sessions were closed above).
      const s = this.#d.manager.settings;
      const epNow = this.#d.manager.endpoint();
      if (!s.keepWarm && epNow?.ownership === 'vortex') {
        try {
          const r = await this.#d.manager.stop();
          result.cleanup.push(...r.steps.map((x) => ({ ...x, step: `keep-warm off: ${x.step}` })));
        } catch (e) {
          result.cleanup.push({ step: 'keep-warm off: stop server', ok: false, detail: (e as Error).message });
        }
      }
      this.#save(run, result);
      resolveDone(result);
    };
    let finished = false;
    child.once('error', (e) => {
      if (!finished) {
        finished = true;
        void finish(null, null, e);
      }
    });
    child.once('close', (code, signal) => {
      if (!finished) {
        finished = true;
        void finish(code, signal);
      }
    });
    return { id };
  }

  #append(run: Run, text: string) {
    text = maskSecrets(text);
    run.output += redact(text);
    const max = this.#d.maxOutputChars;
    if (run.output.length > max) {
      const drop = run.output.length - max;
      run.output = run.output.slice(drop);
      run.outputOffset += drop;
    }
    try {
      fs.appendFileSync(path.join(run.dir, 'output.log'), redact(text));
    } catch {
      /* report folder may have been removed */
    }
  }

  #readJsonl(run: Run, name: string): Record<string, string>[] {
    try {
      return fs.readFileSync(path.join(run.dir, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, string>);
    } catch {
      return [];
    }
  }

  #sessionIds(run: Run): string[] {
    return [...new Set(this.#readJsonl(run, 'sessions.jsonl').map((r) => r.session).filter(Boolean))];
  }

  #trackSessions(run: Run) {
    for (const sid of this.#sessionIds(run)) {
      try {
        this.#d.manager.trackSession(sid);
      } catch {
        /* server gone; cleanup reports it */
      }
    }
  }

  #kill(run: Run, force: boolean) {
    const pid = run.child?.pid;
    if (!pid || run.child?.exitCode !== null) return;
    void this.#d.inspector.kill(pid, { force, tree: true }).catch(() => {});
    if (!force) {
      setTimeout(() => {
        if (run.child && run.child.exitCode === null) void this.#d.inspector.kill(pid, { force: true, tree: true }).catch(() => {});
      }, 5_000).unref();
    }
  }

  async #finish(run: Run, code: number | null, signal: NodeJS.Signals | null, startedAt: string, spawnError?: Error): Promise<RunResult> {
    const junitFile = path.join(run.dir, 'junit.xml');
    const junit = fs.existsSync(junitFile) ? parseJunit(fs.readFileSync(junitFile, 'utf8')) : null;
    const failed = (junit?.failed ?? []).map((f) => ({
      test: f.test,
      message: redact(f.message.split('\n')[0].slice(0, 500)),
      step: failedStepIn(run.cwd, run.files, f.text),
      details: redact(f.text.slice(-4000)),
    }));
    const collection = /ERROR collecting|ImportError|ModuleNotFoundError|SyntaxError|IndentationError/.test(run.output) && (code === 2 || code === 1) && (junit?.total ?? 0) <= (junit?.errors ?? 0);

    let status: RunStatus;
    let category: ErrorCategory = null;
    let summary: string;
    if (spawnError) {
      status = 'error';
      category = 'usage';
      summary = `pytest could not be started: ${spawnError.message}`;
    } else if (run.cancelRequested) {
      status = 'cancelled';
      summary = 'Cancelled by the user.';
    } else if (run.timedOut) {
      status = 'timeout';
      summary = 'Stopped because it exceeded the run timeout.';
    } else if (run.serverLost) {
      status = 'failed';
      category = 'server-lost';
      summary = `The Appium server went away during the run: ${run.serverLost}`;
    } else if (code === 5) {
      status = 'no-tests';
      summary = 'pytest collected zero tests. Check that the file contains a function named test_...';
    } else if (collection) {
      status = 'error';
      category = 'import-or-syntax';
      summary = 'The test file could not be imported (syntax error or missing package). No test ran.';
    } else if (code === 0 && junit && junit.total > 0 && junit.failures + junit.errors === 0) {
      status = junit.total === junit.skipped ? 'skipped' : 'passed';
      summary = `${junit.total - junit.skipped} passed${junit.skipped ? `, ${junit.skipped} skipped` : ''}.`;
    } else if (code === 0) {
      status = 'error';
      category = 'pytest-internal';
      summary = 'pytest exited 0 but no test results were written, so the run is not counted as passed.';
    } else if (code === 1) {
      status = 'failed';
      category = 'automation';
      summary = `${junit ? junit.failures + junit.errors : '?'} of ${junit?.total ?? '?'} test(s) failed.`;
    } else {
      status = 'error';
      category = code === 3 ? 'pytest-internal' : code === 4 ? 'usage' : 'pytest-internal';
      summary = `pytest exited with code ${code ?? 'none'}${signal ? ` (signal ${signal})` : ''}.`;
    }

    // what the plugin saw when tests failed (foreground app), and per-failure diagnosis
    const states = this.#readJsonl(run, 'artifacts.jsonl').filter((r) => r.type === 'state');
    for (const f of failed) {
      const st = states.find((r) => f.test.endsWith(String(r.test ?? '').split('::').pop() ?? '\u0000')) ?? states[states.length - 1];
      (f as RunResult['failed'][number]).diagnosis = diagnoseFailure({ message: f.message, details: f.details, category, status, foregroundPackage: st?.package ?? null, appPackage: this.#pkg.get(run.id) ?? null });
    }
    const setup = this.#readJsonl(run, 'sessions.jsonl').find((r) => r.event === 'driver-setup');
    // Close every session the run opened. Already-closed sessions (normal case) answer 404, which counts as done.
    const ids = this.#sessionIds(run);
    const cleanup: StepResult[] = ids.length ? await this.#d.manager.endSessions(ids) : [{ step: 'close sessions', ok: true, detail: 'the run opened no recorded sessions' }];
    const endedAt = new Date().toISOString();
    return {
      status, category, summary, exitCode: code, signal: signal ?? null,
      tests: junit ? { total: junit.total, failures: junit.failures, errors: junit.errors, skipped: junit.skipped } : null,
      failed, artifacts: [...(this.#readJsonl(run, 'artifacts.jsonl') as RunResult['artifacts']).filter((a) => a.type !== 'state'), ...extraArtifacts(run.dir)], cleanup,
      sessionStartupMs: setup ? Math.round(Number(setup.ms)) : null,
      startedAt, endedAt, durationMs: Date.parse(endedAt) - Date.parse(startedAt),
    };
  }

  #save(run: Run, result: RunResult) {
    journalEnd(this.#d.runsDir, run.id);
    run.result = result;
    run.status = result.status;
    run.child = null;
    try {
      fs.writeFileSync(path.join(run.dir, 'result.json'), JSON.stringify({ id: run.id, engine: 'appium', label: run.label, file: run.file, files: run.files, serial: run.serial, ...result }, null, 2));
    } catch {
      /* ignore */
    }
    if (run.record) this.#d.index.add({ id: run.id, engine: 'appium', label: run.label, dir: run.dir, status: result.status, summary: result.summary, startedAt: result.startedAt, durationMs: result.durationMs });
  }

  cancel(id: string) {
    const run = this.#runs.get(id);
    if (!run) throw new RunError('NO_RUN', 404, 'No such run.');
    if (run.result) return { status: run.status };
    run.cancelRequested = true;
    this.#append(run, '\n[vortex] cancel requested: stopping pytest\n');
    this.#kill(run, false);
    return { status: 'cancelling' };
  }

  has(id: string) {
    return this.#runs.has(id);
  }

  get(id: string, from = 0) {
    const run = this.#runs.get(id);
    if (!run) throw new RunError('NO_RUN', 404, 'No such run (runs from earlier recorder sessions are in the history list).');
    const start = Math.max(0, from - run.outputOffset);
    return { id: run.id, engine: 'appium' as const, serial: run.serial, file: run.file, files: run.files, label: run.label, status: run.status, output: run.output.slice(start), next: run.outputOffset + run.output.length, result: run.result, dir: run.dir };
  }

  wait(id: string): Promise<RunResult> {
    const run = this.#runs.get(id);
    if (!run) throw new RunError('NO_RUN', 404, 'No such run.');
    return run.done;
  }

  /** Past runs of this engine, newest first: indexed runs plus report folders from before the index existed. */
  history(limit = 30) {
    const seen = new Set<string>();
    const out: { id: string; engine: 'appium'; file: string; status: string; summary: string; startedAt: string; durationMs: number; dir: string }[] = [];
    for (const e of this.#d.index.list(limit * 2)) {
      if (e.engine !== 'appium' || seen.has(e.id)) continue;
      seen.add(e.id);
      out.push({ id: e.id, engine: 'appium', file: e.label, status: e.status, summary: e.summary, startedAt: e.startedAt, durationMs: e.durationMs, dir: e.dir });
    }
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(this.#d.runsDir).filter((d) => !d.endsWith('.jsonl')).sort().reverse().slice(0, limit);
    } catch {
      dirs = [];
    }
    for (const d of dirs) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(this.#d.runsDir, d, 'result.json'), 'utf8')) as RunResult & { id: string; file: string };
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push({ id: r.id, engine: 'appium', file: path.basename(r.file), status: r.status, summary: r.summary, startedAt: r.startedAt, durationMs: r.durationMs, dir: path.join(this.#d.runsDir, d) });
      } catch {
        /* not a report folder */
      }
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  active() {
    return [...this.#runs.values()].filter((r) => !r.result).map((r) => ({ id: r.id, engine: 'appium' as const, label: r.label, status: r.status }));
  }
}
