// `npm run doctor`: the setup check from the Server & setup panel, as a command.
// Read-only: it reports what is missing and how to fix it, and changes nothing.

import path from 'node:path';
import { Application } from './application.ts';
import { formatPreflight } from './appium/preflight.ts';

const root = path.resolve(import.meta.dirname, '..');
const app = new Application(root);
const report = await app.preflight();
console.log(formatPreflight(report));
process.exitCode = report.blocked ? 1 : 0;
