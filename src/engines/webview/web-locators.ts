// WebView locator candidates for one DOM element, their verification in the live WebView, and scoring.
//
// Candidates (each is a CSS selector or an XPath, so the same locator works in Appium/Chromedriver and in
// Appium WebView session):
//   data-testid (and data-test, data-qa, data-cy) · CSS id · name · aria-label · placeholder · other attributes ·
//   text (XPath) · relative CSS (a distinctive ancestor + the element) · XPath by attribute · absolute XPath.
// Elements inside iframes carry the frame path (CSS selectors of the iframes from the top document).
//
// Score = strategy base + verification + stability rules (all listed in RULES and shown in the UI):
//   +10 verified unique and the right element · −40 several matches · −100 no match · −60 first match is another
//   element · −25 value looks generated (digits/hash ids, framework ids) · −10 deep absolute path ·
//   −5 lookup slower than 300 ms, −10 slower than 1 s · −15 inside an iframe (needs frame switching; not supported
//   without frame switching).

import type { Session } from '../appium/webdriver.ts';
import { framePath, SAME_ELEMENT_SCRIPT, VERIFY_SCRIPT, type DomNode, type DomSnapshot } from './dom.ts';

export type WebStrategy = 'data-testid' | 'css id' | 'css name' | 'css aria-label' | 'css placeholder' | 'css attribute' | 'xpath text' | 'css relative' | 'xpath attribute' | 'xpath absolute';

export const WEB_BASE: Record<WebStrategy, number> = {
  'data-testid': 95,
  'css id': 90,
  'css name': 80,
  'css aria-label': 78,
  'xpath text': 72,
  'css placeholder': 70,
  'css attribute': 65,
  'css relative': 60,
  'xpath attribute': 55,
  'xpath absolute': 20,
};

export const RULES = [
  'Base by strategy: data-testid 95, id 90, name 80, aria-label 78, text 72, placeholder 70, other attribute 65, relative CSS 60, XPath by attribute 55, absolute XPath 20.',
  '+10 when the live WebView returns exactly one match and it is this element.',
  '-40 when several elements match; -100 when none does; -60 when the first match is a different element.',
  '-25 when the value looks generated (long digit runs, hashes, framework ids such as ember123, :r1:, mui-12).',
  '-10 for an absolute XPath deeper than 6 levels; -5 / -10 when the lookup took more than 300 ms / 1 s.',
  '-15 inside an iframe: the test must switch frames.',
];

export interface WebCandidate {
  strategy: WebStrategy;
  using: 'css selector' | 'xpath';
  value: string;
  frames: string[];
  strengths: string[];
  weaknesses: string[];
  /** Filled by verification. */
  status: 'verified-unique' | 'ambiguous' | 'not-found' | 'wrong-target' | 'error' | 'not-verified';
  matches: number | null;
  ms: number | null;
  score: number;
  python: string;
}

// generated-looking: long digit runs, hex hashes, framework prefixes, or a suffix that mixes letters and digits
const DYNAMIC = /\d{3,}|\b[a-f0-9]{8,}\b|^(ember|react-|mui-|:r|j_id|ext-gen|yui_|gwt-)|[_-](?=[a-z]*\d)[a-z0-9]{5,}$/i;
export const looksGenerated = (v: string) => DYNAMIC.test(v);

const cssStr = (v: string) => '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ') + '"';
const cssIdent = (v: string) => (/^-?[A-Za-z_][A-Za-z0-9_-]*$/.test(v) ? v : v.replace(/^(\d)/, '\\3$1 ').replace(/[^A-Za-z0-9_-]/g, (c) => '\\' + c));
export function xpathLit(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `concat(${s.split("'").map((p) => `'${p}'`).join(`, "'", `)})`;
}

export function webCodes(using: 'css selector' | 'xpath', value: string, frames: string[]) {
  const py = `(AppiumBy.${using === 'xpath' ? 'XPATH' : 'CSS_SELECTOR'}, ${JSON.stringify(value)})`;
  return {
    python: frames.length ? `${py}  # inside frame(s) ${frames.join(' > ')}` : py,
  };
}

/** Candidate locators for `node`, built from the snapshot (not yet verified). */
export function webCandidates(snap: DomSnapshot, node: DomNode): WebCandidate[] {
  const frames = node.frame >= 0 ? framePath(snap, node.frame) : [];
  const sameDoc = snap.nodes.filter((n) => n.frame === node.frame);
  const tag = node.tag;
  const out: WebCandidate[] = [];
  const add = (strategy: WebStrategy, using: 'css selector' | 'xpath', value: string, strengths: string[], weaknesses: string[] = []) => {
    if (out.some((c) => c.using === using && c.value === value)) return;
    const w = [...weaknesses];
    if (frames.length) w.push(`inside iframe ${frames.join(' > ')}: the test must switch frames (Appium)`);
    out.push({ strategy, using, value, frames, strengths, weaknesses: w, status: 'not-verified', matches: null, ms: null, score: 0, ...webCodes(using, value, frames) });
  };
  const local = (pred: (n: DomNode) => boolean) => sameDoc.filter(pred).length;

  for (const a of ['data-testid', 'data-test', 'data-qa', 'data-cy']) {
    const v = node.attrs[a];
    if (v) add('data-testid', 'css selector', `[${a}=${cssStr(v)}]`, ['made for tests: usually stable across releases and languages'], looksGenerated(v) ? ['value looks generated'] : []);
  }
  if (node.id) add('css id', 'css selector', `#${cssIdent(node.id)}`, ['ids are meant to be unique in a document'], looksGenerated(node.id) ? ['id looks generated by a framework or build: it may change between builds'] : []);
  if (node.attrs.name) add('css name', 'css selector', `${tag}[name=${cssStr(node.attrs.name)}]`, ['form field names rarely change (the server reads them)']);
  if (node.attrs['aria-label']) add('css aria-label', 'css selector', `${tag}[aria-label=${cssStr(node.attrs['aria-label'])}]`, ['accessible name: tied to what users hear'], ['changes with the app language']);
  if (node.attrs.placeholder) add('css placeholder', 'css selector', `${tag}[placeholder=${cssStr(node.attrs.placeholder)}]`, ['visible hint text'], ['changes with copy or language edits']);
  for (const a of ['type', 'href', 'alt', 'title', 'role']) {
    const v = node.attrs[a];
    if (!v || (a === 'type' && ['text', 'button', 'submit'].includes(v) && local((n) => n.tag === tag && n.attrs.type === v) > 1)) continue;
    add('css attribute', 'css selector', `${tag}[${a}=${cssStr(v)}]`, [`matches on ${a}`], a === 'href' ? ['links often carry session or tracking parameters'] : []);
  }
  const text = node.text || (node.childCount === 0 ? node.fullText : '');
  if (text && text.length <= 60 && !node.sensitive) {
    add('xpath text', 'xpath', `//${tag}[normalize-space(.)=${xpathLit(text)}]`, ['reads like the screen'], [...(/\d/.test(text) ? ['text contains digits: may be dynamic (counts, prices, times)'] : []), 'changes with copy or language edits']);
  }
  // relative CSS: a distinctive ancestor, then the element by tag + first class
  const own = `${tag}${node.classes[0] ? '.' + cssIdent(node.classes[0]) : ''}`;
  for (let p = node.parent, hops = 0; p !== null && hops < 4; p = snap.nodes[p].parent, hops++) {
    const a = snap.nodes[p];
    if (a.frame !== node.frame) break;
    const dataAttr = Object.keys(a.attrs).find((k) => k.startsWith('data-') && !/^data-(v-|reactid)/.test(k) && a.attrs[k] && !looksGenerated(a.attrs[k]));
    const anchor = a.attrs['data-testid'] ? `[data-testid=${cssStr(a.attrs['data-testid'])}]` : a.id && !looksGenerated(a.id) ? `#${cssIdent(a.id)}` : dataAttr ? `${a.tag}${a.classes[0] ? '.' + cssIdent(a.classes[0]) : ''}[${dataAttr}=${cssStr(a.attrs[dataAttr])}]` : null;
    if (!anchor) continue;
    add('css relative', 'css selector', `${anchor} ${own}`, ['anchored on a distinctive container (for example a list row)'], ['breaks if the container structure changes']);
    break;
  }
  const attrX = node.attrs['data-testid'] ? ['data-testid', node.attrs['data-testid']] : node.attrs.name ? ['name', node.attrs.name] : node.attrs['aria-label'] ? ['aria-label', node.attrs['aria-label']] : node.attrs.placeholder ? ['placeholder', node.attrs.placeholder] : null;
  if (attrX) add('xpath attribute', 'xpath', `//${tag}[@${attrX[0]}=${xpathLit(attrX[1])}]`, ['works where CSS is unavailable'], ['slower than CSS in most engines']);
  // absolute XPath from the frame document root
  const chain: DomNode[] = [];
  for (let c: DomNode | undefined = node; c && c.frame === node.frame; c = c.parent === null ? undefined : snap.nodes[c.parent]) {
    if (c.tag === 'iframe' && c !== node) break;
    chain.unshift(c);
  }
  const abs = '/' + chain.map((c) => `${c.tag}[${c.nth}]`).join('/');
  add('xpath absolute', 'xpath', abs, ['always available'], ['breaks on any layout change', ...(chain.length > 6 ? [`${chain.length} levels deep`] : [])]);
  return out;
}

export function scoreWeb(c: WebCandidate): number {
  let s = WEB_BASE[c.strategy];
  if (c.status === 'verified-unique') s += 10;
  else if (c.status === 'ambiguous') s -= 40;
  else if (c.status === 'not-found') s -= 100;
  else if (c.status === 'wrong-target') s -= 60;
  if (c.weaknesses.some((w) => /generated/.test(w))) s -= 25;
  if (c.strategy === 'xpath absolute' && c.weaknesses.some((w) => /levels deep/.test(w))) s -= 10;
  if (c.ms !== null) s -= c.ms > 1000 ? 10 : c.ms > 300 ? 5 : 0;
  if (c.frames.length) s -= 15;
  return s;
}

/**
 * Verifies candidates in the live WebView: switches into the element's frame, asks WebDriver to find each one
 * (count + time, as the test will), and checks in the page that the first match is this element.
 * Always returns to the top-level document.
 */
export async function verifyWeb(session: Session, snap: DomSnapshot, node: DomNode, cands: WebCandidate[]): Promise<WebCandidate[]> {
  const frames = node.frame >= 0 ? framePath(snap, node.frame) : [];
  try {
    await enterFrames(session, frames);
    const inPage = (await session.executeArgs(VERIFY_SCRIPT, [node.path, cands.map((c) => ({ using: c.using, value: c.value }))])) as { count: number; isTarget: boolean; ms: number; error: string | null }[];
    for (let k = 0; k < cands.length; k++) {
      const c = cands[k];
      const t0 = Date.now();
      try {
        const ids = await session.findElements(c.using, c.value);
        c.ms = Date.now() - t0;
        c.matches = ids.length;
        let isTarget = inPage[k]?.isTarget ?? false;
        if (ids.length) isTarget = (await session.executeArgs(SAME_ELEMENT_SCRIPT, [{ element: ids[0] }, node.path])) === true;
        c.status = ids.length === 0 ? 'not-found' : ids.length > 1 ? 'ambiguous' : !isTarget ? 'wrong-target' : 'verified-unique';
      } catch (e) {
        c.status = 'error';
        c.weaknesses.push(`lookup failed: ${(e as Error).message.slice(0, 160)}`);
      }
      c.score = scoreWeb(c);
    }
  } finally {
    await session.switchFrame(null).catch(() => {});
  }
  return cands.sort((a, b) => b.score - a.score);
}

/** Switches from the top document into the given iframe path (CSS selectors, outermost first). */
export async function enterFrames(session: Session, frames: string[]) {
  await session.switchFrame(null);
  for (const sel of frames) {
    const ids = await session.findElements('css selector', sel);
    if (!ids.length) throw new Error(`iframe ${sel} not found`);
    await session.switchFrame(ids[0]);
  }
}

/** The best verified candidate, or null when none is verified unique. */
export const recommendWeb = (c: WebCandidate[]) => c.find((x) => x.status === 'verified-unique') ?? null;
