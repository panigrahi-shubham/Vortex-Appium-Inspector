// Loaded only in Vortex-owned Appium servers on Windows. Appium's ADB SubProcess
// does not pass windowsHide, so its instrumentation/logcat processes open consoles.
// Closing one of those windows terminates ADB with STATUS_CONTROL_C_EXIT and
// makes an otherwise live UiAutomator2 session unusable. Keep driver children
// headless without modifying the user's Appium installation.
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');

if (process.platform === 'win32') {
  const spawn = childProcess.spawn;
  childProcess.spawn = function (command, args, options) {
    return Array.isArray(args)
      ? spawn(command, args, { ...options, windowsHide: true })
      : spawn(command, { ...args, windowsHide: true });
  };
  syncBuiltinESMExports();
}
