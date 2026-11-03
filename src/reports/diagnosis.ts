// Failure diagnostics: turns a failed test's message (and what Vortex knows about the run) into a cause and a next step.
// Every rule matches text the frameworks actually print; when nothing matches, the answer is "unknown", not a guess.

export type FailureKind =
  | 'missing-secret'
  | 'assertion-mismatch'
  | 'count-mismatch'
  | 'element-not-found'
  | 'element-not-interactable'
  | 'webview'
  | 'wrong-screen'
  | 'app-left-foreground'
  | 'unsupported-command'
  | 'session-lost'
  | 'server-lost'
  | 'load-error'
  | 'run-timeout'
  | 'unknown';

export interface FailureDiagnosis {
  kind: FailureKind;
  title: string;
  hint: string;
  expected?: string;
  actual?: string;
}

export interface FailureInput {
  message: string;
  details?: string;
  category?: string | null;
  status?: string;
  /** Foreground package when the test failed (Appium plugin), and the app under test. */
  foregroundPackage?: string | null;
  appPackage?: string | null;
}

const D = (kind: FailureKind, title: string, hint: string, extra: Partial<FailureDiagnosis> = {}): FailureDiagnosis => ({ kind, title, hint, ...extra });

export function diagnoseFailure(f: FailureInput): FailureDiagnosis {
  // pytest tracebacks print the source of every frame, including Selenium's own error-mapping code (which contains
  // phrases such as "No such context found."). Only the error lines ("E   ...") of such a traceback are evidence.
  const d = f.details ?? '';
  const errorLines = d.split('\n').filter((l) => /^\s*E\s{2,}/.test(l)).map((l) => l.replace(/^\s*E\s+/, ''));
  const text = `${f.message}\n${errorLines.length ? errorLines.join('\n') : d}`;
  let m: RegExpExecArray | null;
  if (f.status === 'timeout') return D('run-timeout', 'The run exceeded its time limit', 'A step waited far longer than expected (or the app hung). Check the last lines of the log; raise the run timeout only if the flow is really that long.');
  if (f.category === 'server-lost') return D('server-lost', 'The Appium server went away during the run', 'Check the Server Manager log. If another tool stopped the server, use a Vortex-owned server or keep it warm.');
  if (f.category === 'import-or-syntax') return D('load-error', 'The test file could not be loaded', 'A syntax error or a missing package: no step ran. If you edited the file, compare it with the .vortex-new version; otherwise run the install command for the framework.');
  if ((m = /Set the (VORTEX_SECRET_[A-Z0-9_]+) environment variable/.exec(text))) return D('missing-secret', `The secret ${m[1]} is not set`, `Set ${m[1]} in the environment that starts Vortex (or your CI) and run again. Vortex never stores the value.`);
  if (f.foregroundPackage && f.appPackage && f.foregroundPackage !== f.appPackage) {
    return D('app-left-foreground', `The app was not in the foreground (${f.foregroundPackage} was)`, 'The app crashed, was closed, or another app opened (a permission dialog, a browser for a link). Check the failure screenshot and the device log.');
  }
  if ((m = /expected screen (\S+), but the foreground activity is (\S+)/.exec(text))) return D('wrong-screen', 'A different screen was open', 'An earlier step did not lead where it did while recording (or the app changed). Check the screenshot; re-record the step if the navigation changed.', { expected: m[1], actual: m[2] });
  if (/no WebView context|chrome not reachable|No Chromedriver|webview_devtools_remote|no such context/i.test(text)) return D('webview', 'The WebView could not be reached', 'Run the WebView diagnostics on this screen: debugging may be off in this build, or Chromedriver may not match the WebView version.');
  if (/UnknownMethodException|unknown method|Unsupported execute method|unknown command|not (?:yet )?implemented/i.test(text)) return D('unsupported-command', 'The Appium driver does not support a command this test uses', 'Check the Appium driver (UiAutomator2) version on the Appium server: the command in the error is missing there. Update the driver, or remove the step.');
  if (/invalid session id|session is either terminated|not in the list of connected devices|device .*offline|instrumentation process is not running/i.test(text)) return D('session-lost', 'The Appium session or the device connection was lost', 'Check the cable or Wi-Fi debugging and the Appium log, then run again.');
  if ((m = /expected (\d+) elements for .*?, found (\d+)/.exec(text)) || (m = /Expected element count to be (\d+), but got (\d+)/.exec(text))) {
    return D('count-mismatch', `Expected ${m[1]} elements, found ${m[2]}`, 'The list changed (data differs from the recording) or the screen was not fully loaded. Use a check that does not depend on the data, or wait for the list first.', { expected: m[1], actual: m[2] });
  }
  // Assertion messages from imported reports.
  if (/Expected element (?:to have (?:text|value) .*|to be empty), but no matching element was found/.test(text)) return D('element-not-found', 'An element did not appear', 'Open the Inspector on this screen. If the locator matches nothing now, the app changed: re-record the step. If it appears later, the screen is slow: add a wait step or raise the timeout.');
  if ((m = /Expected element to have (?:text|value) "(.*?)", but got "(.*?)"(?:\n|$)/m.exec(text))) return D('assertion-mismatch', 'A check found a different value', 'If the new value is correct, update the expected value in the test (or the data file); if it looks dynamic, check "contains" or visibility instead.', { expected: m[1], actual: m[2] });
  if ((m = /Expected element to be (\w+), but it was not/.exec(text))) {
    if (m[1] === 'visible') return D('element-not-found', 'An element did not appear', 'Open the Inspector on this screen. If the locator matches nothing now, the app changed: re-record the step. If it appears later, the screen is slow: add a wait step or raise the timeout.');
    if (m[1] === 'enabled') return D('element-not-interactable', 'The element stayed disabled', 'A form value or an earlier step that enables it may differ from the recording. Check the screenshot.');
    return D('assertion-mismatch', `The element was not ${m[1]}`, 'The element state differs from the recording. Check the screenshot; if the new state is correct, update the check.', { expected: m[1], actual: `not ${m[1]}` });
  }
  if ((m = /expected text '(.*?)', got '(.*?)'(?: \(\(|\s*$|\n)/m.exec(text)) || (m = /assert '(.*)' == '(.*)'/.exec(text))) {
    const [exp, act] = /assert '/.test(m[0]) ? [m[2], m[1]] : [m[1], m[2]];
    return D('assertion-mismatch', 'A check found a different value', 'If the new value is correct, update the expected value in the test (or the data file); if it looks dynamic, check "contains" or visibility instead.', { expected: exp, actual: act });
  }
  if ((m = /Expected:?\s*"?([^"\n]*)"?\s*\n\s*Received:?\s*"?([^"\n]*)"?/i.exec(text)) || /toHaveText|toContainText|Expected toHaveText/.test(text)) {
    return D('assertion-mismatch', 'A check found a different value', 'If the new value is correct, update the expected value in the test (or the data file); if it looks dynamic, check "contains" or visibility instead.', m && m[1] !== undefined ? { expected: m[1], actual: m[2] } : {});
  }
  if (/not clickable|element not interactable|click intercepted|is not enabled|toBeEnabled/i.test(text)) return D('element-not-interactable', 'The element was there but could not be used', 'Something covered it (a dialog, the keyboard) or it was disabled. Check the screenshot; add a wait for the covering element to disappear.');
  if (/not visible: \(|NoSuchElement|no such element|Unable to locate element|waiting for .*to be visible|toBeVisible|not found|did not resolve|Timed out .*waiting/i.test(text)) {
    return D('element-not-found', 'An element did not appear', 'Open the Inspector on this screen. If the locator matches nothing now, the app changed: re-record the step. If it appears later, the screen is slow: add a wait step or raise VORTEX_TIMEOUT.');
  }
  return D('unknown', 'The cause could not be determined automatically', 'Read the error details and the screenshot; the failing step shows where it stopped.');
}
