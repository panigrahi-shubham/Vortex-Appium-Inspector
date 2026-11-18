import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

test('owned Appium preload hides driver subprocess consoles and preserves spawn overloads', () => {
  const source = fs.readFileSync(new URL('../../src/appium/windows-subprocess.cjs', import.meta.url), 'utf8');
  for (const platform of ['win32', 'linux']) {
    const calls: unknown[][] = [];
    const handle = {};
    const original = (...args: unknown[]) => { calls.push(args); return handle; };
    const cp = { spawn: original };
    let synced = 0;
    vm.runInNewContext(source, { process: { platform }, require: (name: string) => name === 'node:child_process' ? cp : { syncBuiltinESMExports: () => synced++ } });
    assert.equal(cp.spawn('adb', ['shell', 'am', 'instrument'], { env: { A: 'b' }, stdio: 'pipe' }), handle);
    assert.equal(cp.spawn('adb', { cwd: '/project' }), handle);
    if (platform === 'win32') {
      assert.equal(synced, 1);
      assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
        ['adb', ['shell', 'am', 'instrument'], { env: { A: 'b' }, stdio: 'pipe', windowsHide: true }],
        ['adb', { cwd: '/project', windowsHide: true }],
      ]);
    } else {
      assert.equal(cp.spawn, original);
      assert.equal(synced, 0);
    }
  }
});
