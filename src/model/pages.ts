// Page-object planning for Appium Python.
//
// Every locator a recording uses is assigned to the page (screen) it was recorded on, gets one stable,
// readable name per page, and every action used on it becomes one reusable page method. The generators only
// turn these words into language-specific names (camelCase / snake_case / UPPER_CASE).

import type { LocatorParts, Recording } from './recording.ts';

export type MethodKind = 'tap' | 'longpress' | 'doubletap' | 'fill' | 'scroll_to';

export interface PageLocator {
  key: string;
  parts: LocatorParts;
  words: string[];
  title: string;
}

export interface PagePlan {
  words: string[];
  locators: PageLocator[];
  /** method kind + locator key, in first-use order */
  methods: { kind: MethodKind; loc: PageLocator }[];
}

const STOP = new Set(['a', 'an', 'the', 'of', 'to', 'and', 'or']);

export function wordsOf(s: string, max = 4): string[] {
  const w = String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((x) => x && !STOP.has(x));
  return w.slice(0, max);
}

export const camel = (w: string[]) => w.map((x, i) => (i ? x[0].toUpperCase() + x.slice(1) : x)).join('');
export const pascal = (w: string[]) => w.map((x) => x[0].toUpperCase() + x.slice(1)).join('');
export const snakeW = (w: string[]) => w.join('_');

const RESERVED = new Set([
  // TypeScript / JavaScript
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'implements', 'interface', 'package', 'private', 'protected', 'public', 'await', 'constructor', 'screen',
  // Python
  'none', 'pass', 'def', 'del', 'elif', 'except', 'from', 'global', 'is', 'lambda', 'nonlocal', 'not', 'raise', 'as', 'assert', 'async', 'driver', 'self',
]);

/** Words that make a valid identifier in both languages (no leading digit, not reserved). */
function safeWords(w: string[], fallback: string): string[] {
  let out = w.length ? w : [fallback];
  if (/^[0-9]/.test(out[0])) out = [fallback, ...out];
  if (out.length === 1 && RESERVED.has(out[0])) out = [...out, fallback];
  return out;
}

function locatorWords(parts: LocatorParts, title: string): string[] {
  const fromTitle = wordsOf(title);
  if (fromTitle.length) return fromTitle;
  if (parts.by === 'scoped') return wordsOf(`${parts.anchorText ?? ''} ${parts.inner ? parts.inner.value.split('/').pop() : 'row'}`);
  return wordsOf(String(parts.value ?? '').split('/').pop() ?? '');
}

export const partsKey = (p: LocatorParts) => JSON.stringify([p.by, p.value ?? null, p.index ?? null, p.container ?? null, p.anchorText ?? null, p.inner ? [p.inner.by, p.inner.value] : null]);

export class PageRegistry {
  pages = new Map<string, PagePlan>();

  page(screenName: string): PagePlan {
    const words = safeWords(wordsOf(screenName || 'App', 3), 'app');
    const k = words.join('_');
    let p = this.pages.get(k);
    if (!p) {
      p = { words, locators: [], methods: [] };
      this.pages.set(k, p);
    }
    return p;
  }

  locator(screenName: string, parts: LocatorParts, title: string): { page: PagePlan; loc: PageLocator } {
    const page = this.page(screenName);
    const key = partsKey(parts);
    let loc = page.locators.find((l) => l.key === key);
    if (!loc) {
      let words = safeWords(locatorWords(parts, title), 'element');
      if (parts.index !== undefined) words = [...words, String(parts.index + 1)];
      const taken = new Set(page.locators.map((l) => l.words.join('_')));
      let n = 2;
      const base = words;
      while (taken.has(words.join('_'))) words = [...base, String(n++)];
      loc = { key, parts, words, title };
      page.locators.push(loc);
    }
    return { page, loc };
  }

  method(page: PagePlan, kind: MethodKind, loc: PageLocator): string[] {
    if (!page.methods.some((m) => m.kind === kind && m.loc.key === loc.key)) page.methods.push({ kind, loc });
    return methodWords(kind, loc);
  }
}

export function methodWords(kind: MethodKind, loc: PageLocator): string[] {
  const verb = { tap: ['tap'], longpress: ['long', 'press'], doubletap: ['double', 'tap'], fill: ['fill'], scroll_to: ['scroll', 'to'] }[kind];
  return [...verb, ...loc.words];
}

/** Screen name for the page that holds an event's post-action checks. */
export const afterScreen = (e: Recording['events'][number]) => (e.screenAfter ?? e.screen).name;

/** Data key for a typed value: the user's key, else derived from the field name. */
export function dataKey(e: Recording['events'][number], fieldWords: string[], used: Map<string, string>): string {
  const base = e.input?.dataKey ? wordsOf(e.input.dataKey) : fieldWords;
  const words = base.length ? base : ['value'];
  let k = words.join('_');
  let n = 2;
  while (used.has(k) && used.get(k) !== e.id) k = `${words.join('_')}_${n++}`;
  used.set(k, e.id);
  return k;
}
