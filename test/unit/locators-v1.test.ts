/**
 * Feature: 1.0.0 locator intelligence — anchor-based locators, stability scoring, replay evidence, step repair
 * Layer: Unit — node:test, on a synthetic login screen (page source XML)
 * Real: page-source parsing, XPath evaluation, ranking, repair suggestions, history file
 * Mocked: Nothing (no device is involved in any of these functions)
 * Guards: Fragile absolute XPaths for unnamed inputs, recommending values that change between captures,
 *         repair suggestions that are not unique on the failure screen
 * Run: npm run test:unit
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { allCandidates, anchorCandidates } from '../../src/engines/appium/anchor-locators.ts';
import { evalXPath } from '../../src/engines/appium/locator-search.ts';
import { rankOffline, recommendOffline } from '../../src/engines/appium/native-locators.ts';
import { parsePageSource } from '../../src/engines/appium/page-source.ts';
import { suggestRepairs } from '../../src/engines/appium/repair.ts';
import { buildScreenPage } from '../../src/engines/appium/screen-page.ts';
import { applyStability, CaptureHistory } from '../../src/engines/appium/stability.ts';
import { LocatorHistory } from '../../src/services/locator-history.ts';

const PKG = 'com.shop';
const node = (cls: string, a: { id?: string; text?: string; desc?: string; clickable?: boolean; y: number }) =>
  `<${cls} index="0" package="${PKG}" class="${cls}" text="${a.text ?? ''}" resource-id="${a.id ? `${PKG}:id/${a.id}` : ''}" content-desc="${a.desc ?? ''}" checkable="false" checked="false" clickable="${a.clickable ? 'true' : 'false'}" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[40,${a.y}][1040,${a.y + 90}]" displayed="true" />`;
const screen = (cart: string, loginId = 'login_button') =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy index="0" class="hierarchy" rotation="0" width="1080" height="2400"><android.widget.FrameLayout index="0" package="${PKG}" class="android.widget.FrameLayout" text="" resource-id="" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]" displayed="true">${[
    node('android.widget.TextView', { id: 'screen_title', text: 'Sign in', y: 100 }),
    node('android.widget.TextView', { text: 'Mobile number', y: 300 }),
    node('android.widget.EditText', { y: 400 }),
    node('android.widget.TextView', { text: 'Password', y: 600 }),
    node('android.widget.EditText', { y: 700 }),
    node('android.widget.Button', { id: loginId, text: 'Login', clickable: true, y: 900 }),
    node('android.widget.TextView', { id: 'forgot_link', text: 'Forgot password?', clickable: true, y: 1050 }),
    node('android.widget.TextView', { id: 'cart_count', text: cart, y: 1200 }),
  ].join('')}</android.widget.FrameLayout></hierarchy>`;

const XML = screen('Items in cart: 3');
const PS = parsePageSource(XML);
const inputs = PS.nodes.filter((n) => /EditText$/.test(n.className));
const byText = (t: string) => PS.nodes.find((n) => n.text === t)!;

test('an unnamed input is located from the label before it, and the anchor selects exactly that input', async () => {
  const [mobile, password] = inputs;
  const a = await anchorCandidates(mobile, PS, XML);
  assert.equal(a[0].value, "//*[@text='Mobile number']/following::android.widget.EditText[1]");
  assert.equal(a[0].strategy, 'xpath anchor');
  assert.deepEqual(await evalXPath(XML, PS, a[0].value), [mobile.index]);
  const b = await anchorCandidates(password, PS, XML);
  assert.equal(b[0].value, "//*[@text='Password']/following::android.widget.EditText[1]");
  assert.deepEqual(await evalXPath(XML, PS, b[0].value), [password.index]);
});

test('anchors are offered only when needed, rank above the absolute XPath, and are recommended for an unnamed input', async () => {
  assert.deepEqual(await anchorCandidates(byText('Login'), PS, XML), [], 'a control with a unique id needs no anchor');
  assert.deepEqual(await anchorCandidates(inputs[0], PS, null), [], 'no raw screen XML, no unchecked anchors');
  const list = await allCandidates(inputs[0], PS, XML);
  const order = list.map((c) => c.strategy);
  assert.ok(order.indexOf('xpath anchor') < order.indexOf('xpath absolute'));
  const ranked = rankOffline(inputs[0], PS, list);
  assert.equal(recommendOffline(ranked)?.strategy, 'xpath anchor');
});

test('a whole-screen page object uses anchors for unnamed inputs instead of skipping them', async () => {
  const anchors = new Map<number, { value: string; label: string }>();
  for (const n of inputs) {
    const [a] = await anchorCandidates(n, PS, XML, 1);
    anchors.set(n.index, { value: a.value, label: /@text='([^']*)'/.exec(a.value)![1] });
  }
  const without = buildScreenPage(PS, { name: 'Sign in', pkg: PKG });
  assert.equal(without.skipped.length, 2, 'without anchors both inputs are skipped');
  const page = buildScreenPage(PS, { name: 'Sign in', pkg: PKG }, anchors);
  assert.equal(page.skipped.length, 0);
  assert.match(page.content, /MOBILE_NUMBER_INPUT = \(AppiumBy\.XPATH, "\/\/\*\[@text='Mobile number'\]\/following::android\.widget\.EditText\[1\]"\)/);
  assert.match(page.content, /def fill_mobile_number\(self, value\):/);
  assert.match(page.content, /def fill_password\(self, value\):/);
});

test('stability: a value that changed between captures of the same screen is penalised, an unchanged one rewarded', () => {
  const history = new CaptureHistory();
  history.add(parsePageSource(screen('Items in cart: 3')));
  const now = parsePageSource(screen('Items in cart: 4'));
  history.add(now);
  const cart = now.nodes.find((n) => n.resourceId.endsWith('cart_count'))!;
  const ranked = applyStability(rankOffline(cart, now), cart, history, () => null);
  const id = ranked.find((c) => c.strategy === 'id')!, text = ranked.find((c) => c.strategy === 'uiautomator text')!;
  assert.ok(id.scoreNotes.some((n) => n.startsWith('+5 unchanged in 1 earlier capture')));
  assert.ok(text.scoreNotes.some((n) => n.startsWith('-20 changed between captures')));
  assert.equal(ranked[0].strategy, 'id');
  // A different screen is no evidence at all.
  const other = new CaptureHistory();
  other.add(parsePageSource(XML.replaceAll('screen_title', 'other_a').replaceAll('forgot_link', 'other_b').replaceAll('cart_count', 'other_c').replaceAll('login_button', 'other_d')));
  other.add(now);
  assert.equal(other.stability('resourceId', cart.resourceId), null);
});

test('replay evidence: a locator not found in the last replay drops below one that keeps passing', () => {
  const login = byText('Login');
  const ranked = applyStability(rankOffline(login, PS), login, null, (c) => (c.strategy === 'id' ? { passed: 4, failed: 1, last: 'failed' } : c.strategy === 'uiautomator text' ? { passed: 3, failed: 0, last: 'passed' } : null));
  const id = ranked.find((c) => c.strategy === 'id')!, text = ranked.find((c) => c.strategy === 'uiautomator text')!;
  assert.ok(id.scoreNotes.some((n) => n.startsWith('-15 not found in the last replay')));
  assert.ok(text.scoreNotes.some((n) => n.startsWith('+5 found in 3 replays')));
  assert.equal(id.score, 80);
  assert.equal(text.score, 82);
  assert.equal(ranked[0].strategy, 'uiautomator text', 'the ranking follows the evidence');
});

test('locator history survives a restart and keeps the newest outcome', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vortex-history-'));
  try {
    const parts = { by: 'id' as const, value: `${PKG}:id/login_button` };
    const first = new LocatorHistory(dir);
    assert.equal(first.get(PKG, parts), null);
    first.record(PKG, [{ parts, found: true }, { parts, found: true }]);
    first.record(PKG, [{ parts, found: false }]);
    assert.deepEqual(new LocatorHistory(dir).get(PKG, parts) && { ...new LocatorHistory(dir).get(PKG, parts), at: undefined }, { passed: 2, failed: 1, last: 'failed', at: undefined });
    assert.equal(new LocatorHistory(dir).get('another.app', parts), null, 'evidence is per app');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repair: after an id was renamed, the control with the same text is suggested with a locator unique on that screen', async () => {
  const after = screen('Items in cart: 3', 'sign_in_cta');
  const ps = parsePageSource(after);
  const r = await suggestRepairs({ type: 'tap', title: 'Login', parts: { by: 'id', value: `${PKG}:id/login_button` } }, ps, after, PKG);
  assert.equal(r.originalMatches, 0);
  const top = r.suggestions[0];
  assert.equal(top.label, 'Login');
  assert.equal(top.strategy, 'id');
  assert.equal(top.value, `${PKG}:id/sign_in_cta`);
  assert.deepEqual(top.parts, { by: 'id', value: `${PKG}:id/sign_in_cta` });
  assert.ok(top.reasons.some((x) => x.includes('same text "Login"')));
  assert.ok(r.suggestions.every((s, i, all) => i === 0 || all[i - 1].similarity >= s.similarity));
});

test('repair: a typing step is matched to an input by its nearby label, never to a non-input', async () => {
  const r = await suggestRepairs({ type: 'type', title: 'Mobile number field', parts: { by: 'id', value: `${PKG}:id/mobile_number_input` } }, PS, XML, PKG);
  assert.equal(r.suggestions[0].index, inputs[0].index);
  assert.equal(r.suggestions[0].strategy, 'xpath anchor');
  assert.ok(r.suggestions.every((s) => /EditText$/.test(s.className)));
});

test('repair: when the old locator still matches one control, that is reported instead of guessed around', async () => {
  const r = await suggestRepairs({ type: 'tap', title: 'Login', parts: { by: 'id', value: `${PKG}:id/login_button` } }, PS, XML, PKG);
  assert.equal(r.originalMatches, 1);
  const none = await suggestRepairs({ type: 'tap', title: 'Checkout', parts: { by: 'id', value: `${PKG}:id/checkout` } }, PS, XML, PKG);
  assert.deepEqual(none.suggestions, [], 'nothing resembles it: no suggestion rather than a wrong one');
});
