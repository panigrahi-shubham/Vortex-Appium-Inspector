# Changelog

## Unreleased

- Added: simple inspection with visible Text, ID/label and Point choices, Python previews, and instant hover suggestions from the captured hierarchy.
- Added: optional auto-refresh (2 or 5 seconds), pausing for pinned selections, editing, dialogs and hidden Inspector tabs; Resume live and stop-on-capture-failure behavior.
- Fixed: locator lists return to the top after selecting another control, keeping recommended text/ID candidates visible.
- Fixed: native screenshot dimensions now define the coordinate space. On the Moto G32 the app window was 1080×2175 while the screenshot was 1080×2400, shifting highlights and point taps. Display, bounds and recorded coordinate validation now use full screenshot pixels.

- Added: explicit Inspect element mode and clipboard actions for the selected locator, Python lookup, element details and generated file code.
- Added: New file dialog and `POST /api/new`, creating real Plain/POM starter files without overwriting an existing test. Failed creation preserves current recorded steps.
- Added: Tutorial tab explaining setup, inspection, copying, file creation, recording, saving, replay and troubleshooting, with buttons to find each control.
- Fixed: new/cleared recordings and subsequent actions no longer display a stale generated preview; refreshed screens disable copy actions for the old selection.
- Empty starters are blocked from replay in Vortex and skipped in standalone pytest without starting a device session.

## 1.0.0

Locators
- Added: anchor-based locators for controls without an id, label or text of their own; used by default instead of the absolute XPath, and by whole-screen page objects.
- Added: stability scoring from repeated captures of the same screen, and from replay results (`<state-dir>/locator-history.json`).
- Added: repair of a failed step from the screen saved at the failure, with the screenshot, the activity and the reasons for each suggestion.

Recording and generation
- Added: shared page library for POM tests (`<out>/_shared/`), append-only so earlier tests keep working.
- Added: Open link (deep link), Check screen (activity) and Checkpoint steps in the UI.
- Added: edit the value of a recorded step.

Appium server
- Added: base path setting (for example `/wd/hub`); opt-in automatic restart of an owned server (3 attempts, backoff).
- Added: live status through server-sent events (`GET /api/events`).

Architecture
- Changed: `src/application.ts` split into services under `src/services/`; `src/server.ts` is a route table; the simulated device moved from `test/fixtures/` to `src/simulator/`, so `--mock` no longer loads test code.
- Added: GitHub Actions workflow (not yet run), MIT `LICENSE`, `docs/ACCEPTANCE.md`.
- Tests: 62 unit and 30 integration tests, 92 in total.

Windows integration fixes
- Fixed: a child exiting during the Windows process-identity lookup now retains the failed server state, exit code and startup log.
- Fixed: integration-test readiness polling now waits after HTTP 503 responses during state recovery; automatic-restart tests wait for the completion notice as well as the running process.
- Verified: typecheck and all 92 automated tests on Windows. Physical-device smoke results and remaining acceptance scope are in `docs/VALIDATION.md`.

## 0.2.0-beta.1

Appium server
- Fixed: a failed start showed "See the log below" with no log. The API now returns the Appium log tail and the UI shows it, with the exit code and reason.
- Fixed: on Windows a slow or blocked process lookup was reported as "Appium exited immediately" while Appium kept running without an ownership record. Vortex now waits longer, and if the lookup never works it stops the process it spawned and says why (`IDENTITY_UNAVAILABLE`).
- Added: setup check (`npm run doctor`, `GET /api/preflight`, button in Server & setup). Read-only.
- Added: busy-port recovery. `PORT_HAS_EXTERNAL_APPIUM` offers Connect; `PORT_IN_USE` names the next free port and offers to start there.
- Added: `GET /api/server/logs`, `POST /api/server/restart`, `POST /api/server/disconnect`; log viewer with Refresh and Copy; server state, PID, version, exit reason and notices in the UI.
- Added: port, Appium path, timeouts and stop-on-exit are editable. The Appium path is validated when saved.
- Added: a detected Android SDK is passed to the Appium child process when `ANDROID_HOME` is missing.
- Added: known attach failures are explained with a cause and a next step.
- Changed: every API error has the shape `{ error, code, hint, details }`.

Locators
- Changed: selecting a control ranks its locators offline; only the recommended one is confirmed on the phone (one lookup, in the background). "Verify all on phone" keeps the full check.
- Added: live locator search (ID, text, contains, class, XPath, UiSelector) against the captured screen, with matches outlined on the screenshot.
- Added: choose any listed native locator for the next action; the generated test uses it.

Recording and generation
- Added: Quick record (a click taps and records), long press, double tap, keyboard shortcuts.
- Added: whole-screen page object generation, saved under `<out>/screens/`.
- Added: secret inputs stored as an environment variable name only.
- Added: delete and reorder steps; autosave and restore of the unsaved recording.

Project
- Changed: package name `vortex-appium-inspector`; `xpath` and `@xmldom/xmldom` are now runtime dependencies (used by XPath search).
- Changed: `public/app.js`, `style.css` and `index.html` are formatted and commented.
- Tests: 49 unit and 21 integration tests, 70 in total (was 35 and 5).

Not verified
- A physical phone, a real Appium server with the UiAutomator2 driver, and Windows. See README and docs/ARCHITECTURE.md.

## 0.1.0-beta.1

Initial Appium-only edition.
