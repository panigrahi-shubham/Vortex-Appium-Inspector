// Stand-in for the Appium server in Vortex's process tests: a real process on a real port, with no phone.
// FAKE_APPIUM_MODE=crash prints a startup error and exits, like Appium does when it cannot start.
const http = require('node:http');

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const host = arg('--address') || '127.0.0.1';
const port = Number(arg('--port') || 4723);
const base = process.argv.includes('--base-path') ? arg('--base-path').replace(/\/+$/, '') : '';

console.log('[Appium] Welcome to Appium v3.9.0 (test stand-in)');
if (process.env.FAKE_APPIUM_MODE === 'crash') {
  console.error('[Appium] Fatal Error: stand-in startup failure: could not load driver "uiautomator2"');
  process.exit(3);
}
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === `${base}/status`) return res.end(JSON.stringify({ value: { ready: true, message: 'ready', build: { version: '3.9.0' } } }));
  res.statusCode = 404;
  res.end(JSON.stringify({ value: { error: 'unknown command' } }));
});
server.listen(port, host, () => console.log(`[Appium] Appium REST http interface listener started on http://${host}:${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
