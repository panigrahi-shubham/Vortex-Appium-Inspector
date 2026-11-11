/**
 * Feature: 0.2.0 speed features — instant locator ranking, live locator search, chosen locators,
 *          whole-screen page objects, secret inputs, step editing, autosave
 * Layer: Integration — node:test, the real Application against the simulated Appium device
 * Real: Application, inspector, locator ranking and search, code generation, Python (py_compile and pytest)
 * Mocked: The Appium server and phone (src/simulator/mock-appium.ts)
 * Guards: Device round trips on select, secrets written to disk, losing an unsaved recording,
 *         generated tests ignoring the locator the tester chose
 * Run: npm run test:integration
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Application } from '../../src/application.ts';
import { detectPython } from '../../src/engines/appium/python-env.ts';
import { MockAppium } from '../fixtures/mock-appium.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
async function setup(t: { after(fn: () => Promise<void>): void }, tempIn?: string) {
  const temp = tempIn ?? fs.mkdtempSync(path.join(os.tmpdir(), 'vortex-features-'));
  const mock = new MockAppium();
  await mock.listen(0);
  const app = new Application(root, path.join(temp, 'generated'), path.join(temp, 'state'));
  app.mock = true;
  await app.init();
  await app.manager.connectExisting({ host: '127.0.0.1', port: mock.port });
  t.after(async () => {
    await app.shutdown();
    await mock.close();
    if (!tempIn) fs.rmSync(temp, { recursive: true, force: true });
  });
  return { app, mock, temp };
}
const attach = (app: Application) => app.start('mock-device', 'com.yourname.tradehub');
const byId = (app: Application, suffix: string) => app.snapshot!.nodes.find((n) => n.resourceId.endsWith(suffix))!.index;
const act = (app: Application, type: string, extra: Record<string, unknown> = {}) => app.action({ token: app.snapshot!.token, type, ...extra });

test('selecting a control ranks locators instantly, with no device lookup', async (t) => {
  const { app, mock } = await setup(t);
  await attach(app);
  const index = byId(app, 'home_search_input');
  const before = mock.requests.length;
  const r = await app.inspect({ token: app.snapshot!.token, index });
  assert.equal(mock.requests.length, before, 'no request reached the device');
  assert.ok('recommended' in r && r.recommended, 'a recommendation is available immediately');
  assert.equal(r.recommended.strategy, 'id');
  assert.equal(r.recommended.status, 'local-unique');
  assert.ok(r.candidates!.every((c, i, all) => i === 0 || all[i - 1].score >= c.score), 'sorted best first');
  assert.ok(r.candidates!.every((c) => !('matchCount' in c)), 'nothing is presented as device-verified');

  // Confirming the recommendation costs one lookup and one rect, not one per candidate.
  const start = mock.requests.length;
  const v = await app.verifyOne({ token: app.snapshot!.token, index, strategy: r.recommended.strategy, value: r.recommended.value });
  assert.equal(v.candidate.status, 'verified-unique');
  assert.ok(mock.requests.length - start <= 4, `one candidate verified in ${mock.requests.length - start} requests`);
});

test('locator search runs on the captured screen for id, text, UiSelector and XPath', async (t) => {
  const { app, mock } = await setup(t);
  await attach(app);
  const token = app.snapshot!.token;
  const before = mock.requests.length;
  const target = byId(app, 'home_search_input');

  const short = await app.search({ token, using: 'id', value: 'home_search_input' });
  assert.deepEqual(short.indexes, [target]);
  assert.match(short.python!, /AppiumBy\.ID/);

  const full = await app.search({ token, using: 'auto', value: 'com.yourname.tradehub:id/home_search_input' });
  assert.equal(full.using, 'id');
  assert.deepEqual(full.indexes, [target]);

  const xp = await app.search({ token, using: 'auto', value: "//*[contains(@resource-id,'home_search_input')]" });
  assert.equal(xp.using, 'xpath');
  assert.deepEqual(xp.indexes, [target]);
  assert.equal(xp.error, null);

  const all = await app.search({ token, using: 'xpath', value: '//android.widget.EditText' });
  assert.ok(all.count >= 1);
  assert.ok(all.indexes.every((i) => /EditText$/.test(app.snapshot!.nodes[i].className)));

  const ui = await app.search({ token, using: 'auto', value: 'new UiSelector().resourceId("com.yourname.tradehub:id/home_search_input")' });
  assert.equal(ui.using, '-android uiautomator');
  assert.deepEqual(ui.indexes, [target]);

  const deviceOnly = await app.search({ token, using: '-android uiautomator', value: 'new UiSelector().childSelector(new UiSelector().text("x"))' });
  assert.equal(deviceOnly.deviceOnly, true);
  assert.equal(deviceOnly.count, 0);

  const bad = await app.search({ token, using: 'xpath', value: '//*[@text=' });
  assert.ok(bad.error, 'a broken XPath is an explained error, not a crash');
  const value = await app.search({ token, using: 'xpath', value: 'count(//*)' });
  assert.match(value.error!, /must select elements/);

  const contains = await app.search({ token, using: 'auto', value: 'products' });
  assert.equal(contains.using, 'text contains');
  assert.ok(contains.count >= 1);

  assert.equal(mock.requests.length, before, 'search never asked the device');
  await assert.rejects(() => app.search({ token: 'stale', using: 'id', value: 'x' }), /screen changed/i);
});

test('a chosen locator is recorded and used by the generated test', async (t) => {
  const { app } = await setup(t);
  await attach(app);
  await act(app, 'launch_app');
  const index = byId(app, 'home_my_products_button');
  const inspected = await app.inspect({ token: app.snapshot!.token, index });
  const xpath = inspected.candidates!.find((c) => c.strategy === 'xpath attributes')!;
  await act(app, 'tap', { index, locator: { strategy: xpath.strategy, value: xpath.value } });
  assert.equal(app.steps.at(-1)!.target!.parts!.by, 'xpath');
  await assert.rejects(() => act(app, 'tap', { index: byId(app, 'myproducts_title_text'), locator: { strategy: 'id', value: 'not-a-candidate' } }), /Choose one of the locators/);
  const built = app.build({ name: 'chosen locator', module: 'general', mode: 'plain' });
  const code = built.files.find((f) => f.path.endsWith('.py'))!.content;
  assert.ok(code.includes('AppiumBy.XPATH'), 'the generated test uses the chosen XPath');
  assert.ok(!code.includes('ID("home_my_products_button")'), 'and not the default id');
});

test('a text locator is refused for typing, because typing changes it', async (t) => {
  const { app } = await setup(t);
  await attach(app);
  const index = byId(app, 'home_search_input');
  await act(app, 'type', { index, args: { text: 'steel' } });
  const again = byId(app, 'home_search_input');
  const text = (await app.inspect({ token: app.snapshot!.token, index: again })).candidates!.find((c) => c.strategy === 'uiautomator text');
  assert.ok(text, 'the field now exposes its text as a candidate');
  await assert.rejects(() => act(app, 'type', { index: again, args: { text: 'x' }, locator: { strategy: text.strategy, value: text.value } }), /text locator changes/);
});

test('a secret is typed on the phone but only its variable name is recorded, saved and generated', async (t) => {
  const { app, temp } = await setup(t);
  await attach(app);
  await act(app, 'launch_app');
  await act(app, 'type', { index: byId(app, 'home_search_input'), args: { text: 'Sup3r-S3cret!' }, secretEnv: 'vortex_secret_password' });
  const step = app.steps.at(-1)!;
  assert.equal(step.secretEnv, 'VORTEX_SECRET_PASSWORD');
  assert.equal(step.args?.text, undefined, 'the value is not kept in the step');
  assert.equal(app.snapshot!.nodes[byId(app, 'home_search_input')].text, 'Sup3r-S3cret!', 'the phone did receive the value');
  await assert.rejects(() => act(app, 'type', { index: byId(app, 'home_search_input'), args: { text: 'x' }, secretEnv: 'bad name' }), /environment variable/);

  const saved = app.save({ name: 'secret login', module: 'general', mode: 'both' });
  const everything = [fs.readFileSync(path.join(temp, 'state', 'autosave.json'), 'utf8'), ...saved.files.map((f) => f.content), JSON.stringify(saved.recording)].join('\n');
  assert.ok(!everything.includes('Sup3r-S3cret!'), 'the value appears in no saved file, recording or autosave');
  assert.ok(saved.files.some((f) => f.content.includes('secret("VORTEX_SECRET_PASSWORD")')), 'the test reads it from the environment');
});

test('long press and double tap are recorded and generated', async (t) => {
  const { app } = await setup(t);
  await attach(app);
  await act(app, 'launch_app');
  await act(app, 'longpress', { index: byId(app, 'home_search_input') });
  await act(app, 'doubletap', { index: byId(app, 'home_search_input') });
  assert.deepEqual(app.steps.slice(-2).map((s) => s.type), ['longpress', 'doubletap']);
  const code = app.build({ name: 'gestures', module: 'general', mode: 'plain' }).files.find((f) => f.path.endsWith('.py'))!.content;
  assert.match(code, /mobile: longClickGesture/);
  assert.match(code, /mobile: doubleClickGesture/);
});

test('steps can be deleted and reordered, and an unsaved recording survives a restart', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vortex-autosave-'));
  t.after(async () => fs.rmSync(temp, { recursive: true, force: true }));
  const first = await setup(t, temp);
  await attach(first.app);
  await act(first.app, 'launch_app');
  await act(first.app, 'sleep', { args: { ms: 10 } });
  await act(first.app, 'swipe', { args: { direction: 'up' } });
  await act(first.app, 'hide_keyboard');
  assert.deepEqual(first.app.steps.map((s) => s.type), ['launch_app', 'sleep', 'swipe', 'hide_keyboard']);
  first.app.moveStep(3, 1);
  assert.deepEqual(first.app.steps.map((s) => s.type), ['launch_app', 'hide_keyboard', 'sleep', 'swipe']);
  first.app.deleteStep(2);
  assert.deepEqual(first.app.steps.map((s) => s.type), ['launch_app', 'hide_keyboard', 'swipe']);
  assert.throws(() => first.app.deleteStep(9), /No such recorded step/);
  assert.throws(() => first.app.moveStep(0, -1), /No such recorded step/);
  const id = first.app.recordingId;

  // A new recorder process on the same state folder: the recording comes back.
  const second = await setup(t, temp);
  assert.deepEqual(second.app.steps.map((s) => s.type), ['launch_app', 'hide_keyboard', 'swipe']);
  assert.equal(second.app.recordingId, id);
  assert.equal(second.app.pkg, 'com.yourname.tradehub');
  assert.equal(second.app.restored?.steps, 3);
  assert.equal((await second.app.status()).restored?.steps, 3);

  second.app.clear();
  assert.equal(fs.existsSync(path.join(temp, 'state', 'autosave.json')), false, 'clearing removes the autosave');
  const third = await setup(t, temp);
  assert.equal(third.app.steps.length, 0);
  assert.equal(third.app.restored, null);
});

test('a whole-screen page object is generated, is valid Python, and never overwrites an edited file', async (t) => {
  const { app, mock, temp } = await setup(t);
  await attach(app);
  const token = app.snapshot!.token;
  const before = mock.requests.length;
  const preview = await app.screenPage({ token, name: 'Home screen' });
  assert.equal(mock.requests.length, before, 'built from the captured screen only');
  assert.equal(preview.className, 'HomeScreenPage');
  assert.equal(preview.fileName, 'home_screen_page.py');
  assert.equal(preview.saved, null);
  const search = preview.elements.find((e) => e.constant === 'HOME_SEARCH_INPUT')!;
  assert.equal(search.kind, 'input');
  assert.equal(search.method, 'fill_home_search');
  const rows = preview.elements.find((e) => e.constant === 'CATEGORY_CARD_ROOT_ROW')!;
  assert.equal(rows.rows, 6, 'a repeated id becomes one row-addressed control, not six copies');
  assert.match(preview.content, /def tap_category_card_root\(self, row=1\):/);
  assert.equal(new Set(preview.elements.map((e) => e.method)).size, preview.elements.length, 'method names are unique');
  assert.match(search.locator, /AppiumBy\.ID, ID\("home_search_input"\)/);
  assert.ok(preview.elements.some((e) => e.kind === 'button' && e.method.startsWith('tap_')));
  assert.equal(new Set(preview.elements.map((e) => e.constant)).size, preview.elements.length, 'names are unique');
  assert.ok(preview.elements.every((e) => !/hierarchy\//.test(e.locator)), 'no absolute XPath is written');
  assert.match(preview.content, /def wait_until_loaded\(self\):/);

  const saved = await app.screenPage({ token, name: 'Home screen', save: true });
  const file = path.join(temp, 'generated', 'screens', 'home_screen_page.py');
  assert.equal(saved.conflict, false);
  assert.equal(fs.readFileSync(file, 'utf8'), preview.content);

  const python = await detectPython();
  if (python.ok && python.command) execFileSync(python.command.file, [...python.command.args, '-m', 'py_compile', file], { stdio: 'pipe' });
  else t.diagnostic('Python not available: syntax of the page object was not compiled');

  fs.appendFileSync(file, '\n# my own helper\n');
  const again = await app.screenPage({ token, name: 'Home screen', save: true });
  assert.equal(again.conflict, true);
  assert.match(fs.readFileSync(file, 'utf8'), /my own helper/, 'the edited file is untouched');
  assert.equal(fs.readFileSync(file + '.vortex-new', 'utf8'), preview.content);
});

test('the setup check and the server log are available through the application', async (t) => {
  const { app } = await setup(t);
  const report = await app.preflight();
  const by = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  assert.equal(by.device.status, 'ok');
  assert.match(by.device.detail, /simulated/i);
  assert.equal(by.port.status, 'warn', 'an Appium that Vortex did not start is reported, not hidden');
  assert.equal(report.checks.length, 9);
  assert.deepEqual(app.serverLogs('50'), { file: null, lines: [] });
});
