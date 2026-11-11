/**
 * Feature: Appium server handling through the real HTTP API, with real processes and ports
 * Layer: Integration — node:test; spawns `node src/server.ts` and a stand-in Appium process
 * Real: Vortex HTTP server and routes, ServerManager, process spawning, OS process identity, TCP ports, log files
 * Mocked: Appium itself (test/integration/fixtures/fake-appium: answers /status, or fails at startup). No phone.
 * Guards: A failed start with no reason shown, a dead-end busy port, settings that cannot be changed,
 *         an owned server left running after Stop
 * Run: npm run test:integration
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fakeAppium = path.join(root, 'test', 'integration', 'fixtures', 'fake-appium');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function startVortex(t: { after(fn: () => Promise<void> | void): void }, env: NodeJS.ProcessEnv = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vortex-server-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.ts', '--port', String(port), '--out', path.join(temp, 'generated'), '--state-dir', path.join(temp, 'state')], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (b) => (log += String(b)));
  child.stderr.on('data', (b) => (log += String(b)));
  t.after(async () => {
    child.kill();
    await new Promise((r) => {
      child.once('exit', r);
      setTimeout(r, 5000);
    });
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try {
      ready = (await fetch(base + '/api/health')).ok;
    } catch { /* the listening socket may not be bound yet */ }
    if (!ready) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, log);
  const call = async (url: string, body?: unknown) => {
    const r = await fetch(base + '/api/' + url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  return { base, call, temp };
}

test('a failed start returns Appium\'s own log, and the log route serves it', async (t) => {
  const { call } = await startVortex(t, { FAKE_APPIUM_MODE: 'crash' });
  const appiumPort = await freePort();
  assert.equal((await call('server/settings', { appiumPath: fakeAppium, port: appiumPort })).status, 200);
  const r = await call('server/start', { port: appiumPort });
  assert.equal(r.status, 500);
  assert.equal(r.body.code, 'STARTUP_FAILED');
  assert.match(r.body.error, /exit code 3/);
  assert.ok(Array.isArray(r.body.details.log), 'the error carries the log tail');
  assert.ok(r.body.details.log.some((l: string) => l.includes('could not load driver "uiautomator2"')), r.body.details.log.join('\n'));
  const status = await call('status');
  assert.equal(status.body.server.server.state, 'exited', 'the failed server is shown as stopped, with its exit code');
  assert.equal(status.body.server.server.exit.code, 3);
  assert.equal(status.body.server.ownedRecords.length, 0, 'no ownership record is left for a process that is gone');
  const logs = await call('server/logs?lines=50');
  assert.ok(logs.body.lines.some((l: string) => l.includes('Fatal Error')), 'the log route still serves the failed start');
});

test('start, log, restart and stop work on a real process; settings are validated', async (t) => {
  const { call } = await startVortex(t);
  const appiumPort = await freePort();
  assert.equal((await call('server/settings', { appiumPath: fakeAppium, port: appiumPort, serverStartupTimeoutMs: 20_000, stopOwnedOnExit: true })).status, 200);
  const bad = await call('server/settings', { port: 80 });
  assert.equal(bad.status, 400, 'a privileged port is refused');
  const wrongPath = await call('server/settings', { appiumPath: os.tmpdir() });
  assert.equal(wrongPath.status, 400, 'a folder that is not Appium is refused');

  const started = await call('server/start', { port: appiumPort });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  let s = (await call('status')).body.server;
  assert.equal(s.server.state, 'running');
  assert.equal(s.server.ownership, 'vortex');
  assert.equal(s.server.port, appiumPort);
  assert.equal(s.settings.appiumPath, fakeAppium);
  const firstPid = s.server.pid;
  assert.ok((await fetch(`http://127.0.0.1:${appiumPort}/status`)).ok);

  const logs = await call('server/logs?lines=50');
  assert.equal(logs.status, 200);
  assert.ok(logs.body.lines.some((l: string) => l.includes('listener started')), logs.body.lines.join('\n'));

  const restarted = await call('server/restart', {});
  assert.equal(restarted.status, 200, JSON.stringify(restarted.body));
  s = (await call('status')).body.server;
  assert.equal(s.server.state, 'running');
  assert.notEqual(s.server.pid, firstPid, 'a new process serves the port');

  const refused = await call('server/disconnect', {});
  assert.equal(refused.body.code, 'OWNED_USE_STOP', 'an owned server is stopped, not abandoned');

  const stopped = await call('server/stop', {});
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  await assert.rejects(fetch(`http://127.0.0.1:${appiumPort}/status`), 'the port is released');
});

test('a busy port names the next free port; an existing Appium is offered for connecting and never stopped', async (t) => {
  const { call } = await startVortex(t);
  const blocker = net.createServer();
  const busyPort = await new Promise<number>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as net.AddressInfo).port)));
  t.after(() => void blocker.close());
  await call('server/settings', { appiumPath: fakeAppium });
  const busy = await call('server/start', { port: busyPort });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, 'PORT_IN_USE');
  assert.ok(Number.isInteger(busy.body.details.suggestedPort) && busy.body.details.suggestedPort > busyPort);

  // An Appium that Vortex did not start.
  const externalPort = await freePort();
  const external = spawn(process.execPath, [path.join(fakeAppium, 'index.js'), '--address', '127.0.0.1', '--port', String(externalPort)], { stdio: 'ignore' });
  t.after(() => void external.kill());
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${externalPort}/status`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const clash = await call('server/start', { port: externalPort });
  assert.equal(clash.body.code, 'PORT_HAS_EXTERNAL_APPIUM');
  assert.equal(clash.body.details.port, externalPort);
  assert.equal((await call('server/connect', { port: externalPort })).status, 200);
  assert.equal((await call('server/stop', {})).body.code, 'EXTERNAL_SERVER', 'Vortex refuses to stop it');
  assert.equal((await call('server/disconnect', {})).status, 200);
  assert.ok((await fetch(`http://127.0.0.1:${externalPort}/status`)).ok, 'the external server is still running');
});

test('the setup check is served and reports every item', async (t) => {
  const { call } = await startVortex(t);
  const r = await call('preflight');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.checks.map((c: { id: string }) => c.id), ['node', 'appium', 'driver', 'android-sdk', 'adb', 'java', 'python', 'device', 'port']);
  assert.ok(r.body.checks.every((c: { status: string; detail: string }) => ['ok', 'warn', 'fail'].includes(c.status) && c.detail));
});

// ---- 1.0.0: base path, automatic restart, live status ----

test('base path: Appium is started under /wd/hub and reached there', async (t) => {
  const { call } = await startVortex(t);
  const appiumPort = await freePort();
  assert.equal((await call('server/settings', { appiumPath: fakeAppium, port: appiumPort, basePath: '/wd/hub' })).status, 200);
  assert.equal((await call('server/settings', { basePath: 'no-slash' })).body.code, 'INVALID_SETTING');
  const started = await call('server/start', { port: appiumPort });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.ok((await fetch(`http://127.0.0.1:${appiumPort}/wd/hub/status`)).ok, 'the server answers under the base path');
  assert.equal((await fetch(`http://127.0.0.1:${appiumPort}/status`)).status, 404, 'and not at the root');
  assert.equal((await call('status')).body.server.server.state, 'running');
  assert.equal((await call('server/settings', { basePath: '/' })).body.code, 'SERVER_ACTIVE', 'the base path cannot change under a running server');
  assert.equal((await call('server/stop', {})).status, 200);
});

test('automatic restart: an owned Appium that is killed comes back on the same port', async (t) => {
  const { call } = await startVortex(t);
  const appiumPort = await freePort();
  await call('server/settings', { appiumPath: fakeAppium, port: appiumPort, autoRestart: true });
  assert.equal((await call('server/start', { port: appiumPort })).status, 200);
  const first = (await call('status')).body.server.server.pid as number;
  process.kill(first, 'SIGKILL');
  let now: Record<string, any> | null = null;
  for (let i = 0; i < 80; i++) {
    now = (await call('status')).body.server;
    if (now!.server?.state === 'running' && now!.server.pid !== first && now!.notices.some((n: string) => n.includes('restarted automatically'))) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(now!.server.state, 'running', JSON.stringify(now!.notices));
  assert.notEqual(now!.server.pid, first);
  assert.ok(now!.notices.some((n: string) => n.includes('restarted automatically')));
  assert.ok((await fetch(`http://127.0.0.1:${appiumPort}/status`)).ok);
  assert.equal((await call('server/stop', {})).status, 200, 'a manual stop still works and is final');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal((await call('status')).body.server.connected, false, 'no restart after a manual stop');
  await assert.rejects(fetch(`http://127.0.0.1:${appiumPort}/status`), 'the port stays closed');
});

test('live status: the event stream reports a change when the server state changes', async (t) => {
  const { base, call } = await startVortex(t);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const stream = await fetch(base + '/api/events', { signal: abort.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = stream.body!.getReader();
  let text = '';
  const until = async (pattern: RegExp, ms: number) => {
    const end = Date.now() + ms;
    while (!pattern.test(text) && Date.now() < end) {
      const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), end - Date.now()))]);
      if (!chunk || chunk.done) break;
      text += Buffer.from(chunk.value).toString('utf8');
    }
    return pattern.test(text);
  };
  assert.ok(await until(/retry: 2000/, 3000), 'the stream opens');
  await call('server/settings', { stopOwnedOnExit: true });
  assert.ok(await until(/event: change/, 5000), `a change is announced after a setting is saved; got: ${text}`);
  const unknown = await call('nothing-here', {});
  assert.equal(unknown.status, 404);
  assert.equal((await fetch(base + '/api/server/start')).status, 405, 'a known path with the wrong method is refused as such');
});
