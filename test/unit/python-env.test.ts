import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidates, detectPython } from '../../src/engines/appium/python-env.ts';

function pythonInfo(executable: string, ready: boolean) {
  return JSON.stringify({ version: '3.12.0', executable, pytest: ready ? '8.4' : null, appium: '6.0', selenium: '4.0' });
}

test('automatic Python detection continues to an interpreter with the replay dependencies', async () => {
  const commands = candidates('');
  const probed: string[] = [];
  const result = await detectPython('', async command => {
    probed.push(command.file);
    return pythonInfo(command.file, command.file === commands[1].file);
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.command, commands[1]);
  assert.deepEqual(probed, [commands[0].file, commands[1].file]);
});

test('Python setup reports the first installed interpreter when none are ready and honors an explicit path', async () => {
  const probe = async (command: { file: string }) => pythonInfo(command.file, false);
  const automatic = await detectPython('', probe);
  assert.deepEqual(automatic.command, candidates('')[0]);
  assert.deepEqual(automatic.problems, ['pytest is not installed.']);
  assert.ok(automatic.installCommand);
  const configured = await detectPython('custom-python', probe);
  assert.deepEqual(configured.command, { file: 'custom-python', args: [] });
  assert.equal(configured.ok, false);
});
