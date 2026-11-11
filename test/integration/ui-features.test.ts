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
