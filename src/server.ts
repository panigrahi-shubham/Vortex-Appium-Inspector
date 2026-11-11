// Loopback-only HTTP server: the browser UI, the JSON API and a server-sent event stream for live status.
//
// Every API call goes through one route table. A route marked `exclusive` runs in the application's
// serial queue, so two requests can never drive the phone or change the recording at the same time.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAppiumPackage } from './appium/appium-locator.ts';
import { Application, problem } from './application.ts';
import { checkLocalRequest } from './http-guard.js';
import { acquireRecorderOwner } from './recorder-owner.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => (args.includes(`--${name}`) ? (args[args.indexOf(`--${name}`) + 1] ?? fallback) : fallback);
const port = Number(opt('port', process.env.PORT || '4701'));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid --port');
const mockMode = args.includes('--mock');
const app = new Application(root, path.resolve(root, opt('out', 'generated')), path.resolve(root, opt('state-dir', '.vortex')));
app.mock = mockMode;

let mock: { close(): Promise<void> } | null = null;
let owner: Awaited<ReturnType<typeof acquireRecorderOwner>> | null = null;
let ready = false;

const json = (res: http.ServerResponse, code: number, data: unknown) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 2_000_000) throw problem('Request is too large.', 'TOO_LARGE', 413);
  }
  const value: unknown = JSON.parse(text || '{}');
  if (!value || Array.isArray(value) || typeof value !== 'object') throw problem('Expected a JSON object.');
  return value as Record<string, unknown>;
}

// ---- routes ------------------------------------------------------------------------------------

type Body = Record<string, unknown>;
interface Route {
  method: 'GET' | 'POST';
  path: string | RegExp;
  /** Runs in the serial queue (everything that touches the phone, the server or the recording). */
  exclusive?: boolean;
  run: (body: Body, url: URL) => unknown;
}

const appiumPort = (body: Body) => Number(body.port || app.manager.settings.port);

/** Closes the Inspector session before the Appium server under it is stopped, restarted or left. */
async function releaseSession() {
  await app.session.stop();
}

/** Only the settings that were sent are changed; each one is validated (here or by the server manager). */
function settingsPatch(body: Body) {
  const patch: Record<string, unknown> = {};
  for (const k of ['port', 'serverStartupTimeoutMs', 'sessionStartupTimeoutMs', 'sessionIdleTimeoutSec']) if (body[k] !== undefined && body[k] !== '') patch[k] = Number(body[k]);
  for (const k of ['stopOwnedOnExit', 'keepWarm', 'autoRestart']) if (typeof body[k] === 'boolean') patch[k] = body[k];
  for (const k of ['appiumPath', 'chromedriverExecutable', 'chromedriverExecutableDir', 'basePath']) if (body[k] !== undefined) patch[k] = String(body[k]);
  if (patch.appiumPath && !readAppiumPackage(String(patch.appiumPath))) {
    throw problem(`"${String(patch.appiumPath)}" is not an Appium package. Enter the appium folder (the one containing package.json) or its entry file, or leave it empty to find Appium automatically.`, 'APPIUM_PATH_INVALID', 400);
  }
  return patch;
}

const routes: Route[] = [
  { method: 'GET', path: '/api/health', run: () => ({ name: 'vortex-appium-inspector', ready: true }) },
  { method: 'GET', path: '/api/status', exclusive: true, run: () => app.status() },
  { method: 'GET', path: '/api/devices', run: () => (mockMode ? [{ serial: 'mock-device', model: 'TradeHub simulated phone', state: 'device' }] : app.devices.list()) },
  { method: 'GET', path: '/api/python', run: () => app.python() },
  { method: 'GET', path: '/api/preflight', run: () => app.preflight() },
  { method: 'GET', path: '/api/server/logs', run: (_b, url) => app.serverLogs(url.searchParams.get('lines')) },
  { method: 'GET', path: /^\/api\/runs\/[\w-]+$/, run: (_b, url) => app.runner.get(url.pathname.split('/').pop()!) },

  // Appium server
  { method: 'POST', path: '/api/server/start', exclusive: true, run: (b) => app.manager.start({ host: '127.0.0.1', port: appiumPort(b) }) },
  { method: 'POST', path: '/api/server/connect', exclusive: true, run: (b) => app.manager.connectExisting({ host: '127.0.0.1', port: appiumPort(b) }) },
  { method: 'POST', path: '/api/server/settings', exclusive: true, run: (b) => app.manager.updateSettings(settingsPatch(b)) },
  { method: 'POST', path: '/api/server/disconnect', exclusive: true, run: async () => (await releaseSession(), app.manager.disconnect()) },
  { method: 'POST', path: '/api/server/restart', exclusive: true, run: async () => (await releaseSession(), app.manager.restart()) },
  { method: 'POST', path: '/api/server/stop', exclusive: true, run: async () => (await releaseSession(), app.manager.stop()) },

  // Inspector session and screen
  {
    method: 'POST',
    path: '/api/session/start',
    exclusive: true,
    run: async (b) => {
      // One recorder per computer may drive a real phone; the simulated device needs no such lock.
      if (!mockMode && !owner) owner = await acquireRecorderOwner();
      return app.start(String(b.serial || ''), String(b.pkg || ''));
    },
  },
  { method: 'POST', path: '/api/session/stop', exclusive: true, run: () => app.session.stop() },
  { method: 'POST', path: '/api/screen', exclusive: true, run: (b) => app.capture(b.autoWeb !== false, b.context ? String(b.context) : undefined) },

  // Locators
  { method: 'POST', path: '/api/inspect', exclusive: true, run: (b) => app.inspect(b) },
  { method: 'POST', path: '/api/inspect/verify', exclusive: true, run: (b) => app.verifyOne(b) },
  { method: 'POST', path: '/api/locator/search', exclusive: true, run: (b) => app.search(b) },

  // Recording
  { method: 'POST', path: '/api/action', exclusive: true, run: (b) => app.action(b) },
  { method: 'POST', path: '/api/recording/undo', exclusive: true, run: () => app.undo() },
  { method: 'POST', path: '/api/recording/clear', exclusive: true, run: () => app.clear() },
  { method: 'POST', path: '/api/recording/delete', exclusive: true, run: (b) => app.deleteStep(b.index) },
  { method: 'POST', path: '/api/recording/move', exclusive: true, run: (b) => app.moveStep(b.from, b.to) },
  { method: 'POST', path: '/api/recording/edit', exclusive: true, run: (b) => app.editStep(b.index, b.value) },

  // Saved tests
  { method: 'POST', path: '/api/generate', exclusive: true, run: (b) => app.build(b) },
  { method: 'POST', path: '/api/save', exclusive: true, run: (b) => app.save(b) },
  { method: 'POST', path: '/api/load', exclusive: true, run: (b) => app.load({ module: b.module, case: b.case }) },
  { method: 'POST', path: '/api/screen-page', exclusive: true, run: (b) => app.screenPage(b) },
  { method: 'POST', path: '/api/run', exclusive: true, run: (b) => app.run({ module: b.module, case: b.case }) },
  { method: 'POST', path: '/api/cancel', exclusive: true, run: (b) => app.runner.cancel(String(b.id)) },
  { method: 'POST', path: '/api/repair/suggest', exclusive: true, run: (b) => app.repairSuggest(b) },
  { method: 'POST', path: '/api/repair/apply', exclusive: true, run: (b) => app.repairApply(b) },
];

const matches = (r: Route, method: string, pathname: string) => r.method === method && (typeof r.path === 'string' ? r.path === pathname : r.path.test(pathname));

// ---- live status (server-sent events) ----------------------------------------------------------
// The stream carries no data, only "something changed": the page then reads /api/status as usual.

const streams = new Set<http.ServerResponse>();
let pending: NodeJS.Timeout | null = null;
function announce() {
  if (pending || !streams.size) return;
  pending = setTimeout(() => {
    pending = null;
    for (const res of streams) res.write(`event: change\ndata: ${Date.now()}\n\n`);
  }, 100);
  pending.unref();
}
app.onChange(announce);

function openStream(req: http.IncomingMessage, res: http.ServerResponse) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
  streams.add(res);
  req.on('close', () => streams.delete(res));
}

// Changes nobody announces (a health check that turns "running" into "unhealthy", a run that ends) are found here.
let lastSignature = '';
const watcher = setInterval(async () => {
  if (!ready || !streams.size) return;
  try {
    const s = await app.manager.status();
    const signature = JSON.stringify([s.server?.state, s.server?.pid, s.server?.port, s.server?.exit?.at, s.notices.length, app.inspector.status().open, app.runner.active().map((r) => r.id)]);
    if (signature !== lastSignature) {
      lastSignature = signature;
      announce();
    }
  } catch {
    /* the next tick tries again */
  }
}, 2_000);
watcher.unref();
const heartbeat = setInterval(() => {
  for (const res of streams) res.write(': keep-alive\n\n');
}, 25_000);
heartbeat.unref();

// ---- static files --------------------------------------------------------------------------------

const ASSETS: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'";

// ---- request handling ------------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const denied = checkLocalRequest(req, port);
    if (denied) return json(res, 403, { error: denied });
    if (!ready) return json(res, 503, { error: 'Recorder is starting. Retry shortly.' });
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/api/events') return openStream(req, res);

    if (url.pathname.startsWith('/api/')) {
      const route = routes.find((r) => matches(r, method, url.pathname));
      if (!route) {
        if (routes.some((r) => matches(r, r.method, url.pathname))) throw problem('Method not allowed.', 'METHOD', 405);
        throw problem('Unknown endpoint.', 'NOT_FOUND', 404);
      }
      const body = method === 'POST' ? await readBody(req) : {};
      try {
        const out = route.exclusive ? await app.exclusive(async () => route.run(body, url)) : await route.run(body, url);
        return json(res, 200, out);
      } finally {
        // A POST may have changed something even when it failed (a start that left an "exited" server, say).
        if (method === 'POST') app.changed();
      }
    }

    if (method !== 'GET' && method !== 'HEAD') throw problem('Method not allowed.', 'METHOD', 405);
    const asset = ASSETS[url.pathname];
    if (!asset) throw problem('Not found.', 'NOT_FOUND', 404);
    res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP });
    res.end(method === 'HEAD' ? undefined : fs.readFileSync(path.join(root, 'public', asset.file)));
  } catch (e) {
    // One error shape for every route. `details` carries evidence such as the Appium log tail or a free port.
    const err = e as Error & { httpStatus?: number; code?: string; hint?: string; issues?: unknown; steps?: unknown; applied?: boolean; details?: Record<string, unknown> };
    if (res.headersSent) return void res.end();
    json(res, err.httpStatus || 500, { error: err.message, code: err.code, hint: err.hint ?? err.details?.hint, details: err.details, issues: err.issues, steps: err.steps, applied: err.applied });
  }
});

// ---- start and stop ------------------------------------------------------------------------------

try {
  // Bind before recovering state, so duplicate starts cannot disturb the live instance.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await app.init();
  if (mockMode) {
    const { MockAppium } = await import('./simulator/mock-appium.ts');
    const fake = new MockAppium();
    await fake.listen(0);
    mock = fake;
    app.pkg = 'com.yourname.tradehub';
    await app.manager.connectExisting({ host: '127.0.0.1', port: fake.port });
    console.log('[vortex] SIMULATED TradeHub device. No phone is controlled.');
  }
  ready = true;
  console.log(`[vortex] Appium Inspector: http://127.0.0.1:${port}`);
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.error(err.code === 'EADDRINUSE' ? `[vortex] Port ${port} is occupied. Open the existing recorder or use --port 4702.` : err.message);
  server.close();
  app.manager.stopWatchdog();
  process.exitCode = 1;
}

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  ready = false;
  clearInterval(watcher);
  clearInterval(heartbeat);
  for (const res of streams) res.end(); // open event streams would keep the server from closing
  streams.clear();
  server.close();
  await app.exclusive(() => app.shutdown()).catch(console.error);
  await mock?.close();
  owner?.close();
}
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
