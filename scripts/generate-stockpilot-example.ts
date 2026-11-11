import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateRecording } from '../src/model/recording.ts';
import { buildCase, saveCase } from '../src/project/project.ts';
import { validatePythonFiles } from '../src/engines/appium/python-validation.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rec = migrateRecording(JSON.parse(fs.readFileSync(path.join(root, 'samples/stockpilot-catalog-search.recording.json'), 'utf8')));
const out = path.resolve(process.argv[2] || path.join(root, 'examples'));
const ref = { module: 'stockpilot', case: 'catalog-search' };
const built = buildCase(rec, ref, { frameworks: ['appium'], mode: 'both', target: 'plain', size: rec.device.screen });
if (built.issues.length) throw Error(JSON.stringify(built.issues));
const validation = validatePythonFiles(built.files);
const result = saveCase(out, ref, { ...built, recording: rec, mode: 'both', frameworks: ['appium'], assets: [], generator: 'vortex reliability engine v2' });
if (result.conflicts.length) throw Error('Example has hand edits; review .vortex-new files before regenerating.');
console.log(JSON.stringify({ directory: result.caseDir, validation }));
