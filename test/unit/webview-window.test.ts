import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectWebWindow } from '../../src/engines/webview/window.ts';

function device(pages: Record<string, { width: number; height: number; hidden: boolean }>) {
  let current = '';
  return {
    get current() { return current; },
    async switchWindow(handle: string) { current = handle; },
    async executeArgs() { return pages[current]; },
  };
}
test('WebView selection skips hidden and zero-sized advertising pages', async () => {
  const session = device({ ad: { width: 0, height: 0, hidden: false }, old: { width: 448, height: 896, hidden: true }, app: { width: 448, height: 896, hidden: false } });
  assert.equal(await selectWebWindow(session, ['ad', 'app', 'old']), 'app');
  assert.equal(session.current, 'app');
});
test('WebView selection requires an explicit choice when visible pages are ambiguous', async () => {
  const session = device({ one: { width: 448, height: 896, hidden: false }, two: { width: 448, height: 896, hidden: false } });
  await assert.rejects(selectWebWindow(session, ['one', 'two']), /Several WebView pages/);
  assert.equal(await selectWebWindow(session, ['one', 'two'], 'two'), 'two');
  await assert.rejects(selectWebWindow(session, ['one', 'two'], 'closed'), /has closed/);
});
test('WebView selection reports no visible page instead of accepting an ad', async () => {
  const session = device({ ad: { width: 0, height: 0, hidden: false } });
  await assert.rejects(selectWebWindow(session, ['ad', 'closed']), /No visible WebView page/);
});
