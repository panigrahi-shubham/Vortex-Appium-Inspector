// Native locator candidates for one element, with deterministic, explained scoring.
//
// Score = strategy base
//       + 10 when the device returned exactly one match and it is this element (verified unique)
//       - 40 when the device returned several matches (ambiguous)
//       - 100 when the device returned no match (not found)
//       - 60 when the first match is a different element (bounds differ)
//       - 25 when the value looks dynamic (counts, prices, times)
//       - 10 for an absolute XPath deeper than 6 levels
//       - 5 / -10 when the lookup took over 300 ms / 1000 ms
// clamped to 0..100. Only "verified unique" candidates can be recommended. Nothing is marked verified
// without asking the device. Execution history is not used yet (no runs are linked to locators so far).

const isDynamic = (s: string) => /\d{4,}|\b\d+[.,]\d+\b|[₹$€£]|\b\d+:\d+\b/.test(s);
import type { NativeNode, PageSource } from './page-source.ts';
import type { Session, Using } from './webdriver.ts';

export type Strategy = 'id' | 'accessibility id' | 'uiautomator description' | 'uiautomator text' | 'uiautomator id + instance' | 'class + text' | 'xpath attributes' | 'xpath absolute' | 'coordinates';

export const BASE_SCORE: Record<Strategy, number> = {
  id: 90,
  'accessibility id': 85,
  'uiautomator description': 78,
  'uiautomator text': 72,
  'class + text': 60,
  'uiautomator id + instance': 55,
  'xpath attributes': 50,
  'xpath absolute': 20,
  coordinates: 5,
};

export interface Candidate {
  strategy: Strategy;
  using: Using | null;
  value: string;
  python: string;
  strengths: string[];
  weaknesses: string[];
  /** Matches counted in the page source itself (exact attribute equality), before asking the device. */
  localMatches: number | null;
}

export type Status = 'verified-unique' | 'ambiguous' | 'not-found' | 'wrong-target' | 'error' | 'not-verifiable';

export interface VerifiedCandidate extends Candidate {
  status: Status;
  matchCount: number | null;
  resolutionMs: number | null;
  score: number;
  scoreNotes: string[];
  error?: string;
}

/** UiSelector string argument: escape backslash and double quote. */
export const uiStr = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

/** XPath 1.0 string literal, using concat() when the value contains both quote kinds. */
export function xpathLiteral(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return 'concat(' + s.split("'").map((p) => `'${p}'`).join(`, "'", `) + ')';
}

/** Python string literal (JSON escapes are valid Python escapes). */
export const pyStr = (s: string) => JSON.stringify(s);

const BY: Record<Using, string> = { id: 'AppiumBy.ID', 'accessibility id': 'AppiumBy.ACCESSIBILITY_ID', '-android uiautomator': 'AppiumBy.ANDROID_UIAUTOMATOR', xpath: 'AppiumBy.XPATH', 'class name': 'AppiumBy.CLASS_NAME', 'css selector': 'AppiumBy.CSS_SELECTOR' };
const pyFind = (using: Using, value: string) => `driver.find_element(${BY[using]}, ${pyStr(value)})`;

export function candidatesFor(node: NativeNode, ps: PageSource): Candidate[] {
  const all = ps.nodes;
  const count = (pred: (n: NativeNode) => boolean) => all.filter(pred).length;
  const out: Candidate[] = [];
  const dyn = (v: string) => (isDynamic(v) ? ['value looks dynamic (count, price or time) and may change between runs'] : []);

  if (node.resourceId) {
    out.push({
      strategy: 'id', using: 'id', value: node.resourceId, python: pyFind('id', node.resourceId),
      strengths: ['resource-id is set by the app developers and usually stable across languages and data'], weaknesses: [], localMatches: count((n) => n.resourceId === node.resourceId),
    });
  }
  if (node.contentDesc) {
    out.push({
      strategy: 'accessibility id', using: 'accessibility id', value: node.contentDesc, python: pyFind('accessibility id', node.contentDesc),
      strengths: ['uses the accessibility label that screen readers announce'], weaknesses: dyn(node.contentDesc), localMatches: count((n) => n.contentDesc === node.contentDesc),
    });
    const v = `new UiSelector().description(${uiStr(node.contentDesc)})`;
    out.push({ strategy: 'uiautomator description', using: '-android uiautomator', value: v, python: pyFind('-android uiautomator', v), strengths: ['resolved on the device by UiAutomator (fast)'], weaknesses: dyn(node.contentDesc), localMatches: count((n) => n.contentDesc === node.contentDesc) });
  }
  if (node.text) {
    const v = `new UiSelector().text(${uiStr(node.text)})`;
    out.push({
      strategy: 'uiautomator text', using: '-android uiautomator', value: v, python: pyFind('-android uiautomator', v),
      strengths: ['matches what the user sees'], weaknesses: ['breaks when the text or the app language changes', ...dyn(node.text)], localMatches: count((n) => n.text === node.text),
    });
    const v2 = `new UiSelector().className(${uiStr(node.className)}).text(${uiStr(node.text)})`;
    out.push({ strategy: 'class + text', using: '-android uiautomator', value: v2, python: pyFind('-android uiautomator', v2), strengths: ['narrows text matches to one widget type'], weaknesses: ['breaks when the text, language or widget class changes', ...dyn(node.text)], localMatches: count((n) => n.text === node.text && n.className === node.className) });
  }
  if (node.resourceId) {
    const same = all.filter((n) => n.resourceId === node.resourceId);
    if (same.length > 1) {
      const inst = same.indexOf(node);
      const v = `new UiSelector().resourceId(${uiStr(node.resourceId)}).instance(${inst})`;
      out.push({ strategy: 'uiautomator id + instance', using: '-android uiautomator', value: v, python: pyFind('-android uiautomator', v), strengths: ['unique even when the id repeats (list rows)'], weaknesses: ['position-based: breaks when rows are added, removed or reordered'], localMatches: null });
    }
  }
  const conds: string[] = [];
  if (node.resourceId) conds.push(`@resource-id=${xpathLiteral(node.resourceId)}`);
  if (node.contentDesc) conds.push(`@content-desc=${xpathLiteral(node.contentDesc)}`);
  if (node.text) conds.push(`@text=${xpathLiteral(node.text)}`);
  if (conds.length) {
    const v = `//${node.className}[${conds.join(' and ')}]`;
    out.push({ strategy: 'xpath attributes', using: 'xpath', value: v, python: pyFind('xpath', v), strengths: ['combines every identifying attribute'], weaknesses: ['XPath is evaluated over the whole page source, which is slower than id or UiAutomator lookups'], localMatches: count((n) => n.className === node.className && (!node.resourceId || n.resourceId === node.resourceId) && (!node.contentDesc || n.contentDesc === node.contentDesc) && (!node.text || n.text === node.text)) });
  }
  out.push({ strategy: 'xpath absolute', using: 'xpath', value: node.path, python: pyFind('xpath', node.path), strengths: ['always available'], weaknesses: ['breaks on any layout change above this element', 'slow on large screens'], localMatches: 1 });
  if (node.bounds && node.bounds.w > 0) {
    const cx = Math.round(node.bounds.x + node.bounds.w / 2);
    const cy = Math.round(node.bounds.y + node.bounds.h / 2);
    out.push({
      strategy: 'coordinates', using: null, value: `${cx},${cy}`, python: `driver.execute_script("mobile: clickGesture", {"x": ${cx}, "y": ${cy}})`,
      strengths: ['works when the element exposes nothing else'], weaknesses: ['tied to this screen size, scroll position and layout', 'cannot be used for assertions'], localMatches: null,
    });
  }
  return out;
}

const sameBounds = (a: { x: number; y: number; width: number; height: number }, b: NativeNode['bounds']) =>
  !!b && Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.width - b.w) <= 2 && Math.abs(a.height - b.h) <= 2;

export function score(c: Candidate, status: Status, resolutionMs: number | null, depth: number): { score: number; notes: string[] } {
  const notes = [`${c.strategy} base ${BASE_SCORE[c.strategy]}`];
  let s = BASE_SCORE[c.strategy];
  if (status === 'verified-unique') (s += 10), notes.push('+10 verified unique on the device');
  if (status === 'ambiguous') (s -= 40), notes.push('-40 several elements match');
  if (status === 'not-found') (s -= 100), notes.push('-100 no element matches on the device');
  if (status === 'wrong-target') (s -= 60), notes.push('-60 the first match is a different element');
  if (c.weaknesses.some((w) => w.includes('dynamic'))) (s -= 25), notes.push('-25 value looks dynamic');
  if (c.strategy === 'xpath absolute' && depth > 6) (s -= 10), notes.push('-10 deep absolute path');
  if (resolutionMs !== null && resolutionMs > 1000) (s -= 10), notes.push('-10 lookup slower than 1 s');
  else if (resolutionMs !== null && resolutionMs > 300) (s -= 5), notes.push('-5 lookup slower than 300 ms');
  return { score: Math.max(0, Math.min(100, s)), notes };
}

/** Asks the device about every candidate: match count, time taken, and whether the first match is this element. */
export async function verifyCandidates(session: Session, node: NativeNode, cands: Candidate[]): Promise<VerifiedCandidate[]> {
  const out: VerifiedCandidate[] = [];
  for (const c of cands) {
    if (!c.using) {
      const r = score(c, 'not-verifiable', null, node.depth);
      out.push({ ...c, status: 'not-verifiable', matchCount: null, resolutionMs: null, score: r.score, scoreNotes: [...r.notes, 'coordinates cannot be verified as an element lookup'] });
      continue;
    }
    const t0 = performance.now();
    try {
      const ids = await session.findElements(c.using, c.value);
      const ms = Math.round(performance.now() - t0);
      let status: Status = ids.length === 0 ? 'not-found' : ids.length > 1 ? 'ambiguous' : 'verified-unique';
      if (ids.length >= 1 && node.bounds) {
        const rect = await session.rect(ids[0]);
        if (!sameBounds(rect, node.bounds)) status = ids.length === 1 ? 'wrong-target' : status;
      }
      const r = score(c, status, ms, node.depth);
      out.push({ ...c, status, matchCount: ids.length, resolutionMs: ms, score: r.score, scoreNotes: r.notes });
    } catch (e) {
      const r = score(c, 'error', null, node.depth);
      out.push({ ...c, status: 'error', matchCount: null, resolutionMs: null, score: 0, scoreNotes: r.notes, error: (e as Error).message });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

export function recommend(list: VerifiedCandidate[]): VerifiedCandidate | null {
  return list.find((c) => c.status === 'verified-unique') ?? null;
}
