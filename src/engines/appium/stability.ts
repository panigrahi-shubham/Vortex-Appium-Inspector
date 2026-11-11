// Locator stability: evidence that a locator keeps working, used to adjust the instant ranking.
//
// Two sources, both optional:
//   1. Captures of the same screen during this session. A value that was present and unique every time earns a
//      small bonus; a value that appeared, disappeared or became ambiguous is penalised (counters, timers, rows).
//   2. Replay history: whether tests that used this locator found the control.
//
// Neither replaces checking on the device: the status of a candidate is unchanged, only its score and notes.

import type { RankedCandidate, Strategy } from './native-locators.ts';
import type { NativeNode, PageSource } from './page-source.ts';

type Field = 'resourceId' | 'contentDesc' | 'text';
interface Capture {
  ids: Set<string>;
  counts: Record<Field, Map<string, number>>;
}

const FIELD: Partial<Record<Strategy, Field>> = {
  id: 'resourceId',
  'uiautomator id + instance': 'resourceId',
  'accessibility id': 'contentDesc',
  'uiautomator description': 'contentDesc',
  'uiautomator text': 'text',
  'class + text': 'text',
};

function summarize(ps: PageSource): Capture {
  const counts: Capture['counts'] = { resourceId: new Map(), contentDesc: new Map(), text: new Map() };
  for (const n of ps.nodes) for (const f of ['resourceId', 'contentDesc', 'text'] as const) if (n[f]) counts[f].set(n[f], (counts[f].get(n[f]) ?? 0) + 1);
  return { ids: new Set(counts.resourceId.keys()), counts };
}

/** Two captures show the same screen when most of their resource-ids are shared. */
function sameScreen(a: Capture, b: Capture): boolean {
  if (a.ids.size < 3 || b.ids.size < 3) return false;
  let shared = 0;
  for (const id of a.ids) if (b.ids.has(id)) shared++;
  return shared / (a.ids.size + b.ids.size - shared) >= 0.7;
}

export class CaptureHistory {
  #captures: Capture[] = [];
  #max: number;
  constructor(max = 8) {
    this.#max = max;
  }

  /** Call once per screen capture, in order. The newest capture is "the current screen". */
  add(ps: PageSource) {
    this.#captures.push(summarize(ps));
    if (this.#captures.length > this.#max) this.#captures.shift();
  }

  reset() {
    this.#captures = [];
  }

  /** In how many earlier captures of the current screen was this value present exactly once? null = no evidence. */
  stability(field: Field, value: string): { uniqueIn: number; of: number } | null {
    const current = this.#captures[this.#captures.length - 1];
    if (!current || !value) return null;
    const earlier = this.#captures.slice(0, -1).filter((c) => sameScreen(c, current));
    if (!earlier.length) return null;
    return { uniqueIn: earlier.filter((c) => c.counts[field].get(value) === 1).length, of: earlier.length };
  }
}

export interface ReplayEvidence {
  passed: number;
  failed: number;
  last: 'passed' | 'failed';
}

/**
 * Applies stability evidence to an offline ranking and re-sorts it.
 * `replay(candidate)` returns what replays of saved tests showed for that locator, or null.
 */
export function applyStability(list: RankedCandidate[], node: NativeNode, captures: CaptureHistory | null, replay: (c: RankedCandidate) => ReplayEvidence | null): RankedCandidate[] {
  const out = list.map((c) => {
    let score = c.score;
    const notes = [...c.scoreNotes];
    const field = FIELD[c.strategy];
    const seen = field && captures ? captures.stability(field, node[field]) : null;
    if (seen) {
      if (seen.uniqueIn === seen.of) (score += 5), notes.push(`+5 unchanged in ${seen.of} earlier capture${seen.of === 1 ? '' : 's'} of this screen`);
      else (score -= 20), notes.push(`-20 changed between captures of this screen (present and unique in ${seen.uniqueIn} of ${seen.of})`);
    }
    const r = replay(c);
    if (r) {
      if (r.last === 'failed') (score -= 15), notes.push(`-15 not found in the last replay that used it (${r.failed} failed, ${r.passed} passed)`);
      else if (r.passed >= 2 && r.failed === 0) (score += 5), notes.push(`+5 found in ${r.passed} replays, never failed`);
    }
    return { ...c, score: Math.max(0, Math.min(100, score)), scoreNotes: notes };
  });
  return out.sort((a, b) => b.score - a.score);
}
