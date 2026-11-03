# Vortex Appium Inspector — 0.1.0-beta.1

A separate Appium-only edition of Vortex for Android. Inspect a phone, record actions and assertions, generate Python pytest tests in Plain or Page Object Model format, save them, and replay them with live output and reports. This copy has no alternative automation engine, CLI daemon, or TypeScript test generator.

[Download the Windows beta ZIP](https://github.com/panigrahi-shubham/Vortex-Appium-Inspector/releases/tag/v0.1.0-beta.1) · [Architecture and beta limits](docs/ARCHITECTURE.md)

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
npm start
```

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

Auto WebView detects exposed Appium contexts and attempts DOM inspection. The context menu lets you inspect native controls or the connected DOM. DOM targets expose CSS and XPath candidates and frame paths. **Verify locators** checks candidates against the live device; unverified candidates are never labeled verified.

When an app does not expose a debuggable WebView, DOM access is unavailable. Native accessibility text, resource IDs, labels and XPath may still be exposed; choose **Coordinate tap** for a deliberate point tap when necessary. Coordinates are recorded in device pixels and are specific to that screen size. They are not an automatic retry after a failed click. The point readout also shows percentages for inspection.

A debug WebView can require a matching Chromedriver. Set its executable in **Server & setup**, then detach and reattach. Vortex does not download drivers or enable debugging in third-party apps. If multiple visible pages are ambiguous, automatic selection fails visibly rather than choosing an advertising page.

Native replay chooses ID, accessibility label, exact text, then XPath. Repeated values use their exact occurrence index; row reorder can invalidate that choice. Unnamed EditText inputs use their XPath, so typing does not depend on the text that will be replaced. Alternative native locator candidates are displayed for inspection; this beta's recorder uses the selected control's default locator.

## Saving and reports

Generated Python files, `recording.json`, and checksummed `vortex-manifest.json` are saved together. Plain and POM share the same recording model. In Both mode only Plain is discoverable by default, avoiding duplicate execution. Files edited by hand are preserved, with proposed replacements beside them as `.vortex-new`; replay is blocked until those conflicts are reviewed.

Live results appear in the UI. Detailed run artifacts, JUnit XML, failure captures and JSON results are under `.vortex/runs/`. Recent runs persist across restarts. Unsaved recordings live in memory: save before closing the recorder. Load a saved recording to continue editing it.

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

Tests cover native locator scoring, server ownership, browser recording/save/replay, generated Plain/POM execution through real pytest, stale-screen rejection, preserving edited files, release WebView fallback, and debug DOM inspection. The Appium endpoint and Android device in these tests are simulated; the DOM uses headless Chromium. This package has **not been validated on a physical device in this rebuild**. It is a beta fork, not a claim of production readiness.

The ZIP excludes dependencies, phones' captures, saved account tests, runtime state and credentials. Install prerequisites on the destination computer. Review `docs/ARCHITECTURE.md` for module boundaries and current limits.
