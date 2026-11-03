// Minimal W3C WebDriver client for Appium (UiAutomator2). No dependencies: Node's fetch only.
// Errors keep the W3C error name and Appium's message, and common setup problems get a plain-language hint.

export class WebDriverError extends Error {
  status: number;
  error: string;
  hint: string | null;
  constructor(status: number, error: string, message: string) {
    super(message);
    this.status = status;
    this.error = error;
    this.hint = hintFor(error, message);
  }
}

/** Plain-language next step for the setup failures people hit most. Never guesses a cause it cannot see. */
export function hintFor(error: string, message: string): string | null {
  const m = message.toLowerCase();
  if (m.includes('could not find a driver') || (m.includes('no driver') && m.includes('uiautomator2'))) return 'The UiAutomator2 driver is not installed in this Appium. Run: appium driver install uiautomator2';
  if (m.includes('not in the list of connected devices') || m.includes('could not find a connected android device')) return 'Appium cannot see the device. Check `adb devices` and that the serial matches.';
  if (m.includes('android_home') || m.includes('android_sdk_root')) return 'Appium needs ANDROID_HOME (or ANDROID_SDK_ROOT) set to your Android SDK folder before the server starts.';
  if (m.includes('unauthorized')) return 'Accept the USB debugging prompt on the phone.';
  if (error === 'invalid session id') return 'The Appium session has ended (closed, timed out or the server restarted). Start a new session.';
  if (m.includes('instrumentation process is not running') || m.includes('uiautomator2 server')) return 'The UiAutomator2 server on the phone stopped. Another automation tool may be using the device; close it and retry.';
  if (m.includes('no chromedriver found') || m.includes('chromedriver') && m.includes('version')) return 'No Chromedriver matches the WebView version on the phone. Set a matching Chromedriver in Server settings (executable or folder), see the WebView diagnostics for the version.';
  if (m.includes('webview_devtools_remote') || m.includes('failed to get sockets matching')) return 'The WebView exposes no debugging socket: WebView debugging is off for this app (usual in release builds) or the WebView is not open.';
  return null;
}

export type Using = 'id' | 'accessibility id' | '-android uiautomator' | 'xpath' | 'class name' | 'css selector';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

export interface Session {
  readonly id: string;
  readonly capabilities: Record<string, unknown>;
  findElements(using: Using, value: string): Promise<string[]>;
  rect(elementId: string): Promise<Rect>;
  attribute(elementId: string, name: string): Promise<string | null>;
  pageSource(): Promise<string>;
  screenshotPng(): Promise<Buffer>;
  contexts(): Promise<string[]>;
  windowRect(): Promise<Rect>;
  execute(script: string, args?: Record<string, unknown>): Promise<unknown>;
  /** execute/sync with positional arguments; element ids given as { element: id } become WebDriver element references. */
  executeArgs(script: string, args: unknown[]): Promise<unknown>;
  currentContext(): Promise<string>;
  switchContext(name: string): Promise<void>;
  /** null = top-level document; otherwise an element id of an <iframe>. */
  switchFrame(elementId: string | null): Promise<void>;
  windowHandles(): Promise<string[]>;
  currentWindow(): Promise<string>;
  switchWindow(handle: string): Promise<void>;
  url(): Promise<string>;
  title(): Promise<string>;
  click(elementId: string): Promise<void>;
  clear(elementId: string): Promise<void>;
  sendKeys(elementId: string, text: string): Promise<void>;
  text(elementId: string): Promise<string>;
  displayed(elementId: string): Promise<boolean>;
  enabled(elementId: string): Promise<boolean>;
  selected(elementId: string): Promise<boolean>;
  delete(): Promise<void>;
}

const toWire = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(toWire);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Object.keys(o).length === 1 && typeof o.element === 'string') return { [ELEMENT_KEY]: o.element, ELEMENT: o.element };
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, toWire(x)]));
  }
  return v;
};

export function createWebDriverClient(baseUrl: string, fetchFn: typeof fetch = fetch) {
  const base = baseUrl.replace(/\/+$/, '');

  async function call<T = unknown>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
    let r: Response;
    try {
      r = await fetchFn(base + path, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json; charset=utf-8' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const err = e as Error;
      if (err.name === 'TimeoutError') throw new WebDriverError(0, 'timeout', `${method} ${path} did not answer within ${Math.round(timeoutMs / 1000)} s`);
      throw new WebDriverError(0, 'connection refused', `Cannot reach Appium at ${base} (${err.message})`);
    }
    const text = await r.text();
    let j: { value?: unknown } = {};
    try {
      j = text ? (JSON.parse(text) as { value?: unknown }) : {};
    } catch {
      throw new WebDriverError(r.status, 'unknown error', `Unexpected non-JSON answer from Appium (HTTP ${r.status})`);
    }
    if (!r.ok) {
      const v = (j.value ?? {}) as { error?: string; message?: string };
      throw new WebDriverError(r.status, v.error ?? 'unknown error', (v.message ?? `HTTP ${r.status}`).split('\n')[0]);
    }
    return j.value as T;
  }

  return {
    status: () => call<{ ready?: boolean; build?: { version?: string } }>('GET', '/status', undefined, 5_000),

    async newSession(alwaysMatch: Record<string, unknown>, timeoutMs: number): Promise<Session> {
      const v = await call<{ sessionId: string; capabilities: Record<string, unknown> }>('POST', '/session', { capabilities: { alwaysMatch, firstMatch: [{}] } }, timeoutMs);
      if (!v?.sessionId) throw new WebDriverError(500, 'session not created', 'Appium did not return a session id');
      const sid = v.sessionId;
      const s = `/session/${encodeURIComponent(sid)}`;
      const el = (id: string) => `${s}/element/${encodeURIComponent(id)}`;
      return {
        id: sid,
        capabilities: v.capabilities ?? {},
        async findElements(using, value) {
          const list = await call<Record<string, string>[]>('POST', `${s}/elements`, { using, value });
          return (list ?? []).map((e) => e[ELEMENT_KEY] ?? e.ELEMENT).filter(Boolean);
        },
        rect: (id) => call<Rect>('GET', `${el(id)}/rect`),
        attribute: (id, name) => call<string | null>('GET', `${el(id)}/attribute/${encodeURIComponent(name)}`),
        pageSource: () => call<string>('GET', `${s}/source`),
        screenshotPng: async () => Buffer.from(await call<string>('GET', `${s}/screenshot`), 'base64'),
        contexts: () => call<string[]>('GET', `${s}/contexts`),
        windowRect: () => call<Rect>('GET', `${s}/window/rect`),
        execute: (script, args = {}) => call('POST', `${s}/execute/sync`, { script, args: [args] }),
        executeArgs: (script, args) => call('POST', `${s}/execute/sync`, { script, args: toWire(args) }),
        currentContext: () => call<string>('GET', `${s}/context`),
        switchContext: async (name) => {
          await call('POST', `${s}/context`, { name }, 120_000);
        },
        switchFrame: async (id) => {
          await call('POST', `${s}/frame`, { id: id === null ? null : { [ELEMENT_KEY]: id, ELEMENT: id } });
        },
        windowHandles: () => call<string[]>('GET', `${s}/window/handles`),
        currentWindow: () => call<string>('GET', `${s}/window`),
        switchWindow: async (handle) => {
          await call('POST', `${s}/window`, { handle, name: handle });
        },
        url: () => call<string>('GET', `${s}/url`),
        title: () => call<string>('GET', `${s}/title`),
        click: async (id) => {
          await call('POST', `${el(id)}/click`, {});
        },
        clear: async (id) => {
          await call('POST', `${el(id)}/clear`, {});
        },
        sendKeys: async (id, text) => {
          await call('POST', `${el(id)}/value`, { text, value: [...text] });
        },
        text: (id) => call<string>('GET', `${el(id)}/text`),
        displayed: (id) => call<boolean>('GET', `${el(id)}/displayed`),
        enabled: (id) => call<boolean>('GET', `${el(id)}/enabled`),
        selected: (id) => call<boolean>('GET', `${el(id)}/selected`),
        async delete() {
          try {
            await call('DELETE', s, undefined, 30_000);
          } catch (e) {
            if (!(e instanceof WebDriverError && (e.status === 404 || e.error === 'invalid session id'))) throw e;
          }
        },
      };
    },
  };
}

export interface CapabilityOptions {
  udid: string | null;
  newCommandTimeoutSec: number;
  /** Chromedriver for WebView contexts (Server settings). Vortex never enables automatic downloads. */
  chromedriverExecutable?: string | null;
  chromedriverExecutableDir?: string | null;
}

/** Capabilities for a UiAutomator2 session on the current screen: nothing is installed, reset or launched. */
export function uiautomator2Capabilities(o: CapabilityOptions): Record<string, unknown> {
  const caps: Record<string, unknown> = {
    platformName: 'Android',
    'appium:automationName': 'UiAutomator2',
    'appium:noReset': true,
    'appium:autoLaunch': false,
    'appium:newCommandTimeout': o.newCommandTimeoutSec,
    'appium:settings[disableIdLocatorAutocompletion]': true,
    'appium:settings[waitForIdleTimeout]': 0,
  };
  if (o.udid) caps['appium:udid'] = o.udid;
  if (o.chromedriverExecutable) caps['appium:chromedriverExecutable'] = o.chromedriverExecutable;
  else if (o.chromedriverExecutableDir) caps['appium:chromedriverExecutableDir'] = o.chromedriverExecutableDir;
  return caps;
}
