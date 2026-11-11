import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { fromUiSteps, migrateRecording, toUiSteps, type UiStep } from '../../src/model/recording.ts';
import { buildCase } from '../../src/project/project.ts';
import { generatePython } from '../../src/engines/appium/python-codegen.ts';
import { detectPython } from '../../src/engines/appium/python-env.ts';
import { validatePythonFiles } from '../../src/engines/appium/python-validation.ts';
import { DEFAULT_RELIABILITY, reliabilitySettings, navigationSuggestions, actionEvidence, screenEvidence } from '../../src/reliability.ts';
import { RecordingStore } from '../../src/services/recording-store.ts';
import type { Snapshot } from '../../src/services/types.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const python = await detectPython();
const meta = { id: 'legacy', name: 'stockpilot reliability', module: 'general', appPackage: 'com.stockpilot.b2b', serial: null, screen: { width: 1080, height: 2400 }, version: '2', reliability: DEFAULT_RELIABILITY };
const step: UiStep = { type: 'assert', title: 'Write a review', mode: 'name', target: { kind: 'text', parts: { by: 'text', value: 'Write a review' } }, args: { assertion: 'visible' } };
const snapshot = (id: string, activity = '.MainActivity'): Snapshot => ({ img: '', width: 1080, height: 2400, contexts: ['NATIVE_APP'], activity, package: meta.appPackage, capturedAt: '2026-11-11T10:00:00Z', token: id, web: null, webMessage: '', nodes: [{ index: 0, parent: null, depth: 0, className: 'android.widget.TextView', resourceId: id, text: id, contentDesc: '', packageName: meta.appPackage, bounds: { x: 0, y: 0, w: 100, h: 100 }, flags: {}, path: '/hierarchy/TextView[1]' }] });

test('v2 evidence and scroll options round-trip without changing older recordings or explicit swipes', () => {
  const s = snapshot('home');
  const evidence = actionEvidence(s, meta.appPackage, 'NATIVE_APP', 0, { using: 'id', value: 'home', parts: { by: 'id', value: 'home' }, title: 'home' }, DEFAULT_RELIABILITY, false);
  const input: UiStep[] = [{ ...step, reliability: evidence }, { type: 'scroll_to', target: step.target, args: { scrollContainer: { by: 'id', value: 'list' }, maxScrolls: 4, percent: 0.5, direction: 'down' } }, { type: 'swipe', args: { from: { x: 100, y: 900 }, to: { x: 100, y: 200 }, duration: 600 } }];
  const rec = fromUiSteps(input, meta);
  const restored = toUiSteps(migrateRecording(JSON.parse(JSON.stringify(rec))));
  assert.deepEqual(restored[0].reliability, evidence);
  assert.deepEqual(restored[1].args, input[1].args);
  assert.deepEqual(restored[2].args, input[2].args);
  const legacy = migrateRecording([step], meta);
  assert.equal(legacy.migratedFrom, 0);
  assert.equal(legacy.events[0].check?.kind, 'visible');
  assert.equal(legacy.events[0].reliability, undefined, 'do not invent historical verification evidence');
});

test('navigation checks require approval and never change an existing assertion', () => {
  const before = snapshot('home'), after = snapshot('product', '.ProductActivity');
  const recorded: UiStep = { type: 'tap', id: 'e1', target: step.target };
  recorded.reliability = actionEvidence(before, meta.appPackage, 'NATIVE_APP', 0, null, DEFAULT_RELIABILITY, false);
  recorded.reliability.after = screenEvidence(after, meta.appPackage, 'NATIVE_APP');
  recorded.reliability.suggestions = navigationSuggestions(before, after, recorded, meta.appPackage);
  assert.equal(recorded.reliability.suggestions.length, 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vortex-approval-'));
  try {
    const store = new RecordingStore(dir); store.add(recorded); store.add(structuredClone(step));
    const original = JSON.stringify(store.steps[1]);
    assert.equal(store.steps.length, 2, 'suggestion did not add any test step');
    store.approveSuggestion(0, recorded.reliability.suggestions[0].id);
    assert.equal(store.steps[1].type, 'assert');
    assert.equal(JSON.stringify(store.steps[2]), original);
    assert.throws(() => store.approveSuggestion(0, recorded.reliability!.suggestions[0].id), /already approved/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Native and WebView locators remain distinct, and missing review assertions are never omitted', () => {
  assert.throws(() => generatePython([{ ...step, target: { kind: 'css', parts: { by: 'css', value: '#review' } } }], { appPackage: meta.appPackage }), /CSS locators require a WebView/);
  const code = generatePython([step, step], { appPackage: meta.appPackage }).code;
  assert.match(code, /begin_step\(driver, 1/);
  assert.match(code, /begin_step\(driver, 2/);
  assert.ok(!code.includes('pytest.skip('));
  assert.ok(!code.includes('time.sleep('), 'no unconditional wait was synthesized');
  const legacyFallback = generatePython([{ ...step, type: 'tap', mode: 'both', x: 10, y: 20 }], { appPackage: meta.appPackage }).code;
  assert.match(legacyFallback, /Legacy both-format accepted; missing targets fail/);
  assert.ok(!legacyFallback.includes('{"x": x, "y": y}'), 'a missing locator cannot trigger an unrelated point tap');
});

test('Plain and POM compile with semantic scroll, explicit swipe, checkpoint, Native and WebView steps', { skip: !python.command && 'Python is required' }, () => {
  const rec = fromUiSteps([
    { ...step, type: 'scroll_to', args: { scrollContainer: { by: 'id', value: 'reviews-list' }, maxScrolls: 3, direction: 'down' } },
    { type: 'swipe', args: { from: { x: 100, y: 900 }, to: { x: 100, y: 200 }, duration: 600 } },
    { type: 'checkpoint', args: { name: 'reviews' } },
    step,
    { ...step, context: 'WEBVIEW', target: { kind: 'css', parts: { by: 'css', value: '#review' } }, webview: { testId: null, index: 0, count: 1, url: null, title: null } },
    { ...step, type: 'scroll_to', context: 'WEBVIEW', target: { kind: 'css', parts: { by: 'css', value: '#review' } }, args: { maxScrolls: 2, scrollContainer: { by: 'css', value: '#scroll-box' }, direction: 'up', percent: 0.4 } },
  ], meta);
  const result = buildCase(rec, { module: 'general', case: 'review' }, { frameworks: ['appium'], mode: 'both', target: 'plain', size: meta.screen });
  assert.deepEqual(result.issues, []);
  assert.equal(validatePythonFiles(result.files).ok, true);
  const plain = result.files.find(f => f.variant === 'plain')!.content;
  assert.match(plain, /max_attempts=3/);
  assert.match(plain, /driver.swipe\(100, 900, 100, 200, 600\)/);
  assert.match(plain, /with webview\(driver/);
  assert.match(plain, /max_attempts=2, container=\(AppiumBy.CSS_SELECTOR, "#scroll-box"\), direction="up", percent=0.4/);
  assert.match(result.files.find(f => f.path.endsWith('base_page.py'))!.content, /scroll_until_visible/);
});

test('export compilation/static validation rejects invalid Python and assertion skips', { skip: !python.command && 'Python is required' }, () => {
  assert.throws(() => validatePythonFiles([{ path: 'test_broken.py', content: 'def test_broken(:\n  pass' }]), /Python validation failed/);
  assert.throws(() => validatePythonFiles([{ path: 'test_skip.py', content: 'import pytest\ndef test_x():\n    pytest.skip("missing review")\n' }]), /Python validation failed/);
  assert.throws(() => reliabilitySettings({ maxScrolls: 500 }), /maxScrolls/);
});

test('WebView failure keeps DOM context and its original error even when restoring Native fails', { skip: !python.ok && 'Python/Appium client required' }, () => {
  const code = generatePython([{ ...step, context: 'WEBVIEW', target: { kind: 'css', parts: { by: 'css', value: '#review' } }, webview: { testId: null, index: 0, count: 1, url: null, title: null } }], { appPackage: meta.appPackage }).code;
  const script = `import os, tempfile\nfrom pathlib import Path\nns = {}\nexec(${JSON.stringify(code)}, ns)\nclass Switch:\n    def __init__(self, driver): self.driver = driver\n    def context(self, name):\n        if name == 'NATIVE_APP': raise RuntimeError('restore failed')\n        self.driver.current_context = name\nclass Driver:\n    current_context = 'NATIVE_APP'\n    current_package = 'com.stockpilot.b2b'\n    current_activity = '.MainActivity'\n    contexts = ['WEBVIEW_com.stockpilot.b2b']\n    window_handles = []\n    page_source = '<html>review missing</html>'\n    def get_screenshot_as_file(self, file): Path(file).write_bytes(b'PNG'); return True\nd = Driver()\nd.switch_to = Switch(d)\nwith tempfile.TemporaryDirectory() as folder:\n    os.environ['VORTEX_ARTIFACTS'] = folder\n    ns['begin_step'](d, 8, 'Review', ('css selector', '#review'))\n    try:\n        with ns['webview'](d): raise AssertionError('original missing review')\n    except AssertionError as error:\n        assert str(error) == 'original missing review'\n    else: raise AssertionError('original error was lost')\n    assert d._vortex_failure['context'] == 'WEBVIEW_com.stockpilot.b2b'\n    assert d._vortex_failure['source'].endswith('.html')\n`;
  execFileSync(python.command!.file, [...python.command!.args, '-c', script], { timeout: 15_000, encoding: 'utf8' });
});

test('actual Python reliability helpers: delayed rendering, unique targets, Native/Web scrolling, end detection, artifacts and cleanup', { skip: !python.command && 'Python is required' }, (t) => {
  const output = execFileSync(python.command!.file, [...python.command!.args, path.join(root, 'test/fixtures/reliability_test.py'), '-v'], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.diagnostic(output.trim());
});
