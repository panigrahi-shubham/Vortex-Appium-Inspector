/**
 * Feature: Appium Server Manager (start, connect, disconnect, stop, restart, session cleanup, recovery)
 * Layer: Unit — node:test
 * Real: ServerManager, RunRegistry, state persistence logic
 * Mocked: Operating system and Appium HTTP (FakeOS): processes, PIDs, ports, kill, /status
 * Guards: Killing a server Vortex does not own, killing a reused PID, stopping under an active run,
 *         tests hanging after a server crash, losing ownership after a recorder crash
 * Run: npm run test:unit
 * Needs: Node.js 22.18+ (runs the TypeScript directly)
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppiumInstall } from '../../src/appium/appium-locator.ts';
import { ManagerError, ServerManager } from '../../src/appium/server-manager.ts';
import { createMemoryStateStore, DEFAULT_SETTINGS, type PersistedState } from '../../src/appium/state-store.ts';
import { FakeOS } from './fake-os.ts';

const INSTALL: AppiumInstall = { entry: '/opt/appium/index.js', version: '3.9.0', source: 'configured' };

function setup(os = new FakeOS(), store = createMemoryStateStore(), settings: Partial<PersistedState['settings']> = {}) {
  store.current.settings = { ...DEFAULT_SETTINGS, stopGraceMs: 1_000, serverStartupTimeoutMs: 5_000, ...settings };
  const m = new ServerManager({ store, inspector: os, http: os.http, locate: async () => INSTALL, spawn: os.spawn, nodePath: 'node', logDir: '/tmp/vortex-test-logs', pollMs: 5 });
  return { os, store, m };
}

async function rejectsWith(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof ManagerError && e.code === code);
}

function fakeRun(m: ServerManager, serverId: string, opts: { cancelOk?: boolean } = {}) {
  const calls = { cancelled: 0, lost: [] as string[] };
  const handle = m.runs.register({
    id: `run-${Math.random().toString(36).slice(2, 7)}`,
    serverId,
    label: 'add-product',
    startedAt: new Date().toISOString(),
    cancel: async () => {
      calls.cancelled++;
      if (opts.cancelOk === false) throw new Error('runner did not respond');
    },
    onServerLost: (reason) => calls.lost.push(reason),
  });
  return { calls, handle };
}

// Risk: The basic start path could leave no verifiable ownership record.
// Given a free port, When Start runs, Then Appium is spawned via node and its PID, start time and command line are persisted.
test('start spawns Appium with node and records a full process identity', async () => {
  const { os, store, m } = setup();
  const r = await m.start({ port: 4723 });
  assert.equal(r.reused, false);
  assert.equal(os.spawns.length, 1);
  assert.equal(os.spawns[0].file, 'node');
  assert.deepEqual(os.spawns[0].args.slice(0, 5), ['/opt/appium/index.js', '--address', '127.0.0.1', '--port', '4723']);
  const rec = store.current.owned[0];
  assert.ok(rec.identity.startTime && rec.identity.commandLine.includes('--port 4723'));
  const s = await m.status();
  assert.equal(s.server?.ownership, 'vortex');
  assert.equal(s.server?.state, 'running');
  assert.equal(s.server?.canStop, true);
});

// Risk: Pressing Start twice could launch two servers.
// Given concurrent Start calls, When both finish, Then only one process was spawned and the second reused it.
test('concurrent starts are serialised and the running server is reused', async () => {
  const { os, m } = setup();
  const [a, b] = await Promise.all([m.start(), m.start()]);
  assert.equal(os.spawns.length, 1);
  assert.deepEqual([a.reused, b.reused].sort(), [false, true]);
});

// Risk: Vortex could start a second Appium on a port another tool already serves.
// Given an external Appium on 4723, When Start runs, Then it refuses, suggests Connect Existing and spawns nothing.
test('start refuses when an external Appium already answers on the port', async () => {
  const { os, m } = setup();
  os.addProcess('appium --port 4723', 4723, '2.11.0');
  await rejectsWith(m.start({ port: 4723 }), 'PORT_HAS_EXTERNAL_APPIUM');
  assert.equal(os.spawns.length, 0);
});

// Risk: Start could collide with a non-Appium program holding the port.
// Given a non-Appium listener, When Start runs, Then it reports the owning PID and spawns nothing.
test('start refuses when another program holds the port', async () => {
  const { os, m } = setup();
  const other = os.addProcess('java -jar something.jar', 4723);
  await assert.rejects(m.start({ port: 4723 }), (e: unknown) => e instanceof ManagerError && e.code === 'PORT_IN_USE' && String(e.message).includes(String(other.pid)));
  assert.equal(os.spawns.length, 0);
});

// Risk (core rule): Vortex kills a server owned by another tool.
// Given a connected external server, When Stop and Restart are requested, Then both are refused and nothing is killed.
test('external servers can be connected and disconnected but never stopped', async () => {
  const { os, m } = setup();
  const ext = os.addProcess('node appium --port 4723', 4723, '3.9.0');
  const c = await m.connectExisting({ host: '127.0.0.1', port: 4723 });
  assert.equal(c.ownership, 'external');
  assert.equal(c.status.server?.pid, ext.pid);
  assert.equal(c.status.server?.pidSource, 'os-lookup');
  assert.equal(c.status.server?.canStop, false);
  await rejectsWith(m.stop(), 'EXTERNAL_SERVER');
  await rejectsWith(m.stop({ cancelActiveRuns: true }), 'EXTERNAL_SERVER');
  await rejectsWith(m.restart(), 'EXTERNAL_SERVER');
  await m.disconnect();
  assert.equal(os.kills.length, 0);
  assert.ok(os.procs.has(ext.pid), 'external process must still be running');
});

// Risk: A responding port is mistaken for ownership.
// Given an external server on the same port Vortex once used, When connecting, Then it is still classed as external.
test('a responding port alone never makes a server Vortex-owned', async () => {
  const { os, store, m } = setup();
  await m.start({ port: 4723 });
  const owned = store.current.owned[0];
  os.exit(owned.pid); // our server dies...
  await m.status();
  os.addProcess('node appium --port 4723', 4723, '3.9.0'); // ...and someone else starts one on the same port
  await rejectsWith(m.start({ port: 4723 }), 'PORT_HAS_EXTERNAL_APPIUM');
  const c = await m.connectExisting({ port: 4723 });
  assert.equal(c.ownership, 'external');
});

// Risk: A reused PID gets killed after the original Appium died.
// Given a server recovered after a recorder crash (no child handle, so its exit is not observed) whose PID
// now belongs to another program, When Stop runs, Then ownership verification fails and nothing is killed.
test('stop never kills a PID that now belongs to a different process', async () => {
  const os = new FakeOS();
  const store = createMemoryStateStore();
  await setup(os, store).m.start({ port: 4723 });
  const pid = store.current.owned[0].pid;
  const { m } = setup(os, store); // the recorder restarted after a crash
  await m.init();
  os.reusePid(pid); // Appium died and Windows/Linux handed the same PID to an unrelated program
  // No health check has run yet, so the manager still believes it owns a live server.
  const r = await m.stop();
  assert.equal(r.ok, false);
  assert.match(r.steps.find((s) => s.step === 'verify ownership')!.detail, /different process; it was NOT stopped/);
  assert.equal(os.kills.length, 0);
  assert.ok(os.procs.has(pid), 'the unrelated process must survive');
  assert.equal(store.current.owned.length, 0, 'stale record is removed');
});

// Risk: Stopping the server under a running test breaks the run mid-way.
// Given an active run, When Stop / Cleanup / Restart are requested normally, Then they are blocked with RUN_ACTIVE and the server keeps running.
test('ordinary stop, restart and session cleanup are blocked while a run is active', async () => {
  const { os, store, m } = setup();
  await m.start();
  const serverId = (await m.status()).server!.id;
  m.trackSession('sess-1');
  const { calls } = fakeRun(m, serverId);
  await assert.rejects(m.stop(), (e: unknown) => e instanceof ManagerError && e.code === 'RUN_ACTIVE' && Array.isArray((e.details as { next?: unknown }).next));
  await rejectsWith(m.restart(), 'RUN_ACTIVE');
  await rejectsWith(m.cleanupSessions(), 'RUN_ACTIVE');
  assert.equal(os.kills.length, 0);
  assert.equal(os.deletedSessions.length, 0);
  assert.equal(calls.cancelled, 0);
  assert.ok(os.procs.has(store.current.owned[0].pid));
});

// Risk: The explicit "Cancel Run -> Cleanup Session -> Stop Server" path skips a step or runs them out of order.
// Given an active run and a Vortex session, When stop is called with cancelActiveRuns, Then the run is cancelled, the session deleted, then the process stopped and the port confirmed free.
test('cancel run -> clean up session -> stop server, in that order', async () => {
  const { os, store, m } = setup();
  await m.start();
  const serverId = (await m.status()).server!.id;
  const pid = store.current.owned[0].pid;
  m.trackSession('sess-1');
  const { calls } = fakeRun(m, serverId);
  const r = await m.stop({ cancelActiveRuns: true });
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  assert.match(r.steps[0].step, /^cancel run run-/);
  assert.deepEqual(r.steps.slice(1).map((s) => s.step), ['delete session sess-1', 'verify ownership', 'graceful stop (SIGTERM)', 'confirm port released']);
  assert.equal(calls.cancelled, 1);
  assert.deepEqual(os.deletedSessions, ['sess-1']);
  assert.ok(!os.procs.has(pid));
  assert.deepEqual(m.runs.all(), []);
  assert.equal(store.current.owned.length, 0);
});

// Risk: A run that cannot be cancelled is killed anyway (leaving a half-done test and device state).
// Given a run whose cancel fails, When cancel-and-stop is requested, Then the server is NOT stopped and the report says why.
test('server is not stopped when a run refuses to cancel', async () => {
  const { os, store, m } = setup();
  await m.start();
  fakeRun(m, (await m.status()).server!.id, { cancelOk: false });
  const r = await m.stop({ cancelActiveRuns: true });
  assert.equal(r.ok, false);
  assert.match(r.steps.at(-1)!.detail, /not stopped because a run could not be cancelled/);
  assert.equal(os.kills.length, 0);
  assert.ok(os.procs.has(store.current.owned[0].pid));
});

// Risk: A test hangs forever after its Appium server crashes.
// Given an active run, When the owned server exits unexpectedly, Then the run is failed immediately with the reason and status shows the exit.
test('unexpected exit of the owned server fails dependent runs immediately', async () => {
  const { os, store, m } = setup();
  await m.start();
  const { calls } = fakeRun(m, (await m.status()).server!.id);
  os.exit(store.current.owned[0].pid, 137, 'SIGKILL');
  assert.equal(calls.lost.length, 1);
  assert.match(calls.lost[0], /exited unexpectedly \(code 137, signal SIGKILL\)/);
  const s = await m.status();
  assert.equal(s.server?.state, 'exited');
  assert.equal(s.server?.exit?.failedRuns.length, 1);
  assert.equal(store.current.owned.length, 0);
  assert.deepEqual(m.runs.all(), []);
});

// Risk: After a recorder crash the still-running server becomes an orphan nobody may stop.
// Given manager A started a server and crashed (no shutdown), When manager B starts with the same state, Then B adopts it as Vortex-owned and can stop it.
test('crash recovery: a new recorder adopts and can stop the server the old one started', async () => {
  const os = new FakeOS();
  const store = createMemoryStateStore();
  const a = setup(os, store).m;
  await a.start({ port: 4723 });
  const pid = store.current.owned[0].pid;
  a.stopWatchdog(); // "crash": A disappears without shutdown()

  const b = setup(os, store).m;
  const report = await b.init();
  assert.match(report[0].detail, /still running and was adopted/);
  const s = await b.status();
  assert.equal(s.server?.ownership, 'vortex');
  assert.equal(s.server?.recovered, true);
  assert.equal(s.server?.pid, pid);
  const r = await b.stop();
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  assert.ok(!os.procs.has(pid));
});

// Risk: Stale records after a crash lead to killing the wrong process later.
// Given records for an exited PID and a reused PID, When the recorder starts, Then both records are dropped and nothing is killed.
test('crash recovery drops stale records and never kills during recovery', async () => {
  const os = new FakeOS();
  const store = createMemoryStateStore();
  const live = os.addProcess('/usr/bin/vim notes.txt');
  const mk = (pid: number, port: number, startTime: string) => ({
    id: `r${port}`, host: '127.0.0.1', port, pid, identity: { pid, startTime, commandLine: `node /opt/appium/index.js --port ${port}` },
    appiumEntry: '/opt/appium/index.js', appiumVersion: '3.9.0', logFile: '/tmp/x.log', startedAt: '2026-01-01T00:00:00Z', startedBy: 'old',
  });
  store.current.owned = [mk(4242, 4723, 't0'), mk(live.pid, 4724, 'tOld')];
  const { m } = setup(os, store);
  const report = await m.init();
  assert.match(report[0].detail, /no longer running/);
  assert.match(report[1].detail, /different process; stale record removed and that process left alone/);
  assert.equal(store.current.owned.length, 0);
  assert.equal(os.kills.length, 0);
  assert.ok(os.procs.has(live.pid));
  assert.equal((await m.status()).connected, false);
});

// Risk: An owned process that is alive but hung cannot be cleaned up.
// Given a recovered owned process that no longer answers /status, When the recorder starts, Then it is shown as unhealthy and Stop works.
test('recovered owned server that is not answering is marked unhealthy and can be stopped', async () => {
  const os = new FakeOS();
  const store = createMemoryStateStore();
  const first = setup(os, store).m;
  await first.start();
  const pid = store.current.owned[0].pid;
  os.appium.delete(4723); // still alive, no longer answering
  const { m } = setup(os, store);
  await m.init();
  assert.equal((await m.status()).server?.state, 'unhealthy');
  assert.equal((await m.stop()).ok, true);
  assert.ok(!os.procs.has(pid));
});

// Risk: A server that ignores the graceful stop stays running.
// Given SIGTERM is ignored, When Stop runs, Then a forced stop follows and both steps are reported.
test('graceful stop that times out is followed by a forced stop', async () => {
  const { os, store, m } = setup(undefined, undefined, { stopGraceMs: 1_000 });
  await m.start();
  const pid = store.current.owned[0].pid;
  os.ignoreGraceful.add(pid);
  const r = await m.stop();
  assert.deepEqual(r.steps.map((s) => [s.step, s.ok]), [
    ['clean up Vortex sessions', true],
    ['verify ownership', true],
    ['graceful stop (SIGTERM)', false],
    ['forced stop', true],
    ['confirm port released', true],
  ]);
  assert.deepEqual(os.kills.map((k) => k.opts.force), [false, true]);
  assert.ok(os.kills.every((k) => k.opts.tree));
});

// Risk: Windows has no graceful signal; the report must not claim one.
// Given the Windows platform, When Stop runs, Then the step is reported as taskkill, not SIGTERM.
test('on Windows the stop step is reported honestly as taskkill', async () => {
  const { m } = setup(new FakeOS('win32'));
  await m.start();
  const r = await m.stop();
  assert.ok(r.steps.some((s) => s.step === 'stop (taskkill /T /F)' && s.ok));
});

// Risk: "Port released" is reported when another program grabbed the port.
// Given a different program binds the port right after the stop, When stop finishes, Then the report names that PID as not Vortex.
test('port confirmation distinguishes "free" from "taken by another program"', async () => {
  const os = new FakeOS();
  const { store, m } = setup(os);
  await m.start();
  const pid = store.current.owned[0].pid;
  const origExit = os.exit.bind(os);
  os.exit = (p, c, s) => {
    origExit(p, c, s);
    if (p === pid) os.addProcess('python -m http.server 4723', 4723);
  };
  const r = await m.stop();
  const step = r.steps.find((s) => s.step === 'confirm port released')!;
  assert.equal(step.ok, true);
  assert.match(step.detail, /no longer holds port 4723; it is now used by PID \d+ \(not Vortex\)/);
});

// Risk: Restart loses the port or leaves the old process behind.
// Given a running owned server, When Restart runs, Then the old PID is gone and a new owned server runs on the same port.
test('restart stops the old process and starts a new one on the same port', async () => {
  const { os, store, m } = setup();
  await m.start({ port: 4730 });
  const oldPid = store.current.owned[0].pid;
  const r = await m.restart();
  assert.equal(r.ok, true);
  assert.ok(!os.procs.has(oldPid));
  assert.equal(store.current.owned.length, 1);
  assert.notEqual(store.current.owned[0].pid, oldPid);
  assert.equal(store.current.owned[0].port, 4730);
});

// Risk: Startup failures leave orphan records or report success.
// Given Appium exits immediately / during startup / never becomes ready, When Start runs, Then a specific error is raised and no record remains.
for (const [behaviour, code] of [
  ['exit-immediately', 'STARTUP_FAILED'],
  ['exit-during-startup', 'STARTUP_FAILED'],
  ['never-ready', 'STARTUP_TIMEOUT'],
] as const) {
  test(`startup failure (${behaviour}) is reported as ${code} with no leftover record`, async () => {
    const { os, store, m } = setup(undefined, undefined, { serverStartupTimeoutMs: 5_000 });
    os.spawnBehaviour = behaviour;
    await rejectsWith(m.start(), code);
    assert.equal(store.current.owned.length, 0);
    if (behaviour === 'never-ready') assert.ok(os.kills.length >= 1, 'the stuck process is stopped');
  });
}

// Risk: The configured shutdown policy is ignored.
// Given stopOwnedOnExit true/false, When the recorder shuts down, Then the server is stopped / left running and adopted next time.
test('shutdown stops the owned server only when configured to', async () => {
  const os = new FakeOS();
  const store = createMemoryStateStore();
  const on = setup(os, store, { stopOwnedOnExit: true }).m;
  await on.start();
  const pid1 = store.current.owned[0].pid;
  assert.equal((await on.shutdown())?.ok, true);
  assert.ok(!os.procs.has(pid1));

  const off = setup(os, store, { stopOwnedOnExit: false }).m;
  await off.start();
  const pid2 = store.current.owned[0].pid;
  assert.equal(await off.shutdown(), null);
  assert.ok(os.procs.has(pid2), 'kept warm after the recorder exits');
  const next = setup(os, store, { stopOwnedOnExit: false }).m;
  await next.init();
  assert.equal((await next.status()).server?.pid, pid2);
});

// Risk: Connect Existing to Vortex's own earlier server is treated as foreign (cannot be stopped).
// Given a valid ownership record for the port, When connecting, Then the server is recognised as Vortex-owned.
test('connect existing recognises a server Vortex started earlier', async () => {
  const os = new FakeOS();
  const store = createMemoryStateStore();
  const a = setup(os, store, { stopOwnedOnExit: false }).m;
  await a.start();
  await a.shutdown();
  const b = setup(os, store).m; // no init(): user presses Connect Existing directly
  const c = await b.connectExisting({ host: 'localhost', port: 4723 });
  assert.equal(c.ownership, 'vortex');
});

// Risk: A run against an external server hangs when that server disappears.
// Given an active run on an external server, When /status fails twice, Then the run is failed.
test('runs on an external server are failed when it stops answering', async () => {
  const { os, m } = setup();
  const ext = os.addProcess('appium', 4723, '3.9.0');
  await m.connectExisting({ port: 4723 });
  const { calls } = fakeRun(m, (await m.status()).server!.id);
  os.exit(ext.pid);
  await m.checkHealth();
  assert.equal(calls.lost.length, 0, 'one missed check is tolerated');
  await m.checkHealth();
  assert.equal(calls.lost.length, 1);
  assert.equal(os.kills.length, 0);
});

// Risk: Settings accept values that would start a server on the network or break timeouts.
// Given invalid settings, When saved, Then they are rejected; valid ones are persisted.
test('settings are validated and persisted', async () => {
  const { store, m } = setup();
  await rejectsWith(m.updateSettings({ host: '0.0.0.0' }), 'HOST_NOT_ALLOWED');
  await rejectsWith(m.updateSettings({ port: 80 }), 'INVALID_SETTING');
  await rejectsWith(m.updateSettings({ keepWarm: 'yes' as unknown as boolean }), 'INVALID_SETTING');
  await rejectsWith(m.updateSettings({ appiumPath: 'relative/appium' }), 'INVALID_SETTING');
  await rejectsWith(m.start({ host: '192.168.1.10' }), 'HOST_NOT_ALLOWED');
  await m.updateSettings({ port: 4800, keepWarm: false, sessionIdleTimeoutSec: 600 });
  assert.equal(store.current.settings.port, 4800);
  assert.equal(store.current.settings.keepWarm, false);
  assert.equal(store.current.settings.sessionIdleTimeoutSec, 600);
});

// Risk: Disconnect is used to "lose" a server Vortex is responsible for.
// Given a Vortex-owned server, When Disconnect is pressed, Then it is refused with guidance to use Stop.
test('disconnect is refused for a Vortex-owned running server', async () => {
  const { m } = setup();
  await m.start();
  await rejectsWith(m.disconnect(), 'OWNED_USE_STOP');
});

// Risk: Session cleanup deletes sessions Vortex did not create.
// Given one tracked session, When cleanup runs, Then only that session is deleted.
test('session cleanup deletes only sessions Vortex created', async () => {
  const { os, m } = setup();
  await m.start();
  m.trackSession('abc-123');
  const r = await m.cleanupSessions();
  assert.equal(r.ok, true);
  assert.deepEqual(os.deletedSessions, ['abc-123']);
  assert.throws(() => m.trackSession('../../evil'), /invalid session id/);
});
