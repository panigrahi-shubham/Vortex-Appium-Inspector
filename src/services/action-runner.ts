// Performs one action on the phone and records it as a step.
//
// Rules that keep recordings trustworthy:
//   - an action is accepted only for the screen it was chosen on (the capture token), and that capture is
//     invalidated before the first device command, so a timed-out tap can never be sent twice;
//   - an element action needs a locator that matches exactly one control;
//   - one capture follows a successful action: tests synchronise with explicit waits and assertions.

import { randomUUID } from 'node:crypto';
import type { AppiumInspector } from '../engines/appium/inspector.ts';
import { xpathLiteral } from '../engines/appium/native-locators.ts';
import { checkpointName, KEYCODES } from '../engines/appium/python-codegen.ts';
import type { Session } from '../engines/appium/webdriver.ts';
import { framePath, type DomSnapshot } from '../engines/webview/dom.ts';
import { enterFrames, webCandidates } from '../engines/webview/web-locators.ts';
import type { UiStep } from '../model/recording.ts';
import type { LocatorService } from './locator-service.ts';
import { delay, problem } from './problem.ts';
import type { RecordingStore } from './recording-store.ts';
import type { SessionService } from './session-service.ts';
import type { Snapshot, Target } from './types.ts';

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Actions that act on, or check, one control. */
const ELEMENT_ACTIONS = ['tap', 'longpress', 'doubletap', 'type', 'assert', 'clear', 'wait_visible', 'wait_hidden', 'wait_enabled', 'scroll_to'];
const ASSERTIONS = ['visible', 'hidden', 'enabled', 'disabled', 'text', 'contains', 'checked', 'unchecked', 'selected', 'unselected', 'count'];
const ATTR = { id: 'resource-id', label: 'content-desc', text: 'text' } as const;

export interface ActionDeps {
  inspector: AppiumInspector;
  session: SessionService;
  locators: LocatorService;
  recording: RecordingStore;
}

export class ActionRunner {
  readonly #d: ActionDeps;

  constructor(deps: ActionDeps) {
    this.#d = deps;
  }

  async run(body: Record<string, unknown>) {
    const { inspector, session: sessions, recording } = this.#d;
    const screen = sessions.requireScreen(body.token);
    const type = String(body.type);
    const args = { ...((body.args as Record<string, unknown>) ?? {}) };
    const context = body.context === 'WEBVIEW' ? 'WEBVIEW' : 'NATIVE_APP';
    const session = inspector.session();
    const x = Number(body.x), y = Number(body.y);
    const coordinate = body.coordinate === true && type === 'tap';
    let target: Target | null = null;

    if (coordinate) {
      if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x >= (screen.width ?? 0) || y >= (screen.height ?? 0)) throw problem('Tap coordinates are outside the screenshot.');
    } else if (ELEMENT_ACTIONS.includes(type)) {
      target = context === 'WEBVIEW' ? this.#webTarget(body, screen) : await this.#nativeTarget(body, screen, type, args);
    }

    const secretEnv = type === 'type' && body.secretEnv ? String(body.secretEnv).trim().toUpperCase() : '';
    if (secretEnv && !SECRET_NAME.test(secretEnv)) throw problem('Name the secret like an environment variable, for example VORTEX_SECRET_PASSWORD (A-Z, 0-9 and _).');
    const size = { width: screen.width ?? 0, height: screen.height ?? 0 };
    const began = Date.now();
    // Invalidate before the first command. A timeout after delivery must not be retried as another click.
    sessions.snapshot = null;
    let applied = false;
    try {
      if (context === 'WEBVIEW' && target) {
        const ctx = screen.web!.context;
        if ((await session.currentContext()) !== ctx) await session.switchContext(ctx);
        await enterFrames(session, target.parts.frames ?? []);
      } else await inspector.webToNative();

      const ids = async () => (target ? session.findElements(target.using, target.value) : []);
      const one = async () => {
        const found = await ids();
        if (found.length !== 1) throw problem(`Locator matched ${found.length} controls. Choose a unique locator.`, 'NOT_UNIQUE', 409);
        return found[0];
      };

      if (type === 'tap') {
        if (coordinate) await session.execute('mobile: clickGesture', { x, y });
        else await session.click(await one());
      } else if (type === 'type' || type === 'clear') {
        const el = await one();
        await session.clear(el);
        if (type === 'type') await session.sendKeys(el, String(args.text ?? ''));
        // A secret is typed once on the phone and then forgotten: only the variable name is recorded.
        if (secretEnv) delete args.text;
      } else if (type === 'longpress') await session.execute('mobile: longClickGesture', { elementId: await one(), duration: 800 });
      else if (type === 'doubletap') await session.execute('mobile: doubleClickGesture', { elementId: await one() });
      else if (type === 'press') {
        const key = String(args.key).toUpperCase();
        if (!(key in KEYCODES)) throw problem('Unsupported hardware key.');
        await session.execute('mobile: pressKey', { keycode: KEYCODES[key] });
        args.key = key;
      } else if (type === 'launch_app') await session.execute('mobile: activateApp', { appId: recording.pkg });
      else if (type === 'close_app') await session.execute('mobile: terminateApp', { appId: recording.pkg });
      else if (type === 'hide_keyboard') await session.execute('mobile: hideKeyboard');
      else if (type === 'deep_link') {
        const url = String(args.url ?? '').trim();
        if (!/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(url)) throw problem('Enter a full link, for example myapp://orders/42 or https://example.com/path.');
        await session.execute('mobile: deepLink', { url, package: recording.pkg });
        args.url = url;
      } else if (type === 'check_activity') {
        // Records the screen the app is on now, so the test waits for the same screen.
        const activity = String((await session.execute('mobile: getCurrentActivity')) ?? '').trim();
        const pkg = String((await session.execute('mobile: getCurrentPackage')) ?? '').trim();
        if (!activity) throw problem('The phone did not report the current screen (activity).', 'NO_ACTIVITY', 422);
        if (pkg && pkg !== recording.pkg) throw problem(`The app in front is ${pkg}, not ${recording.pkg}. Bring the app under test to the front first.`, 'WRONG_APP', 409);
        args.activity = `${recording.pkg}/${activity}`;
      } else if (type === 'checkpoint') {
        // Nothing happens on the phone now: the test saves a screenshot at this point when it runs.
        args.name = checkpointName(String(args.name ?? ''));
      } else if (type === 'swipe') await this.#swipe(session, args, size);
      else if (type === 'sleep') {
        args.ms = Math.max(0, Math.min(30_000, Number(args.ms) || 1500));
        await delay(Number(args.ms));
      } else if (['assert', 'wait_visible', 'wait_hidden', 'wait_enabled'].includes(type)) await this.#check(session, type, args, ids, context);
      else if (type === 'scroll_to') {
        for (let i = 0; i <= 8; i++) {
          const found = await ids();
          if (found.length === 1 && (await session.displayed(found[0]))) break;
          if (i === 8) throw problem('Control was not found after eight scrolls.', 'NOT_VISIBLE', 422);
          await session.execute('mobile: scrollGesture', { left: 0, top: Math.round(size.height * 0.2), width: size.width, height: Math.round(size.height * 0.6), direction: 'down', percent: 0.7 });
        }
      } else throw problem(`Unsupported action: ${type}`);
      applied = true;

      const step: UiStep = {
        id: randomUUID(),
        type,
        title: target?.title || type.replaceAll('_', ' '),
        context: target && context === 'WEBVIEW' ? 'WEBVIEW' : 'NATIVE_APP',
        target: target ? { kind: target.parts.by === 'id' ? 'testId' : target.parts.by, parts: target.parts } : coordinate ? { kind: 'coordinate' } : null,
        mode: coordinate ? 'coord' : 'name',
        pre: true,
        args,
        ...(coordinate ? { x, y } : {}),
      };
      if (context === 'WEBVIEW' && !coordinate && screen.web) {
        const nativeId = screen.web.native ? screen.nodes.find((n) => n.index === screen.web!.native!.index)?.resourceId || null : null;
        step.webview = { testId: nativeId, index: 0, count: screen.web.nativeWebViews.length, url: screen.web.url, title: screen.web.title };
      }
      if (secretEnv) step.secretEnv = secretEnv;
      if (body.record !== false) recording.add(step);
      if (context === 'WEBVIEW') await session.switchFrame(null).catch(() => {});
      const fresh = await sessions.capture(body.autoWeb !== false);
      return { screen: fresh, steps: recording.steps, durationMs: Date.now() - began, applied: true };
    } catch (e) {
      if (secretEnv) delete args.text;
      throw Object.assign(e as Error, {
        applied,
        steps: recording.steps,
        hint: applied ? 'The action completed and was recorded, but refresh failed. Refresh manually; do not repeat the action.' : 'The command failed. Refresh and inspect the phone before retrying; a device command may have been delivered.',
      });
    } finally {
      if (context === 'WEBVIEW') await session.switchFrame(null).catch(() => {});
    }
  }

  #webTarget(body: Record<string, unknown>, screen: Snapshot): Target {
    const web = screen.web;
    if (!web) throw problem('No WebView DOM. Select a native control instead.');
    const n = web.nodes[Number(body.index)];
    if (!n) throw problem('Select a DOM control.');
    const dom = web as unknown as DomSnapshot;
    const candidates = webCandidates(dom, n);
    const chosen = candidates.find((c) => c.using === body.using && c.value === body.value) ?? candidates[0];
    const using = body.using === 'xpath' ? 'xpath' : body.using === 'css selector' ? 'css selector' : chosen?.using;
    const value = String(body.value || chosen?.value || '');
    if (!using || !value) throw problem('Select a CSS or XPath locator.');
    return { using, value, parts: { by: using === 'xpath' ? 'xpath' : 'css', value, frames: n.frame >= 0 ? framePath(dom, n.frame) : [] }, title: n.text || n.tag };
  }

  async #nativeTarget(body: Record<string, unknown>, screen: Snapshot, type: string, args: Record<string, unknown>): Promise<Target> {
    const picked = body.locator && typeof body.locator === 'object' ? (body.locator as { strategy?: unknown; value?: unknown }) : null;
    let target = await this.#d.locators.nativeTarget(Number(body.index), screen, picked ? { strategy: String(picked.strategy), value: String(picked.value) } : null);
    if (['type', 'clear'].includes(type) && target.parts.by === 'text') throw problem('A text locator changes as soon as the field is edited. Choose the ID, label or XPath for typing.');
    // A count check counts every control with the value, not the one row that was selected.
    if (type === 'assert' && args.assertion === 'count' && target.parts.index !== undefined && target.parts.by !== 'xpath' && target.parts.by !== 'css') {
      const { index: _index, ...parts } = target.parts;
      target = { ...target, using: 'xpath', value: `//*[@${ATTR[parts.by as keyof typeof ATTR]}=${xpathLiteral(parts.value!)}]`, parts };
    }
    return target;
  }

  async #swipe(session: Session, args: Record<string, unknown>, size: { width: number; height: number }) {
    const direction = String(args.direction || 'up');
    if (!['up', 'down', 'left', 'right'].includes(direction)) throw problem('Invalid swipe direction.');
    const w = size.width, h = size.height, vertical = ['up', 'down'].includes(direction), positive = ['down', 'right'].includes(direction);
    args.from = { x: vertical ? w * 0.5 : w * (positive ? 0.25 : 0.75), y: vertical ? h * (positive ? 0.25 : 0.75) : h * 0.5 };
    args.to = { x: vertical ? w * 0.5 : w * (positive ? 0.75 : 0.25), y: vertical ? h * (positive ? 0.75 : 0.25) : h * 0.5 };
    args.duration = 400;
    await session.execute('mobile: swipeGesture', { left: Math.round(w * 0.15), top: Math.round(h * 0.2), width: Math.round(w * 0.7), height: Math.round(h * 0.6), direction, percent: 0.75 });
  }

  /** Waits up to 10 s for the condition, as the generated test will; fails the action when it does not hold. */
  async #check(session: Session, type: string, args: Record<string, unknown>, ids: () => Promise<string[]>, context: string) {
    const kind = type === 'wait_visible' ? 'visible' : type === 'wait_hidden' ? 'hidden' : type === 'wait_enabled' ? 'enabled' : String(args.assertion || 'visible');
    if (!ASSERTIONS.includes(kind)) throw problem('Unsupported assertion.');
    if (kind === 'count' && (!Number.isInteger(Number(args.expected)) || Number(args.expected) < 0)) throw problem('Count must be a nonnegative integer.');
    let passed = false;
    const end = Date.now() + 10_000;
    while (!passed && Date.now() < end) {
      const found = await ids();
      if (kind === 'count') passed = found.length === Number(args.expected);
      else if (kind === 'hidden') passed = !found.length || (found.length === 1 && !(await session.displayed(found[0])));
      else if (found.length === 1) {
        const el = found[0];
        if (kind === 'visible') passed = await session.displayed(el);
        else if (kind === 'text') passed = (await session.text(el)) === String(args.expected ?? '');
        else if (kind === 'contains') passed = (await session.text(el)).includes(String(args.expected ?? ''));
        else {
          const value = ['enabled', 'disabled'].includes(kind) ? await session.enabled(el) : ['checked', 'unchecked'].includes(kind) && context !== 'WEBVIEW' ? (await session.attribute(el, 'checked')) === 'true' : await session.selected(el);
          passed = value === !['disabled', 'unchecked', 'unselected'].includes(kind);
        }
      }
      if (!passed) await delay(200);
    }
    if (!passed) throw problem(`Assertion failed: expected ${kind}${args.expected !== undefined ? ' ' + args.expected : ''}.`, 'ASSERTION_FAILED', 422);
    if (type === 'assert') args.assertion = kind;
  }
}
