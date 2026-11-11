/**
 * Feature: 0.2.0 UI — locator search, instant ranking, chosen locator, quick record, secrets, step tools,
 *          screen page object, Server & setup panel
 * Layer: Integration — node:test + Playwright (Chromium) against `node src/server.ts`
 * Real: Browser UI, HTTP server, Application, code generation; for the server panel a stand-in Appium process
 * Mocked: Phone and Appium sessions (--mock). No real device.
 * Guards: A feature that works in the API but is unreachable or broken in the UI; page errors
 * Run: npm run test:integration   (set VORTEX_UI_SHOTS=<folder> to keep screenshots)
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fakeAppium = path.join(root, 'test', 'integration', 'fixtures', 'fake-appium');
const shots = process.env.VORTEX_UI_SHOTS || '';

test('reliability controls, navigation approval and checkpoint playback work through the recorder UI', { timeout: 90_000 }, async t => {
  const { page, errors, base } = await open(t, ['--mock'], { VORTEX_TIMEOUT: '1' });
  await page.waitForFunction(() => document.querySelector('#device option')?.textContent?.includes('mock-device'));
  await page.locator('#pkg').fill('com.yourname.tradehub');
  await page.locator('#attach').click(); await noticeHas(page, 'Session attached');
  await page.locator('#reliabilitySettings > summary').click();
  await page.locator('#reliabilityTimeout').fill('2');
  await page.locator('#reliabilityScrolls').fill('3');
  await page.locator('#reliabilityStable').fill('0');
  await page.locator('#suggestNavigation').uncheck();
  await page.locator('[data-global="launch_app"]').click(); await stepCount(page, 1);
  const state = await (await fetch(base + '/api/status')).json();
  assert.equal(state.steps[0].reliability.settings.maxScrolls, 3);
  assert.equal(state.steps[0].reliability.settings.suggestNavigation, false);
  await page.locator('#suggestNavigation').check();
  await page.locator('#locatorSearch').fill('home_my_products_button');
  await page.waitForFunction(() => document.querySelector('#searchResult')?.textContent?.startsWith('1 match'));
  await page.locator('#locatorSearch').press('Enter');
  await page.waitForFunction(() => document.querySelector('#selector')?.getAttribute('placeholder') !== undefined && document.querySelector('#locators button') !== null);
  await page.locator('#tap').click(); await stepCount(page, 2);
  await page.getByRole('button', { name: 'Add navigation check', exact: true }).click(); await stepCount(page, 3);
  await page.locator('#scrollTargetBy').selectOption('id');
  await page.locator('#scrollTargetValue').fill('com.yourname.tradehub:id/myproducts_title_text');
  await page.locator('#reliableScroll').click(); await stepCount(page, 4);
  await page.locator('#actionMoreTab').click();
  await page.locator('#extraValue').fill('product-list');
  await page.locator('#checkpoint').click(); await stepCount(page, 5);
  await page.locator('#name').fill('reliability ui');
  await page.locator('#save').click(); await noticeHas(page, 'Ready to replay');
  // Launch/activate deliberately preserves app data and navigation state. Prepare Home for this flow.
  await page.locator('#record').uncheck();
  await page.locator('[data-global="press"][data-key="BACK"]').click();
  await noticeHas(page, 'Recording paused.');
  await page.locator('#record').check();
  await page.locator('#playbackCheckpoint').selectOption('5');
  await page.locator('#run').click();
  await page.waitForFunction(() => document.querySelector('#output')?.textContent?.includes('partial run'), null, { timeout: 30_000 });
  assert.match(await page.locator('#output').innerText(), /through step 5/);
  assert.match(await page.locator('#output').innerText(), /^PASSED/);
  assert.deepEqual(errors, []);
  await shot(page, 'vortex-reliability-controls.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#actionCenter').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile layout fits the viewport');
  await shot(page, 'vortex-reliability-mobile.png');
});

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

async function open(t: { after(fn: () => Promise<void> | void): void }, extraArgs: string[], env: NodeJS.ProcessEnv = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vortex-ui-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.ts', ...extraArgs, '--port', String(port), '--out', path.join(temp, 'generated'), '--state-dir', path.join(temp, 'state')], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    // A bound server can return 503 while recovering state. Back off on that response too.
    if (!ready) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, log);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.goto(base);
  await page.locator('#advancedInspect > summary').click();
  return { page, errors, base };
}

const noticeHas = async (page: Page, text: string) => {
  try {
    await page.waitForFunction((t) => document.querySelector('#notice')?.textContent?.includes(t), text, { timeout: 15_000 });
  } catch {
    assert.fail(`expected the notice to contain "${text}" but it says: ${await page.locator('#notice').innerText()}`);
  }
};
const stepCount = (page: Page, n: number) => page.waitForFunction((c) => document.querySelector('#stepCount')?.textContent === String(c), n);
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: path.join(shots, name), fullPage: true });
};

/** Clicks the screenshot at the centre of the control whose resource-id ends with `suffix`. */
async function clickOnPhone(page: Page, suffix: string) {
  await page.locator('#screenshot').scrollIntoViewIfNeeded();
  const rel = await page.evaluate(async (s) => {
    const status = await (await fetch('/api/status')).json();
    const n = status.screen.nodes.find((x: { resourceId: string }) => x.resourceId.endsWith(s));
    return { x: (n.bounds.x + n.bounds.w / 2) / status.screen.width, y: (n.bounds.y + n.bounds.h / 2) / status.screen.height };
  }, suffix);
  const box = (await page.locator('#screenshot').boundingBox())!;
  await page.mouse.click(box.x + rel.x * box.width, box.y + rel.y * box.height);
}

test('locator search, chosen locator, quick record, secret, step tools and screen page object work in the browser', async (t) => {
  const { page, errors } = await open(t, ['--mock']);
  await page.waitForFunction(() => document.querySelector('#device option')?.textContent?.includes('mock-device'));
  await page.locator('#pkg').fill('com.yourname.tradehub');
  await page.locator('#attach').click();
  await noticeHas(page, 'Session attached');

  // Locator search: counted on the captured screen, drawn on the screenshot, list filtered.
  await page.locator('#locatorSearch').fill('//android.widget.EditText');
  await page.waitForFunction(() => /match.*xpath/.test(document.querySelector('#searchResult')?.textContent ?? ''));
  assert.ok((await page.locator('#matches .match').count()) >= 1, 'matches are outlined on the screenshot');
  await page.locator('#searchUsing').selectOption('id');
  await page.locator('#locatorSearch').fill('home_my_products_button');
  await page.waitForFunction(() => document.querySelector('#searchResult')?.textContent?.startsWith('1 match · unique'));
  assert.equal(await page.locator('#tree button').count(), 1, 'the list shows only the match');
  assert.match(await page.locator('#searchResult').innerText(), /AppiumBy\.ID/);

  // Enter selects it: ranked instantly, then the recommended locator is confirmed on the phone in the background.
  await page.locator('#locatorSearch').press('Enter');
  await page.waitForFunction(() => document.querySelector('#locators button')?.textContent?.startsWith('★ id'));
  await page.waitForFunction(() => document.querySelector('#locators button.ok .state')?.textContent?.startsWith('verified on phone'));
  await shot(page, 'vortex-ui-main.png');

  // Choose a different locator: the action and the generated test use it.
  await page.locator('#locators button').filter({ hasText: 'xpath attributes' }).click();
  assert.match(await page.locator('#selector').inputValue(), /^xpath attributes: /);
  await page.locator('#tap').click();
  await stepCount(page, 1);
  await page.locator('[data-global="press"][data-key="BACK"]').click();
  await stepCount(page, 2);

  // Quick record: one click on the screenshot is one recorded step.
  await page.locator('#locatorSearch').fill('');
  await page.locator('#quick').check();
  await clickOnPhone(page, 'home_my_products_button');
  await stepCount(page, 3);
  await page.locator('[data-global="press"][data-key="BACK"]').click();
  await stepCount(page, 4);

  // Quick record on a text field selects it and waits for typing; a secret is never shown or stored.
  await clickOnPhone(page, 'home_search_input');
  await noticeHas(page, 'Type the text and press Enter');
  await page.locator('#secret').check();
  await page.locator('#text').fill('Sup3r-S3cret!');
  await page.locator('#text').press('Enter');
  await stepCount(page, 5);
  assert.equal(await page.locator('#text').inputValue(), '', 'the secret is cleared from the page');
  const stepsText = await page.locator('#steps').innerText();
  assert.match(stepsText, /\$VORTEX_SECRET_PASSWORD \(secret\)/);
  assert.ok(!stepsText.includes('Sup3r-S3cret!'));

  // Step tools: delete the second Back, move a step.
  await page.locator('#steps p').nth(3).getByTitle('Delete this step').click();
  await stepCount(page, 4);
  await page.locator('#steps p').nth(3).getByTitle('Move up').click();
  await noticeHas(page, 'Step moved');
  assert.match(await page.locator('#steps p').nth(2).innerText(), /^3\. type/);

  // Generated test: chosen XPath and the secret read from the environment.
  await page.locator('#preview').click();
  await page.waitForFunction(() => document.querySelector('#code')?.textContent?.includes('from appium import webdriver'));
  const code = await page.locator('#code').innerText();
  assert.ok(code.includes('AppiumBy.XPATH'), 'the chosen XPath is in the test');
  assert.ok(code.includes('secret("VORTEX_SECRET_PASSWORD")'));
  assert.ok(!code.includes('Sup3r-S3cret!'));

  // Whole-screen page object.
  await page.locator('#pageName').fill('Home');
  await page.locator('#pagePreview').click();
  await page.waitForFunction(() => document.querySelector('#code')?.textContent?.includes('class HomePage:'));
  assert.match(await page.locator('#code').innerText(), /def fill_home_search\(self, value\):/);
  await page.locator('#pageSave').click();
  await noticeHas(page, 'Saved screens/home_page.py in the output folder');

  // 1.0: checkpoint and screen-check steps, editing a step, shared page objects in the preview.
  const before = await page.locator('#steps p').count();
  await page.locator('#actionMoreTab').click();
  await page.locator('#extraValue').fill('home ready');
  await page.locator('#checkpoint').click();
  await stepCount(page, before + 1);
  await page.locator('#checkScreen').click();
  await stepCount(page, before + 2);
  assert.match(await page.locator('#steps').innerText(), /checkpoint · home-ready/);
  assert.match(await page.locator('#steps').innerText(), /check activity · com\.yourname\.tradehub\/\.ui\.HomeActivity/);
  page.removeAllListeners('dialog');
  page.once('dialog', (d) => void d.accept('home screen ready'));
  await page.locator('#steps p').filter({ hasText: 'checkpoint' }).getByTitle("Edit this step's value").click();
  await noticeHas(page, 'Step updated');
  assert.match(await page.locator('#steps').innerText(), /checkpoint · home-screen-ready/);
  page.on('dialog', (d) => void d.accept());
  await page.locator('#mode').selectOption('pom');
  await page.locator('#sharedPages').check();
  await page.locator('#preview').click();
  await page.waitForFunction(() => Array.from(document.querySelectorAll('#files option')).some((o) => o.textContent?.startsWith('_shared/pages/com_yourname_tradehub_pages/')));

  // Shortcuts.
  await page.locator('h2').first().click();
  await page.keyboard.press('?');
  await page.locator('#shortcutsDialog').waitFor({ state: 'visible' });
  await page.locator('#shortcutsClose').click();
  assert.deepEqual(errors, []);
});

test('Server & setup: a failed start shows the Appium log; settings are validated; the setup check lists every item', async (t) => {
  const { page, errors } = await open(t, [], { FAKE_APPIUM_MODE: 'crash' });
  const appiumPort = await freePort();
  await page.locator('#setup').click();
  await page.locator('#serverDialog').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#serverState')?.textContent?.startsWith('Not connected'));

  // A path that is not Appium is refused with a reason.
  await page.locator('#appiumPath').fill(os.tmpdir());
  await page.locator('#settings').click();
  await noticeHas(page, 'is not an Appium package');

  await page.locator('#appiumPath').fill(fakeAppium);
  await page.locator('#appiumPort').fill(String(appiumPort));
  await page.locator('#settings').click();
  await noticeHas(page, 'Settings saved');

  // The stand-in Appium fails at startup: the reason and its log are on screen.
  await page.locator('#serverStart').click();
  await noticeHas(page, '(exit code 3). See the log below.'); // "exited immediately" or "exited during startup", depending on timing
  await page.waitForFunction(() => document.querySelector('#serverLog')?.textContent?.includes('could not load driver "uiautomator2"'));
  await page.waitForFunction(() => document.querySelector('#serverState')?.textContent?.startsWith('EXITED'));
  assert.match(await page.locator('#serverState').innerText(), /exit code 3/);

  // Setup check lists every item with its fix.
  await page.locator('#preflight').click();
  await page.waitForFunction(() => document.querySelectorAll('#checks .check').length === 9);
  assert.match(await page.locator('#checks').innerText(), /UiAutomator2 driver/);
  await shot(page, 'vortex-ui-server.png');
  assert.deepEqual(errors, []);
});

test('Server & setup: a port held by another Appium offers Connect, and a port held by another program offers the next free port', async (t) => {
  const { page, errors } = await open(t, []);
  const externalPort = await freePort();
  const external = spawn(process.execPath, [path.join(fakeAppium, 'index.js'), '--address', '127.0.0.1', '--port', String(externalPort)], { stdio: 'ignore' });
  t.after(() => void external.kill());
  const blocker = net.createServer();
  const busyPort = await new Promise<number>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as net.AddressInfo).port)));
  t.after(() => void blocker.close());
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${externalPort}/status`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  await page.locator('#setup').click();
  await page.locator('#serverDialog').waitFor({ state: 'visible' });
  await page.locator('#appiumPath').fill(fakeAppium);
  await page.locator('#settings').click();
  await noticeHas(page, 'Settings saved');

  await page.locator('#appiumPort').fill(String(busyPort));
  await page.locator('#serverStart').click();
  await page.locator('#serverOffer button').filter({ hasText: 'Start on port' }).waitFor();

  await page.locator('#appiumPort').fill(String(externalPort));
  await page.locator('#serverStart').click();
  const connect = page.locator('#serverOffer button').filter({ hasText: `Connect to the Appium already on port ${externalPort}` });
  await connect.waitFor();
  await connect.click();
  await noticeHas(page, 'Connected to the existing Appium server');
  await page.waitForFunction(() => /RUNNING · external server \(Vortex will never stop it\)/.test(document.querySelector('#serverState')?.textContent ?? ''));
  await page.locator('#serverDisconnect').click();
  await noticeHas(page, 'Disconnected. The external server keeps running.');
  assert.ok((await fetch(`http://127.0.0.1:${externalPort}/status`)).ok);
  assert.deepEqual(errors, []);
});

test('repair in the browser: a failed replay offers the control again, and the repaired test passes', async (t) => {
  const { page, errors, base } = await open(t, ['--mock'], { VORTEX_TIMEOUT: '3' });
  await page.waitForFunction(() => document.querySelector('#device option')?.textContent?.includes('mock-device'));
  await page.locator('#pkg').fill('com.yourname.tradehub');
  await page.locator('#attach').click();
  await noticeHas(page, 'Session attached');
  await page.locator('[data-global="launch_app"]').click();
  await stepCount(page, 1);
  await page.locator('#tree button').filter({ hasText: 'home_my_products_button' }).click();
  await page.locator('#tap').click();
  await stepCount(page, 2);
  await page.locator('[data-global="close_app"]').click();
  await stepCount(page, 3);
  await page.locator('#name').fill('repair in browser');
  await page.locator('#save').click();
  await noticeHas(page, 'Ready to replay');

  // The app is "updated" behind the recorder's back: the button gets a new id.
  const status = (await (await fetch(base + '/api/status')).json()) as { server: { server: { port: number } } };
  const renamed = await fetch(`http://127.0.0.1:${status.server.server.port}/mock/rename`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'home_my_products_button', to: 'home_products_shortcut' }) });
  assert.equal(renamed.status, 200);

  await page.locator('#run').click();
  await page.waitForFunction(() => document.querySelector('#output')?.textContent?.startsWith('FAILED'), {}, { timeout: 60_000 });
  const offer = page.locator('#repair button').filter({ hasText: 'Repair step 2' });
  await offer.waitFor();
  await offer.click();
  await noticeHas(page, 'Choose the control this step meant');
  assert.match(await page.locator('#repair').innerText(), /The app was on \.ui\.HomeActivity when the test failed/);
  assert.ok((await page.locator('#repair .repair-shot .match').count()) >= 1, 'suggested controls are outlined on the failure screenshot');
  const first = page.locator('#repair .suggestion').first();
  assert.match(await first.innerText(), /home_products_shortcut/);
  await shot(page, 'vortex-ui-repair.png');
  await first.getByRole('button', { name: 'Use this locator' }).click();
  await noticeHas(page, 'Step 2 now uses id: com.yourname.tradehub:id/home_products_shortcut');

  await page.locator('#run').click();
  await page.waitForFunction(() => document.querySelector('#output')?.textContent?.startsWith('PASSED'), {}, { timeout: 60_000 });
  assert.equal(await page.locator('#repair').isHidden(), true, 'no repair is offered for a passing test');
  assert.deepEqual(errors, []);
});

test('live status in the browser: the header follows the Appium server without a reload', async (t) => {
  const { page, errors, base } = await open(t, []);
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('disconnected'));
  const appiumPort = await freePort();
  const post = (url: string, body: unknown) => fetch(base + '/api/' + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  // The server is started from outside the page (another tab, or the API): the page hears about it.
  assert.equal((await post('server/settings', { appiumPath: fakeAppium, port: appiumPort })).status, 200);
  assert.equal((await post('server/start', { port: appiumPort })).status, 200);
  await page.waitForFunction((p) => document.querySelector('#status')?.textContent?.includes(`running on ${p}`), appiumPort, { timeout: 10_000 });
  assert.equal((await post('server/stop', {})).status, 200);
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('disconnected'), {}, { timeout: 10_000 });
  assert.deepEqual(errors, []);
});

test('inspect and clipboard tools, new file creation and tutorial work together without accidental phone actions', async (t) => {
  const { page, base, errors } = await open(t, ['--mock']);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await page.waitForFunction(() => document.querySelector('#device option')?.textContent?.includes('mock-device'));
  await page.locator('#pkg').fill('com.yourname.tradehub');
  await page.locator('#attach').click();
  await noticeHas(page, 'Session attached');
  let actions = 0;
  page.on('request', (r) => { if (r.url().endsWith('/api/action')) actions++; });
  assert.equal(await page.locator('#copyLocator').isDisabled(), true);
  await page.locator('#quick').check();
  await page.locator('#inspectMode').click();
  assert.equal(await page.locator('#quick').isChecked(), false);
  assert.equal(await page.locator('#inspectMode').getAttribute('aria-pressed'), 'true');
  await clickOnPhone(page, 'home_my_products_button');
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#copyLocator')?.disabled);
  assert.equal(actions, 0, 'inspecting does not perform phone actions');
  await page.locator('#copyLocator').click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /home_my_products_button$/);
  await page.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => Promise.reject(Error('blocked')) }));
  await page.locator('#copyLocator').click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /home_my_products_button$/, 'manual-copy fallback works when Clipboard API is denied');
  await page.evaluate(() => Reflect.deleteProperty(navigator.clipboard, 'writeText'));
  await page.locator('#copyPython').click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /driver\.find_element\(AppiumBy\.ID,/);
  const xpath = page.locator('#locators button').filter({ hasText: 'xpath absolute' });
  const value = await xpath.getAttribute('data-value');
  await xpath.click();
  await page.locator('#copyLocator').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), value, 'copy uses the chosen locator');
  await page.locator('#copyElement').click();
  const details = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  assert.equal(details.locator.value, value);
  assert.match(details.element.resourceId, /home_my_products_button$/);
  await xpath.click();
  await page.locator('#copyLocator').click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /home_my_products_button$/, 'deselecting a locator restores the default element lookup');
  await shot(page, 'vortex-inspect-copy.png');

  await page.locator('#tutorialTab').click();
  assert.equal(await page.locator('#inspectorView').isVisible(), false);
  assert.equal(await page.locator('#tutorialView').isVisible(), true);
  await shot(page, 'vortex-tutorial-desktop.png');
  await page.keyboard.press('t');
  assert.equal(actions, 0, 'tutorial does not dispatch action shortcuts');
  await page.locator('[data-guide-target="newFile"]').click();
  assert.equal(await page.locator('#inspectorView').isVisible(), true);
  await page.locator('#newFile').click();
  await page.locator('#newFileName').fill('tutorial search');
  await page.locator('#newFileModule').fill('getting-started');
  await page.locator('#newFileForm').getByRole('button', { name: 'Create file', exact: true }).click();
  await noticeHas(page, 'Created getting-started/tutorial-search');
  assert.match(await page.locator('#code').innerText(), /pytest\.skip\("Empty starter/);
  await page.locator('#copyCode').click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /def test_getting_started_tutorial_search\(\):/);
  const empty = await fetch(base + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ module: 'getting-started', case: 'tutorial-search' }) });
  assert.equal((await empty.json() as { code: string }).code, 'EMPTY_TEST');

  await page.locator('[data-global="launch_app"]').click();
  await stepCount(page, 1);
  assert.doesNotMatch(await page.locator('#code').innerText(), /Empty starter/, 'recording invalidates old file preview');
  await page.locator('#save').click();
  await noticeHas(page, 'Ready to replay');
  await page.locator('#newFile').click();
  await page.locator('#newFileName').fill('second test');
  await page.locator('#newFileForm').getByRole('button', { name: 'Create file', exact: true }).click();
  assert.match(await page.locator('#newFileError').innerText(), /Save your current recording/);
  assert.equal(await page.locator('#stepCount').innerText(), '1');
  await page.locator('#discardForNew').check();
  await page.locator('#newFileName').fill('tutorial search');
  await page.locator('#newFileForm').getByRole('button', { name: 'Create file', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#newFileError')?.textContent?.includes('already exists'));
  assert.equal(await page.locator('#stepCount').innerText(), '1');
  await page.locator('#newFileName').fill('second test');
  await page.locator('#newFileForm').getByRole('button', { name: 'Create file', exact: true }).click();
  await noticeHas(page, 'Created getting-started/second-test');
  await stepCount(page, 0);
  assert.equal(await page.locator('#name').inputValue(), 'second test');
  await page.locator('#refresh').click();
  await noticeHas(page, 'Screen refreshed');
  assert.equal(await page.locator('#copyLocator').isDisabled(), true, 'copy cannot use a stale selection');
  await page.locator('#tutorialTab').click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'tutorial fits a narrow viewport');
  await shot(page, 'vortex-tutorial.png');
  assert.deepEqual(errors, []);
});

test('simple inspection previews without round trips and copies text, ID and the exact point used for recording', async (t) => {
  const { page, base, errors } = await open(t, ['--mock']);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await page.waitForFunction(() => document.querySelector('#device option')?.textContent?.includes('mock-device'));
  await page.locator('#pkg').fill('com.yourname.tradehub');
  await page.locator('#attach').click();
  await noticeHas(page, 'Session attached');
  let inspections = 0, actions = 0;
  page.on('request', r => {
    if (r.url().endsWith('/api/inspect')) inspections++;
    if (r.url().endsWith('/api/action')) actions++;
  });
  const target = await page.evaluate(async () => {
    const s = await (await fetch('/api/status')).json();
    return s.screen.nodes.find((n: { resourceId: string }) => n.resourceId.endsWith('home_my_products_button'));
  });
  await page.locator('#screenshot').scrollIntoViewIfNeeded();
  const image = (await page.locator('#screenshot').boundingBox())!;
  const position = { x: image.x + (target.bounds.x + target.bounds.w / 2) / 1080 * image.width, y: image.y + (target.bounds.y + target.bounds.h / 2) / 2400 * image.height };
  await page.mouse.move(position.x, position.y);
  assert.match(await page.locator('#hoverLocator').innerText(), /home_my_products_button/);
  assert.equal(inspections, 0, 'hover needs no API lookup');
  let release!: () => void;
  const gate = new Promise<void>(r => release = r);
  t.after(() => release());
  await page.route('**/api/inspect', async route => { await gate; await route.continue(); });
  await page.mouse.click(position.x, position.y);
  await page.waitForFunction(() => document.querySelector('#bestLocatorValue')?.textContent?.includes('home_my_products_button'));
  assert.equal(await page.locator('#copyLocator').isDisabled(), true, 'the capture preview appears even while full inspection is pending');
  release();
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#copyLocator')?.disabled);
  await page.unroute('**/api/inspect');
  await page.locator('#simpleText').click();
  assert.match(await page.locator('#bestLocatorValue').innerText(), /new UiSelector\(\)\.text\(/);
  await page.locator('#copyPython').click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /AppiumBy\.ANDROID_UIAUTOMATOR/);
  await page.locator('#simpleId').click();
  await page.locator('#copyLocator').click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /home_my_products_button$/);
  await page.evaluate(() => { document.querySelector('#locators')!.scrollTop = 100000; });
  await page.locator('#tree button').filter({ hasText: 'home_search_input' }).click();
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#copyLocator')?.disabled);
  assert.equal(await page.locator('#locators').evaluate(e => e.scrollTop), 0, 'selecting a different element reveals the best candidates');
  await page.locator('#simplePoint').click();
  await page.locator('#screenshot').scrollIntoViewIfNeeded();
  const box = (await page.locator('#screenshot').boundingBox())!;
  const clickX = Math.ceil(box.x) + 10, clickY = Math.ceil(box.y) + 10;
  await page.mouse.click(clickX, clickY);
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#copyPython')?.disabled);
  const expectedX = Math.floor((clickX - box.x) / box.width * 1080), expectedY = Math.floor((clickY - box.y) / box.height * 2400);
  assert.equal(await page.locator('#bestLocatorValue').innerText(), `${expectedX},${expectedY}`);
  await page.locator('#copyPython').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `driver.execute_script("mobile: clickGesture", {"x": ${expectedX}, "y": ${expectedY}})`);
  assert.equal(actions, 0, 'inspection and selector choices do not tap the phone');
  await shot(page, 'vortex-simple-inspector.png');
  await page.locator('#tap').click();
  await stepCount(page, 1);
  const state = await (await fetch(base + '/api/status')).json() as { steps: { mode: string; x: number; y: number }[] };
  assert.equal(state.steps[0].mode, 'coord');
  assert.equal(state.steps[0].x, expectedX);
  assert.equal(state.steps[0].y, expectedY);
  assert.deepEqual(errors, []);
});

test('auto-refresh serializes slow captures, pins selection, pauses for editing/tutorial, and stops on failure', async (t) => {
  const { page, errors } = await open(t, ['--mock']);
  await page.waitForFunction(() => document.querySelector('#device option')?.textContent?.includes('mock-device'));
  await page.locator('#pkg').fill('com.yourname.tradehub');
  await page.locator('#attach').click();
  await noticeHas(page, 'Session attached');
  let captures = 0, inFlight = 0, maxInFlight = 0, fail = false;
  await page.route('**/api/screen', async route => {
    captures++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    if (fail) await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Device unplugged' }) });
    else {
      await new Promise(r => setTimeout(r, 2500));
      await route.continue();
    }
    inFlight--;
  });
  await page.locator('#autoRefresh').check();
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#inspectMode')?.disabled);
  await page.locator('#tree button').filter({ hasText: 'home_my_products_button' }).click();
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#copyLocator')?.disabled);
  assert.match(await page.locator('#liveScreenStatus').innerText(), /Paused for inspection/);
  const pinned = captures;
  await page.waitForTimeout(2200);
  assert.equal(captures, pinned, 'auto-refresh preserves a selected element for copying');
  await page.locator('#resumeLive').click();
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#inspectMode')?.disabled);
  assert.ok(captures > pinned);
  assert.equal(maxInFlight, 1, 'slow captures never overlap');
  await page.locator('#actionTypeTab').click();
  await page.locator('#text').focus();
  const editing = captures;
  await page.waitForTimeout(2200);
  assert.equal(captures, editing);
  await page.locator('#tutorialTab').click();
  const hidden = captures;
  await page.waitForTimeout(2200);
  assert.equal(captures, hidden, 'reading the tutorial does not drive captures');
  await page.locator('#inspectorTab').click();
  await page.locator('#autoRefresh').uncheck();
  fail = true;
  await page.locator('#autoRefresh').check();
  await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('#autoRefresh')?.checked);
  await noticeHas(page, 'Device unplugged');
  const stopped = captures;
  await page.waitForTimeout(2200);
  assert.equal(captures, stopped, 'a failed capture stops automatic requests');
  assert.equal(await page.locator('#copyLocator').isDisabled(), true);
  assert.deepEqual(errors, []);
});
