import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Application } from '../../src/application.ts';
import { detectPython } from '../../src/engines/appium/python-env.ts';
import { MockAppium } from '../../src/simulator/mock-appium.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const python = await detectPython();
process.env.VORTEX_TIMEOUT = '1';
process.env.VORTEX_STABLE_MS = '0';

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vortex-reliability-'));
  const mock = new MockAppium(); await mock.listen(0);
  const app = new Application(root, path.join(temp, 'generated'), path.join(temp, 'state'));
  app.mock = true; await app.init();
  await app.manager.connectExisting({ host: '127.0.0.1', port: mock.port });
  await app.start('mock-device', 'com.yourname.tradehub');
  t.after(async () => { await app.shutdown(); await mock.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  return { app, mock, temp };
}
const byId = (app: Application, suffix: string) => app.snapshot!.nodes.find(n => n.resourceId.endsWith(suffix))!.index;
const act = (app: Application, type: string, extra: Record<string, unknown> = {}) => app.action({ token: app.snapshot!.token, type, ...extra });

test('recorded evidence is verified, navigation suggestions are opt-in, and rejected suggestions are not generated', async t => {
  const { app } = await setup(t);
  await act(app, 'launch_app');
  await act(app, 'tap', { index: byId(app, 'home_my_products_button') });
  const event = app.steps[1];
  assert.equal(event.reliability?.locator?.matches, 1);
  assert.ok(event.reliability?.attributes?.id);
  assert.notEqual(event.reliability?.before.identity, event.reliability?.after?.identity);
  assert.ok(event.screen?.activity);
  assert.equal(event.reliability?.suggestions.length, 1);
  const preview = app.build({ name: 'navigation', mode: 'plain' });
  assert.equal(preview.recording.events.length, 2);
  assert.equal(preview.validation.ok, true);
  app.recording.approveSuggestion(1, event.reliability!.suggestions[0].id);
  assert.equal(app.steps[2].type, 'assert');
  assert.equal(app.steps[2].args?.assertion, 'visible');
  assert.equal(app.build({ name: 'navigation' }).recording.events.length, 3);
});

for (const mode of ['plain', 'pom'] as const) test(`${mode}: checkpoint playback is partial; full replay fails on missing target with step artifacts and closes its session`, { skip: !python.ok && 'Python/Appium client required', timeout: 90_000 }, async t => {
  const { app, mock } = await setup(t);
  await act(app, 'launch_app');
  await act(app, 'checkpoint', { args: { name: 'home' } });
  await act(app, 'assert', { index: byId(app, 'home_my_products_button'), args: { assertion: 'visible' } });
  const saved = app.save({ name: `checkpoint ${mode}`, module: 'reliability', mode, reliability: { timeoutSec: 1, maxScrolls: 3, stableMs: 0, suggestNavigation: true } });
  await assert.rejects(() => app.run({ ...saved.ref, stopAfterStep: 3 }), /saved checkpoint/);
  mock.renameId('home_my_products_button', 'renamed_products');
  const partial = await app.run({ ...saved.ref, stopAfterStep: 2 });
  const passed = await app.runner.wait(partial.id);
  assert.equal(passed.status, 'passed', JSON.stringify(passed));
  assert.equal(passed.stopAfterStep, 2);
  assert.match(passed.summary, /partial run/);
  assert.equal(mock.sessions.size, 0);
  const full = await app.run(saved.ref);
  const failed = await app.runner.wait(full.id);
  assert.equal(failed.status, 'failed', JSON.stringify(failed));
  assert.equal(failed.stopAfterStep, undefined);
  assert.match(failed.failed[0]?.step ?? '', /^3\./);
  const run = app.runner.get(full.id);
  const json = fs.readdirSync(run.dir).find(f => /^failure-step-3-.*\.json$/.test(f));
  assert.ok(json, JSON.stringify(failed.artifacts));
  const evidence = JSON.parse(fs.readFileSync(path.join(run.dir, json), 'utf8'));
  assert.equal(evidence.step, 3);
  assert.equal(evidence.context, 'NATIVE_APP');
  assert.match(evidence.locator[1], /home_my_products_button/);
  assert.ok(evidence.package && evidence.activity && evidence.source && evidence.screenshot);
  assert.equal(mock.sessions.size, 0, 'failure cleanup closed the session');
});

for (const mode of ['plain', 'pom'] as const) test(`${mode}: exported Native → WebView → Native replay executes against the Chromium-backed fixture`, { skip: !python.ok && 'Python/Appium client required', timeout: 90_000 }, async t => {
  const { app, mock } = await setup(t);
  await act(app, 'launch_app');
  await act(app, 'tap', { index: byId(app, 'home_market_card') });
  assert.ok(app.snapshot!.web, app.snapshot!.webMessage);
  const input = app.snapshot!.web!.nodes.find(n => n.tag === 'input')!;
  const inspected = await app.inspect({ token: app.snapshot!.token, context: 'WEBVIEW', index: input.i });
  const css = inspected.candidates.find(c => c.using === 'css selector')!;
  await act(app, 'type', { context: 'WEBVIEW', index: input.i, using: css.using, value: css.value, args: { text: 'steel' } });
  await act(app, 'assert', { context: 'WEBVIEW', index: app.snapshot!.web!.nodes.find(n => n.tag === 'input')!.i, using: css.using, value: css.value, args: { assertion: 'visible' } });
  const page = await mock.webPage();
  function installScrollBox() {
    if (!document.body) { document.addEventListener('DOMContentLoaded', installScrollBox, { once: true }); return; }
    if (document.getElementById('vortex-scroll-box')) return;
    const box = document.createElement('div'); box.id = 'vortex-scroll-box';
    box.style.cssText = 'position:fixed;top:20px;left:20px;width:200px;height:120px;overflow:auto;z-index:999;background:white';
    const spacer = document.createElement('div'); spacer.style.height = '420px';
    const review = document.createElement('button'); review.id = 'vortex-review'; review.textContent = 'Review regression';
    box.append(spacer, review); document.body.append(box);
  }
  await page.addInitScript(installScrollBox);
  await page.evaluate(installScrollBox);
  await app.capture();
  await act(app, 'scroll_to', { context: 'WEBVIEW', scrollTarget: { by: 'css', value: '#vortex-review' }, args: { scrollContainer: { by: 'css', value: '#vortex-scroll-box' }, direction: 'down' } });
  assert.ok(await page.locator('#vortex-scroll-box').evaluate((el: { scrollTop: number }) => el.scrollTop > 0), 'recorder scrolls a displayed but clipped DOM target');
  await act(app, 'press', { args: { key: 'BACK' } });
  await act(app, 'assert', { index: byId(app, 'home_my_products_button'), args: { assertion: 'visible' } });
  const saved = app.save({ name: `web replay ${mode}`, module: 'reliability', mode });
  await page.locator('#vortex-scroll-box').evaluate((el: { scrollTop: number }) => { el.scrollTop = 0; });
  assert.ok(saved.recording.events.some(e => e.context === 'WEBVIEW'));
  const run = await app.run(saved.ref);
  const result = await app.runner.wait(run.id);
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.ok(await page.locator('#vortex-scroll-box').evaluate((el: { scrollTop: number }) => el.scrollTop > 0), 'exported helper scrolls the selected WebView container');
  assert.equal(mock.sessions.size, 0);
});
