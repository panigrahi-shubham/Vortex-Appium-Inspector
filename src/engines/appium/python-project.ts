// Appium Python generation from the shared recording model: Plain (one standalone pytest file, the
// Milestone 2 format) and POM (page objects, base page, data module, conftest fixtures, test).
//
// Python POM layout inside <case>/appium/pom/:
//   pytest.ini                         marks the folder as pytest's root, so conftest.py is found for a single file
//   conftest.py                        driver fixture + one fixture per page
//   pages/<module>_<case>_pages/       the page package; its name is unique per case so several cases can run in
//                                      one pytest process without module-name collisions
//   tests/test_<module>_<case>_pom.py  the test (file name differs from the Plain one for the same reason)

import { afterScreen, dataKey, PageRegistry, snakeW, type MethodKind, type PageLocator, type PagePlan } from '../../model/pages.ts';
import { describeEvent, isCoordinateEvent, type GeneratedFile, type GenerationIssue } from '../../model/output.ts';
import type { AssertionKind, LocatorParts, Recording } from '../../model/recording.ts';
import { pyStr } from './native-locators.ts';
import { ACTIVITY_HELPER, activityName, CHECKPOINT_HELPER, checkpointName, CHROMEDRIVER_CAPS, CodegenValidationError, generatePython, KEYCODES, PY_REQUIREMENTS, pyLocator, segKey, snake, WEBVIEW_HELPER, webviewHeader, type RecordedStep } from './python-codegen.ts';

export const PY_FORMAT = 'vortex-appium-python v1';

/** Python identifier from free text (never starts with a digit). */
export function pyIdent(s: string): string {
  const v = snake(s);
  return /^[0-9]/.test(v) ? `t_${v}` : v;
}

/** The model as the step objects the Milestone 2 generator reads. */
export function recordingToPySteps(rec: Recording): RecordedStep[] {
  return rec.events.map((e) => {
    const a = e.action;
    const args: Record<string, unknown> = {};
    if (a.key !== undefined) args.key = a.key;
    if (a.direction !== undefined) args.direction = a.direction;
    if (a.distance !== undefined) args.distance = a.distance;
    if (a.from) args.from = a.from;
    if (a.to) args.to = a.to;
    if (a.durationMs !== undefined) args.duration = a.durationMs;
    if (a.ms !== undefined) args.ms = a.ms;
    if (a.url !== undefined) args.url = a.url;
    if (a.activity !== undefined) args.activity = a.activity;
    if (a.name !== undefined) args.name = a.name;
    if (e.input?.text !== undefined) args.text = e.input.text;
    if (e.check) {
      args.assertion = e.check.kind;
      if (e.check.expected !== undefined) args.expected = e.check.expected;
    }
    return {
      type: a.type,
      title: e.title,
      ...(e.target ? { target: { kind: e.target.kind, ...(e.target.parts ? { parts: e.target.parts } : {}) } } : {}),
      ...(e.position ? { x: e.position.x, y: e.position.y } : {}),
      pre: e.preCheck,
      mode: e.tapStyle,
      args,
      post: e.post.map((p) => ({ assertion: p.kind, expected: p.expected, ...(p.target.parts ? { parts: p.target.parts } : {}), title: p.title })),
      ...(e.observations.settleMs !== null ? { settleMs: e.observations.settleMs } : {}),
      ...(e.input?.secretEnv ? { secretEnv: e.input.secretEnv } : {}),
      ...(e.context === 'WEBVIEW' ? { context: 'WEBVIEW' as const, webview: e.webview } : {}),
    };
  });
}

/** One page of the shared library as it is persisted: names never change once given, so earlier tests keep working. */
export interface LibraryPage {
  words: string[];
  locators: { key: string; parts: LocatorParts; words: string[]; title: string }[];
  methods: { kind: MethodKind; key: string }[];
}

/** Page objects shared by every POM test of one app (see docs/ARCHITECTURE.md, "Shared page library"). */
export interface SharedLibrary {
  /** Python package name of the shared pages, e.g. com_example_app_pages. */
  pkgName: string;
  /** True once any test used a WebView page (the base page then carries the WebView helpers). */
  web: boolean;
  pages: LibraryPage[];
}

export interface PyOptions {
  moduleSlug: string;
  caseSlug: string;
  size: { width: number; height: number } | null;
  /** When set, POM pages are read from and added to this library instead of a private package per test. */
  library?: SharedLibrary | null;
}

/** Folder (relative to the output folder) that holds the shared page packages. */
export const SHARED_PAGES_DIR = '_shared/pages';

export const pyStem = (o: Pick<PyOptions, 'moduleSlug' | 'caseSlug'>) => pyIdent(`${o.moduleSlug}_${o.caseSlug}`);

export function generatePythonPlainFiles(rec: Recording, o: PyOptions): { files: GeneratedFile[]; issues: GenerationIssue[] } {
  try {
    const g = generatePython(recordingToPySteps(rec), {
      name: rec.name,
      appPackage: rec.app.package,
      size: o.size,
      stem: pyStem(o),
      header: [`Format: ${PY_FORMAT} (Plain). Recording: ${rec.id}.`],
    });
    return { files: [{ path: `appium/plain/${g.fileName}`, content: g.code, framework: 'appium', variant: 'plain', role: 'entry' }], issues: [] };
  } catch (e) {
    if (e instanceof CodegenValidationError) return { files: [], issues: e.issues.map((i) => ({ framework: 'appium', variant: 'plain', step: i.step, message: i.message })) };
    throw e;
  }
}

// ---- POM -------------------------------------------------------------------------------------

const pageModule = (p: PagePlan) => snakeW([...p.words, ...(p.words[p.words.length - 1] === 'page' ? [] : ['page'])]);
const pageClass = (p: PagePlan) => pageModule(p).split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join('');
const constName = (l: PageLocator) => snakeW(l.words).toUpperCase();
const METHOD_VERB: Record<MethodKind, string> = { tap: 'tap', longpress: 'long_press', doubletap: 'double_tap', fill: 'fill', scroll_to: 'scroll_to' };

const CHECKS: Record<AssertionKind, (L: string, exp: string) => string> = {
  visible: (L) => `expect_visible(${L})`,
  hidden: (L) => `expect_hidden(${L})`,
  enabled: (L) => `expect_enabled(${L})`,
  disabled: (L) => `expect_disabled(${L})`,
  text: (L, e) => `expect_text(${L}, ${e})`,
  contains: (L, e) => `expect_contains(${L}, ${e})`,
  checked: (L) => `expect_checked(${L}, True)`,
  unchecked: (L) => `expect_checked(${L}, False)`,
  selected: (L) => `expect_selected(${L}, True)`,
  unselected: (L) => `expect_selected(${L}, False)`,
  count: (L, e) => `expect_count(${L}, ${e})`,
};

const BASE_PAGE = (pkg: string, name: string, web: boolean) => [
  `"""Base page for the page objects of "${name.replace(/"""/g, "'''")}" (generated by Vortex; ${PY_FORMAT})."""`,
  '',
  'import os',
  'import time',
  ...(web ? ['from contextlib import contextmanager', ''] : ['']),
  ...(web ? ['from appium.webdriver.common.appiumby import AppiumBy'] : []),
  'from selenium.common.exceptions import NoSuchElementException, StaleElementReferenceException, TimeoutException',
  'from selenium.webdriver.support import expected_conditions as EC',
  'from selenium.webdriver.support.ui import WebDriverWait',
  '',
  `APP_PACKAGE = os.environ.get("APP_PACKAGE", ${pyStr(pkg)})`,
  'TIMEOUT = float(os.environ.get("VORTEX_TIMEOUT", "15"))',
  'FALLBACK_TIMEOUT = 5  # seconds to wait for the element before tapping the recorded position',
  '',
  '',
  'def ID(name):',
  '    """Full resource-id of an element in the app under test."""',
  '    return f"{APP_PACKAGE}:id/{name}"',
  '',
  '',
  ...(web ? [...WEBVIEW_HELPER, '', ''] : []),
  ...ACTIVITY_HELPER,
  '',
  '',
  ...CHECKPOINT_HELPER,
  '',
  '',
  'class BasePage:',
  '    def __init__(self, driver):',
  '        self.driver = driver',
  '',
  '    # ---- finding ----',
  '    def find(self, locator):',
  '        """Waits until the element is visible and returns it."""',
  '        return WebDriverWait(self.driver, TIMEOUT).until(EC.visibility_of_element_located(locator), f"not visible: {locator}")',
  '',
  '    def find_clickable(self, locator):',
  '        """Waits until the element is visible and enabled and returns it."""',
  '        return WebDriverWait(self.driver, TIMEOUT).until(EC.element_to_be_clickable(locator), f"not clickable: {locator}")',
  '',
  '    # ---- actions ----',
  '    def tap(self, locator, fallback=None, check_first=True):',
  '        """Taps the element. With `fallback=(x, y)`, taps that recorded position if the element is not found or cannot be tapped."""',
  '        if fallback is not None:',
  '            try:',
  '                WebDriverWait(self.driver, FALLBACK_TIMEOUT).until(EC.element_to_be_clickable(locator)).click()',
  '            except (TimeoutException, NoSuchElementException, StaleElementReferenceException):',
  '                self.driver.execute_script("mobile: clickGesture", {"x": fallback[0], "y": fallback[1]})',
  '        elif check_first:',
  '            self.find_clickable(locator).click()',
  '        else:',
  '            self.driver.find_element(*locator).click()',
  '',
  '    def long_press(self, locator):',
  '        self.driver.execute_script("mobile: longClickGesture", {"elementId": self.find(locator).id})',
  '',
  '    def double_tap(self, locator):',
  '        self.driver.execute_script("mobile: doubleClickGesture", {"elementId": self.find(locator).id})',
  '',
  '    def fill(self, locator, value):',
  '        field = self.find(locator)',
  '        field.clear()',
  '        field.send_keys(value)',
  '',
  '    def scroll_into_view(self, locator, max_swipes=8):',
  '        """Swipes up until the element is visible (at most `max_swipes` times); in a WebView, scrolls the page."""',
  '        if self.driver.current_context != "NATIVE_APP":',
  '            el = WebDriverWait(self.driver, TIMEOUT).until(EC.presence_of_element_located(locator), f"not found: {locator}")',
  '            self.driver.execute_script("arguments[0].scrollIntoView({block: \'center\'})", el)',
  '            return el',
  '        size = self.driver.get_window_size()',
  '        x = size["width"] // 2',
  '        for _ in range(max_swipes + 1):',
  '            found = [e for e in self.driver.find_elements(*locator) if e.is_displayed()]',
  '            if found:',
  '                return found[0]',
  '            self.driver.swipe(x, int(size["height"] * 0.7), x, int(size["height"] * 0.3), 400)',
  '        raise AssertionError(f"{locator} not visible after {max_swipes} swipes")',
  '',
  '    # ---- checks ----',
  '    def expect_condition(self, locator, predicate):',
  '        def matches(driver):',
  '            try:',
  '                el = driver.find_element(*locator)',
  '                return el.is_displayed() and predicate(el)',
  '            except (NoSuchElementException, StaleElementReferenceException):',
  '                return False',
  '        WebDriverWait(self.driver, TIMEOUT).until(matches, f"expected state not reached: {locator}")',
  '',
  '    def expect_visible(self, locator):',
  '        self.find(locator)',
  '',
  '    def expect_hidden(self, locator):',
  '        WebDriverWait(self.driver, TIMEOUT).until(EC.invisibility_of_element_located(locator), f"still visible: {locator}")',
  '',
  '    def expect_enabled(self, locator):',
  '        self.expect_condition(locator, lambda el: el.is_enabled())',
  '',
  '    def expect_disabled(self, locator):',
  '        self.expect_condition(locator, lambda el: not el.is_enabled())',
  '',
  '    def expect_text(self, locator, expected):',
  '        self.expect_condition(locator, lambda el: el.text == expected)',
  '',
  '    def expect_contains(self, locator, expected):',
  '        self.expect_condition(locator, lambda el: expected in el.text)',
  '',
  '    def expect_checked(self, locator, expected=True):',
  '        def matches(el):',
  '            state = el.get_attribute("checked")',
  '            return (state == "true" if state in ("true", "false") else el.is_selected()) == expected',
  '        self.expect_condition(locator, matches)',
  '',
  '    def expect_selected(self, locator, expected=True):',
  '        self.expect_condition(locator, lambda el: el.is_selected() == expected)',
  '',
  '    def expect_count(self, locator, expected):',
  '        """Waits until exactly `expected` elements match."""',
  '        try:',
  '            WebDriverWait(self.driver, TIMEOUT).until(lambda d: len(d.find_elements(*locator)) == expected)',
  '        except TimeoutException:',
  '            raise AssertionError(f"expected {expected} elements for {locator}, found {len(self.driver.find_elements(*locator))}") from None',
];

export function generatePythonPom(rec: Recording, o: PyOptions): { files: GeneratedFile[]; issues: GenerationIssue[]; shared?: { files: { path: string; content: string }[]; library: SharedLibrary } } {
  const pkg = rec.app.package;
  const stem = pyStem(o);
  const lib = o.library ?? null;
  /** Package the page classes are imported from: the shared library, or this test's own package. */
  const pkgName = lib ? lib.pkgName : `${stem}_pages`;
  /** Package holding this test's own data module (always private to the test). */
  const dataPkg = `${stem}_pages`;
  const reg = new PageRegistry();
  // Start from the pages the library already has. Their names are fixed; this test only adds to them.
  for (const p of lib?.pages ?? []) {
    const locators: PageLocator[] = p.locators.map((l) => ({ ...l, words: [...l.words] }));
    const plan: PagePlan = { words: [...p.words], locators, methods: p.methods.flatMap((m) => { const loc = locators.find((l) => l.key === m.key); return loc ? [{ kind: m.kind, loc }] : []; }) };
    reg.pages.set(plan.words.join('_'), plan);
  }
  const issues: GenerationIssue[] = [];
  const usedPages = new Set<PagePlan>();
  const data = new Map<string, string>();
  const dataValues: { key: string; text?: string; secretEnv?: string }[] = [];
  const imports = new Set<string>();

  const pageVar = (p: PagePlan) => pageModule(p);
  const ref = (screen: string, parts: LocatorParts | null | undefined, title: string): { page: PagePlan; loc: PageLocator } | { error: string } => {
    const check = pyLocator(parts ?? undefined, pkg);
    if ('error' in check) return check;
    const r = reg.locator(screen, parts!, title);
    usedPages.add(r.page);
    return r;
  };

  const body: string[] = [];
  let seg: string | null = null;
  let usesWeb = false;
  for (const e of rec.events) {
    const n = e.seq;
    const isWeb = e.context === 'WEBVIEW';
    const out = [`# ${n}. ${describeEvent(e).replace(/\r?\n/g, ' ')}${isWeb ? ' (web)' : ''}`];
    const issue = (message: string) => issues.push({ framework: 'appium', variant: 'pom', step: n, message });
    const T = e.target;
    const coordTarget = !T || T.kind === 'coordinate';
    // WebView elements get their own page class ("<page> web"), separate from the native screen
    const scr = isWeb ? `${e.screen.name} web` : e.screen.name;
    const r = coordTarget ? null : ref(scr, T!.parts, e.title);
    const R = r && 'page' in r ? r : null;
    const need = () => {
      if (R) return R;
      issue(r && 'error' in r ? r.error : 'this step needs an element locator, but the element has none');
      return null;
    };
    const call = (kind: MethodKind, args: string[]) => {
      const m = `${METHOD_VERB[kind]}_${snakeW(R!.loc.words)}`;
      reg.method(R!.page, kind, R!.loc);
      return `${pageVar(R!.page)}.${m}(${args.join(', ')})`;
    };
    const a = e.action;
    if (isWeb && ['longpress', 'doubletap', 'swipe', 'press', 'sleep'].includes(a.type)) issue(`"${a.type}" is not available for WebView elements: record it on the native screen instead`);
    else switch (a.type) {
      case 'tap':
      case 'longpress':
      case 'doubletap': {
        if (!coordTarget && !R) {
          need();
          break;
        }
        if (isCoordinateEvent(e)) {
          if (!e.position) {
            issue('no recorded position for this step');
            break;
          }
          const g = { tap: 'clickGesture', longpress: 'longClickGesture', doubletap: 'doubleClickGesture' }[a.type];
          out.push(`driver.execute_script("mobile: ${g}", {"x": ${e.position.x}, "y": ${e.position.y}})  # ${coordTarget ? 'element has no id, label or text' : 'coordinate style chosen'}`);
          break;
        }
        if (a.type !== 'tap') {
          out.push(call(a.type, []));
          break;
        }
        const both = e.tapStyle === 'both';
        if (both && !e.position) {
          issue('name-with-fallback tap needs the recorded position; switch the step to "Name only"');
          break;
        }
        out.push(call('tap', both ? [`fallback=(${e.position!.x}, ${e.position!.y})`] : e.preCheck ? [] : ['check_first=False']));
        break;
      }
      case 'type': {
        if (coordTarget) {
          issue('No input element was recorded at this point. Delete this step, choose Type, and click inside the editable field (not an autocomplete suggestion). For an HTML field, switch to its WebView context and record it in the WebView inspector.');
          break;
        }
        if (!need()) break;
        const key = dataKey(e, R!.loc.words, data);
        if (!dataValues.some((d) => d.key === key)) dataValues.push({ key, ...(e.input?.secretEnv ? { secretEnv: e.input.secretEnv } : { text: e.input?.text ?? '' }) });
        if (e.input?.secretEnv) imports.add('secret');
        else imports.add('DATA');
        out.push(call('fill', [e.input?.secretEnv ? `secret(${pyStr(e.input.secretEnv)})` : `DATA[${pyStr(key)}]`]));
        break;
      }
      case 'swipe': {
        const f = a.from, t = a.to;
        if (f && t) {
          out.push(`driver.swipe(${f.x}, ${f.y}, ${t.x}, ${t.y}, ${Number(a.durationMs) > 0 ? Math.round(Number(a.durationMs)) : 400})`);
        } else if (o.size && a.direction && Number.isFinite(a.distance)) {
          const cx = Math.round(o.size.width / 2), cy = Math.round(o.size.height / 2), h = Math.round(a.distance! / 2);
          const m = { up: [cx, cy + h, cx, cy - h], down: [cx, cy - h, cx, cy + h], left: [cx + h, cy, cx - h, cy], right: [cx - h, cy, cx + h, cy] }[a.direction];
          out.push(`driver.swipe(${m.join(', ')}, 400)  # recorded before start/end points were stored: centred on the screen`);
        } else issue('the swipe has no recorded start/end points and no screen size to derive them from');
        break;
      }
      case 'scroll_to':
        if (coordTarget) {
          issue('there is nothing to scroll to because the element has no locator. Record a Swipe instead.');
          break;
        }
        if (!need()) break;
        out.push(call('scroll_to', []));
        break;
      case 'press': {
        const key = String(a.key ?? '').toUpperCase();
        const code = KEYCODES[key];
        if (!code) issue(`unknown key "${key}"`);
        else out.push(`driver.press_keycode(${code})  # ${key}`);
        break;
      }
      case 'wait_visible':
      case 'wait_hidden':
        if (!need()) break;
        out.push(`${pageVar(R!.page)}.${a.type === 'wait_visible' ? 'expect_visible' : 'expect_hidden'}(${pageVar(R!.page)}.${constName(R!.loc)})`);
        break;
      case 'clear':
        if (!need()) break;
        out.push(`${pageVar(R!.page)}.find(${pageVar(R!.page)}.${constName(R!.loc)}).clear()`);
        break;
      case 'wait_enabled':
        if (!need()) break;
        out.push(`${pageVar(R!.page)}.find_clickable(${pageVar(R!.page)}.${constName(R!.loc)})`);
        break;
      case 'hide_keyboard':
        out.push('if driver.is_keyboard_shown():', '    driver.hide_keyboard()');
        break;
      case 'launch_app':
        imports.add('APP_PACKAGE');
        out.push('driver.activate_app(APP_PACKAGE)');
        break;
      case 'close_app':
        imports.add('APP_PACKAGE');
        out.push('driver.terminate_app(APP_PACKAGE)');
        break;
      case 'deep_link':
        if (!a.url) issue('the deep link has no URL');
        else {
          imports.add('APP_PACKAGE');
          out.push(`driver.execute_script("mobile: deepLink", {"url": ${pyStr(a.url)}, "package": APP_PACKAGE})`);
        }
        break;
      case 'check_activity': {
        const act = activityName(a.activity ?? '');
        if (!act) issue('the screen check has no activity name');
        else {
          imports.add('wait_activity');
          out.push(`wait_activity(driver, ${pyStr(act)})`);
        }
        break;
      }
      case 'checkpoint':
        imports.add('checkpoint');
        out.push(`checkpoint(driver, ${pyStr(checkpointName(a.name ?? ''))})`);
        break;
      case 'sleep':
        imports.add('time');
        out.push(`time.sleep(${((Number(a.ms) || 1000) / 1000).toFixed(2).replace(/\.?0+$/, '')})  # fixed wait recorded on purpose; a wait-for step is more reliable`);
        break;
      case 'assert': {
        if (!need() || !e.check) break;
        const line = checkLine(e.check.kind, e.check.expected, R!.page, R!.loc, issue);
        if (line) out.push(line);
        break;
      }
    }
    if (e.post.length) {
      out.push('# then:');
      for (const p of e.post) {
        const pr = ref(isWeb ? scr : afterScreen(e), p.target.parts, p.title);
        if ('error' in pr) {
          issue(`suggested check on "${p.title || 'element'}": ${pr.error}`);
          continue;
        }
        const line = checkLine(p.kind, p.expected, pr.page, pr.loc, (m) => issue(`suggested check on "${p.title || 'element'}": ${m}`));
        if (line) out.push(line);
      }
    }
    if ((e.observations.settleMs ?? 0) > 3000) out.push(`# the screen took about ${((e.observations.settleMs ?? 0) / 1000).toFixed(1)} s to settle after this step`);
    const key = segKey(e);
    if (key !== seg) {
      if (key) body.push(webviewHeader(e));
      seg = key;
    }
    if (key) usesWeb = true;
    for (const raw of out) {
      const l = (key ? '    ' : '') + raw;
      if (body[body.length - 1] === l && !raw.startsWith('#')) continue;
      body.push(l);
    }
  }

  function checkLine(kind: AssertionKind, expected: string | number | undefined, page: PagePlan, loc: PageLocator, issue: (m: string) => void): string | null {
    const f = CHECKS[kind];
    if (!f) {
      issue(`the "${String(kind)}" check is not supported`);
      return null;
    }
    let exp = pyStr(String(expected ?? ''));
    if (kind === 'count') {
      const c = Number(expected);
      if (!Number.isInteger(c) || c < 0) {
        issue(`count check needs a whole number, got "${String(expected)}"`);
        return null;
      }
      exp = String(c);
    }
    return `${pageVar(page)}.${f(`${pageVar(page)}.${constName(loc)}`, exp)}`;
  }

  const files: GeneratedFile[] = [];
  const sharedFiles: { path: string; content: string }[] = [];
  const add = (p: string, lines: string[], role: GeneratedFile['role'] = 'support') => files.push({ path: `appium/pom/${p}`, content: lines.join('\n') + '\n', framework: 'appium', variant: 'pom', role });
  /** Page classes and the base page go to the shared library when there is one, otherwise into the test's folder. */
  const addPageFile = (p: string, lines: string[]) => (lib ? sharedFiles.push({ path: p, content: lines.join('\n') + '\n' }) : add(p, lines));
  const pages = [...reg.pages.values()];
  const webBase = usesWeb || !!lib?.web;
  const title = rec.name.replace(/"""/g, "'''");

  add('pytest.ini', [
    `# Generated by Vortex (${PY_FORMAT}). Marks this folder as pytest's root so conftest.py is used`,
    '# when a single test file is run. Add your own pytest settings below.',
    '[pytest]',
  ]);
  addPageFile(`pages/${pkgName}/__init__.py`, [lib ? `"""Page objects shared by every Vortex test of ${pkg} (generated by Vortex)."""` : `"""Page objects for "${title}" (generated by Vortex)."""`]);
  addPageFile(`pages/${pkgName}/base_page.py`, BASE_PAGE(pkg, lib ? `the shared page library of ${pkg}` : rec.name, webBase));
  for (const p of pages) {
    const lines: string[] = [];
    const consts = p.locators.map((l) => {
      const c = pyLocator(l.parts, pkg) as { code: string };
      return `    ${constName(l)} = ${c.code}`;
    });
    const needsId = consts.some((c) => c.includes('ID('));
    const needsPkg = consts.some((c) => c.includes('{APP_PACKAGE}'));
    lines.push(lib ? `"""${pageClass(p).replace(/Page$/, '')} screen, shared by every Vortex test of ${pkg} (generated by Vortex; ${PY_FORMAT})."""` : `"""${pageClass(p).replace(/Page$/, '')} screen, as recorded in "${title}" (generated by Vortex; ${PY_FORMAT})."""`, '');
    lines.push('from appium.webdriver.common.appiumby import AppiumBy', '');
    lines.push(`from .base_page import ${[needsPkg ? 'APP_PACKAGE' : '', needsId ? 'ID' : '', 'BasePage'].filter(Boolean).join(', ')}`, '', '');
    lines.push(`class ${pageClass(p)}(BasePage):`);
    lines.push(...consts);
    for (const m of p.methods) {
      const name = `${METHOD_VERB[m.kind]}_${snakeW(m.loc.words)}`;
      const C = `self.${constName(m.loc)}`;
      lines.push('');
      if (m.kind === 'tap') lines.push(`    def ${name}(self, fallback=None, check_first=True):`, `        self.tap(${C}, fallback, check_first)`);
      else if (m.kind === 'longpress') lines.push(`    def ${name}(self):`, `        self.long_press(${C})`);
      else if (m.kind === 'doubletap') lines.push(`    def ${name}(self):`, `        self.double_tap(${C})`);
      else if (m.kind === 'fill') lines.push(`    def ${name}(self, value):`, `        self.fill(${C}, value)`);
      else lines.push(`    def ${name}(self):`, `        self.scroll_into_view(${C})`);
    }
    if (!consts.length && !p.methods.length) lines.push('    pass');
    addPageFile(`pages/${pkgName}/${pageModule(p)}.py`, lines);
  }
  if (dataValues.length) {
    const plain = dataValues.filter((d) => d.text !== undefined);
    const lines = [`"""Test data for "${title}" (generated by Vortex). Edit values here, not in the test."""`, '', 'import os', '', 'DATA = {', ...plain.map((d) => `    ${pyStr(d.key)}: ${pyStr(d.text!)},`), '}'];
    lines.push('', '', 'def secret(name):', '    """Sensitive input is never stored: it is read from an environment variable at run time."""', '    value = os.environ.get(name)', '    if not value:', '        raise RuntimeError(f"Set the {name} environment variable: this test types a sensitive value that Vortex does not store.")', '    return value');
    if (lib) add(`pages/${dataPkg}/__init__.py`, [`"""Test data for "${title}" (generated by Vortex)."""`]);
    add(`pages/${dataPkg}/data.py`, lines);
  }

  const used = pages.filter((p) => usedPages.has(p));
  // With a shared library the registry also holds pages of other tests: this test imports only the ones it uses.
  const fixturePages = lib ? used : pages;
  add('conftest.py', [
    `"""Fixtures for "${title}" (generated by Vortex; ${PY_FORMAT}).`,
    '',
    'Settings (environment variables): APPIUM_URL, ANDROID_UDID (optional), APP_PACKAGE, VORTEX_TIMEOUT.',
    '"""',
    '',
    'import os',
    'import sys',
    'from pathlib import Path',
    '',
    'import pytest',
    'from appium import webdriver',
    'from appium.options.android import UiAutomator2Options',
    '',
    'sys.path.insert(0, str(Path(__file__).resolve().parent / "pages"))',
    ...(lib
      ? [
          '# Page classes come from the library shared by every test of this app (<output folder>/_shared/pages).',
          '# Set VORTEX_SHARED_PAGES if you move this test away from the output folder.',
          'sys.path.insert(0, os.environ.get("VORTEX_SHARED_PAGES") or str(Path(__file__).resolve().parents[4] / "_shared" / "pages"))',
        ]
      : []),
    '',
    `from ${pkgName}.base_page import APP_PACKAGE  # noqa: E402`,
    ...fixturePages.map((p) => `from ${pkgName}.${pageModule(p)} import ${pageClass(p)}  # noqa: E402`),
    '',
    'APPIUM_URL = os.environ.get("APPIUM_URL", "http://127.0.0.1:4723")',
    '',
    '',
    '@pytest.fixture',
    'def driver():',
    '    options = UiAutomator2Options()',
    '    options.platform_name = "Android"',
    '    options.automation_name = "UiAutomator2"',
    '    options.no_reset = True',
    '    options.set_capability("appium:autoLaunch", False)',
    '    options.set_capability("appium:disableWindowAnimation", True)',
    '    options.new_command_timeout = int(os.environ.get("VORTEX_IDLE_TIMEOUT", "300"))',
    '    if os.environ.get("ANDROID_UDID"):',
    '        options.udid = os.environ["ANDROID_UDID"]',
    ...CHROMEDRIVER_CAPS,
    '    drv = webdriver.Remote(APPIUM_URL, options=options)',
    '    try:',
    '        # Keep hybrid WebView IDs exact and avoid idle waits on continuously updating views.',
    '        drv.update_settings({"disableIdLocatorAutocompletion": True, "ignoreUnimportantViews": True, "waitForIdleTimeout": 0})',
    ...(rec.events[0]?.action.type === 'launch_app' ? [] : ['        drv.activate_app(APP_PACKAGE)']),
    '        yield drv',
    '    finally:',
    '        try:',
    '            drv.terminate_app(APP_PACKAGE)',
    '        finally:',
    '            drv.quit()  # always end the Appium session',
    ...fixturePages.flatMap((p) => ['', '', '@pytest.fixture', `def ${pageVar(p)}(driver):`, `    return ${pageClass(p)}(driver)`]),
  ]);

  const test: string[] = [
    `"""${title} (POM): recorded with Vortex Android Recorder (Appium UiAutomator2, pytest).`,
    '',
    `Run:   pytest tests/test_${stem}_pom.py   (from the appium/pom folder)`,
    `Needs: pip install ${PY_REQUIREMENTS.map((r) => `"${r}"`).join(' ')}`,
    '       a running Appium server with the uiautomator2 driver, and the device connected.',
    `Format: ${PY_FORMAT} (POM). Recording: ${rec.id}.`,
  ];
  const secrets = dataValues.filter((d) => d.secretEnv).map((d) => d.secretEnv!);
  if (secrets.length) test.push(`Sensitive input: set ${[...new Set(secrets)].join(', ')} before running (the values are never stored).`);
  test.push('"""', '');
  if (imports.has('time')) test.push('import time', '');
  const dataImports = ['DATA', 'secret'].filter((x) => imports.has(x));
  const baseImports = ['APP_PACKAGE', 'checkpoint', 'wait_activity'].filter((x) => imports.has(x));
  if (usesWeb) baseImports.push('webview');
  if (baseImports.length) test.push(`from ${pkgName}.base_page import ${baseImports.join(', ')}`);
  if (dataImports.length) test.push(`from ${dataPkg}.data import ${dataImports.join(', ')}`);
  if (baseImports.length || dataImports.length) test.push('');
  test.push('', `def test_${stem}_pom(${['driver', ...used.map(pageVar)].join(', ')}):`);
  if (!body.length) test.push('    pass  # no steps recorded yet');
  for (const l of body) test.push('    ' + l);
  files.push({ path: `appium/pom/tests/test_${stem}_pom.py`, content: test.join('\n') + '\n', framework: 'appium', variant: 'pom', role: 'entry' });
  if (!lib) return { files, issues };
  const library: SharedLibrary = {
    pkgName: lib.pkgName,
    web: webBase,
    pages: pages.map((p) => ({ words: p.words, locators: p.locators.map((l) => ({ key: l.key, parts: l.parts, words: l.words, title: l.title })), methods: p.methods.map((m) => ({ kind: m.kind, key: m.loc.key })) })),
  };
  return { files, issues, shared: { files: sharedFiles, library } };
}
