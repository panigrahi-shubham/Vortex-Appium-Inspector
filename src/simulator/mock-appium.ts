// A controlled, UiAutomator2-like Appium server for tests and demos without a phone.
//
// It serves the synthetic TradeHub screens in samples/ (home, products) over the W3C WebDriver endpoints
// that Vortex and the Appium Python client use: sessions, element lookup (id, accessibility id, class name,
// -android uiautomator, xpath), element state, click/clear/value, mobile: gestures and keys, page source,
// screenshots, contexts and window size. Tapping "My Products" opens the products screen, tapping the market card
// opens "Market Insights" (a WebView screen); Back returns home.
//
// WebView: on the insights screen it offers a WEBVIEW_com.yourname.tradehub context like UiAutomator2 + Chromedriver.
// Commands in that context are served by a real headless Chromium (Playwright) showing samples/insights.html, so
// CSS/XPath lookups, clicks, typing, frames and scripts behave as in a browser engine. Options simulate WebView
// debugging being disabled and an incompatible Chromedriver, for diagnostics tests.
//
// It is a test fixture: passing against it proves the generated code and the runner work end to end,
// NOT that anything works on a real device.
//
// It lives in src/ because `npm start -- --mock` uses it; it is never loaded when a real phone is used.
//
// Standalone: node src/simulator/mock-appium.ts --port 4790

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';
import xpath from 'xpath';
import { parseTree } from './sample-tree.js';
import { blit, decodePng, encodePng } from '../visual/png.ts';
import { openWebView, WEBVIEW } from './webview-host.mjs';

const SAMPLES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'samples');
const APP = 'com.yourname.tradehub';
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

interface Node {
  id: number;
  parentId: number | null;
  childIds: number[];
  depth: number;
  type: string;
  text: string;
  label: string;
  identifier: string;
  rect: { x: number; y: number; w: number; h: number };
  selected: boolean;
  checked: boolean | null;
  enabled: boolean;
}

interface Screen {
  nodes: Node[];
  png: Buffer;
  xml: string;
  /** Same XML with a vortex-i attribute per element, for XPath evaluation only. */
  doc: Document;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const CLICKABLE = /Button|ImageButton|Switch|EditText|CheckBox/;

function pkgOf(n: Node, nodes: Node[]): string {
  let cur: Node | undefined = n;
  while (cur) {
    const i = cur.identifier.indexOf(':id/');
    if (i > 0) return cur.identifier.slice(0, i);
    cur = cur.parentId === null ? undefined : nodes[cur.parentId];
  }
  // look down for a package hint
  const stack = [...n.childIds];
  while (stack.length) {
    const c = nodes[stack.pop()!];
    const i = c.identifier.indexOf(':id/');
    if (i > 0) return c.identifier.slice(0, i);
    stack.push(...c.childIds);
  }
  return APP;
}

function toXml(nodes: Node[], withIndex: boolean, typed: Map<number, string>): string {
  const el = (n: Node, sibIndex: number): string => {
    const tag = n.type || 'android.view.View';
    const r = n.rect;
    const text = typed.get(n.id) ?? n.text;
    const attrs = [
      ['index', String(sibIndex)], ['package', pkgOf(n, nodes)], ['class', tag], ['text', text], ['resource-id', n.identifier],
      ['checkable', String(n.checked !== null)], ['checked', String(!!n.checked)], ['clickable', String(CLICKABLE.test(tag) || /button|nav_|card/.test(n.identifier))],
      ['enabled', String(n.enabled)], ['focusable', String(CLICKABLE.test(tag))], ['focused', 'false'], ['long-clickable', 'false'], ['password', 'false'],
      ['scrollable', String(/Recycler|ScrollView/.test(tag))], ['selected', String(n.selected)], ['bounds', `[${r.x},${r.y}][${r.x + r.w},${r.y + r.h}]`], ['displayed', 'true'],
    ];
    if (n.label) attrs.splice(5, 0, ['content-desc', n.label]);
    if (withIndex) attrs.push(['vortex-i', String(n.id)]);
    const a = attrs.map(([k, v]) => `${k}="${esc(v)}"`).join(' ');
    const kids = n.childIds.map((c, i) => el(nodes[c], i)).join('');
    return kids ? `<${tag} ${a}>${kids}</${tag}>` : `<${tag} ${a} />`;
  };
  const roots = nodes.filter((n) => n.parentId === null).map((n, i) => el(n, i)).join('');
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy index="0" class="hierarchy" rotation="0" width="1080" height="2400">${roots}</hierarchy>`;
}

/** Parses the subset of UiSelector syntax used by Vortex and common hand-written tests. */
export function parseUiSelector(src: string): { method: string; arg: string | number | boolean }[] {
  const inner = /scrollIntoView\(\s*(new UiSelector\(\)[\s\S]*)\)\s*;?\s*$/.exec(src)?.[1] ?? src;
  if (!/^\s*new UiSelector\(\)/.test(inner)) throw new Error(`unsupported UiAutomator expression: ${src}`);
  const out: { method: string; arg: string | number | boolean }[] = [];
  const re = /\.(\w+)\(\s*("(?:[^"\\]|\\.)*"|true|false|-?\d+)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) {
    const raw = m[2];
    const arg = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw === 'true' ? true : raw === 'false' ? false : Number(raw);
    out.push({ method: m[1], arg });
  }
  return out;
}

export interface MockAppiumOptions {
  port?: number;
  devices?: string[];
  /** false = the app's WebView is not debuggable (no WEBVIEW context, as with a release build). Default true. */
  webviewDebuggable?: boolean;
  /** When set, switching to the WebView context fails with this Chromedriver error. */
  chromedriverError?: string | null;
}

const WEBVIEW_CONTEXT = `WEBVIEW_${APP}`;
/** Synthetic activities of the sample screens (same names as the recorder's mock device). */
const ACTIVITIES = { home: '.ui.HomeActivity', products: '.ui.products.MyProductsActivity', insights: '.ui.insights.MarketInsightsActivity' } as const;
/** Deep links of the sample app: tradehub://products, tradehub://insights, anything else opens home. */
export const deepLinkScreen = (url: string): 'home' | 'products' | 'insights' => (/^tradehub:\/\/products\b/.test(url) ? 'products' : /^tradehub:\/\/insights\b/.test(url) ? 'insights' : 'home');
type WebHost = Awaited<ReturnType<typeof openWebView>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handle = any;

export class MockAppium {
  server: http.Server;
  port = 0;
  devices: string[];
  sessions = new Map<string, { caps: Record<string, unknown>; settings?: Record<string, unknown> }>();
  log: string[] = [];
  /** Every session request received ("METHOD /path"), so tests can prove that a feature did not touch the device. */
  requests: string[] = [];
  screen: 'home' | 'products' | 'insights' = 'home';
  webviewDebuggable: boolean;
  chromedriverError: string | null;
  web: WebHost | null = null;
  #webDirty = true;
  #webIds = new Map<string, Handle>();
  #webSeq = 0;
  #ctx = new Map<string, { context: string; frame: Handle | null }>();
  version = 0;
  typed = new Map<number, string>();
  appRunning = true;
  #cache = new Map<string, Screen>();

  constructor(o: MockAppiumOptions = {}) {
    this.devices = o.devices ?? ['mock-device', 'emulator-5554'];
    this.webviewDebuggable = o.webviewDebuggable ?? true;
    this.chromedriverError = o.chromedriverError ?? null;
    this.server = http.createServer((req, res) => void this.#handle(req, res));
  }

  listen(port = 0): Promise<number> {
    return new Promise((resolve) => this.server.listen(port, '127.0.0.1', () => resolve((this.port = (this.server.address() as { port: number }).port))));
  }

  close(): Promise<void> {
    void this.web?.close();
    this.web = null;
    this.server.closeAllConnections?.();
    return new Promise((r) => this.server.close(() => r()));
  }

  /** resource-id suffixes changed since the app was "released", to simulate a new build (old suffix -> new suffix). */
  renamed = new Map<string, string>();

  /** Simulates an app update that renames a resource-id, e.g. renameId('home_my_products_button', 'home_products_shortcut'). */
  renameId(fromSuffix: string, toSuffix: string) {
    this.renamed.set(fromSuffix, toSuffix);
    this.#cache.clear();
    this.version++;
  }

  #originalId(id: string): string {
    for (const [from, to] of this.renamed) if (id.endsWith(to)) return id.slice(0, -to.length) + from;
    return id;
  }

  #load(): Screen {
    const key = `${this.screen}:${[...this.typed.entries()].join(',')}`;
    const hit = this.#cache.get(key);
    if (hit) return hit;
    const nodes = parseTree(fs.readFileSync(path.join(SAMPLES, `${this.screen}.json`))) as Node[];
    for (const n of nodes) for (const [from, to] of this.renamed) if (n.identifier.endsWith(from)) n.identifier = n.identifier.slice(0, -from.length) + to;
    const withIdx = toXml(nodes, true, this.typed);
    const s: Screen = {
      nodes,
      png: fs.readFileSync(path.join(SAMPLES, `${this.screen}.png`)),
      xml: toXml(nodes, false, this.typed),
      doc: new DOMParser().parseFromString(withIdx, 'text/xml') as unknown as Document,
    };
    this.#cache.set(key, s);
    return s;
  }

  #go(screen: 'home' | 'products' | 'insights') {
    if (screen !== this.screen) {
      this.screen = screen;
      this.version++;
      this.typed.clear();
      if (screen === 'insights') this.#webDirty = true; // a fresh page each time the screen opens
      for (const c of this.#ctx.values()) if (screen !== 'insights') Object.assign(c, { context: 'NATIVE_APP', frame: null });
    }
  }

  /** The Chromium page behind the WebView, opened on first use and reloaded when the screen is reopened. */
  async webPage(): Promise<Handle> {
    if (!this.web) this.web = await openWebView(SAMPLES);
    else if (this.#webDirty) await this.web.reset();
    if (this.#webDirty) {
      this.#webIds.clear();
      this.#webDirty = false;
    }
    return this.web.page;
  }

  /** A native tap inside the WebView goes to the page, like a real touch. */
  async #nativeTapAt(x: number, y: number) {
    const B = WEBVIEW.nativeBounds;
    if (this.screen !== 'insights' || x < B.x || y < B.y || x >= B.x + B.width || y >= B.y + B.height) return false;
    const page = await this.webPage();
    await page.mouse.click((x - B.x) / WEBVIEW.dpr, (y - B.y) / WEBVIEW.dpr);
    return true;
  }

  async #screenshot(s: Screen): Promise<Buffer> {
    if (this.screen !== 'insights' || !this.web) return s.png;
    const base = decodePng(s.png);
    blit(base, decodePng(await (await this.webPage()).screenshot()), WEBVIEW.nativeBounds.x, WEBVIEW.nativeBounds.y);
    return encodePng(base);
  }

  /** What a tap on this node does in the TradeHub app (same rules as the recorder's mock device). */
  #tapNode(nodes: Node[], n: Node) {
    const ids: string[] = [];
    for (let cur: Node | undefined = n; cur; cur = cur.parentId === null ? undefined : nodes[cur.parentId]) ids.push(this.#originalId(cur.identifier));
    if (ids.some((i) => i.endsWith('home_my_products_button'))) this.#go('products');
    else if (ids.some((i) => i.endsWith('home_market_card'))) this.#go('insights');
    else if (ids.some((i) => i.endsWith(':id/nav_home') || i.endsWith('insights_back_button'))) this.#go('home');
  }

  #hit(nodes: Node[], x: number, y: number): Node | null {
    const inside = (n: Node) => n.rect.w > 0 && n.rect.h > 0 && x >= n.rect.x && x < n.rect.x + n.rect.w && y >= n.rect.y && y < n.rect.y + n.rect.h;
    const down = (ids: number[]): Node | null => {
      for (let i = ids.length - 1; i >= 0; i--) {
        const c = nodes[ids[i]];
        if (inside(c)) return down(c.childIds) ?? c;
      }
      return null;
    };
    // the app's subtree first (the status/navigation bars come earlier in the samples)
    return down(nodes.filter((n) => n.parentId === null).map((n) => n.id));
  }

  find(using: string, value: string): Node[] {
    const s = this.#load();
    const all = s.nodes;
    switch (using) {
      case 'id':
        return all.filter((n) => n.identifier === (value.includes(':id/') ? value : `${APP}:id/${value}`));
      case 'accessibility id':
        return all.filter((n) => n.label === value);
      case 'class name':
        return all.filter((n) => n.type === value);
      case 'xpath': {
        const res = xpath.select(value, s.doc as unknown as Node & globalThis.Node) as unknown as { getAttribute?: (n: string) => string | null }[];
        return (Array.isArray(res) ? res : []).map((e) => e.getAttribute?.('vortex-i')).filter((v): v is string => v !== null && v !== undefined).map((v) => all[Number(v)]);
      }
      case '-android uiautomator': {
        const chain = parseUiSelector(value);
        let list = all.filter((n) => {
          for (const { method, arg } of chain) {
            const text = this.typed.get(n.id) ?? n.text;
            if (method === 'resourceId' && n.identifier !== arg) return false;
            if (method === 'text' && text !== arg) return false;
            if (method === 'textContains' && !text.includes(String(arg))) return false;
            if (method === 'textStartsWith' && !text.startsWith(String(arg))) return false;
            if (method === 'description' && n.label !== arg) return false;
            if (method === 'descriptionContains' && !n.label.includes(String(arg))) return false;
            if (method === 'className' && n.type !== arg) return false;
            if (method === 'scrollable' && /Recycler|ScrollView/.test(n.type) !== arg) return false;
          }
          return true;
        });
        const inst = chain.find((c) => c.method === 'instance');
        if (inst) list = list[Number(inst.arg)] ? [list[Number(inst.arg)]] : [];
        return list;
      }
      default:
        throw Object.assign(new Error(`Locator Strategy '${using}' is not supported for this session`), { w3c: 'invalid selector', status: 400 });
    }
  }

  /** WebDriver commands in the WebView context, served by Chromium (what Chromedriver does on a phone). */
  async #web(route: string, rest: string[], body: Record<string, unknown>, ctx: { context: string; frame: Handle | null }, send: (s: number, v: unknown) => void, fail: (s: number, e: string, m: string) => void) {
    const page = await this.webPage();
    const frame = ctx.frame ?? page.mainFrame();
    const ref = (h: Handle) => {
      const id = `w-${++this.#webSeq}`;
      this.#webIds.set(id, h);
      return { [ELEMENT]: id, ELEMENT: id };
    };
    const el = (): Handle => {
      const h = this.#webIds.get(String(rest[1]));
      if (!h) throw Object.assign(new Error('stale element reference: element is not attached to the page document'), { w3c: 'stale element reference', status: 404 });
      return h;
    };
    const selector = (using: string, value: string) => {
      if (using === 'css selector') return value;
      if (using === 'xpath') return `xpath=${value}`;
      if (using === 'tag name') return value;
      if (using === 'link text') return `xpath=//a[normalize-space(.)=${JSON.stringify(value)}]`;
      throw Object.assign(new Error(`invalid selector: Unsupported locator strategy: ${using}`), { w3c: 'invalid selector', status: 400 });
    };
    const unref = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(unref);
      if (v && typeof v === 'object') {
        const id = (v as Record<string, string>)[ELEMENT] ?? (v as Record<string, string>).ELEMENT;
        if (id && this.#webIds.has(id)) return this.#webIds.get(id);
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unref(x)]));
      }
      return v;
    };
    try {
      if (route.startsWith('GET element/:id/attribute/') || route.startsWith('GET element/:id/property/')) {
        // Chromedriver: boolean attributes answer "true" or null; others the property when it exists, else the attribute
        const name = decodeURIComponent(rest[3] ?? '');
        const prop = route.includes('/property/');
        return send(200, await el().evaluate((e: Element, [n, p]: [string, boolean]) => {
          const BOOL = ['checked', 'selected', 'disabled', 'readonly', 'required', 'multiple', 'hidden'];
          const v = (e as unknown as Record<string, unknown>)[n];
          if (p) return v === undefined ? null : v;
          if (BOOL.includes(n)) return v === true || e.hasAttribute(n) ? 'true' : null;
          if (v !== undefined && v !== null && typeof v !== 'object' && typeof v !== 'function') return String(v);
          return e.getAttribute(n);
        }, [name, prop]));
      }
      switch (route) {
        case 'POST elements':
          return send(200, (await frame.$$(selector(String(body.using), String(body.value)))).map(ref));
        case 'POST element': {
          const h = await frame.$(selector(String(body.using), String(body.value)));
          return h ? send(200, ref(h)) : fail(404, 'no such element', `no such element: Unable to locate element: {"method":"${String(body.using)}","selector":"${String(body.value)}"}`);
        }
        case 'POST element/:id/elements':
          return send(200, (await el().$$(selector(String(body.using), String(body.value)))).map(ref));
        case 'POST element/:id/click':
          await el().click({ timeout: 5000 });
          return send(200, null);
        case 'POST element/:id/clear':
          await el().fill('');
          return send(200, null);
        case 'POST element/:id/value':
          await el().type(String(body.text ?? ((body.value as string[]) ?? []).join('')));
          return send(200, null);
        case 'GET element/:id/text':
          return send(200, await el().evaluate((e: HTMLElement) => (e.innerText ?? e.textContent ?? '').trim()));
        case 'GET element/:id/displayed':
          return send(200, await el().isVisible());
        case 'GET element/:id/enabled':
          return send(200, await el().isEnabled());
        case 'GET element/:id/selected':
          return send(200, await el().evaluate((e: HTMLInputElement & HTMLOptionElement) => !!(e.checked || e.selected)));
        case 'GET element/:id/name':
          return send(200, await el().evaluate((e: Element) => e.tagName.toLowerCase()));
        case 'GET element/:id/rect': {
          const b = await el().boundingBox();
          return send(200, b ? { x: b.x, y: b.y, width: b.width, height: b.height } : { x: 0, y: 0, width: 0, height: 0 });
        }
        case 'POST frame': {
          const id = body.id as unknown;
          if (id === null || id === undefined) ctx.frame = null;
          else {
            const h = unref(id) as Handle;
            const f = h && typeof h.contentFrame === 'function' ? await h.contentFrame() : null;
            if (!f) return fail(404, 'no such frame', 'no such frame');
            ctx.frame = f;
          }
          return send(200, null);
        }
        case 'POST frame/parent':
          ctx.frame = ctx.frame?.parentFrame() ?? null;
          if (ctx.frame === page.mainFrame()) ctx.frame = null;
          return send(200, null);
        case 'GET window/handles':
          return send(200, ['CDwindow-1']);
        case 'GET window':
          return send(200, 'CDwindow-1');
        case 'POST window':
          return String(body.handle) === 'CDwindow-1' ? send(200, null) : fail(404, 'no such window', 'no such window');
        case 'GET url':
          return send(200, page.url());
        case 'GET title':
          return send(200, await page.title());
        case 'GET source':
          return send(200, await frame.content());
        case 'GET screenshot':
          return send(200, (await page.screenshot()).toString('base64'));
        case 'POST execute/sync': {
          const args = unref(body.args ?? []) as unknown[];
          const v = await frame.evaluate(([src, a]: [string, unknown[]]) => new Function(src).apply(null, a), [String(body.script), args]);
          return send(200, v ?? null);
        }
        case 'POST timeouts':
          return send(200, null);
        default:
          return fail(404, 'unknown command', `The mock WebView does not implement ${route}`);
      }
    } catch (e) {
      const err = e as Error & { w3c?: string; status?: number };
      return fail(err.status ?? 500, err.w3c ?? 'javascript error', err.message.split('\n')[0]);
    }
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse) {
    if ((req.url ?? '').startsWith('/session')) this.requests.push(`${req.method} ${req.url}`);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const url = new URL(req.url ?? '/', 'http://x');
    this.log.push(`${req.method} ${url.pathname}`);
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ value }));
    };
    const fail = (status: number, error: string, message: string) => send(status, { error, message, stacktrace: '' });
    try {
      const p = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && url.pathname === '/status') return send(200, { ready: true, message: 'mock Appium (Vortex test fixture)', build: { version: '3.9.0-mock' } });
      // fixture control (not part of WebDriver): jump to a sample screen, e.g. to follow the recorder's mock phone
      if (req.method === 'POST' && url.pathname === '/mock/screen' && ['home', 'products', 'insights'].includes(body.screen)) {
        this.#go(body.screen);
        return send(200, { screen: this.screen });
      }
      // fixture control: simulate an app update that renames a resource-id (used to exercise step repair)
      if (req.method === 'POST' && url.pathname === '/mock/rename' && /^[\w.]+$/.test(String(body.from ?? '')) && /^[\w.]+$/.test(String(body.to ?? ''))) {
        this.renameId(String(body.from), String(body.to));
        return send(200, { renamed: Object.fromEntries(this.renamed) });
      }
      if (p[0] !== 'session') return fail(404, 'unknown command', `The requested resource could not be found: ${req.method} ${url.pathname}`);
      if (req.method === 'POST' && p.length === 1) {
        const caps = { ...(body.capabilities?.alwaysMatch ?? {}), ...((body.capabilities?.firstMatch ?? [])[0] ?? {}) } as Record<string, unknown>;
        const auto = String(caps['appium:automationName'] ?? '');
        if (String(caps.platformName ?? '').toLowerCase() !== 'android' || auto.toLowerCase() !== 'uiautomator2') {
          return fail(500, 'session not created', `Could not find a driver for automationName '${auto}' and platformName '${String(caps.platformName)}'. Have you installed a driver that supports those capabilities?`);
        }
        const udid = caps['appium:udid'] as string | undefined;
        if (udid && !this.devices.includes(udid)) return fail(500, 'session not created', `Device ${udid} was not in the list of connected devices`);
        const sessionId = randomUUID();
        this.sessions.set(sessionId, { caps });
        return send(200, { sessionId, capabilities: { ...caps, deviceName: udid ?? this.devices[0] } });
      }
      const sid = p[1];
      const rest = p.slice(2);
      if (!this.sessions.has(sid)) return fail(404, 'invalid session id', 'A session is either terminated or not started');
      if (req.method === 'POST' && rest.join('/') === 'appium/settings') {
        const session = this.sessions.get(sid)!;
        session.settings = { ...session.settings, ...(body.settings as Record<string, unknown>) };
        return send(200, null);
      }
      if (req.method === 'GET' && rest.join('/') === 'appium/settings') return send(200, this.sessions.get(sid)!.settings ?? {});
      const route = `${req.method} ${rest.map((x, i) => (rest[i - 1] === 'element' && i % 2 === 1 ? ':id' : x)).join('/')}`;
      const s = this.#load();
      const elId = (n: Node) => `${this.version}-${n.id}`;
      const node = (): Node => {
        const [v, i] = String(rest[1]).split('-').map(Number);
        if (v !== this.version || !s.nodes[i]) throw Object.assign(new Error('The element is not linked to the current page (the screen changed)'), { w3c: 'stale element reference', status: 404 });
        return s.nodes[i];
      };
      const notFound = (using: string, value: string) => fail(404, 'no such element', `An element could not be located on the page using the given search parameters (${using}=${value})`);
      const ctx = this.#ctx.get(sid) ?? { context: 'NATIVE_APP', frame: null };
      this.#ctx.set(sid, ctx);
      if (ctx.context === 'NATIVE_APP' && route.startsWith('GET element/:id/attribute/')) {
        const n=node(), name=decodeURIComponent(rest[3]);
        const attrs: Record<string,unknown>={displayed:n.rect.w>0&&n.rect.h>0,enabled:n.enabled,checked:n.checked,selected:n.selected,text:this.typed.get(n.id)??n.text,'resource-id':n.identifier,'content-desc':n.label,class:n.type};
        return send(200,attrs[name]===undefined?null:String(attrs[name]));
      }
      const webAvailable = this.screen === 'insights' && this.webviewDebuggable;
      if (route === 'GET contexts') return send(200, webAvailable ? ['NATIVE_APP', WEBVIEW_CONTEXT] : ['NATIVE_APP']);
      if (route === 'GET context') return send(200, ctx.context);
      if (route === 'POST context') {
        const name = String(body.name ?? '');
        if (name === 'NATIVE_APP') {
          Object.assign(ctx, { context: name, frame: null });
          return send(200, null);
        }
        if (name !== WEBVIEW_CONTEXT || !webAvailable) return fail(404, 'no such context', 'No such context found.');
        if (this.chromedriverError) return fail(500, 'unknown error', this.chromedriverError);
        await this.webPage();
        Object.assign(ctx, { context: name, frame: null });
        return send(200, null);
      }
      if (route === 'POST execute/sync' && String(body.script) === 'mobile: getContexts') {
        if (!webAvailable) return send(200, []);
        const page = await this.webPage();
        const B = WEBVIEW.nativeBounds;
        return send(200, [{
          proc: '@webview_devtools_remote_4242',
          webview: WEBVIEW_CONTEXT,
          info: { 'Android-Package': APP, Browser: 'Chrome/120.0.6099.230', 'Protocol-Version': '1.3' },
          pages: [{ id: 'page-1', type: 'page', url: page.url(), title: await page.title(), description: JSON.stringify({ attached: true, empty: false, screenX: B.x, screenY: B.y, visible: true, width: B.width, height: B.height }) }],
          webviewName: WEBVIEW_CONTEXT,
        }]);
      }
      if (ctx.context !== 'NATIVE_APP' && !(route === 'POST execute/sync' && String(body.script).startsWith('mobile: ')) && route !== 'DELETE ') {
        if (this.screen !== 'insights') return fail(500, 'unknown error', 'chrome not reachable: the WebView is gone (the screen changed)');
        return this.#web(route, rest, body, ctx, send, fail);
      }
      switch (route) {
        case 'DELETE ':
          this.sessions.delete(sid);
          return send(200, null);
        case 'POST elements':
          return send(200, this.find(body.using, body.value).map((n) => ({ [ELEMENT]: elId(n), ELEMENT: elId(n) })));
        case 'POST element': {
          const f = this.find(body.using, body.value);
          return f.length ? send(200, { [ELEMENT]: elId(f[0]), ELEMENT: elId(f[0]) }) : notFound(body.using, body.value);
        }
        case 'GET element/:id/rect': {
          const r = node().rect;
          return send(200, { x: r.x, y: r.y, width: r.w, height: r.h });
        }
        case 'GET element/:id/text': {
          const n = node();
          return send(200, this.typed.get(n.id) ?? n.text);
        }
        case 'GET element/:id/displayed':
          return send(200, node().rect.w > 0 && node().rect.h > 0);
        case 'GET element/:id/enabled':
          return send(200, node().enabled);
        case 'GET element/:id/selected':
          return send(200, node().selected);
        case 'GET element/:id/name':
          return send(200, node().type);
        case 'POST element/:id/click': {
          const n = node();
          if (!(this.screen === 'insights' && n.type !== 'android.webkit.WebView' && n.identifier === '' && (await this.#nativeTapAt(n.rect.x + n.rect.w / 2, n.rect.y + n.rect.h / 2)))) this.#tapNode(s.nodes, n);
          return send(200, null);
        }
        case 'POST element/:id/clear':
          this.typed.set(node().id, '');
          this.#cache.clear();
          return send(200, null);
        case 'POST element/:id/value':
          this.typed.set(node().id, String(body.text ?? (body.value ?? []).join('')));
          this.#cache.clear();
          return send(200, null);
        case 'GET source':
          return send(200, s.xml);
        case 'GET appium/device/current_activity':
          return send(200, ACTIVITIES[this.screen]);
        case 'GET appium/device/current_package':
          return send(200, APP);
        case 'GET appium/device/is_keyboard_shown':
          return send(200, false);
        case 'POST appium/device/hide_keyboard':
          return send(200, null);
        case 'GET screenshot':
          return send(200, (await this.#screenshot(s)).toString('base64'));
        case 'GET window/rect':
          return send(200, { x: 0, y: 0, width: 1080, height: 2400 });
        case 'POST timeouts':
          return send(200, null);
        case 'POST actions':
        case 'DELETE actions':
          return send(200, null);
        case 'POST execute/sync': {
          const script = String(body.script);
          const a = (body.args?.[0] ?? {}) as Record<string, unknown>;
          if (/^mobile: (click|longClick|doubleClick)Gesture$/.test(script)) {
            if (a.elementId) {
              const [v, i] = String(a.elementId).split('-').map(Number);
              if (v !== this.version) return fail(404, 'stale element reference', 'The element is not linked to the current page');
              if (script !== 'mobile: longClickGesture') this.#tapNode(s.nodes, s.nodes[i]);
            } else if (!(script !== 'mobile: longClickGesture' && (await this.#nativeTapAt(Number(a.x), Number(a.y))))) {
              const hit = this.#hit(s.nodes, Number(a.x), Number(a.y));
              if (hit && script !== 'mobile: longClickGesture') this.#tapNode(s.nodes, hit);
            }
            return send(200, null);
          }
          if (script === 'mobile: activateApp') {
            if (!this.appRunning) this.#go('home');
            this.appRunning = true;
            return send(200, null);
          }
          if (script === 'mobile: terminateApp') {
            this.appRunning = false;
            this.#go('home');
            return send(200, true);
          }
          if (script === 'mobile: pressKey') {
            if (Number(a.keycode) === 4 || Number(a.keycode) === 3) this.#go('home');
            return send(200, null);
          }
          if (script === 'mobile: dragGesture' || script === 'mobile: swipeGesture') return send(200, null);
          // UiAutomator2 execute methods used by Appium-Python-Client 5+ for current_activity / keyboard
          if (script === 'mobile: getCurrentActivity') return send(200, ACTIVITIES[this.screen]);
          if (script === 'mobile: getCurrentPackage') return send(200, APP);
          if (script === 'mobile: isKeyboardShown') return send(200, false);
          if (script === 'mobile: hideKeyboard') return send(200, null);
          if (script === 'mobile: deepLink') {
            this.#go(deepLinkScreen(String(a.url ?? '')));
            return send(200, null);
          }
          return fail(400, 'unsupported operation', `Unsupported execute method '${script}' in the mock`);
        }
        default:
          return fail(404, 'unknown command', `The mock does not implement ${route}`);
      }
    } catch (e) {
      const err = e as Error & { w3c?: string; status?: number };
      return fail(err.status ?? 500, err.w3c ?? 'unknown error', err.message);
    }
  }
}

// Standalone mode
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--port');
  const flag = (n: string) => process.argv.includes(n);
  const m = new MockAppium({ webviewDebuggable: !flag('--webview-not-debuggable'), chromedriverError: flag('--chromedriver-mismatch') ? "No Chromedriver found that can automate Chrome '120.0.6099'. You could also try to enable automated chromedrivers download as a possible workaround." : null });
  const port = await m.listen(i > 0 ? Number(process.argv[i + 1]) : 4790);
  console.log(`mock Appium (test fixture, not a real device) on http://127.0.0.1:${port}`);
}
