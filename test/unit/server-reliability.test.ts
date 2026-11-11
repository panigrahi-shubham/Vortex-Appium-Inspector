/**
 * Feature: Appium server reliability (0.2.0): identity lookup failures, busy ports, child environment,
 *          setup check, session failure hints, Android SDK detection
 * Layer: Unit — node:test
 * Real: ServerManager, preflight, session-hints, android-env
 * Mocked: Operating system and Appium HTTP (FakeOS), file system and commands for the setup check
 * Guards: Reporting a live Appium as "exited immediately", leaving an unowned Appium on the port,
 *         a dead-end "port in use" error, raw driver errors with no next step
 * Run: npm run test:unit
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appiumChildEnv, detectAndroidSdk } from '../../src/appium/android-env.ts';
import type { AppiumInstall } from '../../src/appium/appium-locator.ts';
import { formatPreflight, javaMajor, runPreflight, type PreflightDeps } from '../../src/appium/preflight.ts';
import { ManagerError, ServerManager } from '../../src/appium/server-manager.ts';
import { explainSessionError } from '../../src/appium/session-hints.ts';
import { createMemoryStateStore, DEFAULT_SETTINGS } from '../../src/appium/state-store.ts';
import { FakeOS } from './fake-os.ts';

const INSTALL: AppiumInstall = { entry: '/opt/appium/index.js', version: '3.9.0', source: 'configured' };

function setup(os = new FakeOS(), childEnv?: () => { env: NodeJS.ProcessEnv; note: string | null }) {
  const store = createMemoryStateStore();
  store.current.settings = { ...DEFAULT_SETTINGS, stopGraceMs: 1_000, serverStartupTimeoutMs: 5_000 };
  const m = new ServerManager({ store, inspector: os, http: os.http, locate: async () => INSTALL, spawn: os.spawn, nodePath: 'node', logDir: '/tmp/vortex-test-logs', pollMs: 5, childEnv: childEnv ?? (() => ({ env: {}, note: null })) });
  return { os, store, m };
}
const code = (c: string) => (e: unknown) => e instanceof ManagerError && e.code === c;

// Risk: A slow process lookup (PowerShell on Windows) is reported as "Appium exited immediately".
// Given the lookup fails many times while the process is alive, When Start runs, Then it keeps waiting and succeeds.
test('a slow identity lookup does not fail the start', async () => {
  const { os, store, m } = setup();
  os.infoFailures = 26; // more than the first 25 attempts
  const r = await m.start({ port: 4723 });
  assert.equal(r.reused, false);
  assert.equal((await m.status()).server?.state, 'running');
  assert.equal(store.current.owned.length, 1);
});

// Risk: Appium keeps running with no ownership record, holding the port, so every later Start fails.
// Given the lookup never works, When Start runs, Then the spawned process is ended and the error says why.
test('when identity is never available the spawned Appium is stopped, not orphaned', async () => {
  const { os, store, m } = setup();
  os.infoFailures = Number.POSITIVE_INFINITY;
  await assert.rejects(m.start({ port: 4723 }), (e: unknown) => {
    assert.ok(e instanceof ManagerError);
    assert.equal(e.code, 'IDENTITY_UNAVAILABLE');
    assert.equal(e.details.stopped, true);
    assert.match(e.message, /was stopped/);
    return true;
  });
  assert.equal(os.ports.has(4723), false, 'the port is released');
  assert.equal(store.current.owned.length, 0, 'no ownership record for a process that is gone');
  assert.equal((await m.status()).connected, false);
  os.infoFailures = 0;
  assert.equal((await m.start({ port: 4723 })).reused, false, 'a later start works');
});

// Risk: The process cannot be ended either; the tester must be told exactly what is left running.
test('when the spawned Appium cannot be stopped the error names the PID to end', async () => {
  const { os, m } = setup();
  os.infoFailures = Number.POSITIVE_INFINITY;
  os.childIgnoresKill = true;
  await assert.rejects(m.start({ port: 4723 }), (e: unknown) => {
    assert.ok(e instanceof ManagerError && e.code === 'IDENTITY_UNAVAILABLE');
    assert.equal(e.details.stopped, false);
    assert.match(e.message, /end PID \d+ yourself/);
    return true;
  });
});

// Risk: "Port in use" leaves the tester guessing which port to try.
test('a busy port reports the owner and the next free port', async () => {
  const { os, m } = setup();
  os.addProcess('some-other-program', 4723);
  os.addProcess('another-program', 4724);
  await assert.rejects(m.start({ port: 4723 }), (e: unknown) => {
    assert.ok(e instanceof ManagerError && e.code === 'PORT_IN_USE');
    assert.equal(e.details.suggestedPort, 4725);
    assert.match(e.message, /Port 4725 is free/);
    return true;
  });
  assert.equal((await m.start({ port: 4725 })).reused, false);
});

// Risk: An external Appium on the port is stopped or replaced. It must only be offered for connecting.
test('an external Appium on the port is reported for connecting, never replaced', async () => {
  const { os, m } = setup();
  const ext = os.addProcess('node appium', 4723, '3.9.0');
  await assert.rejects(m.start({ port: 4723 }), code('PORT_HAS_EXTERNAL_APPIUM'));
  assert.equal(os.spawns.length, 0);
  assert.ok(os.procs.has(ext.pid));
  assert.equal((await m.connectExisting({ port: 4723 })).ownership, 'external');
  assert.deepEqual(await m.disconnect(), { ok: true });
  assert.ok(os.procs.has(ext.pid), 'disconnect leaves the external server running');
});

// Risk: Appium started by Vortex cannot find the Android SDK although it is installed.
test('the Appium child receives the detected Android SDK and the reason is noted', async () => {
  const { os, m } = setup(new FakeOS(), () => ({ env: { ANDROID_HOME: 'C:\\Sdk', ANDROID_SDK_ROOT: 'C:\\Sdk' }, note: 'ANDROID_HOME was not set; passing the Android SDK found at C:\\Sdk (default folder) to Appium' }));
  await m.start({ port: 4723 });
  assert.equal(os.spawns[0].env?.ANDROID_HOME, 'C:\\Sdk');
  assert.ok((await m.status()).notices.some((n) => n.includes('passing the Android SDK')));
});

// ---- Android SDK detection ----

test('Android SDK: the variable wins, then adb on PATH, then the default folder', () => {
  const files = new Set(['C:\\Sdk\\platform-tools', 'C:\\Sdk\\platform-tools\\adb.exe', 'D:\\tools\\platform-tools\\adb.exe', 'C:\\Users\\me\\AppData\\Local\\Android\\Sdk\\platform-tools']);
  const exists = (p: string) => files.has(p);
  assert.deepEqual(detectAndroidSdk({ env: { ANDROID_HOME: 'C:\\Sdk' }, platform: 'win32', exists, home: 'C:\\Users\\me' }), { home: 'C:\\Sdk', source: 'ANDROID_HOME', adb: 'C:\\Sdk\\platform-tools\\adb.exe' });
  assert.deepEqual(detectAndroidSdk({ env: { PATH: 'C:\\Windows;D:\\tools\\platform-tools' }, platform: 'win32', exists, home: 'C:\\Users\\me' }), { home: 'D:\\tools', source: 'adb on PATH', adb: 'D:\\tools\\platform-tools\\adb.exe' });
  assert.equal(detectAndroidSdk({ env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, platform: 'win32', exists, home: 'C:\\Users\\me' }).source, 'default folder');
  assert.deepEqual(detectAndroidSdk({ env: {}, platform: 'win32', exists: () => false, home: 'C:\\Users\\me' }), { home: null, source: null, adb: null });
});

test('Android SDK: a variable pointing at a folder without platform-tools is not trusted', () => {
  const r = detectAndroidSdk({ env: { ANDROID_HOME: '/wrong' }, platform: 'linux', exists: (p) => p === '/home/me/Android/Sdk/platform-tools', home: '/home/me' });
  assert.equal(r.home, '/home/me/Android/Sdk');
  const child = appiumChildEnv({ env: { ANDROID_HOME: '/wrong' }, platform: 'linux', exists: (p) => p === '/home/me/Android/Sdk/platform-tools', home: '/home/me' });
  assert.equal(child.env.ANDROID_HOME, '/home/me/Android/Sdk');
  assert.match(child.note ?? '', /passing the Android SDK/);
});

test('Android SDK: nothing is changed when the variable is already correct', () => {
  const child = appiumChildEnv({ env: { ANDROID_HOME: '/sdk', OTHER: 'x' }, platform: 'linux', exists: (p) => p === '/sdk/platform-tools', home: '/home/me' });
  assert.equal(child.note, null);
  assert.equal(child.env.ANDROID_HOME, '/sdk');
  assert.equal(child.env.OTHER, 'x');
});

// ---- setup check ----

function preflightDeps(over: Partial<PreflightDeps> = {}): PreflightDeps {
  const files = new Set(['/sdk/platform-tools', '/sdk/platform-tools/adb', '/home/me/.appium/node_modules/appium-uiautomator2-driver/package.json', '/jdk/bin/java']);
  return {
    env: { ANDROID_HOME: '/sdk', JAVA_HOME: '/jdk' },
    platform: 'linux',
    nodeVersion: '24.15.0',
    exists: (p) => files.has(p),
    readFile: () => JSON.stringify({ version: '5.0.3' }),
    home: '/home/me',
    projectRoot: '/project',
    exec: async (file) => (file.endsWith('adb') ? { stdout: 'Android Debug Bridge version 1.0.41\n', stderr: '' } : { stdout: '', stderr: 'openjdk version "17.0.9" 2023-10-17\n' }),
    locateAppium: async () => INSTALL,
    python: async () => ({ ok: true, version: '3.12.1', problems: [], installCommand: null }),
    devices: async () => [{ serial: 'R58M1234', state: 'device', model: 'SM-A525F' }],
    port: async () => ({ port: 4723, state: 'free' }),
    ...over,
  };
}

test('setup check: a complete machine is all OK', async () => {
  const r = await runPreflight(preflightDeps());
  assert.deepEqual(r.checks.map((c) => `${c.id}:${c.status}`), ['node:ok', 'appium:ok', 'driver:ok', 'android-sdk:ok', 'adb:ok', 'java:ok', 'python:ok', 'device:ok', 'port:ok']);
  assert.equal(r.ok, true);
  assert.equal(r.blocked, false);
  assert.match(formatPreflight(r), /Everything needed/);
});

test('setup check: each missing piece names its fix', async () => {
  const r = await runPreflight(
    preflightDeps({
      nodeVersion: '22.20.0',
      env: {},
      exists: () => false,
      locateAppium: async () => {
        throw new Error('Appium is not installed. Install it with npm.');
      },
      python: async () => ({ ok: false, version: null, problems: ['pytest is not installed.'], installCommand: 'py -3 -m pip install -r requirements-appium.txt' }),
      devices: async () => [{ serial: 'R58M1234', state: 'unauthorized' }],
      port: async () => ({ port: 4723, state: 'busy', pids: [4321] }),
    }),
  );
  const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
  assert.equal(by.node.status, 'warn');
  assert.equal(by.appium.fix, 'npm install -g appium');
  assert.equal(by.driver.fix, 'appium driver install uiautomator2');
  assert.equal(by['android-sdk'].status, 'fail');
  assert.equal(by.adb.status, 'fail');
  assert.equal(by.java.status, 'fail');
  assert.match(by.python.fix, /pip install/);
  assert.match(by.device.fix, /Allow USB debugging/);
  assert.match(by.port.detail, /PID 4321/);
  assert.equal(r.blocked, true);
});

test('setup check: a detected SDK and an external Appium are warnings, and a broken check never throws', async () => {
  const files = new Set(['/home/me/Android/Sdk/platform-tools', '/home/me/Android/Sdk/platform-tools/adb', '/home/me/.appium/node_modules/appium-uiautomator2-driver/package.json', '/jdk/bin/java']);
  const r = await runPreflight(
    preflightDeps({
      env: { JAVA_HOME: '/jdk' },
      exists: (p) => files.has(p),
      port: async () => ({ port: 4723, state: 'external', version: '3.9.0' }),
      devices: async () => {
        throw new Error('adb crashed');
      },
    }),
  );
  const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
  assert.equal(by['android-sdk'].status, 'warn');
  assert.match(by['android-sdk'].detail, /Vortex passes it to the Appium server/);
  assert.equal(by.port.status, 'warn');
  assert.match(by.port.fix, /Connect existing/);
  assert.equal(by.device.status, 'warn');
  assert.match(by.device.detail, /adb crashed/);
});

test('java version parsing covers old and new formats', () => {
  assert.equal(javaMajor('openjdk version "17.0.9" 2023-10-17'), 17);
  assert.equal(javaMajor('java version "1.8.0_292"'), 8);
  assert.equal(javaMajor('openjdk version "21" 2023-09-19'), 21);
  assert.equal(javaMajor('not java'), null);
});

// ---- attach failure hints ----

test('attach failures are explained from the text Appium prints; unknown text stays unexplained', () => {
  const cases: [string, string][] = [
    ["Could not find a driver for automationName 'UiAutomator2' and platformName 'Android'", 'DRIVER_MISSING'],
    ['Neither ANDROID_HOME nor ANDROID_SDK_ROOT environment variable was exported', 'ANDROID_SDK_MISSING'],
    ["Device R58M1234 was not in the list of connected devices", 'DEVICE_NOT_FOUND'],
    ['adb: device unauthorized. This adb server\'s $ADB_VENDOR_KEYS is not set', 'DEVICE_UNAUTHORIZED'],
    ['Failure [INSTALL_FAILED_USER_RESTRICTED: Install canceled by user]', 'INSTALL_BLOCKED'],
    ['The instrumentation process cannot be initialized. Make sure the application under test does not crash', 'INSTRUMENTATION_FAILED'],
    ['No Chromedriver found that can automate Chrome \'120.0.6099\'', 'CHROMEDRIVER_MISMATCH'],
    ['POST /session did not answer within 120 s', 'SESSION_TIMEOUT'],
  ];
  for (const [message, expected] of cases) assert.equal(explainSessionError(message)?.code, expected, message);
  assert.equal(explainSessionError('Something entirely new happened'), null);
  assert.match(explainSessionError(cases[0][0])!.hint, /appium driver install uiautomator2/);
});

// ---- base path and automatic restart (1.0.0) ----

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 3_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(5);
  }
  assert.fail('condition was not reached in time');
}

test('base path: validated, passed to Appium, and part of the session URL', async () => {
  const { os, m } = setup();
  await assert.rejects(m.updateSettings({ basePath: 'wd/hub' }), code('INVALID_SETTING'));
  await assert.rejects(m.updateSettings({ basePath: '/wd/hub?x=1' }), code('INVALID_SETTING'));
  assert.equal((await m.updateSettings({ basePath: '/wd/hub/' })).basePath, '/wd/hub');
  await m.start({ port: 4723 });
  const args = os.spawns[0].args;
  assert.equal(args[args.indexOf('--base-path') + 1], '/wd/hub');
  const ep = m.endpoint()!;
  assert.equal(ep.url, 'http://127.0.0.1:4723/wd/hub');
  await assert.rejects(m.updateSettings({ basePath: '/' }), code('SERVER_ACTIVE'));
  await m.stop();
  assert.equal((await m.updateSettings({ basePath: '' })).basePath, '/');
  await m.start({ port: 4723 });
  assert.equal(os.spawns[1].args.includes('--base-path'), false, 'the default base path adds no argument');
  assert.equal(m.endpoint()!.url, 'http://127.0.0.1:4723');
});

// Risk: A crashed server stays dead until the tester notices.
test('automatic restart: off by default; when on, an owned server that dies is started again', async () => {
  const { os, m } = setup();
  await m.start({ port: 4723 });
  os.exit((await m.status()).server!.pid!, 1);
  await sleep(120);
  assert.equal((await m.status()).server?.state, 'exited', 'nothing restarts unless the setting is on');
  assert.equal(os.spawns.length, 1);

  await m.updateSettings({ autoRestart: true });
  await m.start({ port: 4723 });
  const pid = (await m.status()).server!.pid!;
  os.exit(pid, 1);
  await until(async () => (await m.status()).server?.state === 'running');
  const st = await m.status();
  assert.notEqual(st.server!.pid, pid);
  assert.ok(st.notices.some((n) => n.includes('restarted automatically')));
  assert.equal(os.spawns.length, 3);
});

// Risk: A server that cannot start is restarted forever.
test('automatic restart: gives up after 3 failed attempts and says so', async () => {
  const { os, m } = setup();
  await m.updateSettings({ autoRestart: true });
  await m.start({ port: 4723 });
  os.spawnBehaviour = 'exit-immediately';
  os.exit((await m.status()).server!.pid!, 1);
  await until(async () => (await m.status()).notices.some((n) => n.includes('gave up after 3 attempts')), 6_000);
  assert.equal(os.spawns.length, 4, 'one start and exactly three restart attempts');
  await sleep(400);
  assert.equal(os.spawns.length, 4, 'no further attempts');
});

// Risk: An automatic restart fights the tester, or touches a server Vortex does not own.
test('automatic restart: a manual stop is final, and an external server is never restarted', async () => {
  const { os, m } = setup();
  await m.updateSettings({ autoRestart: true });
  await m.start({ port: 4723 });
  await m.stop();
  await sleep(150);
  assert.equal(os.spawns.length, 1, 'stopping on purpose does not trigger a restart');

  const ext = os.addProcess('node appium', 4800, '3.9.0');
  await m.connectExisting({ port: 4800 });
  os.exit(ext.pid, 1);
  await m.checkHealth();
  await m.checkHealth();
  await sleep(150);
  assert.equal(os.spawns.length, 1, 'Vortex never starts a replacement for an external server');
});
