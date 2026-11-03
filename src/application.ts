import path from 'node:path';
import { existsSync as fsExists } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createAppiumHttp } from './appium/appium-client.ts';
import { locateAppium } from './appium/appium-locator.ts';
import { createProcessInspector } from './appium/process-inspector.ts';
import { ServerManager } from './appium/server-manager.ts';
import { createFileStateStore } from './appium/state-store.ts';
import { DeviceLeases } from './devices/device-lease.ts';
import { createDeviceManager, assertSerial } from './devices/device-manager.ts';
import { AppiumInspector } from './engines/appium/inspector.ts';
import { xpathLiteral } from './engines/appium/native-locators.ts';
import { webCandidates } from './engines/webview/web-locators.ts';
import { framePath, type DomSnapshot } from './engines/webview/dom.ts';
import { KEYCODES } from './engines/appium/python-codegen.ts';
import { PytestRunner } from './engines/appium/pytest-runner.ts';
import { detectPython } from './engines/appium/python-env.ts';
import { fromUiSteps, slug, type UiStep, type LocatorParts } from './model/recording.ts';
import { buildCase, caseDir, listProject, readManifest, readCaseRecording, saveCase, type CaseRef, type Mode } from './project/project.ts';
import type { Using } from './engines/appium/webdriver.ts';

export function problem(message: string, code = 'BAD_REQUEST', httpStatus = 400) {
  return Object.assign(new Error(message), { code, httpStatus });
}
export const assertPackage = (pkg: string) => {
  if (!/^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/.test(pkg)) throw problem('Enter a valid Android package, for example com.indiamart.m.');
  return pkg;
};
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
type NativeView = Awaited<ReturnType<AppiumInspector['source']>>;
type WebView = Awaited<ReturnType<AppiumInspector['webSwitch']>>;
type Snapshot = NativeView & { token: string; web: WebView | null; webMessage: string };
type Target = { using: Using; value: string; parts: LocatorParts; title: string; index?: number };
export class Application {
  readonly root: string;
  readonly outDir: string;
  readonly manager: ServerManager;
  readonly inspector: AppiumInspector;
  readonly leases = new DeviceLeases();
  readonly devices = createDeviceManager();
  readonly runner: PytestRunner;
  snapshot: Snapshot | null = null;
  steps: UiStep[] = [];
  serial: string | null = null;
  pkg = '';
  recordingId: string = randomUUID();
  recordedSize: {width:number;height:number} | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private pyCache: { at: number; env: Awaited<ReturnType<typeof detectPython>> } | null = null;
  constructor(root: string, outDir = path.join(root, 'generated'), stateDir = path.join(root, '.vortex')) {
    this.root = root; this.outDir = path.resolve(outDir);
    this.manager = new ServerManager({ store: createFileStateStore(stateDir), inspector: createProcessInspector(), http: createAppiumHttp(), locate: configured => locateAppium(configured || process.env.VORTEX_APPIUM_PATH || '', root), log: m => console.log('[appium]', m) });
    this.inspector = new AppiumInspector(this.manager, this.leases);
    this.runner = new PytestRunner({ manager: this.manager, leases: this.leases, runsDir: path.join(stateDir, 'runs'), python: () => this.python() });
  }
  async init() { await this.manager.init(); this.manager.startWatchdog(); }
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn); this.chain = next.catch(() => {}); return next;
  }
  async python() {
    if (!this.pyCache || Date.now() - this.pyCache.at > 30_000) this.pyCache = { at: Date.now(), env: await detectPython() };
    return this.pyCache.env;
  }
  async status() {
    return { name: 'Vortex Appium Inspector', version: '0.1.0-beta.1', server: await this.manager.status(), session: this.inspector.status(), serial: this.serial, pkg: this.pkg, steps: this.steps, screen: this.snapshot, active: this.runner.active(), history: this.runner.history(), project: listProject(this.outDir) };
  }
  async start(serial: string, pkg: string) {
    assertSerial(serial); assertPackage(pkg);
    if (this.runner.active().length) throw problem('A test is running. Wait for it or cancel it before starting inspection.', 'RUN_ACTIVE', 409);
    if (this.steps.length && (this.pkg !== pkg || (this.serial && this.serial !== serial))) throw problem('Save or clear this recording before switching the app or phone.', 'RECORDING_TARGET', 409);
    if (this.inspector.status().open && (this.serial !== serial || this.pkg !== pkg)) await this.inspector.stop();
    await this.inspector.start(serial, true);
    this.serial = serial; this.pkg = pkg;
    return this.capture(true);
  }
  async capture(autoWeb = true, preferredContext?: string) {
    // A failed refresh invalidates all old hit targets; no old screenshot may authorize an action.
    this.snapshot = null;
    const native = await this.inspector.source();
    let web: WebView | null = null;
    let webMessage = 'Native controls · ID, accessibility, text, XPath and coordinates';
    if (autoWeb && native.nodes.some(n => /WebView$/.test(n.className))) {
      const context = preferredContext ?? native.contexts?.find(c => c === `WEBVIEW_${this.pkg}` || c.startsWith(`WEBVIEW_${this.pkg}:`));
      if (context) {
        try { web = await this.inspector.webSwitch(context, { captureImage: false }); webMessage = 'WebView DOM connected · CSS and XPath available'; }
        catch (e) { webMessage = `DOM unavailable: ${(e as Error).message}. Use native controls or explicit coordinates.`; }
      } else webMessage = 'WebView detected. DOM is not exposed by this build; use native text, ID, XPath or explicit coordinates.';
    }
    this.snapshot = { ...native, token: randomUUID(), web, webMessage };
    if (native.width && native.height) this.recordedSize = {width:native.width,height:native.height};
    return this.snapshot;
  }
  requireScreen(token: unknown): Snapshot {
    if (!this.snapshot || token !== this.snapshot.token) throw problem('The screen changed. Refresh it and select the control again.', 'STALE_SCREEN', 409);
    return this.snapshot;
  }
  nativeTarget(index: number, screen: Snapshot): Target {
    const n = screen.nodes.find(n => n.index === index);
    if (!n) throw problem('Select a control on the current screen.');
    const fields = [ ['resourceId', 'id', 'id'], ['contentDesc', 'label', 'accessibility id'], ['text', 'text', '-android uiautomator'] ] as const;
    for (const [field, by, using] of fields) {
      if (field === 'text' && /EditText$/.test(n.className)) continue;
      const value = n[field]; if (!value) continue;
      const matches = screen.nodes.filter(x => x[field] === value);
      const i = matches.findIndex(x => x.index === index);
      const parts: LocatorParts = { by, value, ...(matches.length > 1 ? { index: i } : {}) };
      if (matches.length > 1) {
        const attr = by === 'id' ? 'resource-id' : by === 'label' ? 'content-desc' : 'text';
        return { using: 'xpath', value: `(//*[@${attr}=${xpathLiteral(value)}])[${i + 1}]`, parts, title: n.text || n.contentDesc || value };
      }
      return { using, value: by === 'text' ? `new UiSelector().text(${JSON.stringify(value)})` : value, parts, title: n.text || n.contentDesc || value };
    }
    // Unnamed EditText fields remain recordable through their native XPath.
    return { using: 'xpath', value: n.path, parts: { by: 'xpath', value: n.path }, title: n.className };
  }
  async inspect(body: Record<string, unknown>) {
    const screen = this.requireScreen(body.token);
    const index = Number(body.index);
    if (body.context === 'WEBVIEW') {
      if (!screen.web) throw problem('No WebView DOM is available.');
      const n = screen.web.nodes[index]; if (!n) throw problem('No such DOM control.');
      if (body.verify) return this.inspector.webLocators(index);
      const snap = screen.web as unknown as DomSnapshot;
      return { node: n, candidates: webCandidates(snap, n) };
    }
    if (!body.verify) return {...this.inspector.candidates(index),target:this.nativeTarget(index,screen)};
    const session = this.inspector.session(), previous = await session.currentContext();
    if (previous !== 'NATIVE_APP') await session.switchContext('NATIVE_APP');
    try {
      if (body.verify) return await this.inspector.locators(index);
      return this.inspector.candidates(index);
    } finally { if (previous !== 'NATIVE_APP') await session.switchContext(previous); }
  }
  async action(body: Record<string, unknown>) {
    const screen = this.requireScreen(body.token);
    const type = String(body.type);
    const args = { ...(body.args as Record<string, unknown> ?? {}) };
    const context = body.context === 'WEBVIEW' ? 'WEBVIEW' : 'NATIVE_APP';
    const session = this.inspector.session();
    const x = Number(body.x), y = Number(body.y);
    let target: Target | null = null;
    const coordinate = body.coordinate === true && type === 'tap';
    if (coordinate) {
      if (type !== 'tap') throw problem('Coordinates are supported for tapping. Choose a locator for typing and assertions.');
      if (![x,y].every(Number.isFinite) || x < 0 || y < 0 || x >= (screen.width ?? 0) || y >= (screen.height ?? 0)) throw problem('Tap coordinates are outside the screenshot.');
    } else if (['tap','type','assert','clear','wait_visible','wait_hidden','wait_enabled','scroll_to'].includes(type)) {
      if (context === 'WEBVIEW') {
        const web = screen.web; if (!web) throw problem('No WebView DOM. Select a native control instead.');
        const n = web.nodes[Number(body.index)]; if (!n) throw problem('Select a DOM control.');
        const candidates = webCandidates(web as unknown as DomSnapshot, n);
        const chosen = candidates.find(c => c.using === body.using && c.value === body.value) ?? candidates[0];
        const using = body.using === 'xpath' ? 'xpath' : body.using === 'css selector' ? 'css selector' : chosen?.using;
        const value = String(body.value || chosen?.value || '');
        if (!using || !value) throw problem('Select a CSS or XPath locator.');
        target = { using, value, parts: { by: using === 'xpath' ? 'xpath' : 'css', value, frames: n.frame >= 0 ? framePath(web as unknown as DomSnapshot, n.frame) : [] }, title: n.text || n.tag };
      } else {
        target = this.nativeTarget(Number(body.index), screen);
        if (type === 'assert' && args.assertion === 'count' && target.parts.index !== undefined) {
          const {index: _index,...parts}=target.parts;
          const attr=parts.by==='id'?'resource-id':parts.by==='label'?'content-desc':'text';
          target={...target,using:'xpath',value:`//*[@${attr}=${xpathLiteral(parts.value!)}]`,parts};
        }
      }
    }
    const preScreen = { width: screen.width ?? 0, height: screen.height ?? 0 };
    const began = Date.now();
    // Invalidate before the first command. A timeout after delivery must not be retried as another click.
    this.snapshot = null;
    let applied = false;
    try {
      if (context === 'WEBVIEW' && target) {
        const ctx = screen.web!.context;
        if (await session.currentContext() !== ctx) await session.switchContext(ctx);
        const { enterFrames } = await import('./engines/webview/web-locators.ts');
        await enterFrames(session, target.parts.frames ?? []);
      } else await this.inspector.webToNative();
      const ids = async () => target ? session.findElements(target.using, target.value) : [];
      const one = async () => { const found = await ids(); if (found.length !== 1) throw problem(`Locator matched ${found.length} controls. Choose a unique locator.`, 'NOT_UNIQUE', 409); return found[0]; };
      if (type === 'tap') {
        if (coordinate) await session.execute('mobile: clickGesture', { x, y });
        else await session.click(await one());
      } else if (type === 'type' || type === 'clear') {
        const el = await one(); await session.clear(el);
        if (type === 'type') await session.sendKeys(el, String(args.text ?? ''));
      } else if (type === 'press') {
        const key = String(args.key).toUpperCase(); if (!(key in KEYCODES)) throw problem('Unsupported hardware key.');
        await session.execute('mobile: pressKey', { keycode: KEYCODES[key] }); args.key = key;
      } else if (type === 'launch_app') await session.execute('mobile: activateApp', { appId: this.pkg });
      else if (type === 'close_app') await session.execute('mobile: terminateApp', { appId: this.pkg });
      else if (type === 'hide_keyboard') await session.execute('mobile: hideKeyboard');
      else if (type === 'swipe') {
        const direction = String(args.direction || 'up');
        if (!['up','down','left','right'].includes(direction)) throw problem('Invalid swipe direction.');
        const w = preScreen.width, h = preScreen.height, vertical = ['up','down'].includes(direction), positive = ['down','right'].includes(direction);
        const from = { x: vertical ? w * .5 : w * (positive ? .25 : .75), y: vertical ? h * (positive ? .25 : .75) : h * .5 };
        const to = { x: vertical ? w * .5 : w * (positive ? .75 : .25), y: vertical ? h * (positive ? .75 : .25) : h * .5 };
        args.from = from; args.to = to; args.duration = 400;
        await session.execute('mobile: swipeGesture', { left: Math.round(w*.15), top: Math.round(h*.2), width: Math.round(w*.7), height: Math.round(h*.6), direction, percent: .75 });
      } else if (type === 'sleep') { args.ms = Math.max(0, Math.min(30_000, Number(args.ms) || 1500)); await delay(Number(args.ms)); }
      else if (['assert','wait_visible','wait_hidden','wait_enabled'].includes(type)) {
        const kind = type === 'wait_visible' ? 'visible' : type === 'wait_hidden' ? 'hidden' : type === 'wait_enabled' ? 'enabled' : String(args.assertion || 'visible');
        const allowed = ['visible','hidden','enabled','disabled','text','contains','checked','unchecked','selected','unselected','count'];
        if (!allowed.includes(kind)) throw problem('Unsupported assertion.');
        if (kind === 'count' && (!Number.isInteger(Number(args.expected)) || Number(args.expected) < 0)) throw problem('Count must be a nonnegative integer.');
        let passed = false;
        const end = Date.now() + 10_000;
        while (!passed && Date.now() < end) {
          const found = await ids();
          if (kind === 'count') passed = found.length === Number(args.expected);
          else if (kind === 'hidden') passed = !found.length || (found.length === 1 && !await session.displayed(found[0]));
          else if (found.length === 1) {
            const el = found[0];
            if (kind === 'visible') passed = await session.displayed(el);
            else if (kind === 'text') passed = await session.text(el) === String(args.expected ?? '');
            else if (kind === 'contains') passed = (await session.text(el)).includes(String(args.expected ?? ''));
            else {
              const value=['enabled','disabled'].includes(kind)?await session.enabled(el):['checked','unchecked'].includes(kind)&&context!=='WEBVIEW'?await session.attribute(el,'checked')==='true':await session.selected(el);
              passed=value===!['disabled','unchecked','unselected'].includes(kind);
            }
          }
          if (!passed) await delay(200);
        }
        if (!passed) throw problem(`Assertion failed: expected ${kind}${args.expected !== undefined ? ' ' + args.expected : ''}.`, 'ASSERTION_FAILED', 422);
        if (type === 'assert') args.assertion = kind;
      } else if (type === 'scroll_to') {
        for (let i=0;i<=8;i++) {
          const found = await ids();
          if (found.length === 1 && await session.displayed(found[0])) break;
          if (i===8) throw problem('Control was not found after eight scrolls.', 'NOT_VISIBLE', 422);
          await session.execute('mobile: scrollGesture', { left: 0, top: Math.round(preScreen.height*.2), width: preScreen.width, height: Math.round(preScreen.height*.6), direction: 'down', percent: .7 });
        }
      } else throw problem(`Unsupported action: ${type}`);
      applied = true;
      const step: UiStep = { id: randomUUID(), type, title: target?.title || type.replaceAll('_',' '), context: target && context === 'WEBVIEW' ? 'WEBVIEW' : 'NATIVE_APP', target: target ? { kind: target.parts.by === 'id' ? 'testId' : target.parts.by, parts: target.parts } : coordinate ? { kind: 'coordinate' } : null, mode: coordinate ? 'coord' : 'name', pre: true, args, ...(coordinate ? {x,y} : {}) };
      if (context === 'WEBVIEW' && !coordinate && screen.web) step.webview = { testId: screen.web.native ? screen.nodes.find(n=>n.index===screen.web!.native!.index)?.resourceId || null : null, index: 0, count: screen.web.nativeWebViews.length, url: screen.web.url, title: screen.web.title };
      if (body.record !== false) this.steps.push(step);
      if (context === 'WEBVIEW') await session.switchFrame(null).catch(() => {});
      // One capture, no multi-second fixed settling loop. Tests synchronize with explicit assertions.
      const fresh = await this.capture(body.autoWeb !== false);
      return { screen: fresh, steps: this.steps, durationMs: Date.now()-began, applied: true };
    } catch (e) {
      throw Object.assign(e as Error, { applied, steps: this.steps, hint: applied ? 'The action completed and was recorded, but refresh failed. Refresh manually; do not repeat the action.' : 'The command failed. Refresh and inspect the phone before retrying; a device command may have been delivered.' });
    } finally { if (context === 'WEBVIEW') await session.switchFrame(null).catch(() => {}); }
  }
  build(body: Record<string, unknown>) {
    if (!this.steps.length) throw problem('Record at least one step before saving.');
    const name = String(body.name || 'recorded flow');
    const ref: CaseRef = { module: slug(String(body.module || 'general')), case: slug(name) };
    const size = this.recordedSize;
    const recording = fromUiSteps(this.steps, { id: this.recordingId, name, module: ref.module, appPackage: this.pkg, serial: this.serial, screen: size, version: '0.1.0-beta.1' });
    const mode: Mode = body.mode === 'pom' ? 'pom' : body.mode === 'both' ? 'both' : 'plain';
    const target = body.target === 'pom' ? 'pom' : 'plain';
    const built = buildCase(recording, ref, { frameworks: ['appium'], mode, target, size });
    if (built.issues.length) throw Object.assign(problem('Fix the recording before generation.', 'VALIDATION', 422), { issues: built.issues });
    return { ref, recording, mode, ...built };
  }
  save(body: Record<string, unknown>) {
    const built = this.build(body);
    const saved = saveCase(this.outDir, built.ref, { ...built, frameworks: ['appium'], assets: [], generator: 'vortex-appium-recorder 0.1.0-beta.1' });
    return { ...built, saved };
  }
  load(body: {module:unknown;case:unknown}) {
    if (this.runner.active().length) throw problem('Wait for the active replay before loading another test.','RUN_ACTIVE',409);
    const loaded=readCaseRecording(this.outDir,{module:String(body.module),case:String(body.case)});
    if (this.inspector.status().open && this.pkg!==loaded.recording.app.package) throw problem('Detach the current session before loading a different app.','RECORDING_TARGET',409);
    this.steps=loaded.steps;this.pkg=loaded.recording.app.package;this.recordingId=loaded.recording.id;this.recordedSize=loaded.recording.device.screen;
    return {steps:this.steps,name:loaded.recording.name,module:loaded.recording.module,pkg:this.pkg,mode:loaded.manifest?.mode||'plain'};
  }
  async run(body: {module:unknown;case:unknown}) {
    if (this.runner.active().length) throw problem('A test is already running.', 'RUN_ACTIVE', 409);
    if (!this.serial || !this.pkg) throw problem('Connect a phone and app first.');
    const ref = { module: String(body.module), case: String(body.case) };
    const dir = caseDir(this.outDir, ref), manifest = readManifest(dir);
    if (!manifest) throw problem('Save this test first.');
    const entries = Object.entries(manifest.files).filter(([,v]) => v.role === 'entry' && v.discoverable);
    if (Object.keys(manifest.files).some(p => fsExists(path.join(dir,p+'.vortex-new')))) throw problem('This case has edited files awaiting review. Resolve .vortex-new files before replay.', 'PENDING_REVIEW', 409);
    if (entries.length !== 1) throw problem('The saved test needs exactly one active entry file.');
    // The recorder session is explicitly handed off to pytest; the Appium server stays warm.
    this.snapshot = null;
    await this.inspector.stop();
    return this.runner.start({ testsDir: this.outDir, file: path.relative(this.outDir, path.join(dir, entries[0][0])), serial: this.serial, appPackage: this.pkg, timeoutMs: 15 * 60_000 });
  }
  async shutdown() {
    for (const run of this.runner.active()) { this.runner.cancel(run.id); await this.runner.wait(run.id); }
    await this.inspector.stop(); await this.manager.shutdown();
  }
}
