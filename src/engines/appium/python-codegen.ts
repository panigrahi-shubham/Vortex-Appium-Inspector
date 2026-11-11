// Generates a standalone pytest + Appium-Python-Client (UiAutomator2) test from recorded steps.
//
// validation error with an actionable message: the generator never writes placeholder code.

import { pyStr, uiStr, xpathLiteral } from './native-locators.ts';

export const PY_REQUIREMENTS = ['Appium-Python-Client==6.0.12', 'pytest==8.4.2'];

import type { LocatorParts, WebViewRef } from '../../model/recording.ts';
export type { LocatorParts };

export interface RecordedTarget {
  kind: string;
  expr?: string | null;
  parts?: LocatorParts;
}

export interface RecordedAssertion {
  assertion: string;
  expected?: string | number;
  parts?: LocatorParts;
  title?: string;
}

export interface RecordedStep {
  type: string;
  title?: string;
  target?: RecordedTarget;
  x?: number;
  y?: number;
  pre?: boolean;
  mode?: 'both' | 'name' | 'coord';
  args?: Record<string, unknown>;
  post?: RecordedAssertion[];
  settleMs?: number;
  /** Sensitive input: the value comes from this environment variable at run time and is never stored. */
  secretEnv?: string;
  /** WebView steps run inside `with webview(driver, ...)`. */
  context?: 'NATIVE_APP' | 'WEBVIEW';
  webview?: WebViewRef | null;
}

export interface CodegenIssue {
  step: number;
  message: string;
}

export class CodegenValidationError extends Error {
  code = 'VALIDATION';
  issues: CodegenIssue[];
  constructor(issues: CodegenIssue[], what = 'Appium') {
    super(`${issues.length} step(s) cannot be generated for ${what}: ` + issues.map((i) => `step ${i.step}: ${i.message}`).join('; '));
    this.issues = issues;
  }
}

export const KEYCODES: Record<string, number> = { BACK: 4, HOME: 3, ENTER: 66, APP_SWITCH: 187, RECENT: 187, DELETE: 67, TAB: 61, SEARCH: 84 };

export function snake(name: string): string {
  return String(name || 'recorded flow').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'recorded_flow';
}

// ---- locators ------------------------------------------------------------------------------

const PKG_MARK = '\u0000PKG\u0000';

/** Python expression for an XPath; resource-ids of the app package use {APP_PACKAGE} so APP_PACKAGE can be overridden. */
function pyXpath(xp: string): string {
  if (!xp.includes(PKG_MARK)) return pyStr(xp);
  const body = xp
    .split(PKG_MARK)
    .map((seg) => JSON.stringify(seg).slice(1, -1).replace(/\{/g, '{{').replace(/\}/g, '}}'))
    .join('{APP_PACKAGE}');
  return `f"${body}"`;
}

function attr(field: 'id' | 'label' | 'text', value: string, pkg: string): string {
  if (field === 'id') {
    const p = pkg + ':id/';
    return value.startsWith(p) ? `@resource-id='${PKG_MARK}:id/${value.slice(p.length)}'` : `@resource-id=${xpathLiteral(value)}`;
  }
  return `@${field === 'label' ? 'content-desc' : 'text'}=${xpathLiteral(value)}`;
}

/** Python `(AppiumBy.X, value)` tuple for recorded locator parts, or a reason it cannot be built. */
export function pyLocator(parts: LocatorParts | undefined, pkg: string): { code: string } | { error: string } {
  if (!parts) return { error: 'this step was recorded before Appium export existed (no locator details). Delete it and record it again.' };
  if (parts.by === 'css' || parts.by === 'xpath') {
    if (!parts.value) return { error: 'empty WebView selector' };
    return { code: `(AppiumBy.${parts.by === 'css' ? 'CSS_SELECTOR' : 'XPATH'}, ${pyStr(parts.value)})` };
  }
  if (parts.by === 'scoped') {
    if (!parts.container || !parts.anchorText) return { error: 'incomplete list-row locator' };
    let xp = `//*[${attr('id', parts.container, pkg)}][.//*[${attr('text', parts.anchorText, pkg)}]]`;
    if (parts.inner) xp += `//*[${attr(parts.inner.by, parts.inner.value, pkg)}]`;
    return { code: `(AppiumBy.XPATH, ${pyXpath(xp)})` };
  }
  const value = parts.value ?? '';
  if (!value) return { error: 'empty locator value' };
  if (parts.index !== undefined) {
    if (parts.index < 0) return { error: 'the element position could not be determined exactly; pick a more specific element' };
    return { code: `(AppiumBy.XPATH, ${pyXpath(`(//*[${attr(parts.by, value, pkg)}])[${parts.index + 1}]`)})` };
  }
  if (parts.by === 'id') {
    const p = pkg + ':id/';
    return { code: `(AppiumBy.ID, ${value.startsWith(p) ? `ID(${pyStr(value.slice(p.length))})` : pyStr(value)})` };
  }
  if (parts.by === 'label') return { code: `(AppiumBy.ACCESSIBILITY_ID, ${pyStr(value)})` };
  return { code: `(AppiumBy.ANDROID_UIAUTOMATOR, ${pyStr(`new UiSelector().text(${uiStr(value)})`)})` };
}

// ---- steps ---------------------------------------------------------------------------------

interface Ctx {
  /** true while emitting a WebView step (checked/unchecked use is_selected there). */
  web?: boolean;
  pkg: string;
  size: { width: number; height: number } | null;
  helpers: Set<string>;
  imports: Set<string>;
  issues: CodegenIssue[];
}

function describe(st: RecordedStep): string {
  const t = st.title ? ` "${st.title}"` : '';
  const a = st.args ?? {};
  switch (st.type) {
    case 'tap': return `Tap${t}`;
    case 'longpress': return `Long-press${t}`;
    case 'doubletap': return `Double-tap${t}`;
    case 'swipe': return `Swipe ${String(a.direction ?? '')}`;
    case 'scroll_to': return `Scroll to${t}`;
    case 'type': return `Type into${t}`;
    case 'press': return `Press ${String(a.key ?? '')}`;
    case 'wait_visible': return `Wait for${t} to appear`;
    case 'wait_hidden': return `Wait for${t} to disappear`;
    case 'sleep': return `Wait ${String(a.ms ?? '')} ms`;
    case 'assert': return `Check${t} (${String(a.assertion ?? '')})`;
    case 'clear': return `Clear${t}`;
    case 'hide_keyboard': return 'Hide the keyboard';
    case 'launch_app': return 'Launch the app';
    case 'close_app': return 'Close the app';
    case 'deep_link': return `Open ${String(a.url ?? 'deep link')}`;
    case 'wait_enabled': return `Wait until${t} is enabled`;
    case 'check_activity': return `Check the screen is ${String(a.activity ?? '')}`.trim();
    case 'checkpoint': return `Screenshot checkpoint "${String(a.name ?? 'checkpoint')}"`;
    default: return st.type;
  }
}

const comment = (s: string) => '# ' + s.replace(/\r?\n/g, ' ');

function assertionLines(a: RecordedAssertion, L: string, ctx: Ctx, n: number): string[] {
  const exp = a.expected ?? '';
  ctx.helpers.add('find');
  const conditions: Record<string, string> = {
    enabled: 'el.is_enabled()', disabled: 'not el.is_enabled()',
    text: `el.text == ${pyStr(String(exp))}`, contains: `${pyStr(String(exp))} in el.text`,
    checked: ctx.web ? 'el.is_selected()' : 'el.get_attribute("checked") == "true"',
    unchecked: ctx.web ? 'not el.is_selected()' : 'el.get_attribute("checked") == "false"',
    selected: 'el.is_selected()', unselected: 'not el.is_selected()',
  };
  if (conditions[a.assertion]) {
    ctx.helpers.add('wait_condition');
    return [`wait_condition(driver, ${L}, lambda el: ${conditions[a.assertion]}, ${pyStr(`expected ${a.assertion}${a.expected !== undefined ? ': ' + String(exp) : ''}`)})`];
  }
  switch (a.assertion) {
    case 'visible':
      return [`find(driver, ${L})`];
    case 'hidden':
      ctx.helpers.add('wait_gone');
      return [`wait_gone(driver, ${L})`];
    case 'count': {
      const c = Number(exp);
      if (!Number.isInteger(c) || c < 0) {
        ctx.issues.push({ step: n, message: `count check needs a whole number, got "${String(exp)}"` });
        return [];
      }
      ctx.helpers.add('wait_count');
      return [`wait_count(driver, ${L}, ${c})`];
    }
    default:
      ctx.issues.push({ step: n, message: `the "${a.assertion}" check is not supported for Appium. Remove it or use visible/hidden/text.` });
      return [];
  }
}

function swipeCoords(st: RecordedStep, ctx: Ctx): { x1: number; y1: number; x2: number; y2: number; approx: boolean } | null {
  const a = st.args ?? {};
  const from = a.from as { x?: number; y?: number } | undefined;
  const to = a.to as { x?: number; y?: number } | undefined;
  if (from && to && [from.x, from.y, to.x, to.y].every((v) => Number.isFinite(v))) {
    return { x1: from.x!, y1: from.y!, x2: to.x!, y2: to.y!, approx: false };
  }
  const dist = Number(a.distance);
  if (!ctx.size || !Number.isFinite(dist)) return null;
  const cx = Math.round(ctx.size.width / 2);
  const cy = Math.round(ctx.size.height / 2);
  const h = Math.round(dist / 2);
  const d = String(a.direction);
  const map: Record<string, [number, number, number, number]> = {
    up: [cx, cy + h, cx, cy - h],
    down: [cx, cy - h, cx, cy + h],
    left: [cx + h, cy, cx - h, cy],
    right: [cx - h, cy, cx + h, cy],
  };
  const m = map[d];
  return m ? { x1: m[0], y1: m[1], x2: m[2], y2: m[3], approx: true } : null;
}

/** A WebView step: the same helpers work through Chromedriver; only locator-based actions exist there. */
function webStepLines(st: RecordedStep, n: number, ctx: Ctx): string[] {
  const out = [comment(`${n}. ${describe(st)} (web)`)];
  const loc = pyLocator(st.target?.parts, ctx.pkg);
  const issue = (m: string) => ctx.issues.push({ step: n, message: m });
  if ('error' in loc) {
    issue(loc.error);
    return out;
  }
  const L = loc.code;
  const a = st.args ?? {};
  ctx.helpers.add('find');
  switch (st.type) {
    case 'tap':
      ctx.helpers.add('find_clickable');
      out.push(`find_clickable(driver, ${L}).click()`);
      break;
    case 'type':
      if (st.secretEnv) ctx.helpers.add('secret');
      out.push(`field = find(driver, ${L})`, 'field.clear()', `field.send_keys(${st.secretEnv ? `secret(${pyStr(st.secretEnv)})` : pyStr(String(a.text ?? ''))})`);
      break;
    case 'scroll_to':
      out.push(`driver.execute_script("arguments[0].scrollIntoView({block: 'center'})", find(driver, ${L}))`);
      break;
    case 'wait_visible':
      out.push(`find(driver, ${L})`);
      break;
    case 'wait_hidden':
      ctx.helpers.add('wait_gone');
      out.push(`wait_gone(driver, ${L})`);
      break;
    case 'assert':
      ctx.web = true;
      out.push(...assertionLines({ assertion: String(a.assertion), expected: a.expected as string | number | undefined }, L, ctx, n));
      ctx.web = false;
      break;
    default:
      issue(`"${st.type}" is not available for WebView elements: record it on the native screen instead`);
  }
  for (const p of st.post ?? []) {
    const pl = pyLocator(p.parts, ctx.pkg);
    if ('error' in pl) issue(`suggested check on "${p.title ?? 'element'}": ${pl.error}`);
    else {
      ctx.web = true;
      out.push(...assertionLines(p, pl.code, ctx, n));
      ctx.web = false;
    }
  }
  return out;
}

export const segKey = (st: { context?: string; webview?: WebViewRef | null; target?: { parts?: LocatorParts | null } | null }) =>
  st.context === 'WEBVIEW' ? JSON.stringify([st.webview?.testId ?? null, st.webview?.index ?? 0, st.target?.parts?.frames ?? []]) : null;

/** `with webview(driver, ...):` header for a run of WebView steps. */
export function webviewHeader(st: { webview?: WebViewRef | null; target?: { parts?: LocatorParts | null } | null }): string {
  const args = ['driver'];
  const frames = st.target?.parts?.frames ?? [];
  if (frames.length) args.push(`frames=[${frames.map(pyStr).join(', ')}]`);
  const url = st.webview?.url ? st.webview.url.split(/[?#]/)[0] : null;
  if (url) args.push(`url=${pyStr(url)}`);
  return `with webview(${args.join(', ')}):`;
}

function stepLines(st: RecordedStep, n: number, ctx: Ctx): string[] {
  if (st.context === 'WEBVIEW') return webStepLines(st, n, ctx);
  const out = [comment(`${n}. ${describe(st)}`)];
  const T = st.target;
  // Only a target recorded as "coordinate" is a coordinate step. A locator without parts (recorded by an older
  // version) is an error, never silently downgraded to a coordinate tap.
  const coordTarget = !T || T.kind === 'coordinate';
  const loc = coordTarget ? null : pyLocator(T!.parts, ctx.pkg);
  const L = loc && 'code' in loc ? loc.code : null;
  const need = (what: string): string | null => {
    if (L) return L;
    ctx.issues.push({ step: n, message: loc && 'error' in loc ? loc.error : `${what} needs an element locator, but this element has none` });
    return null;
  };
  const xy = Number.isFinite(st.x) && Number.isFinite(st.y);
  const a = st.args ?? {};

  switch (st.type) {
    case 'tap':
    case 'longpress':
    case 'doubletap': {
      // Android reports the navigation-bar backdrop as a target in some WebViews,
      // but tapping its recorded point can hit the system Back button. Use the
      // dedicated Appium action when this step was recorded to dismiss a keyboard.
      if (st.type === 'tap' && T?.parts?.by === 'id' && T.parts.value === 'android:id/navigationBarBackground') {
        out.push('driver.hide_keyboard()  # dismiss the software keyboard safely');
        break;
      }
      const gesture = { tap: 'clickGesture', longpress: 'longClickGesture', doubletap: 'doubleClickGesture' }[st.type];
      const mode = coordTarget ? 'coord' : st.type === 'tap' ? st.mode ?? 'both' : 'name';
      if (!coordTarget && !L) {
        need(st.type);
        break;
      }
      if (mode === 'coord') {
        if (!xy) {
          ctx.issues.push({ step: n, message: 'no recorded position for this tap' });
          break;
        }
        const why = coordTarget ? 'element has no id, label or text' : `coordinate style chosen; locator would be ${L}`;
        out.push(`driver.execute_script("mobile: ${gesture}", {"x": ${st.x}, "y": ${st.y}})  # ${why}`);
      } else if (mode === 'both') {
        if (!xy) {
          ctx.issues.push({ step: n, message: 'name-with-fallback tap needs the recorded position; switch the step to "Name only"' });
          break;
        }
        ctx.helpers.add('tap_or_at');
        out.push(`tap_or_at(driver, ${L}, ${st.x}, ${st.y})`);
      } else if (st.type === 'tap') {
        if (st.pre !== false) {
          ctx.helpers.add('find_clickable');
          out.push(`find_clickable(driver, ${L}).click()`);
        } else out.push(`driver.find_element(*${L}).click()`);
      } else {
        ctx.helpers.add('find');
        out.push(`driver.execute_script("mobile: ${gesture}", {"elementId": find(driver, ${L}).id})`);
      }
      break;
    }
    case 'type': {
      const text = String(a.text ?? '');
      if (coordTarget) {
        ctx.issues.push({ step: n, message: 'No input element was recorded at this point. Delete this step, choose Type, and click inside the editable field (not an autocomplete suggestion). For an HTML field, switch to its WebView context and record it in the WebView inspector.' });
        break;
      }
      if (!need('typing')) break;
      ctx.helpers.add('find');
      if (st.secretEnv) ctx.helpers.add('secret');
      out.push(`field = find(driver, ${L})`, 'field.clear()', `field.send_keys(${st.secretEnv ? `secret(${pyStr(st.secretEnv)})` : pyStr(text)})`);
      break;
    }
    case 'swipe': {
      const c = swipeCoords(st, ctx);
      if (!c) {
        ctx.issues.push({ step: n, message: 'the swipe has no recorded start/end points and no screen size to derive them from' });
        break;
      }
      const dur = Number(a.duration) > 0 ? Math.round(Number(a.duration)) : 400;
      out.push(`driver.swipe(${c.x1}, ${c.y1}, ${c.x2}, ${c.y2}, ${dur})${c.approx ? '  # recorded before start/end points were stored: centred on the screen' : ''}`);
      break;
    }
    case 'scroll_to': {
      if (coordTarget) {
        ctx.issues.push({ step: n, message: 'there is nothing to scroll to because the element has no locator. Record a Swipe instead.' });
        break;
      }
      if (!need('scroll to')) break;
      ctx.helpers.add('scroll_into_view');
      out.push(`scroll_into_view(driver, ${L})`);
      break;
    }
    case 'press': {
      const key = String(a.key ?? '').toUpperCase();
      const code = KEYCODES[key];
      if (!code) {
        ctx.issues.push({ step: n, message: `unknown key "${key}"` });
        break;
      }
      out.push(`driver.press_keycode(${code})  # ${key}`);
      break;
    }
    case 'wait_visible':
      if (!need('wait')) break;
      ctx.helpers.add('find');
      out.push(`find(driver, ${L})`);
      break;
    case 'wait_hidden':
      if (!need('wait')) break;
      ctx.helpers.add('wait_gone');
      out.push(`wait_gone(driver, ${L})`);
      break;
    case 'clear':
      if (!need('clearing')) break;
      ctx.helpers.add('find');
      out.push(`find(driver, ${L}).clear()`);
      break;
    case 'wait_enabled':
      if (!need('a wait')) break;
      ctx.helpers.add('find_clickable');
      out.push(`find_clickable(driver, ${L})`);
      break;
    case 'hide_keyboard':
      out.push('if driver.is_keyboard_shown():', '    driver.hide_keyboard()');
      break;
    case 'launch_app':
      out.push('driver.activate_app(APP_PACKAGE)');
      break;
    case 'close_app':
      out.push('driver.terminate_app(APP_PACKAGE)');
      break;
    case 'deep_link':
      if (!a.url) ctx.issues.push({ step: n, message: 'the deep link has no URL' });
      else out.push(`driver.execute_script("mobile: deepLink", {"url": ${pyStr(String(a.url))}, "package": APP_PACKAGE})`);
      break;
    case 'check_activity': {
      const act = activityName(String(a.activity ?? ''));
      if (!act) {
        ctx.issues.push({ step: n, message: 'the screen check has no activity name' });
        break;
      }
      ctx.helpers.add('wait_activity');
      ctx.imports.add('time');
      out.push(`wait_activity(driver, ${pyStr(act)})`);
      break;
    }
    case 'checkpoint':
      ctx.helpers.add('checkpoint');
      out.push(`checkpoint(driver, ${pyStr(checkpointName(String(a.name ?? '')))})`);
      break;
    case 'sleep': {
      const ms = Number(a.ms) || 1000;
      ctx.imports.add('time');
      out.push(`time.sleep(${(ms / 1000).toFixed(2).replace(/\.?0+$/, '')})  # fixed wait recorded on purpose; a wait-for step is more reliable`);
      break;
    }
    case 'assert':
      if (!need('a check')) break;
      out.push(...assertionLines({ assertion: String(a.assertion), expected: a.expected as string | number | undefined }, L!, ctx, n));
      break;
    default:
      ctx.issues.push({ step: n, message: `the "${st.type}" step is not supported for Appium yet` });
  }

  const post = st.post ?? [];
  if (post.length) {
    out.push('# then:');
    for (const p of post) {
      const pl = pyLocator(p.parts, ctx.pkg);
      if ('error' in pl) {
        ctx.issues.push({ step: n, message: `suggested check on "${p.title ?? 'element'}": ${pl.error}` });
        continue;
      }
      out.push(...assertionLines(p, pl.code, ctx, n));
    }
  }
  if ((st.settleMs ?? 0) > 3000) out.push(comment(`the screen took about ${((st.settleMs ?? 0) / 1000).toFixed(1)} s to settle after this step`));
  return out;
}

// ---- helpers -------------------------------------------------------------------------------

/** Python context manager for WebView steps (also used by the POM base page, with `self` removed). */
export const WEBVIEW_HELPER = [
  '@contextmanager',
  'def webview(driver, frames=(), url=None):',
  '    """Runs the block in the app WebView (and iframes), then always returns to the native context.',
  '',
  '    Needs WebView debugging enabled in the app build and a Chromedriver that matches the WebView version',
  '    (CHROMEDRIVER_EXECUTABLE or CHROMEDRIVER_DIR). `url` picks the recorded page when the WebView has several.',
  '    """',
  '    deadline = time.time() + TIMEOUT',
  '    name = None',
  '    while name is None:',
  '        names = [c for c in driver.contexts if c.startswith("WEBVIEW")]',
  '        own = [c for c in names if c == f"WEBVIEW_{APP_PACKAGE}"]',
  '        name = own[0] if own else names[0] if len(names) == 1 else None',
  '        if name is None:',
  '            if time.time() > deadline:',
  '                raise AssertionError(f"no WebView context for {APP_PACKAGE} (contexts: {driver.contexts}); see the Vortex WebView diagnostics")',
  '            time.sleep(0.5)',
  '    driver.switch_to.context(name)',
  '    try:',
  '        handles = driver.window_handles',
  '        if url and len(handles) > 1:',
  '            for handle in handles:',
  '                driver.switch_to.window(handle)',
  '                if driver.current_url.split("?")[0].split("#")[0] == url:',
  '                    break',
  '            else:',
  '                raise AssertionError(f"no WebView page at {url}")',
  '        for css in frames:',
  '            driver.switch_to.frame(WebDriverWait(driver, TIMEOUT).until(EC.presence_of_element_located((AppiumBy.CSS_SELECTOR, css))))',
  '        yield',
  '    except Exception:',
  '        folder = os.environ.get("VORTEX_ARTIFACTS")  # set by Vortex runs: keep the page for the report',
  '        if folder:',
  '            try:',
  '                with open(os.path.join(folder, f"failure-dom-{int(time.time() * 1000)}.html"), "w", encoding="utf-8") as f:',
  '                    f.write(driver.page_source)',
  '            except Exception:  # noqa: BLE001 - never hide the real failure',
  '                pass',
  '        raise',
  '    finally:',
  '        driver.switch_to.context("NATIVE_APP")',
];

/** Chromedriver for WebView steps, from the environment (Vortex sets it from Server settings). */
export const CHROMEDRIVER_CAPS = [
  '    if os.environ.get("CHROMEDRIVER_EXECUTABLE"):',
  '        options.set_capability("appium:chromedriverExecutable", os.environ["CHROMEDRIVER_EXECUTABLE"])',
  '    elif os.environ.get("CHROMEDRIVER_DIR"):',
  '        options.set_capability("appium:chromedriverExecutableDir", os.environ["CHROMEDRIVER_DIR"])',
];

/** "com.app/.ui.HomeActivity" -> ".ui.HomeActivity" (what UiAutomator2 reports as current_activity). */
export const activityName = (full: string) => (full.includes('/') ? full.split('/').pop()! : full).trim();
export const checkpointName = (n: string) => String(n || 'checkpoint').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'checkpoint';

/** Module-level helpers shared by the Plain file and the POM base page. */
export const ACTIVITY_HELPER = [
  'def wait_activity(driver, expected):',
  '    """Waits until the foreground activity is `expected` (short ".ui.Name" or full class name)."""',
  '    deadline = time.time() + TIMEOUT',
  '    current = None',
  '    while time.time() < deadline:',
  '        current = driver.current_activity',
  '        if current and (current == expected or current.endswith(expected) or expected.endswith(current)):',
  '            return',
  '        time.sleep(0.3)',
  '    raise AssertionError(f"expected screen {expected}, but the foreground activity is {current}")',
];
export const CHECKPOINT_HELPER = [
  'def checkpoint(driver, name):',
  '    """Saves a screenshot checkpoint next to the run report (or in ./checkpoints when run outside Vortex)."""',
  '    folder = os.environ.get("VORTEX_ARTIFACTS") or os.path.join(os.getcwd(), "checkpoints")',
  '    os.makedirs(folder, exist_ok=True)',
  '    path, n = os.path.join(folder, f"checkpoint-{name}.png"), 1',
  '    while os.path.exists(path):  # never overwrite an earlier checkpoint',
  '        n += 1',
  '        path = os.path.join(folder, f"checkpoint-{name}-{n}.png")',
  '    driver.get_screenshot_as_file(path)',
];

export const HELPERS: Record<string, string[]> = {
  wait_condition: [
    'def wait_condition(driver, locator, predicate, message):',
    '    last = {"text": None}',
    '    def matches(d):',
    '        try:',
    '            el = d.find_element(*locator)',
    '            last["text"] = el.text',
    '            return el.is_displayed() and predicate(el)',
    '        except (NoSuchElementException, StaleElementReferenceException):',
    '            return False',
    '    try:',
    '        WebDriverWait(driver, TIMEOUT).until(matches, f"{message}: {locator}")',
    '    except TimeoutException:',
    '        last_text = last["text"]',
    '        raise AssertionError(f"{message}; last text={last_text!r}; locator={locator}") from None',
  ],
  wait_activity: ACTIVITY_HELPER,
  checkpoint: CHECKPOINT_HELPER,
  secret: [
    'def secret(name):',
    '    """Sensitive input is never stored in the test: it is read from an environment variable at run time."""',
    '    value = os.environ.get(name)',
    '    if not value:',
    '        raise RuntimeError(f"Set the {name} environment variable: this test types a sensitive value that Vortex does not store.")',
    '    return value',
  ],
  find: [
    'def find(driver, locator):',
    '    """Waits until the element is visible and returns it."""',
    '    return WebDriverWait(driver, TIMEOUT).until(EC.visibility_of_element_located(locator), f"not visible: {locator}")',
  ],
  find_clickable: [
    'def find_clickable(driver, locator):',
    '    """Waits until the element is visible and enabled and returns it."""',
    '    return WebDriverWait(driver, TIMEOUT).until(EC.element_to_be_clickable(locator), f"not clickable: {locator}")',
  ],
  wait_gone: [
    'def wait_gone(driver, locator):',
    '    """Waits until the element is hidden or removed."""',
    '    WebDriverWait(driver, TIMEOUT).until(EC.invisibility_of_element_located(locator), f"still visible: {locator}")',
  ],
  wait_count: [
    'def wait_count(driver, locator, expected):',
    '    """Waits until exactly `expected` elements match."""',
    '    try:',
    '        WebDriverWait(driver, TIMEOUT).until(lambda d: len(d.find_elements(*locator)) == expected)',
    '    except TimeoutException:',
    '        raise AssertionError(f"expected {expected} elements for {locator}, found {len(driver.find_elements(*locator))}") from None',
  ],
  tap_or_at: [
    'def tap_or_at(driver, locator, x, y):',
    '    """Taps by locator; if it is not found or cannot be tapped, taps the position recorded while recording."""',
    '    try:',
    '        WebDriverWait(driver, FALLBACK_TIMEOUT).until(EC.element_to_be_clickable(locator)).click()',
    '    except (TimeoutException, NoSuchElementException, StaleElementReferenceException):',
    '        driver.execute_script("mobile: clickGesture", {"x": x, "y": y})',
  ],
  webview: WEBVIEW_HELPER,
  scroll_into_view: [
    'def scroll_into_view(driver, locator, max_swipes=8):',
    '    """Swipes up until the element is visible (at most `max_swipes` times)."""',
    '    size = driver.get_window_size()',
    '    x = size["width"] // 2',
    '    for _ in range(max_swipes + 1):',
    '        found = [e for e in driver.find_elements(*locator) if e.is_displayed()]',
    '        if found:',
    '            return found[0]',
    '        driver.swipe(x, int(size["height"] * 0.7), x, int(size["height"] * 0.3), 400)',
    '    raise AssertionError(f"{locator} not visible after {max_swipes} swipes")',
  ],
};

// ---- file ----------------------------------------------------------------------------------

export function generatePython(steps: RecordedStep[], opts: { name?: string; appPackage: string; size?: { width: number; height: number } | null; stem?: string; header?: string[] }): { code: string; fileName: string; testName: string } {
  const name = opts.name || 'recorded flow';
  const ctx: Ctx = { pkg: opts.appPackage, size: opts.size ?? null, helpers: new Set(), imports: new Set(), issues: [] };
  const body: string[] = [];
  let seg: string | null = null;
  steps.forEach((st, i) => {
    const key = segKey(st);
    if (key !== seg) {
      if (key) {
        body.push(webviewHeader(st));
        ctx.helpers.add('webview');
        ctx.imports.add('time');
      }
      seg = key;
    }
    const pad = key ? '    ' : '';
    for (const line of stepLines(st, i + 1, ctx)) {
      if (body[body.length - 1] === pad + line && !line.startsWith('#')) continue; // identical consecutive checks
      body.push(pad + line);
    }
  });
  if (ctx.issues.length) throw new CodegenValidationError(ctx.issues);

  const s = opts.stem ? snake(opts.stem) : snake(name);
  const secrets = [...new Set(steps.filter((x) => x.type === 'type' && x.secretEnv).map((x) => x.secretEnv!))];
  const usesIdHelper = body.some((l) => l.includes('ID(')) || body.some((l) => l.includes('{APP_PACKAGE}'));
  const needsExc = ctx.helpers.has('tap_or_at') || ctx.helpers.has('wait_count') || ctx.helpers.has('wait_condition');
  const lines: string[] = [];
  lines.push(`"""${name.replace(/"""/g, "'''")} — recorded with Vortex Android Recorder (Appium UiAutomator2, pytest).`);
  lines.push('');
  lines.push('Run:   pytest ' + `test_${s}.py`);
  lines.push('Needs: pip install ' + PY_REQUIREMENTS.map((r) => `"${r}"`).join(' '));
  lines.push('       a running Appium server with the uiautomator2 driver, and the device connected.');
  lines.push('Settings (environment variables): APPIUM_URL, ANDROID_UDID (optional), APP_PACKAGE, VORTEX_TIMEOUT.');
  if (steps.some((x) => x.context === 'WEBVIEW')) lines.push('WebView steps need WebView debugging in the app build and a matching Chromedriver (CHROMEDRIVER_EXECUTABLE or CHROMEDRIVER_DIR).');
  if (opts.size) lines.push(`Recorded on a ${opts.size.width}x${opts.size.height} screen; coordinate steps assume that size.`);
  if (secrets.length) lines.push(`Sensitive input: set ${secrets.join(', ')} before running (the values are never stored).`);
  for (const h of opts.header ?? []) lines.push(h);
  lines.push('"""');
  lines.push('');
  lines.push('import os');
  if (ctx.imports.has('time')) lines.push('import time');
  if (ctx.helpers.has('webview')) lines.push('from contextlib import contextmanager');
  lines.push('');
  lines.push('import pytest');
  lines.push('from appium import webdriver');
  lines.push('from appium.options.android import UiAutomator2Options');
  lines.push('from appium.webdriver.common.appiumby import AppiumBy');
  if (needsExc) lines.push('from selenium.common.exceptions import NoSuchElementException, StaleElementReferenceException, TimeoutException');
  lines.push('from selenium.webdriver.support import expected_conditions as EC');
  lines.push('from selenium.webdriver.support.ui import WebDriverWait');
  lines.push('');
  lines.push('APPIUM_URL = os.environ.get("APPIUM_URL", "http://127.0.0.1:4723")');
  lines.push(`APP_PACKAGE = os.environ.get("APP_PACKAGE", ${pyStr(opts.appPackage)})`);
  lines.push('TIMEOUT = float(os.environ.get("VORTEX_TIMEOUT", "15"))');
  if (ctx.helpers.has('tap_or_at')) lines.push('FALLBACK_TIMEOUT = 5  # seconds to wait for the element before tapping the recorded position');
  lines.push('');
  if (usesIdHelper) {
    lines.push('');
    lines.push('def ID(name):');
    lines.push('    """Full resource-id of an element in the app under test."""');
    lines.push('    return f"{APP_PACKAGE}:id/{name}"');
    lines.push('');
  }
  for (const h of ['secret', 'webview', 'wait_activity', 'checkpoint', 'find', 'find_clickable', 'wait_gone', 'wait_count', 'wait_condition', 'tap_or_at', 'scroll_into_view']) {
    if (!ctx.helpers.has(h)) continue;
    lines.push('');
    lines.push(...HELPERS[h]);
    lines.push('');
  }
  lines.push('');
  lines.push('@pytest.fixture');
  lines.push('def driver():');
  lines.push('    options = UiAutomator2Options()');
  lines.push('    options.platform_name = "Android"');
  lines.push('    options.automation_name = "UiAutomator2"');
  lines.push('    options.no_reset = True');
  lines.push('    options.set_capability("appium:autoLaunch", False)');
  lines.push('    options.set_capability("appium:disableWindowAnimation", True)');
  lines.push('    options.new_command_timeout = int(os.environ.get("VORTEX_IDLE_TIMEOUT", "300"))');
  lines.push('    if os.environ.get("ANDROID_UDID"):');
  lines.push('        options.udid = os.environ["ANDROID_UDID"]');
  lines.push(...CHROMEDRIVER_CAPS);
  lines.push('    drv = webdriver.Remote(APPIUM_URL, options=options)');
  lines.push('    try:');
  lines.push('        # Keep hybrid WebView IDs exact and avoid idle waits on continuously updating views.');
  lines.push('        drv.update_settings({"disableIdLocatorAutocompletion": True, "ignoreUnimportantViews": True, "waitForIdleTimeout": 0})');
  if (steps[0]?.type !== 'launch_app') lines.push('        drv.activate_app(APP_PACKAGE)');
  lines.push('        yield drv');
  lines.push('    finally:');
  lines.push('        try:');
  lines.push('            drv.terminate_app(APP_PACKAGE)');
  lines.push('        finally:');
  lines.push('            drv.quit()  # always end the Appium session');
  lines.push('');
  lines.push('');
  lines.push(`def test_${s}(${body.length ? 'driver' : ''}):`);
  if (!body.length) lines.push('    pytest.skip("Empty starter: record steps in Vortex and save this test before running.")');
  for (const l of body) lines.push('    ' + l);
  lines.push('');
  return { code: lines.join('\n'), fileName: `test_${s}.py`, testName: `test_${s}` };
}
