/**
 * Feature: 1.0.0 — repair of a failed step, shared page library, deep link / screen check / checkpoint steps,
 *          step editing, stability notes
 * Layer: Integration — node:test, the real Application and real pytest against the simulated Appium device
 * Real: Application and its services, code generation, files on disk, Python and pytest runs
 * Mocked: The Appium server and phone (src/simulator/mock-appium.ts), including a simulated app update
 * Guards: A repair that does not actually make the test pass, shared pages that break earlier tests,
 *         overwriting a hand-edited shared page
 * Run: npm run test:integration
 */
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
const noPython = python.ok ? false : 'Python with pytest and Appium-Python-Client is needed for replay';
process.env.VORTEX_TIMEOUT = '3'; // generated tests wait this long for a control: keeps the failing replay short

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vortex-v1-'));
  const mock = new MockAppium();
  await mock.listen(0);
  const app = new Application(root, path.join(temp, 'generated'), path.join(temp, 'state'));
  app.mock = true;
  await app.init();
  await app.manager.connectExisting({ host: '127.0.0.1', port: mock.port });
  t.after(async () => {
    await app.shutdown();
    await mock.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  return { app, mock, temp, out: path.join(temp, 'generated') };
}
const attach = (app: Application) => app.start('mock-device', 'com.yourname.tradehub');
const byId = (app: Application, suffix: string) => app.snapshot!.nodes.find((n) => n.resourceId.endsWith(suffix))!.index;
const act = (app: Application, type: string, extra: Record<string, unknown> = {}) => app.action({ token: app.snapshot!.token, type, ...extra });
async function replay(app: Application, ref: { module: string; case: string }) {
  const started = await app.run(ref);
  const result = await app.runner.wait(started.id);
  return { id: started.id, result };
}

test('repair: a replay that cannot find a renamed control is repaired from the failure screen and then passes', { skip: noPython }, async (t) => {
  const { app, mock, out, temp } = await setup(t);
  await attach(app);
  await act(app, 'launch_app');
  await act(app, 'tap', { index: byId(app, 'home_my_products_button') });
  await act(app, 'assert', { index: byId(app, 'myproducts_title_text'), args: { assertion: 'visible' } });
  await act(app, 'close_app'); // so every replay starts from the app's first screen
  const saved = app.save({ name: 'repair flow', module: 'general', mode: 'plain' });
  assert.deepEqual(saved.saved.conflicts, []);
  const entry = path.join(out, 'general', 'repair-flow', saved.files.find((f) => f.role === 'entry')!.path);

  // The app is "updated": the button keeps its text but gets a new id.
  mock.renameId('home_my_products_button', 'home_products_shortcut');
  const first = await replay(app, saved.ref);
  assert.equal(first.result.status, 'failed', first.result.summary);
  assert.match(first.result.failed[0].step ?? '', /^2\. /, 'the failure is attributed to the tap step');
  // A tap waits for a clickable control, so a missing one is reported as "could not be used".
  assert.ok(['element-not-found', 'element-not-interactable'].includes(first.result.failed[0].diagnosis?.kind ?? ''));

  const suggestion = await app.repairSuggest({ id: first.id });
  assert.equal(suggestion.step.number, 2);
  assert.equal(suggestion.originalMatches, 0, 'the old id is gone from the failure screen');
  assert.equal(suggestion.note, null);
  assert.equal(suggestion.activity, '.ui.HomeActivity', 'the screen at the failure is reported for review');
  const top = suggestion.suggestions[0];
  assert.equal(top.strategy, 'id');
  assert.match(top.value, /home_products_shortcut$/);
  assert.ok(suggestion.screen.img?.startsWith('data:image/png;base64,'), 'the failure screenshot is offered for review');
  assert.ok(fs.readFileSync(entry, 'utf8').includes('home_my_products_button'), 'nothing is changed until a suggestion is chosen');
  await assert.rejects(() => app.repairApply({ id: first.id, index: top.index, strategy: 'id', value: 'com.yourname.tradehub:id/not_suggested' }), /Choose one of the suggested locators/);

  const applied = await app.repairApply({ id: first.id, index: top.index, strategy: top.strategy, value: top.value });
  assert.equal(applied.step, 2);
  assert.deepEqual(applied.conflicts, []);
  const code = fs.readFileSync(entry, 'utf8');
  assert.ok(code.includes('home_products_shortcut') && !code.includes('home_my_products_button'), 'the saved test uses the new locator');
  assert.match(String(app.steps[1].target?.parts?.value), /home_products_shortcut$/, 'the open recording is kept in step with the saved file');

  const second = await replay(app, saved.ref);
  assert.equal(second.result.status, 'passed', second.result.summary + '\n' + app.runner.get(second.id).output.slice(-1500));
  await assert.rejects(() => app.repairSuggest({ id: second.id }), /did not fail in a recorded step/);

  // Both replays left evidence for locator ranking.
  const history = JSON.parse(fs.readFileSync(path.join(temp, 'state', 'locator-history.json'), 'utf8')) as { entries: Record<string, { passed: number; failed: number; last: string }> };
  const find = (suffix: string) => Object.entries(history.entries).find(([k]) => k.includes(suffix))?.[1];
  assert.equal(find('home_my_products_button')?.last, 'failed');
  assert.deepEqual({ passed: find('home_products_shortcut')?.passed, last: find('home_products_shortcut')?.last }, { passed: 1, last: 'passed' });
});

test('shared page library: tests of one app extend the same page classes, and earlier tests keep passing', { skip: noPython }, async (t) => {
  const { app, out } = await setup(t);
  const lib = path.join(out, '_shared', 'pages', 'com_yourname_tradehub_pages');
  await attach(app);

  await act(app, 'launch_app');
  await act(app, 'tap', { index: byId(app, 'home_my_products_button') });
  await act(app, 'assert', { index: byId(app, 'myproducts_title_text'), args: { assertion: 'visible' } });
  const preview = app.build({ name: 'flow a', module: 'shop', mode: 'pom', sharedPages: true });
  assert.ok(preview.sharedFiles.some((f) => f.path.startsWith('_shared/pages/com_yourname_tradehub_pages/')), 'the preview lists the shared page files');
  assert.equal(fs.existsSync(lib), false, 'a preview writes nothing');
  const a = app.save({ name: 'flow a', module: 'shop', mode: 'pom', sharedPages: true });
  assert.deepEqual(a.saved.conflicts, []);
  const caseA = path.join(out, 'shop', 'flow-a', 'appium', 'pom');
  assert.equal(fs.existsSync(path.join(caseA, 'pages')), false, 'the test has no private page package');
  assert.match(fs.readFileSync(path.join(caseA, 'conftest.py'), 'utf8'), /_shared" \/ "pages"/);
  const pagesAfterA = fs.readdirSync(lib).sort();
  assert.ok(pagesAfterA.includes('base_page.py'));
  const libraryAfterA = Object.fromEntries(pagesAfterA.map((f) => [f, fs.readFileSync(path.join(lib, f), 'utf8')]));

  // A second test on the same app adds a locator and a method to a page the first test already uses.
  app.clear();
  await act(app, 'press', { args: { key: 'BACK' }, record: false }); // back to the home screen, without recording it
  await act(app, 'launch_app');
  await act(app, 'type', { index: byId(app, 'home_search_input'), args: { text: 'steel pipes' } });
  await act(app, 'assert', { index: byId(app, 'home_search_input'), args: { assertion: 'text', expected: 'steel pipes' } });
  const b = app.save({ name: 'flow b', module: 'shop', mode: 'pom', sharedPages: true });
  assert.deepEqual(b.saved.conflicts, []);
  const grown = Object.entries(libraryAfterA).filter(([f, before]) => fs.readFileSync(path.join(lib, f), 'utf8') !== before).map(([f]) => f);
  assert.ok(grown.length >= 1, 'at least one shared page gained members');
  for (const f of grown) {
    const now = fs.readFileSync(path.join(lib, f), 'utf8');
    // Append-only: every constant and method the first test relies on is still there under the same name.
    for (const name of libraryAfterA[f].match(/^    (?:[A-Z][A-Z0-9_]* =|def \w+)/gm) ?? []) assert.ok(now.includes(name), `${f} keeps ${name.trim()}`);
  }
  assert.equal(app.load({ module: 'shop', case: 'flow-a' }).sharedPages, true);

  const runA = await replay(app, a.ref);
  assert.equal(runA.result.status, 'passed', 'the first test still passes after the library grew\n' + app.runner.get(runA.id).output.slice(-1500));
  const runB = await replay(app, b.ref);
  assert.equal(runB.result.status, 'passed', app.runner.get(runB.id).output.slice(-1500));

  // A shared page edited by hand is never overwritten, and replay waits for the review.
  const edited = path.join(lib, grown[0]);
  fs.appendFileSync(edited, '\n# reviewed by hand\n');
  await attach(app);
  app.clear();
  await act(app, 'launch_app');
  await act(app, 'tap', { index: byId(app, 'home_search_button') });
  await act(app, 'tap', { index: byId(app, 'home_compare_button') });
  const c = app.save({ name: 'flow c', module: 'shop', mode: 'pom', sharedPages: true });
  const conflict = c.saved.conflicts.find((x) => x.path.startsWith('_shared/'));
  assert.ok(conflict, 'the conflict is reported with the save');
  assert.match(fs.readFileSync(edited, 'utf8'), /reviewed by hand/, 'the edited page is untouched');
  assert.ok(fs.existsSync(`${edited}.vortex-new`));
  await assert.rejects(() => app.run(c.ref), /shared page library has edited files awaiting review/);

  // A private-pages test is unaffected by the library.
  const d = app.save({ name: 'flow d', module: 'shop', mode: 'pom' });
  assert.ok(fs.existsSync(path.join(out, 'shop', 'flow-d', 'appium', 'pom', 'pages', 'shop_flow_d_pages', 'base_page.py')));
  assert.equal(app.load({ module: 'shop', case: 'flow-d' }).sharedPages, false);
  assert.deepEqual(d.sharedFiles, []);
});

test('deep link, screen check and checkpoint steps are recorded, editable and generated', async (t) => {
  const { app } = await setup(t);
  await attach(app);
  await act(app, 'launch_app');
  await assert.rejects(() => act(app, 'deep_link', { args: { url: 'not a link' } }), /Enter a full link/);
  await app.capture();
  await act(app, 'deep_link', { args: { url: 'tradehub://products' } });
  assert.ok(app.snapshot!.nodes.some((n) => n.resourceId.endsWith('myproducts_title_text')), 'the link opened the products screen');
  await act(app, 'check_activity');
  assert.equal(app.steps.at(-1)!.args?.activity, 'com.yourname.tradehub/.ui.products.MyProductsActivity');
  await act(app, 'checkpoint', { args: { name: 'Products list / first look' } });
  assert.equal(app.steps.at(-1)!.args?.name, 'Products-list-first-look');
  await act(app, 'sleep', { args: { ms: 50 } });

  app.editStep(1, 'tradehub://insights');
  assert.equal(app.steps[1].args?.url, 'tradehub://insights');
  app.editStep(1, 'tradehub://products');
  app.editStep(4, '120');
  assert.equal(app.steps[4].args?.ms, 120);
  assert.throws(() => app.editStep(4, 'soon'), /milliseconds/);
  assert.throws(() => app.editStep(0, 'x'), /has no value to edit/);
  assert.throws(() => app.editStep(1, 'ftp'), /Enter a full link/);

  for (const mode of ['plain', 'pom'] as const) {
    const code = app.build({ name: 'extras', module: 'general', mode }).files.find((f) => f.role === 'entry')!.content;
    assert.match(code, /"mobile: deepLink", \{"url": "tradehub:\/\/products", "package": APP_PACKAGE\}/, mode);
    assert.match(code, /wait_activity\(driver, "\.ui\.products\.MyProductsActivity"\)/, mode);
    assert.match(code, /checkpoint\(driver, "Products-list-first-look"\)/, mode);
  }
});

test('ranking notes show stability once the same screen was captured again', async (t) => {
  const { app } = await setup(t);
  await attach(app);
  const index = byId(app, 'home_search_input');
  const first = await app.inspect({ token: app.snapshot!.token, index });
  assert.ok(!first.candidates!.some((c) => 'scoreNotes' in c && c.scoreNotes.some((n) => n.includes('earlier capture'))), 'one capture is no evidence');
  await app.capture();
  const again = await app.inspect({ token: app.snapshot!.token, index: byId(app, 'home_search_input') });
  const id = again.candidates!.find((c) => c.strategy === 'id')!;
  assert.ok('scoreNotes' in id && id.scoreNotes.some((n) => n.startsWith('+5 unchanged in 1 earlier capture')), JSON.stringify(id));
});
