// Turns a failed "Attach session" into a cause and a next step.
// Every rule matches text Appium, the UiAutomator2 driver or adb actually print. When nothing matches the
// answer is null: the raw message is shown as it is, never a guess.

export interface SessionHint {
  code: string;
  cause: string;
  hint: string;
}

const RULES: { code: string; test: RegExp; cause: string; hint: string }[] = [
  {
    code: 'DRIVER_MISSING',
    test: /could not find a driver for automationName|no drivers? (?:have been|were) installed|driver .*uiautomator2.* (?:is )?not installed/i,
    cause: 'The UiAutomator2 driver is not installed for this Appium.',
    hint: 'Run: appium driver install uiautomator2   Then restart the Appium server and attach again.',
  },
  {
    code: 'ANDROID_SDK_MISSING',
    test: /neither ANDROID_HOME nor ANDROID_SDK_ROOT|ANDROID_HOME.*(?:not set|was not exported)|could not find 'adb(?:\.exe)?'|adb(?:\.exe)?['"]? is not recognized|spawn adb(?:\.exe)? ENOENT/i,
    cause: 'Appium cannot find the Android SDK (adb).',
    hint: 'Set ANDROID_HOME to your Android SDK folder (the one containing platform-tools), open a new terminal, and restart Appium. Run the setup check to confirm.',
  },
  {
    code: 'JAVA_MISSING',
    test: /JAVA_HOME|unable to (?:find|locate).*java|java(?:\.exe)?['"]? .*(?:not found|is not recognized)|apksigner.*(?:failed|not found)/i,
    cause: 'Java was not found or JAVA_HOME points to the wrong place.',
    hint: 'Install a JDK (17 or newer), set JAVA_HOME to it, open a new terminal, and restart Appium.',
  },
  {
    code: 'DEVICE_UNAUTHORIZED',
    test: /unauthorized/i,
    cause: 'The phone has not authorised this computer for USB debugging.',
    hint: 'Unlock the phone and accept the "Allow USB debugging" prompt (tick "Always allow"). If no prompt appears: revoke USB debugging authorisations in Developer options, then reconnect the cable.',
  },
  {
    code: 'DEVICE_NOT_FOUND',
    test: /could not find a connected android device|not in the list of connected devices|device .*(?:offline|not found)|no devices?\/emulators? found/i,
    cause: 'adb does not see the phone, or it is offline.',
    hint: 'Check the cable and USB mode (File transfer), run `adb devices`, and press ↻ next to the phone list. Use `adb kill-server` then `adb devices` if it stays offline.',
  },
  {
    code: 'INSTALL_BLOCKED',
    test: /INSTALL_FAILED_USER_RESTRICTED|install cancell?ed by user|INSTALL_FAILED_VERIFICATION_FAILURE|INSTALL_FAILED_INSUFFICIENT_STORAGE/i,
    cause: 'The phone refused to install the Appium helper apps.',
    hint: 'Keep the phone unlocked and approve the install prompt. On Xiaomi, Realme, Oppo and Vivo enable "Install via USB" (and "USB debugging (Security settings)") in Developer options. Free some storage if the phone is full.',
  },
  {
    code: 'INSTRUMENTATION_FAILED',
    test: /instrumentation process (?:cannot be initialized|is not running)|uiautomator2 server .*(?:is not running|failed to start|cannot be started)|socket hang up/i,
    cause: 'The UiAutomator2 helper on the phone did not start or was killed.',
    hint: 'Close other automation tools using this phone, exclude "Appium Settings" and "io.appium.uiautomator2.server" from battery optimisation, then attach again. If it persists: adb uninstall io.appium.uiautomator2.server and adb uninstall io.appium.uiautomator2.server.test, then attach (Appium reinstalls them).',
  },
  {
    code: 'PORT_BUSY_ON_DEVICE',
    test: /EADDRINUSE|address already in use|systemPort|port .*is (?:busy|already in use)/i,
    cause: 'Another automation session is already using this phone or its forwarding port.',
    hint: 'Close the other recorder, Appium Inspector or test run that controls this phone, then attach again.',
  },
  {
    code: 'CHROMEDRIVER_MISMATCH',
    test: /no chromedriver found that can automate chrome|chromedriver .*(?:only supports|version)|unable to automate chrome version/i,
    cause: 'The Chromedriver does not match the WebView (Chrome) version on the phone.',
    hint: 'Download the Chromedriver matching the WebView version shown in the message, set its path in Server & setup, then detach and attach.',
  },
  {
    code: 'SESSION_TIMEOUT',
    test: /did not answer within|timed? ?out/i,
    cause: 'Appium did not create the session in time.',
    hint: 'The first attach installs helper apps on the phone and can take a minute: keep the phone unlocked, approve any prompt, and attach again. If it repeats, open the Appium log in Server & setup.',
  },
];

export function explainSessionError(message: string): SessionHint | null {
  for (const r of RULES) if (r.test.test(message)) return { code: r.code, cause: r.cause, hint: r.hint };
  return null;
}
