// WebView diagnostics: why DOM inspection works or does not, with the evidence for each conclusion.
//
// Read-only checks through adb (no settings are changed, nothing is installed):
//   pidof <package>                      is the app running
//   cat /proc/net/unix                   which processes expose a DevTools socket (webview_devtools_remote_<pid>)
//   dumpsys package <package>            is the build debuggable (debug builds enable WebView debugging)
//   dumpsys webviewupdate                which WebView implementation and version the phone uses
// plus the native hierarchy (is there a WebView, or another engine such as GeckoView or Flutter) and, when an
// Appium session is open, its contexts and the last context-switch / DOM error.
//
// The CPU architecture (ABI) is never used as an explanation: no check here can show that it is the cause.

import type { Adb } from '../../devices/device-manager.ts';
import { assertSerial } from '../../devices/device-manager.ts';

export type WebViewCategory =
  | 'ok'
  | 'webview-debugging-disabled'
  | 'webview-not-active'
  | 'webview-not-detected'
  | 'incompatible-chromedriver'
  | 'incorrect-context'
  | 'unsupported-implementation'
  | 'missing-dom-access'
  | 'device-transport'
  | 'unknown';

export interface Evidence {
  check: string;
  ok: boolean | null;
  detail: string;
}

export interface WebViewDiagnosis {
  category: WebViewCategory;
  title: string;
  detail: string;
  nextSteps: string[];
  evidence: Evidence[];
  app: { package: string; pids: number[]; debuggable: boolean | null; versionName: string | null };
  sockets: { name: string; pid: number | null; owner: 'app' | 'chrome' | 'other' }[];
  webviewProvider: { package: string; version: string; major: number | null } | null;
  nativeWebViews: number;
  otherEngines: string[];
}

export interface AppiumWebViewInfo {
  contexts?: string[] | null;
  switchError?: string | null;
  domError?: string | null;
}

const OTHER_ENGINES: [RegExp, string][] = [
  [/org\.mozilla\.geckoview/i, 'GeckoView (Firefox engine)'],
  [/io\.flutter\./i, 'Flutter (draws its own UI; no DOM)'],
  [/com\.tencent\.smtt/i, 'Tencent X5 WebView'],
  [/org\.xwalk\./i, 'Crosswalk WebView'],
  [/com\.facebook\.react\.(?!.*WebView)/i, 'React Native view (not a WebView)'],
];

export function parseUnixSockets(out: string): { name: string; pid: number | null; owner: 'app' | 'chrome' | 'other' }[] {
  const seen = new Set<string>();
  const res: { name: string; pid: number | null; owner: 'app' | 'chrome' | 'other' }[] = [];
  for (const m of out.matchAll(/@([\w.]*devtools_remote(?:_(\d+))?)\b/g)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const pid = m[2] ? Number(m[2]) : null;
    res.push({ name: m[1], pid, owner: /^webview_devtools_remote_\d+$/.test(m[1]) ? 'app' : /^chrome_devtools_remote$/.test(m[1]) ? 'chrome' : 'other' });
  }
  return res;
}

export function parseWebViewProvider(out: string): WebViewDiagnosis['webviewProvider'] {
  const m = /Current WebView package \(name, version\):\s*\(([\w.]+),\s*([\d.]+)\)/.exec(out);
  if (!m) return null;
  const major = Number(m[2].split('.')[0]);
  return { package: m[1], version: m[2], major: Number.isFinite(major) ? major : null };
}

export function parsePackageInfo(out: string): { debuggable: boolean | null; versionName: string | null } {
  const flags = /\bflags=\[([^\]]*)\]/.exec(out);
  const v = /versionName=([^\s]+)/.exec(out);
  return { debuggable: flags ? /\bDEBUGGABLE\b/.test(flags[1]) : null, versionName: v ? v[1] : null };
}

export interface DiagnoseInput {
  serial: string;
  pkg: string;
  /** Class names of the native elements on screen. */
  nativeTypes: string[];
  appium?: AppiumWebViewInfo | null;
}

export async function diagnoseWebView(adb: Adb, i: DiagnoseInput): Promise<WebViewDiagnosis> {
  const serial = assertSerial(i.serial);
  if (!/^[A-Za-z0-9_.]+$/.test(i.pkg)) throw new Error(`invalid package name "${i.pkg}"`);
  const sh = (...a: string[]) => adb(['-s', serial, 'shell', ...a]);
  const evidence: Evidence[] = [];
  const nativeWebViews = i.nativeTypes.filter((t) => t === 'android.webkit.WebView').length;
  const otherEngines = [...new Set(i.nativeTypes.flatMap((t) => OTHER_ENGINES.filter(([re]) => re.test(t)).map(([, n]) => n)))];
  const base = { app: { package: i.pkg, pids: [] as number[], debuggable: null as boolean | null, versionName: null as string | null }, sockets: [] as WebViewDiagnosis['sockets'], webviewProvider: null as WebViewDiagnosis['webviewProvider'], nativeWebViews, otherEngines, evidence };
  const done = (category: WebViewCategory, title: string, detail: string, nextSteps: string[]): WebViewDiagnosis => ({ category, title, detail, nextSteps, ...base });

  let pidOut: string;
  try {
    // `|| true`: pidof exits 1 when the process is not running; that is an answer, not a failure
    pidOut = await sh('pidof', i.pkg, '||', 'true');
  } catch (e) {
    evidence.push({ check: 'adb shell pidof', ok: false, detail: (e as Error).message.split('\n')[0] });
    return done('device-transport', 'The phone did not answer over adb', 'Vortex could not run read-only adb commands on the phone, so nothing about the WebView can be checked.', ['Check the cable or Wi-Fi debugging and `adb devices`.', 'Accept the USB debugging prompt on the phone.']);
  }
  base.app.pids = pidOut.trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite);
  evidence.push({ check: `app process (${i.pkg})`, ok: base.app.pids.length > 0, detail: base.app.pids.length ? `running, pid ${base.app.pids.join(', ')}` : 'not running' });

  const [unix, pkgInfo, provider] = await Promise.all([
    sh('cat', '/proc/net/unix').catch((e: Error) => `ERROR ${e.message}`),
    sh('dumpsys', 'package', i.pkg).catch(() => ''),
    sh('dumpsys', 'webviewupdate').catch(() => ''),
  ]);
  const p = parsePackageInfo(pkgInfo);
  base.app.debuggable = p.debuggable;
  base.app.versionName = p.versionName;
  evidence.push({ check: 'build type', ok: null, detail: p.debuggable === null ? 'unknown (package flags not readable)' : p.debuggable ? 'debuggable build: WebView debugging is enabled automatically' : 'release (not debuggable): WebView debugging is on only if the app enables it in code' });
  base.webviewProvider = parseWebViewProvider(provider);
  evidence.push({ check: 'WebView implementation on the phone', ok: base.webviewProvider !== null, detail: base.webviewProvider ? `${base.webviewProvider.package} ${base.webviewProvider.version}` : 'not reported by dumpsys webviewupdate' });
  const unixReadable = !unix.startsWith('ERROR');
  base.sockets = unixReadable ? parseUnixSockets(unix) : [];
  const appSocket = base.sockets.find((s) => s.owner === 'app' && s.pid !== null && base.app.pids.includes(s.pid));
  evidence.push({ check: 'DevTools socket of the app', ok: unixReadable ? !!appSocket : null, detail: !unixReadable ? `could not read /proc/net/unix (${unix.slice(6, 120)})` : appSocket ? `@${appSocket.name}` : base.sockets.length ? `none for the app; other sockets: ${base.sockets.map((s) => '@' + s.name).join(', ')}` : 'no DevTools sockets on the phone' });
  evidence.push({ check: 'WebView in the native hierarchy', ok: nativeWebViews > 0, detail: nativeWebViews ? `${nativeWebViews} android.webkit.WebView element(s) on screen` : otherEngines.length ? `no android.webkit.WebView; found ${otherEngines.join(', ')}` : 'no android.webkit.WebView on screen' });
  if (i.appium) {
    if (i.appium.contexts) evidence.push({ check: 'Appium contexts', ok: i.appium.contexts.some((c) => c.startsWith('WEBVIEW')), detail: i.appium.contexts.join(', ') });
    if (i.appium.switchError) evidence.push({ check: 'switch to the WebView context', ok: false, detail: i.appium.switchError });
    if (i.appium.domError) evidence.push({ check: 'read the DOM', ok: false, detail: i.appium.domError });
  }

  if (!base.app.pids.length) return done('webview-not-active', 'The app is not running', `${i.pkg} has no running process, so it has no WebView to inspect.`, ['Open the app on the phone and go to the screen with web content, then run the diagnostics again.']);
  if (!nativeWebViews && otherEngines.length) {
    return done('unsupported-implementation', 'This screen does not use an Android WebView', `The screen is drawn by ${otherEngines.join(', ')}. Chromedriver and DevTools only work with Chromium-based WebViews, so there is no DOM to inspect here.`, ['Use the native hierarchy (accessibility) or the visual fallback for this screen.']);
  }
  if (!appSocket && unixReadable) {
    if (!nativeWebViews) return done('webview-not-detected', 'No WebView on this screen', 'The native hierarchy has no WebView and the app exposes no DevTools socket.', ['Go to the screen that shows web content and run the diagnostics again.', 'If the content is in Chrome (a Custom Tab), it belongs to Chrome, not to the app.']);
    if (p.debuggable === false) {
      return done('webview-debugging-disabled', 'WebView debugging is disabled in this build', 'A WebView is on screen, but the app exposes no DevTools socket. This is normal for release builds: the DOM can only be read when the app calls WebView.setWebContentsDebuggingEnabled(true) (or is a debuggable build). Vortex does not bypass this.', ['Ask for a debug or test build of the app, or one that enables WebView debugging.', 'Until then, use the native hierarchy or the visual fallback for this screen.', 'Release and debug builds can differ here: check the build you will test.']);
    }
    return done('webview-not-active', 'The WebView has no DevTools socket yet', 'A WebView is on screen and the build allows debugging, but no DevTools socket exists for the app yet (the WebView may still be starting, or it runs in a separate process).', ['Wait for the page to load and run the diagnostics again.', 'If it persists, check whether the WebView runs in another process of the app (android:process).']);
  }
  if (i.appium?.switchError) {
    const e = i.appium.switchError;
    if (/no chromedriver found|chromedriver.*(version|support)|session not created.*chrome version/i.test(e)) {
      const v = base.webviewProvider?.major;
      return done('incompatible-chromedriver', 'Chromedriver does not match the WebView', `Appium could not attach Chromedriver to the WebView. ${v ? `The phone's WebView is version ${base.webviewProvider!.version}, so Chromedriver ${v}.x is needed.` : 'The WebView version could not be read.'}`, [`Download Chromedriver ${v ?? '<WebView major version>'} and set it in Server settings (Chromedriver executable or folder).`, 'Vortex does not enable Appium automatic Chromedriver downloads (it needs an insecure server flag).']);
    }
    if (/no such context/i.test(e)) return done('incorrect-context', 'The WebView context name did not match', `Appium did not find the context that was requested (${e}).`, ['Refresh the context list and pick the WEBVIEW_ context of the app.']);
    return done('unknown', 'Switching to the WebView failed', e, ['See the Appium server log in the Server Manager.']);
  }
  if (i.appium?.contexts && !i.appium.contexts.some((c) => c.startsWith('WEBVIEW'))) {
    return done('incorrect-context', 'Appium lists no WebView context', 'The app exposes a DevTools socket, but Appium reports only NATIVE_APP. The page may be empty or not attached yet.', ['Refresh the contexts after the page has loaded.']);
  }
  if (i.appium?.domError) return done('missing-dom-access', 'The DOM could not be read', `Switching worked, but reading the page failed: ${i.appium.domError}`, ['Try another window (page) of the WebView, or reload the page.']);
  if (!unixReadable) return done('unknown', 'WebView debugging could not be checked', 'The phone did not allow reading /proc/net/unix, so the DevTools socket could not be checked.', ['Start an Appium session and refresh the contexts: a WEBVIEW_ context means debugging works.']);
  return done('ok', 'WebView debugging is available', `@${appSocket!.name} is open for ${i.pkg}${base.webviewProvider ? `; WebView ${base.webviewProvider.version}` : ''}.`, [i.appium?.contexts ? 'Switch to the WEBVIEW context to read the DOM.' : 'Start an Appium session to read the DOM.']);
}

/** adb answers for the simulated phone (--mock), so the panel can be tried; reported as simulated in the UI. */
export function mockAdb(screen: () => string): Adb {
  return async (args: string[]) => {
    const cmd = args.slice(3).join(' ');
    if (cmd.startsWith('pidof')) return '4242\n';
    if (cmd === 'cat /proc/net/unix') return `Num       RefCount Protocol Flags    Type St Inode Path\n0000000000000000: 00000002 00000000 00010000 0001 01 12345 @chrome_devtools_remote\n${screen() === 'insights' ? '0000000000000000: 00000002 00000000 00010000 0001 01 23456 @webview_devtools_remote_4242\n' : ''}`;
    if (cmd.startsWith('dumpsys package')) return 'Packages:\n  Package [com.yourname.tradehub]\n    versionName=1.0-demo\n    flags=[ DEBUGGABLE HAS_CODE ALLOW_CLEAR_USER_DATA ]\n';
    if (cmd === 'dumpsys webviewupdate') return 'Current WebView package (name, version): (com.google.android.webview, 120.0.6099.230)\n';
    return '';
  };
}
