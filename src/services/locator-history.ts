// What replays of saved tests showed about each locator: found, or not found. Kept in the state folder and
// used only to adjust locator ranking (see engines/appium/stability.ts). It never changes a saved test.

import fs from 'node:fs';
import path from 'node:path';
import type { ReplayEvidence } from '../engines/appium/stability.ts';
import { partsKey } from '../model/pages.ts';
import type { LocatorParts } from '../model/recording.ts';

interface Entry extends ReplayEvidence {
  at: string;
}

const MAX_ENTRIES = 5_000;

export class LocatorHistory {
  readonly #file: string;
  #entries = new Map<string, Entry>();

  constructor(stateDir: string) {
    this.#file = path.join(path.resolve(stateDir), 'locator-history.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.#file, 'utf8')) as { version?: number; entries?: Record<string, Entry> };
      if (raw.version === 1 && raw.entries) this.#entries = new Map(Object.entries(raw.entries));
    } catch {
      /* no history yet, or unreadable: start empty */
    }
  }

  static key(pkg: string, parts: LocatorParts) {
    return `${pkg}|${partsKey(parts)}`;
  }

  get(pkg: string, parts: LocatorParts): ReplayEvidence | null {
    return this.#entries.get(LocatorHistory.key(pkg, parts)) ?? null;
  }

  record(pkg: string, outcomes: { parts: LocatorParts; found: boolean }[]) {
    if (!outcomes.length) return;
    const at = new Date().toISOString();
    for (const o of outcomes) {
      const k = LocatorHistory.key(pkg, o.parts);
      const e = this.#entries.get(k) ?? { passed: 0, failed: 0, last: 'passed' as const, at };
      this.#entries.delete(k); // re-insert so the newest entries are last
      this.#entries.set(k, { passed: e.passed + (o.found ? 1 : 0), failed: e.failed + (o.found ? 0 : 1), last: o.found ? 'passed' : 'failed', at });
    }
    while (this.#entries.size > MAX_ENTRIES) this.#entries.delete(this.#entries.keys().next().value!);
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: Object.fromEntries(this.#entries) }) + '\n', 'utf8');
      fs.renameSync(tmp, this.#file);
    } catch (e) {
      console.error('[vortex] could not save locator history:', (e as Error).message);
    }
  }
}
