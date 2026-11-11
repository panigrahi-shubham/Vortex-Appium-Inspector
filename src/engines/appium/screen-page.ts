// Whole-screen page object: one click turns the captured screen into a Python page class with a locator and
// a method for every control a test is likely to use. Built only from the page source already in memory.
//
// A control is included only when it has a locator that is unique on the captured screen (or a repeated
// resource-id, addressed by position). Controls with nothing but an absolute XPath are listed as skipped,
// never written as fragile code. Nothing here is checked on the device.

import { partsForCandidate, pyStr, rankOffline, xpathLiteral } from './native-locators.ts';
import type { NativeNode, PageSource } from './page-source.ts';

export type ElementKind = 'input' | 'toggle' | 'button' | 'text';

export interface ScreenElement {
  /** Index of the control on the captured screen (the first row for a repeated control). */
  index: number;
  kind: ElementKind;
  /** Python constant name, e.g. HOME_SEARCH_INPUT, or CATEGORY_CARD_ROW for a repeated control. */
  constant: string;
  method: string;
  /** Python locator tuple, or for a repeated control the XPath template containing {row}. */
  locator: string;
  /** How many controls share this id on the captured screen; null for a single control. */
  rows: number | null;
  note: string | null;
}

export interface ScreenPage {
  className: string;
  fileName: string;
  content: string;
  elements: ScreenElement[];
  skipped: { index: number; label: string; reason: string }[];
}

const STABLE = new Set(['id', 'accessibility id', 'uiautomator text', 'xpath attributes']);
const MAX_ELEMENTS = 80;

export function snake(s: string): string {
  const out = s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/, '');
  return /^[0-9]/.test(out) ? `el_${out}` : out;
}

const pascal = (s: string) =>
  snake(s)
    .split('_')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');

function kindOf(n: NativeNode): ElementKind | null {
  if (/EditText$/.test(n.className)) return 'input';
  if (n.flags.checkable) return 'toggle';
  if (n.flags.clickable) return 'button';
  if (n.text && n.resourceId) return 'text';
  return null;
}

function locatorCode(parts: { by: string; value: string; index?: number }, pkg: string): string {
  const attr = parts.by === 'id' ? 'resource-id' : parts.by === 'label' ? 'content-desc' : 'text';
  if (parts.index !== undefined && parts.by !== 'xpath') return `(AppiumBy.XPATH, ${pyStr(`(//*[@${attr}=${xpathLiteral(parts.value)}])[${parts.index + 1}]`)})`;
  if (parts.by === 'id') return parts.value.startsWith(`${pkg}:id/`) ? `(AppiumBy.ID, ID(${pyStr(parts.value.slice(pkg.length + 4))}))` : `(AppiumBy.ID, ${pyStr(parts.value)})`;
  if (parts.by === 'label') return `(AppiumBy.ACCESSIBILITY_ID, ${pyStr(parts.value)})`;
  if (parts.by === 'text') return `(AppiumBy.ANDROID_UIAUTOMATOR, ${pyStr(`new UiSelector().text(${JSON.stringify(parts.value)})`)})`;
  return `(AppiumBy.XPATH, ${pyStr(parts.value)})`;
}

/** tap_login for login_button, fill_search for search_input, home_title for home_title_text. */
function methodName(kind: ElementKind, name: string): string {
  const strip = (re: RegExp) => name.replace(re, '') || name;
  if (kind === 'input') return `fill_${strip(/_(input|field|edit|edit_text|et)$/)}`;
  if (kind === 'toggle') return `set_${strip(/_(checkbox|check|switch|toggle|radio)$/)}`;
  if (kind === 'button') return `tap_${strip(/_(button|btn)$/)}`;
  return /_(text|label|title|tv)$/.test(name) ? name : `${name}_text`;
}

/**
 * `anchors` (optional) maps the index of a control without an id, label or unique text to an XPath anchored
 * to a nearby label, already checked against this screen (see anchor-locators.ts). Without it such controls
 * are listed as skipped.
 */
export function buildScreenPage(ps: PageSource, opts: { name: string; pkg: string }, anchors: Map<number, { value: string; label: string }> = new Map()): ScreenPage {
  const base = snake(opts.name) || 'screen';
  const className = `${pascal(base)}Page`;
  const elements: ScreenElement[] = [];
  const skipped: ScreenPage['skipped'] = [];
  const usedNames = new Set<string>();
  const usedMethods = new Set<string>(['wait_until_loaded']);
  const seenRepeated = new Set<string>();
  const claim = (set: Set<string>, wanted: string) => {
    let name = wanted;
    for (let k = 2; set.has(name); k++) name = `${wanted}_${k}`;
    set.add(name);
    return name;
  };

  for (const n of ps.nodes) {
    const kind = kindOf(n);
    if (!kind || !n.bounds || n.bounds.w <= 0 || n.bounds.h <= 0) continue;
    if (n.packageName && n.packageName !== opts.pkg) continue; // status bar, keyboard, system dialogs
    const label = n.text || n.contentDesc || n.resourceId || n.className;
    if (elements.length >= MAX_ELEMENTS) {
      skipped.push({ index: n.index, label, reason: `more than ${MAX_ELEMENTS} controls on this screen` });
      continue;
    }
    const idName = n.resourceId.includes(':id/') ? n.resourceId.slice(n.resourceId.indexOf(':id/') + 4) : n.resourceId;
    const same = n.resourceId ? ps.nodes.filter((x) => x.resourceId === n.resourceId) : [];

    // A repeated id is a list: one row-addressed locator and one method with a `row` argument, not a copy per row.
    if (same.length > 1) {
      if (seenRepeated.has(n.resourceId)) continue;
      seenRepeated.add(n.resourceId);
      const name = claim(usedNames, snake(idName));
      const template = `(//*[@resource-id=${xpathLiteral(n.resourceId)}])[{row}]`;
      if (/[{}]/.test(n.resourceId)) {
        skipped.push({ index: n.index, label, reason: 'the id contains braces and cannot be used as a row template' });
        continue;
      }
      elements.push({ index: n.index, kind, constant: `${name.toUpperCase()}_ROW`, method: claim(usedMethods, methodName(kind, name)), locator: template, rows: same.length, note: `${same.length} on the captured screen; rows are 1-based and follow the list order` });
      continue;
    }

    let parts: { by: string; value: string; index?: number } | null = null;
    let note: string | null = null;
    if (n.resourceId) parts = { by: 'id', value: n.resourceId };
    else {
      // No id: fall back to a label or text that is unique on the captured screen. An input's text is what the
      // test replaces, so it is never used as that input's locator.
      const unique = rankOffline(n, ps).find((c) => c.status === 'local-unique' && STABLE.has(c.strategy) && !(kind === 'input' && (c.strategy === 'uiautomator text' || (c.strategy === 'xpath attributes' && !n.contentDesc))));
      parts = unique ? partsForCandidate(unique, n, ps) : null;
      if (unique?.weaknesses.some((w) => w.includes('dynamic'))) note = 'value looks dynamic: review';
      else if (unique?.strategy === 'uiautomator text') note = 'located by its text: breaks if the wording or language changes';
    }
    const anchor = parts ? undefined : anchors.get(n.index);
    if (anchor) {
      parts = { by: 'xpath', value: anchor.value };
      note = `found from the label "${anchor.label}": breaks if that wording changes`;
    }
    if (!parts) {
      skipped.push({ index: n.index, label, reason: 'no id, label, unique text or nearby label: only an absolute XPath would work' });
      continue;
    }
    const wanted = snake(anchor ? `${anchor.label} ${kind === 'input' ? 'input' : kind}` : idName || n.contentDesc || n.text);
    if (!wanted) {
      skipped.push({ index: n.index, label, reason: 'no readable name could be made for this control' });
      continue;
    }
    const name = claim(usedNames, wanted);
    elements.push({ index: n.index, kind, constant: name.toUpperCase(), method: claim(usedMethods, methodName(kind, name)), locator: locatorCode(parts, opts.pkg), rows: null, note });
  }

  const single = elements.filter((e) => e.rows === null);
  const anchor = single.find((e) => e.kind === 'text' && e.locator.includes('AppiumBy.ID')) ?? single.find((e) => e.locator.includes('AppiumBy.ID')) ?? single[0];
  const usesId = elements.some((e) => e.locator.includes(' ID('));
  const L: string[] = [];
  L.push(
    `"""${className}: page object for the "${opts.name.replace(/["\\]/g, '')}" screen of ${opts.pkg}.`,
    '',
    'Generated by Vortex from one captured screen (vortex-appium-python v1, screen page).',
    'Every locator was unique on that screen when it was captured. None was checked on the device:',
    'run your test once before relying on them.',
    '"""',
    '',
    'import os',
    '',
    'from appium.webdriver.common.appiumby import AppiumBy',
    'from selenium.webdriver.support import expected_conditions as EC',
    'from selenium.webdriver.support.ui import WebDriverWait',
    '',
    `APP_PACKAGE = os.environ.get("APP_PACKAGE", ${pyStr(opts.pkg)})`,
    'TIMEOUT = float(os.environ.get("VORTEX_TIMEOUT", "15"))',
    '',
  );
  if (usesId) L.push('', 'def ID(name):', '    """Full resource-id of an element in the app under test."""', '    return f"{APP_PACKAGE}:id/{name}"', '');
  L.push('', `class ${className}:`);
  if (!elements.length) L.push('    """No control with a stable locator was found on the captured screen."""', '');
  for (const e of elements) L.push(`    ${e.constant} = ${e.rows === null ? e.locator : pyStr(e.locator)}${e.note ? `  # ${e.note}` : ''}`);
  L.push(
    '',
    '    def __init__(self, driver):',
    '        self.driver = driver',
    '',
    '    def _visible(self, locator):',
    '        return WebDriverWait(self.driver, TIMEOUT).until(EC.visibility_of_element_located(locator), f"not visible: {locator}")',
    '',
    '    def _clickable(self, locator):',
    '        return WebDriverWait(self.driver, TIMEOUT).until(EC.element_to_be_clickable(locator), f"not clickable: {locator}")',
  );
  if (anchor) L.push('', '    def wait_until_loaded(self):', `        """Waits for this screen (its ${anchor.constant} control) and returns the page for chaining."""`, `        self._visible(self.${anchor.constant})`, '        return self');
  for (const e of elements) {
    const row = e.rows !== null;
    const loc = row ? `(AppiumBy.XPATH, self.${e.constant}.format(row=row))` : `self.${e.constant}`;
    const args = (extra = '') => `(self${extra}${row ? ', row=1' : ''})`;
    L.push('');
    if (e.kind === 'input') L.push(`    def ${e.method}${args(', value')}:`, `        field = self._visible(${loc})`, '        field.clear()', '        field.send_keys(value)', '        return self');
    else if (e.kind === 'toggle') L.push(`    def ${e.method}${args(', checked=True')}:`, `        box = self._clickable(${loc})`, '        if (box.get_attribute("checked") == "true") != checked:', '            box.click()', '        return self');
    else if (e.kind === 'button') L.push(`    def ${e.method}${args()}:`, `        self._clickable(${loc}).click()`);
    else L.push(`    def ${e.method}${args()}:`, `        return self._visible(${loc}).text`);
  }
  return { className, fileName: `${base}_page.py`, content: L.join('\n') + '\n', elements, skipped };
}
