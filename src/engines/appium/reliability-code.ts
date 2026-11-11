import fs from 'node:fs';
import { pyStr } from './native-locators.ts';
import { DEFAULT_RELIABILITY, type ReliabilitySettings } from '../../reliability.ts';

/** One implementation, embedded in Plain and the reusable POM base page. */
export const RELIABILITY_HELPERS = fs.readFileSync(new URL('./python/reliability.py', import.meta.url), 'utf8').trim().split('\n');
export function pythonReliabilitySettings(settings?: ReliabilitySettings) {
  const s = settings ?? DEFAULT_RELIABILITY;
  return `{"timeoutSec": ${s.timeoutSec}, "maxScrolls": ${s.maxScrolls}, "stableMs": ${s.stableMs}, "hideKeyboardBeforeTap": ${s.hideKeyboardBeforeTap === false ? 'False' : 'True'}}`;
}

export function guardedStep(lines: string[], n: number, title: string, locator: string | null): string[] {
  return [lines[0], `if not begin_step(driver, ${n}, ${pyStr(title.replace(/[\r\n]/g, ' '))}, ${locator ?? 'None'}):`, '    return', 'with recorded_step(driver):', ...lines.slice(1).map(l => '    ' + l)];
}
