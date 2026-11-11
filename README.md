# Vortex Appium Inspector — 1.0.0

A separate Appium-only edition of Vortex for Android. Inspect a phone, record actions and assertions, generate Python pytest tests in Plain or Page Object Model format, save them, and replay them with live output and reports. This copy has no alternative automation engine, CLI daemon, or TypeScript test generator.

[Releases](https://github.com/panigrahi-shubham/Vortex-Appium-Inspector/releases) · [Architecture and limits](docs/ARCHITECTURE.md) · [Real-phone acceptance checklist](docs/ACCEPTANCE.md) · [Changelog](CHANGELOG.md)

## Validation status

1.0.0 is feature-complete and passes its automated suite (92 tests): unit tests, the real HTTP API with real processes, generated tests executed by real pytest, and the UI in a browser.

The full 92-test suite and typecheck pass on Windows. Those automated tests use a simulated phone and a stand-in for Appium. A separate physical-device smoke test uses a Moto G32 running Android 13, StockPilot B2B (`com.stockpilot.b2b`), Appium 3.9.0 and UiAutomator2 7.6.2. See [validation results and scope](docs/VALIDATION.md). The broader [real-phone acceptance checklist](docs/ACCEPTANCE.md) still applies to your own app and device.

## New in 1.0.0

**Locators that last**
- **Anchor locators**: a control with no id, label or text of its own (an unnamed input) is found from the label next to it, for example `//*[@text='Mobile number']/following::android.widget.EditText[1]`, instead of a fragile absolute XPath. Every anchor is checked against the captured screen before it is offered.
- **Stability scoring**: a value that changed between captures of the same screen (a counter, a timer) is ranked down; one that stayed the same is ranked up. Replays feed the ranking too: a locator a replay could not find is ranked down, one that keeps passing is ranked up. The reasons are in each locator's tooltip.
- **Repair a failed step**: when a replay cannot find a control, **Repair step N** shows the screen saved at the failure, outlines the controls that resemble the recorded one, and explains why. Choosing one updates the saved test. Nothing changes until you choose, and the screen (activity) at the failure is shown so a wrong-screen failure is not "repaired" by mistake.

**Page objects shared across tests**
- Tick **Share page objects across tests (POM)** and tests of the same app reuse and extend one set of page classes in `generated/_shared/pages/` instead of a private copy each. Names never change once given, so earlier tests keep working when a later test adds to a page.

**More steps**
- **Open link** (deep link), **Check screen** (the test waits for this activity) and **Checkpoint** (the test saves a screenshot here).
- **Edit a step's value** (text, expected value, wait, link, checkpoint name) with ✎, without recording it again.

**Appium server**
- **Base path** setting for servers under `/wd/hub`.
- **Automatic restart** (off by default): a Vortex-owned server that stops unexpectedly is started again, at most 3 attempts, never an external server, never after a manual stop.
- **Live status**: the page follows the server, the session and replays without reloading (server-sent events).

**Under the hood**
- `src/application.ts` is now a thin coordinator over six services in `src/services/`; `src/server.ts` is a route table; the simulated device moved to `src/simulator/`.
- GitHub Actions workflow (typecheck and tests on Linux and Windows) and an MIT `LICENSE`.

## Added in 0.2.0

**Appium server you can diagnose**
- A failed start shows Appium's own log in **Server & setup**, with the exit code and reason. The log has Refresh and Copy.
- **Setup check** (`npm run doctor`, or the button): Node, Appium, UiAutomator2 driver, Android SDK, adb, Java, Python packages, phone and port, each with the exact fix. Read-only: it installs and changes nothing.
- A busy port is no longer a dead end: an Appium already on the port offers **Connect**; another program on the port offers **Start on the next free port**.
- A slow or blocked process lookup on Windows is no longer reported as "Appium exited immediately", and a server whose ownership cannot be recorded is stopped instead of being left on the port.
- If `ANDROID_HOME` is missing but the SDK can be found, Vortex passes it to the Appium it starts and says so.
- Common attach failures (driver missing, phone not authorised, install blocked, helper app not starting, Chromedriver mismatch) are explained with a next step.
- **Restart** and **Disconnect** buttons; port, Appium path, timeouts and stop-on-exit are editable and validated.

**Faster locator finding**
- Selecting a control ranks its locators instantly from the captured screen, with no device round trip. Only the recommended locator is confirmed on the phone, in the background (one lookup).
- **Try a locator**: type an ID, text, XPath or `new UiSelector()…` and see the match count, the matching controls outlined on the screenshot and ready-to-paste Python, as you type.
- Click any listed locator to use it: the action and the generated test use the locator you chose.

**Faster script creation**
- **Quick record**: a click on the screenshot taps the phone and records the step. Click a text field, type, press Enter.
- **Page object for this screen**: one click generates a Python page class for every usable control on the screen. Repeated list rows become one method with a `row` argument.
- **Secret inputs**: the value is typed on the phone once and never saved; the test reads it from an environment variable. Ticked automatically for password fields.
- Long press and double tap; delete or reorder any step; keyboard shortcuts (press **?**).
- Unsaved recordings are autosaved and restored after a crash or restart.

Clone the source, or extract the release ZIP, before following setup:

```powershell
git clone https://github.com/panigrahi-shubham/Vortex-Appium-Inspector.git
cd Vortex-Appium-Inspector
```

## Quick start on Windows

Prerequisites: Node.js **24.15 or newer**, Python 3.9+, Java 17+, Android SDK platform-tools (`adb`) on PATH, and `ANDROID_HOME` pointing to the SDK. Enable USB debugging and authorize the computer on the unlocked phone.

```powershell
npm ci
npm install -g appium
appium driver install uiautomator2
py -3 -m pip install -r requirements-appium.txt
npm run doctor
npm start
```

`npm run doctor` lists anything still missing and how to fix it. The same check is in **Server & setup → Run setup check**.

Open **http://127.0.0.1:4701**. You can also double-click `START-VORTEX.cmd` after setup. Stop the recorder with Ctrl+C in its terminal.

1. Close other recorder/automation sessions controlling the phone.
2. Choose **Server & setup → Start Appium**. If you already started Appium yourself, choose **Connect existing** with its port instead. The default Appium port is 4723.
3. Choose the phone, enter its app package (for example `com.indiamart.m`), and **Attach session**. Attaching preserves app data and the current screen.
4. Click **Launch app**, then select controls on the screenshot or in the searchable tree. Selecting inspects; the **Tap**, **Fill input**, and **Assert** buttons perform actions. Fill replaces the current text.
5. Add explicit assertions after navigation or updates. Choose text equals, visibility, enabled state, checked state, selection, or count. Counts use all matching controls rather than a single indexed row.
6. Choose Plain pytest, POM, or Both. Preview and **Save test**. The output is in `generated/<module>/<test>/`.
7. **Run saved test** closes the Inspector session, starts pytest with its own session, and shows live output. Passed means pytest reported executed tests without failures, not merely that a process launched. Reattach when replay ends to inspect again.

Running a saved test repeats its actions and may change account or product data. The app asks before replay. Undo removes a recorded step; it does not undo phone actions. Clearing a recording does not remove saved files.

## WebViews and locator choices

Auto WebView detects exposed Appium contexts and attempts DOM inspection. The context menu lets you inspect native controls or the connected DOM. DOM targets expose CSS and XPath candidates and frame paths. **Verify all on phone** checks every candidate against the live device. A candidate reads "unique on this screen" (counted on the captured screen) until the phone has confirmed it; only then does it read "verified on phone".

When an app does not expose a debuggable WebView, DOM access is unavailable. Native accessibility text, resource IDs, labels and XPath may still be exposed; choose **Coordinate tap** for a deliberate point tap when necessary. Coordinates are recorded in device pixels and are specific to that screen size. They are not an automatic retry after a failed click. The point readout also shows percentages for inspection.

A debug WebView can require a matching Chromedriver. Set its executable in **Server & setup**, then detach and reattach. Vortex does not download drivers or enable debugging in third-party apps. If multiple visible pages are ambiguous, automatic selection fails visibly rather than choosing an advertising page.

Native replay chooses ID, accessibility label, exact text, then XPath. Repeated values use their exact occurrence index; row reorder can invalidate that choice. Unnamed EditText inputs use their XPath, so typing does not depend on the text that will be replaced. Click any listed native locator to use it for the next action; the generated test then uses that locator. A text locator is refused for Fill and Clear, because editing the field changes it.

## Saving and reports

Generated Python files, `recording.json`, and checksummed `vortex-manifest.json` are saved together. Plain and POM share the same recording model. In Both mode only Plain is discoverable by default, avoiding duplicate execution. Files edited by hand are preserved, with proposed replacements beside them as `.vortex-new`; replay is blocked until those conflicts are reviewed.

Live results appear in the UI. Detailed run artifacts, JUnit XML, failure captures and JSON results are under `.vortex/runs/`. Recent runs persist across restarts. An unsaved recording is autosaved to the state folder after every step and restored at the next start; Clear discards it. Load a saved recording to continue editing it.

With **Share page objects across tests**, POM page classes live in `generated/_shared/pages/<app>_pages/` and the library's contents in `generated/_shared/vortex-library.json`. Set `VORTEX_SHARED_PAGES` if you move a test away from the output folder.

Page objects from **Page object for this screen** are saved to `generated/screens/<name>_page.py`. An edited file is never overwritten: the new version is written beside it as `.vortex-new`.

Vortex only stops Appium processes whose saved process identity proves it started them. External servers can be disconnected, not killed. Device access and context changes are serialized; the app does not run an independent ADB hierarchy dumper while Appium owns the phone. A failed capture clears hit targets and requires refresh. An action followed by a failed capture remains recorded and is not automatically repeated.

## Options and standalone replay

```powershell
npm start -- --port 4702 --out generated --state-dir .vortex
# Preview using a simulated phone (does not control a real device):
npm start -- --mock
# Run a generated Plain test directly:
$env:ANDROID_UDID = "your-adb-serial"
$env:APPIUM_URL = "http://127.0.0.1:4723"
py -3 -m pytest generated/general/recorded-flow/appium/plain/test_general_recorded_flow.py
```

Set `VORTEX_PYTHON` to a particular python.exe or `VORTEX_APPIUM_PATH` to Appium's index.js if autodetection fails. Environment overrides also include `APP_PACKAGE`, `VORTEX_TIMEOUT`, `CHROMEDRIVER_EXECUTABLE` and `CHROMEDRIVER_DIR` for generated tests. Close the Inspector session before standalone pytest runs.

The UI uses port 4701 so this edition has its own address. Only one recorder should control a real phone at once. Another Vortex recorder may hold ownership port 4699; close that recorder before attaching this edition.

## Development and verification

```powershell
npm ci
py -3 -m pip install -r requirements-appium.txt
npx playwright install chromium
npm run typecheck
npm test
npm run package:windows
```

Tests cover native locator scoring, server ownership, browser recording/save/replay, generated Plain/POM execution through real pytest, stale-screen rejection, preserving edited files, release WebView fallback, and debug DOM inspection. Since 0.2.0 they also cover server start, log, restart, stop and busy-port recovery through the real HTTP API with real processes (using a stand-in for Appium), the setup check, offline locator ranking and search, chosen locators, secrets, autosave, page objects, and the new UI in a browser. The Appium endpoint and Android device in these tests are simulated; the DOM uses headless Chromium. 1.0.0 adds tests for anchors, stability, replay evidence, the full repair loop (fail, suggest, apply, pass) and the shared page library, each with real pytest runs. Separate physical-device validation is documented in [docs/VALIDATION.md](docs/VALIDATION.md).

The ZIP includes the two small runtime packages used for XPath search (`xpath`, `@xmldom/xmldom`) and excludes development dependencies, phones' captures, saved account tests, runtime state and credentials. Install prerequisites on the destination computer. Review `docs/ARCHITECTURE.md` for module boundaries and current limits.
