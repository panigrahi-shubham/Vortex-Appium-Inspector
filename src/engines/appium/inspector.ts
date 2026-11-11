// Appium Inspector session: a UiAutomator2 session on the current screen, used to read the native hierarchy,
// take screenshots and verify locator candidates. Holds the device lease while open, so the ADB recorder
// (whose `uiautomator dump` would collide with the UiAutomator2 server) does not touch the phone meanwhile.

import { allCandidates } from './anchor-locators.ts';
import { randomUUID } from 'node:crypto';
import type { ServerManager } from '../../appium/server-manager.ts';
import type { DeviceLeases } from '../../devices/device-lease.ts';
import { candidatesFor, recommend, verifyCandidates } from './native-locators.ts';
import { parsePageSource, type PageSource } from './page-source.ts';
import { createWebDriverClient, uiautomator2Capabilities, WebDriverError, type Session } from './webdriver.ts';
import { SNAPSHOT_SCRIPT, framePath, type DomSnapshot } from '../webview/dom.ts';
import { selectWebWindow } from '../webview/window.ts';
import { enterFrames, recommendWeb, RULES, verifyWeb, webCandidates, webCodes, type WebCandidate } from '../webview/web-locators.ts';

export interface NativeWebView {
  index: number;
  resourceId: string;
  bounds: { x: number; y: number; w: number; h: number };
}

export interface WebState {
  context: string;
  snap: DomSnapshot | null;
  /** Native WebView the page is drawn in (for mapping DOM bounds to screen pixels). */
  native: NativeWebView | null;
  nativeWebViews: NativeWebView[];
  lastSwitchError: string | null;
  lastDomError: string | null;
}

export class InspectorError extends Error {
  code: string;
  httpStatus: number;
  hint: string | null;
  constructor(code: string, httpStatus: number, message: string, hint: string | null = null) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.hint = hint;
  }
}

interface Open {
  recording: boolean;
  id: string;
  serial: string;
  session: Session;
  release: () => void;
  startedAt: string;
  last: PageSource | null;
  /** Raw XML of the last native screen read, kept so locators can be evaluated without asking the device. */
  lastXml: string | null;
  web: WebState;
}

/** Child-index paths of the given elements from their document's <html> element. */
const PATH_OF_SCRIPT = `
return Array.prototype.map.call(arguments, function (el) {
  var p = [];
  while (el && el.parentElement) { p.unshift(Array.prototype.indexOf.call(el.parentElement.children, el)); el = el.parentElement; }
  return p;
});
`;

export class AppiumInspector {
  #open: Open | null = null;
  #manager: ServerManager;
  #leases: DeviceLeases;

  constructor(manager: ServerManager, leases: DeviceLeases) {
    this.#manager = manager;
    this.#leases = leases;
  }

  status() {
    const o = this.#open;
    return o ? { open: true, recording: o.recording, serial: o.serial, sessionId: o.session.id, startedAt: o.startedAt, context: o.web.context } : { open: false };
  }

  /** Commands share this inspector's single UiAutomator2 session. Callers serialize access. */
  session(): Session { return this.#need().session; }

  async start(serial: string, recording = false) {
    if (this.#open) {
      if (this.#open.serial === serial && this.#open.recording === recording) return this.status();
      throw new InspectorError('INSPECTOR_OPEN', 409, `The Inspector is already open on ${this.#open.serial}. Close it first.`);
    }
    const ep = this.#manager.endpoint();
    if (!ep) throw new InspectorError('NO_SERVER', 409, 'No running Appium server. Start or connect one in the Server Manager first.');
    const id = randomUUID();
    const release = this.#leases.acquire(serial, { kind: recording ? 'recorder' : 'inspector', id, label: recording ? 'Automatic WebView recording' : 'Appium Inspector' });
    const s = this.#manager.settings;
    try {
      const client = createWebDriverClient(ep.url);
      const session = await client.newSession(uiautomator2Capabilities({ udid: serial, newCommandTimeoutSec: s.sessionIdleTimeoutSec, chromedriverExecutable: s.chromedriverExecutable, chromedriverExecutableDir: s.chromedriverExecutableDir }), s.sessionStartupTimeoutMs);
      this.#manager.trackSession(session.id);
      this.#open = { id, serial, recording, session, release, startedAt: new Date().toISOString(), last: null, lastXml: null, web: { context: 'NATIVE_APP', snap: null, native: null, nativeWebViews: [], lastSwitchError: null, lastDomError: null } };
      return this.status();
    } catch (e) {
      release();
      throw this.#wrap(e, 'SESSION_FAILED');
    }
  }

  async source() {
    const o = this.#need();
    if (o.web.context !== 'NATIVE_APP') await this.webToNative();
    try {
      const [xml, png, win, contexts] = await Promise.all([
        o.session.pageSource(),
        o.session.screenshotPng(),
        o.session.windowRect().catch(() => null),
        o.session.contexts().catch(() => null),
      ]);
      const ps = parsePageSource(xml);
      o.last = ps;
      o.lastXml = xml;
      o.web.nativeWebViews = ps.nodes.filter(n => n.className === 'android.webkit.WebView' && n.bounds).map(n => ({index:n.index,resourceId:n.resourceId,bounds:n.bounds!}));
      return {
        img: 'data:image/png;base64,' + png.toString('base64'),
        width: ps.width ?? win?.width ?? null,
        height: ps.height ?? win?.height ?? null,
        contexts,
        nodes: ps.nodes.map((n) => ({ index: n.index, parent: n.parent, depth: n.depth, className: n.className, resourceId: n.resourceId, text: n.text, contentDesc: n.contentDesc, packageName: n.packageName, bounds: n.bounds, flags: n.flags, path: n.path })),
      };
    } catch (e) {
      throw this.#wrap(e, 'SOURCE_FAILED');
    }
  }

  /** Read through the existing automation owner; never run an ADB uiautomator dump alongside it. */
  async nativeTree() {
    const o = this.#need();
    if (o.web.context !== 'NATIVE_APP') await this.webToNative();
    try {
      const xml = await o.session.pageSource();
      const ps = parsePageSource(xml);
      o.last = ps;
      o.lastXml = xml;
      o.web.nativeWebViews = ps.nodes.filter(n => n.className === 'android.webkit.WebView' && n.bounds).map(n => ({ index: n.index, resourceId: n.resourceId, bounds: n.bounds! }));
      return ps.nodes.map(n => ({
        id: n.index, parentId: n.parent, childIds: n.children, depth: n.depth,
        ref: '', type: n.className, text: n.text, label: n.contentDesc,
        identifier: n.resourceId, placeholder: n.attrs.hint ?? '',
        rect: n.bounds ?? { x: 0, y: 0, w: 0, h: 0 },
        selected: n.flags.selected ?? false, enabled: n.flags.enabled ?? true,
        checked: n.flags.checkable ? n.flags.checked ?? false : null,
      }));
    } catch (e) { throw this.#wrap(e, 'SOURCE_FAILED'); }
  }

  async recordingDom(pkg: string) {
    const o = this.#need();
    if (!o.web.nativeWebViews.length) await this.nativeTree();
    const contexts = await o.session.contexts();
    const name = contexts.find(c => c === `WEBVIEW_${pkg}`) ?? contexts.find(c => c.startsWith(`WEBVIEW_${pkg}:`));
    if (!name) throw new InspectorError('NO_WEB_CONTEXT', 409, 'DOM access is not exposed for this app. Native locators and coordinate taps remain available.');
    return this.webSwitch(name, { captureImage: false });
  }

  async locators(index: number) {
    const o = this.#need();
    const ps = o.last;
    if (!ps) throw new InspectorError('NO_SOURCE', 409, 'Read the screen first.');
    const node = ps.nodes[index];
    if (!node) throw new InspectorError('NO_ELEMENT', 404, `No element with index ${index} on the last screen read.`);
    try {
      const verified = await verifyCandidates(o.session, node, await allCandidates(node, ps, o.lastXml));
      return { node: { index: node.index, className: node.className, resourceId: node.resourceId, text: node.text, contentDesc: node.contentDesc, packageName: node.packageName, bounds: node.bounds, flags: node.flags, path: node.path }, recommended: recommend(verified), candidates: verified };
    } catch (e) {
      throw this.#wrap(e, 'VERIFY_FAILED');
    }
  }

  /** The last native screen read (parsed and raw), for locator work that must not touch the device. */
  cachedSource(): { ps: PageSource; xml: string | null } {
    const o = this.#need();
    if (!o.last) throw new InspectorError('NO_SOURCE', 409, 'Read the screen first.');
    return { ps: o.last, xml: o.lastXml };
  }

  /** Asks the device about one candidate only (one lookup and one rect), instead of the whole list. */
  async verifyOne(index: number, strategy: string, value: string) {
    const o = this.#need();
    const ps = o.last, node = ps?.nodes[index];
    if (!ps || !node) throw new InspectorError('NO_ELEMENT', 404, 'Select a control from a fresh screen.');
    const cand = (await allCandidates(node, ps, o.lastXml)).find((c) => c.strategy === strategy && c.value === value);
    if (!cand) throw new InspectorError('NO_CANDIDATE', 404, 'That locator is not one of the candidates of this control.');
    try {
      return (await verifyCandidates(o.session, node, [cand]))[0];
    } catch (e) {
      throw this.#wrap(e, 'VERIFY_FAILED');
    }
  }

  candidates(index: number) {
    const ps=this.#need().last, node=ps?.nodes[index];
    if (!ps || !node) throw new InspectorError('NO_ELEMENT',404,'Select a control from a fresh screen.');
    return {node,candidates:candidatesFor(node,ps)};
  }

  // ---- WebView ------------------------------------------------------------------------------

  /** Contexts Appium offers, the WebViews in the native hierarchy and, when supported, the pages of each WebView. */
  async webContexts() {
    const o = this.#need();
    try {
      if (o.web.context !== 'NATIVE_APP') await this.webToNative();
      const xml = await o.session.pageSource();
      const ps = parsePageSource(xml);
      o.last = ps;
      o.lastXml = xml;
      o.web.nativeWebViews = ps.nodes.filter((n) => n.className === 'android.webkit.WebView' && n.bounds).map((n) => ({ index: n.index, resourceId: n.resourceId, bounds: n.bounds! }));
      const contexts = await o.session.contexts();
      let details: unknown = null;
      try {
        details = await o.session.execute('mobile: getContexts', { waitForWebviewMs: 2000 });
      } catch {
        details = null; // older drivers: the plain list is enough
      }
      return { current: o.web.context, contexts, details, nativeWebViews: o.web.nativeWebViews, nativeTypes: [...new Set(ps.nodes.map((n) => n.className))] };
    } catch (e) {
      throw this.#wrap(e, 'CONTEXTS_FAILED');
    }
  }

  /** Switches to a WEBVIEW context (and window), reads the DOM. On failure the session goes back to NATIVE_APP. */
  async webSwitch(name: string, opts: { window?: string | null; webview?: number | null; captureImage?: boolean } = {}) {
    const o = this.#need();
    if (!/^WEBVIEW_[\w.:-]+$|^CHROMIUM$/.test(name)) throw new InspectorError('BAD_CONTEXT', 400, `"${name}" is not a WebView context.`);
    if (!o.web.nativeWebViews.length) await this.webContexts();
    const png = opts.captureImage === false ? null : await o.session.screenshotPng().catch(() => null);
    try {
      await o.session.switchContext(name);
      o.web.lastSwitchError = null;
    } catch (e) {
      o.web.lastSwitchError = (e as Error).message;
      await o.session.switchContext('NATIVE_APP').catch(() => {});
      o.web.context = 'NATIVE_APP';
      throw this.#wrap(e, 'SWITCH_FAILED');
    }
    o.web.context = name;
    const pick = opts.webview ?? null;
    o.web.native = (pick !== null ? o.web.nativeWebViews.find((w) => w.index === pick) : o.web.nativeWebViews[0]) ?? null;
    try {
      const windows = await o.session.windowHandles().catch(() => [] as string[]);
      await selectWebWindow(o.session, windows, opts.window);
      const current = await o.session.currentWindow().catch(() => null);
      const snap = await this.#snapshot(o);
      if (snap.viewport.w <= 0 || snap.viewport.h <= 0) throw new Error('This WebView page has no visible viewport. Select the visible app page instead.');
      return { windows, window: current, nativeImg: png ? 'data:image/png;base64,' + png.toString('base64') : null, ...this.#view(o, snap) };
    } catch (e) {
      o.web.lastDomError = (e as Error).message;
      await this.webToNative().catch(() => {});
      throw this.#wrap(e, 'DOM_FAILED');
    }
  }

  /** Reads the DOM again (after the page changed). */
  async webRefresh() {
    const o = this.#needWeb();
    try {
      const png = await this.#nativeShot(o);
      const snap = await this.#snapshot(o);
      return { nativeImg: png, ...this.#view(o, snap) };
    } catch (e) {
      throw this.#wrap(e, 'DOM_FAILED');
    }
  }

  async webLocators(i: number) {
    const o = this.#needWeb();
    const snap = o.web.snap!;
    const node = snap.nodes[i];
    if (!node) throw new InspectorError('NO_ELEMENT', 404, `No DOM element with index ${i} in the last snapshot.`);
    try {
      const cands = await verifyWeb(o.session, snap, node, webCandidates(snap, node));
      return { node: { ...node, screen: this.#toScreen(o, node.rect), frames: node.frame >= 0 ? framePath(snap, node.frame) : [] }, recommended: recommendWeb(cands), candidates: cands, rules: RULES };
    } catch (e) {
      throw this.#wrap(e, 'VERIFY_FAILED');
    }
  }

  /** Runs a CSS selector or XPath in the page (top document or one frame) and returns the matching elements. */
  async webSearch(using: 'css selector' | 'xpath', value: string, frame = -1) {
    const o = this.#needWeb();
    const snap = o.web.snap!;
    if (!value.trim()) throw new InspectorError('EMPTY', 400, 'Enter a selector.');
    const frames = frame >= 0 && snap.frames[frame] ? framePath(snap, frame) : [];
    try {
      await enterFrames(o.session, frames);
      const t0 = Date.now();
      let ids: string[];
      try {
        ids = await o.session.findElements(using, value);
      } catch (e) {
        return { using, value, frames, count: 0, ms: Date.now() - t0, matches: [], error: (e as Error).message };
      }
      const ms = Date.now() - t0;
      const paths = (await o.session.executeArgs(PATH_OF_SCRIPT, ids.slice(0, 50).map((id) => ({ element: id })))) as number[][];
      const fIdx = frame >= 0 ? frame : -1;
      const matches = paths.map((p) => snap.nodes.find((n) => n.frame === fIdx && n.path.length === p.length && n.path.every((x, k) => x === p[k]))?.i ?? null);
      return { using, value, frames, count: ids.length, ms, matches, error: null, ...webCodes(using, value, frames) };
    } catch (e) {
      throw this.#wrap(e, 'SEARCH_FAILED');
    } finally {
      await o.session.switchFrame(null).catch(() => {});
    }
  }

  /** Performs a web action through the chosen locator (as the generated test will) and reads the DOM again. */
  async webCommand(i: number, action: 'tap' | 'type' | 'scroll', opts: { text?: string; using?: 'css selector' | 'xpath'; value?: string } = {}) {
    const o = this.#needWeb();
    const snap = o.web.snap!;
    const node = snap.nodes[i];
    if (!node) throw new InspectorError('NO_ELEMENT', 404, `No DOM element with index ${i} in the last snapshot.`);
    let cand: WebCandidate | null = null;
    if (opts.using && opts.value) {
      cand = { strategy: 'css attribute', using: opts.using, value: opts.value, frames: node.frame >= 0 ? framePath(snap, node.frame) : [], strengths: [], weaknesses: [], status: 'not-verified', matches: null, ms: null, score: 0, python: '' };
    } else cand = recommendWeb(await verifyWeb(o.session, snap, node, webCandidates(snap, node)));
    if (!cand) throw new InspectorError('NO_LOCATOR', 409, 'No locator for this element is verified unique, so the action was not performed. Pick a locator from the list or search for one.');
    try {
      await enterFrames(o.session, cand.frames);
      const ids = await o.session.findElements(cand.using, cand.value);
      if (ids.length !== 1) throw new InspectorError('NOT_UNIQUE', 409, `The locator matched ${ids.length} elements; nothing was done.`);
      if (action === 'tap') await o.session.click(ids[0]);
      else if (action === 'scroll') await o.session.executeArgs('arguments[0].scrollIntoView({block:"center"});', [{ element: ids[0] }]);
      else {
        await o.session.clear(ids[0]);
        await o.session.sendKeys(ids[0], opts.text ?? '');
      }
    } catch (e) {
      throw this.#wrap(e, 'ACTION_FAILED');
    } finally {
      await o.session.switchFrame(null).catch(() => {});
    }
    return { locator: { using: cand.using, value: cand.value, frames: cand.frames, strategy: cand.strategy, score: cand.score, weaknesses: cand.weaknesses }, page: { url: snap.url, title: snap.title } };
  }

  async webAct(i: number, action: 'tap' | 'type', opts: { text?: string; using?: 'css selector' | 'xpath'; value?: string } = {}) {
    const completed = await this.webCommand(i, action, opts);
    await new Promise((r) => setTimeout(r, 300));
    const fresh = await this.webRefresh();
    return { ...completed, ...fresh };
  }

  /** Back to the native context (WebView-to-native recovery). */
  async webToNative() {
    const o = this.#need();
    try {
      await o.session.switchContext('NATIVE_APP');
    } finally {
      o.web.context = 'NATIVE_APP';
      o.web.snap = null;
    }
    return { context: 'NATIVE_APP' };
  }

  /** What the diagnostics need from the open session. */
  webInfo() {
    const o = this.#open;
    return o ? { lastSwitchError: o.web.lastSwitchError, lastDomError: o.web.lastDomError, context: o.web.context } : null;
  }

  async #snapshot(o: Open): Promise<DomSnapshot> {
    try {
      const snap = (await o.session.executeArgs(SNAPSHOT_SCRIPT, [])) as DomSnapshot;
      if (!snap || !Array.isArray(snap.nodes)) throw new Error('the page returned no DOM');
      o.web.snap = snap;
      o.web.lastDomError = null;
      return snap;
    } catch (e) {
      o.web.lastDomError = (e as Error).message;
      throw e;
    }
  }

  async #nativeShot(o: Open): Promise<string | null> {
    // Chromedriver screenshots show only the page; the native screen is read in NATIVE_APP and the context restored.
    const ctx = o.web.context;
    try {
      await o.session.switchContext('NATIVE_APP');
      const png = await o.session.screenshotPng();
      return 'data:image/png;base64,' + png.toString('base64');
    } catch {
      return null;
    } finally {
      await o.session.switchContext(ctx).catch(() => {});
    }
  }

  #toScreen(o: Open, r: { x: number; y: number; w: number; h: number }) {
    const nb = o.web.native?.bounds;
    const snap = o.web.snap;
    if (!nb || !snap || !snap.viewport.w) return null;
    const k = nb.w / snap.viewport.w;
    return { x: Math.round(nb.x + r.x * k), y: Math.round(nb.y + r.y * k), w: Math.round(r.w * k), h: Math.round(r.h * k), scale: k };
  }

  #view(o: Open, snap: DomSnapshot) {
    return {
      context: o.web.context,
      native: o.web.native,
      nativeWebViews: o.web.nativeWebViews,
      url: snap.url,
      title: snap.title,
      viewport: snap.viewport,
      dpr: snap.dpr,
      truncated: snap.truncated,
      frames: snap.frames,
      nodes: snap.nodes.map((n) => ({ ...n, screen: this.#toScreen(o, n.rect) })),
      mapping: o.web.native && snap.viewport.w > 0 ? `DOM pixels x ${(o.web.native.bounds.w / snap.viewport.w).toFixed(3)} + WebView at (${o.web.native.bounds.x}, ${o.web.native.bounds.y})` : 'no visible WebView viewport: highlights cannot be placed on the screenshot',
    };
  }

  #needWeb(): Open {
    const o = this.#need();
    if (o.web.context === 'NATIVE_APP' || !o.web.snap) throw new InspectorError('NOT_IN_WEBVIEW', 409, 'Switch to a WebView context first.');
    return o;
  }

  /** Always ends the session and frees the device, even when Appium is already gone. */
  async stop() {
    const o = this.#open;
    if (!o) return { open: false, detail: 'not open' };
    if (o.web.context !== 'NATIVE_APP') await o.session.switchContext('NATIVE_APP').catch(() => {});
    this.#open = null;
    let detail = 'session closed';
    try {
      await o.session.delete();
    } catch (e) {
      detail = `session could not be closed cleanly: ${(e as Error).message}`;
    } finally {
      this.#manager.untrackSession(o.session.id);
      o.release();
    }
    return { open: false, detail };
  }

  #need(): Open {
    if (!this.#open) throw new InspectorError('NOT_OPEN', 409, 'The Inspector is not open.');
    return this.#open;
  }

  #wrap(e: unknown, code: string): InspectorError {
    if (e instanceof InspectorError) return e;
    if (e instanceof WebDriverError) {
      if (e.error === 'invalid session id' && this.#open) {
        // The session is gone (timeout, server restart): free the device so recording can continue.
        const o = this.#open;
        this.#open = null;
        this.#manager.untrackSession(o.session.id);
        o.release();
      }
      return new InspectorError(code, 502, `Appium: ${e.message}`, e.hint);
    }
    return new InspectorError(code, 500, (e as Error).message);
  }
}
