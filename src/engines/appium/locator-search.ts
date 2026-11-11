// Live locator search: evaluates a locator against the screen that is already in memory, so every keystroke
// can show how many elements match and where they are, with no device round trip.
//
// Supported offline: id, accessibility id, exact text, text contains, class name, XPath 1.0, and the common
// UiSelector chains. Anything else is reported as "device only" rather than guessed.

import type { NativeNode, PageSource } from './page-source.ts';

export type SearchUsing = 'auto' | 'id' | 'accessibility id' | 'text' | 'text contains' | 'class name' | 'xpath' | '-android uiautomator';

export interface SearchResult {
  using: Exclude<SearchUsing, 'auto'>;
  value: string;
  /** Indexes of matching nodes in the captured screen, in document order. */
  indexes: number[];
  count: number;
  ms: number;
  /** Ready-to-paste Python, when the strategy maps to an Appium locator. */
  python: string | null;
  /** Set when the locator could not be evaluated offline; `indexes` is then empty. */
  error: string | null;
  deviceOnly: boolean;
}

const py = (s: string) => JSON.stringify(s);

/** Picks the strategy a tester most likely means from the shape of what they typed. */
export function detectUsing(value: string): Exclude<SearchUsing, 'auto'> {
  const v = value.trim();
  if (/^(\/|\(|\.\/)/.test(v)) return 'xpath';
  if (/^new\s+Ui(Selector|Scrollable)\s*\(/.test(v)) return '-android uiautomator';
  if (/^[\w.]+:id\/[\w.]+$/.test(v)) return 'id';
  if (/^[a-z][\w]*(\.[a-z_][\w]*)+\.[A-Z]\w*$/.test(v)) return 'class name';
  return 'text contains';
}

type Predicate = (n: NativeNode) => boolean;

/** `new UiSelector().resourceId("x").text("y").instance(1)` -> predicates and an optional instance. */
export function parseUiSelector(value: string): { predicates: Predicate[]; instance: number | null } | { unsupported: string } {
  let rest = value.trim();
  const head = /^new\s+UiSelector\s*\(\s*\)/.exec(rest);
  if (!head) return { unsupported: 'only "new UiSelector()..." chains are evaluated offline' };
  rest = rest.slice(head[0].length);
  const predicates: Predicate[] = [];
  let instance: number | null = null;
  const call = /^\s*\.\s*(\w+)\s*\(\s*("(?:[^"\\]|\\.)*"|-?\d+|true|false)\s*\)/;
  while (rest.trim()) {
    const m = call.exec(rest);
    if (!m) return { unsupported: `cannot read "${rest.trim().slice(0, 40)}"` };
    rest = rest.slice(m[0].length);
    const [, name, raw] = m;
    const str = raw.startsWith('"') ? (JSON.parse(raw) as string) : null;
    const num = /^-?\d+$/.test(raw) ? Number(raw) : null;
    const bool = raw === 'true' ? true : raw === 'false' ? false : null;
    const needStr = (fn: (n: NativeNode, s: string) => boolean) => {
      if (str === null) return false;
      predicates.push((n) => fn(n, str));
      return true;
    };
    const flag = (key: keyof NativeNode['flags']) => {
      if (bool === null) return false;
      predicates.push((n) => (n.flags[key] ?? false) === bool);
      return true;
    };
    let ok = false;
    if (name === 'resourceId') ok = needStr((n, s) => n.resourceId === s);
    else if (name === 'resourceIdMatches') ok = needStr((n, s) => new RegExp(`^(?:${s})$`).test(n.resourceId));
    else if (name === 'text') ok = needStr((n, s) => n.text === s);
    else if (name === 'textContains') ok = needStr((n, s) => n.text.includes(s));
    else if (name === 'textStartsWith') ok = needStr((n, s) => n.text.startsWith(s));
    else if (name === 'textMatches') ok = needStr((n, s) => new RegExp(`^(?:${s})$`).test(n.text));
    else if (name === 'description') ok = needStr((n, s) => n.contentDesc === s);
    else if (name === 'descriptionContains') ok = needStr((n, s) => n.contentDesc.includes(s));
    else if (name === 'descriptionStartsWith') ok = needStr((n, s) => n.contentDesc.startsWith(s));
    else if (name === 'className') ok = needStr((n, s) => n.className === s);
    else if (name === 'packageName') ok = needStr((n, s) => n.packageName === s);
    else if (name === 'clickable') ok = flag('clickable');
    else if (name === 'enabled') ok = flag('enabled');
    else if (name === 'checked') ok = flag('checked');
    else if (name === 'checkable') ok = flag('checkable');
    else if (name === 'selected') ok = flag('selected');
    else if (name === 'focused') ok = flag('focused');
    else if (name === 'scrollable') ok = flag('scrollable');
    else if (name === 'instance' && num !== null && num >= 0) (instance = num), (ok = true);
    if (!ok) return { unsupported: `.${name}(...) is evaluated on the device only` };
  }
  return { predicates, instance };
}

let xmlTools: Promise<{ parse: (xml: string) => unknown; select: (expr: string, doc: unknown) => unknown } | null> | undefined;

async function loadXmlTools() {
  xmlTools ??= (async () => {
    try {
      const [{ DOMParser }, xpath] = await Promise.all([import('@xmldom/xmldom'), import('xpath')]);
      const quiet = { locator: {}, errorHandler: { warning() {}, error() {}, fatalError(e: unknown) { throw new Error(String(e)); } } };
      const select = (xpath as unknown as { default?: { select: (e: string, d: unknown) => unknown }; select?: (e: string, d: unknown) => unknown });
      return {
        parse: (xml: string) => new (DOMParser as unknown as new (o: unknown) => { parseFromString(x: string, t: string): unknown })(quiet).parseFromString(xml, 'text/xml'),
        select: (expr: string, doc: unknown) => (select.select ?? select.default!.select)(expr, doc),
      };
    } catch {
      return null;
    }
  })();
  return xmlTools;
}

interface DomElement {
  nodeType: number;
  nodeName: string;
}

// One parsed document per captured screen: typing in the search box re-evaluates against the same DOM.
let domCache: { xml: string; doc: unknown; order: Map<unknown, number> } | null = null;

/** Indexes of the controls an XPath selects on a captured screen, in document order. Throws on an invalid expression. */
export async function evalXPath(xml: string, ps: PageSource, expr: string): Promise<number[]> {
  const tools = await loadXmlTools();
  if (!tools) throw new Error('XPath search needs the "xpath" and "@xmldom/xmldom" packages: run npm ci');
  if (!domCache || domCache.xml !== xml) {
    const doc = tools.parse(xml) as { getElementsByTagName(n: string): ArrayLike<DomElement> };
    const all = doc.getElementsByTagName('*');
    const order = new Map<unknown, number>();
    let i = 0;
    for (let k = 0; k < all.length; k++) if (all[k].nodeName !== 'hierarchy') order.set(all[k], i++);
    if (i !== ps.nodes.length) throw new Error('the captured screen could not be indexed for XPath (element counts differ)');
    domCache = { xml, doc, order };
  }
  const found = tools.select(expr, domCache.doc);
  if (!Array.isArray(found)) throw new Error('the XPath must select elements, not a value');
  const out: number[] = [];
  for (const el of found as DomElement[]) {
    if (el.nodeType !== 1) throw new Error('the XPath must select elements, not attributes or text');
    const idx = domCache.order.get(el);
    if (idx !== undefined) out.push(idx);
  }
  return out;
}

export async function searchLocal(ps: PageSource, xml: string | null, usingIn: SearchUsing, valueIn: string): Promise<SearchResult> {
  const value = String(valueIn ?? '').trim();
  const using = usingIn === 'auto' ? detectUsing(value) : usingIn;
  const t0 = performance.now();
  const done = (indexes: number[], python: string | null, error: string | null = null, deviceOnly = false): SearchResult => ({ using, value, indexes, count: indexes.length, ms: Math.round((performance.now() - t0) * 10) / 10, python, error, deviceOnly });
  if (!value) return done([], null, 'Type a locator.');
  if (value.length > 2_000) return done([], null, 'The locator is too long.');
  const where = (pred: Predicate) => ps.nodes.filter(pred).map((n) => n.index);
  try {
    if (using === 'id') {
      const full = value.includes(':id/');
      return done(where((n) => (full ? n.resourceId === value : n.resourceId.endsWith(`:id/${value}`))), `(AppiumBy.ID, ${py(value)})`);
    }
    if (using === 'accessibility id') return done(where((n) => n.contentDesc === value), `(AppiumBy.ACCESSIBILITY_ID, ${py(value)})`);
    if (using === 'text') return done(where((n) => n.text === value), `(AppiumBy.ANDROID_UIAUTOMATOR, ${py(`new UiSelector().text(${JSON.stringify(value)})`)})`);
    if (using === 'text contains') {
      const q = value.toLowerCase();
      return done(where((n) => [n.text, n.contentDesc, n.resourceId].some((s) => s.toLowerCase().includes(q))), null);
    }
    if (using === 'class name') return done(where((n) => n.className === value), `(AppiumBy.CLASS_NAME, ${py(value)})`);
    if (using === '-android uiautomator') {
      const parsed = parseUiSelector(value);
      if ('unsupported' in parsed) return done([], `(AppiumBy.ANDROID_UIAUTOMATOR, ${py(value)})`, `Not evaluated offline: ${parsed.unsupported}.`, true);
      let hits = ps.nodes.filter((n) => parsed.predicates.every((p) => p(n)));
      if (parsed.instance !== null) hits = hits[parsed.instance] ? [hits[parsed.instance]] : [];
      return done(hits.map((n) => n.index), `(AppiumBy.ANDROID_UIAUTOMATOR, ${py(value)})`);
    }
    if (!xml) return done([], `(AppiumBy.XPATH, ${py(value)})`, 'Refresh the screen once to enable XPath search.');
    return done(await evalXPath(xml, ps, value), `(AppiumBy.XPATH, ${py(value)})`);
  } catch (e) {
    return done([], null, (e as Error).message.split('\n')[0]);
  }
}
