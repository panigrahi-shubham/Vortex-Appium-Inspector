# V1.0.0 validation — 11 November 2026

The extracted v1.0.0 source was merged into the original `vortex-appium-recorder` project. Existing dependencies, generated tests and runtime state were preserved. Replaced source files were backed up locally; the extracted package and device artifacts are excluded from Git.

## Windows automated checks

- Node.js 24.15.0: `npm run typecheck` passed.
- `npm test` from the merged original folder, including the workspace UI additions and coordinate mapping fix: **99 passed, 0 failed, 0 skipped**.
- The suite includes browser recording/save/replay and repair, generated Plain/POM execution by pytest, and actual child-process/HTTP server lifecycle tests. The phone and Appium endpoints in this suite are simulated.
- Windows testing exposed and fixed loss of startup failure status/logs when a child exits during process-identity lookup. Regression checks cover the exit state, exit code and retained log path.
- Readiness polling now backs off on HTTP 503 while the server initializes. The restart test waits for both the running process and its completion notice.

## Physical-device smoke test

Environment: Windows, Moto G32, Android 13, StockPilot B2B (`com.stockpilot.b2b`), real Appium 3.9.0 and UiAutomator2 7.6.2, Python 3.14.4, pytest 8.4.2 and Appium-Python-Client 6.0.12. Vortex runs with mock mode disabled and targets the USB-connected phone explicitly.

The recorded 14-step flow activates the app, selects Home, checks the search control, opens Catalog, checks its title, fills `rice`, checks the input text, checks the activity, saves a checkpoint, clears the input, presses Back, returns Home, checks its search control and saves another checkpoint. The search locator was verified unique against the live phone.

StockPilot displays a conditional startup offer. Test setup activates the app, dismisses that offer when present and selects Home before each replay. These are prepared-state smoke tests, not proof of arbitrary cold-start handling. An earlier replay without that setup failed at the Catalog assertion and correctly saved failure artifacts showing the offer.

- Plain pytest: **passed**, 1 test, exit code 0; 12.5 seconds including session setup/cleanup (run `20261111T061818-c27202`).
- Shared-page POM pytest: **passed**, 1 test, exit code 0; 12.7 seconds including session setup/cleanup (run `20261111T061857-7fc2c0`).
- Both replays produced the Catalog/Home checkpoints and closed their Appium sessions successfully.

Generated account-specific tests, screenshots, JUnit results and run logs remain local under `generated/acceptance-20261111/` and `.vortex/acceptance-20261111/runs/`. They are not published to GitHub.

## Remaining scope

This smoke test does not complete every item in [ACCEPTANCE.md](ACCEPTANCE.md). Physical-device WebView DOM inspection, secret entry, locator repair, unplug/cancel recovery, deep links, long press/double tap, shared-library extension across multiple physical-device tests and performance comparisons were not exercised. Relevant automated scenarios use simulated devices. IndiaMART was launched, but the completed recording uses StockPilot B2B; no IndiaMART product mutation was tested.

## Inspect, copy, new file and tutorial follow-up

- Browser integration checks exercise explicit Inspect mode without phone actions, raw locator/Python/JSON copying, switching and deselecting locators, the Clipboard API denial fallback, stale-selection disabling, file-code copying, tutorial navigation and a narrow viewport.
- New-file tests verify on-disk creation, duplicate-name refusal, preservation of current steps after a rejected creation, and replacing the empty starter with newly recorded steps. Empty Plain/POM starters were executed by standalone pytest against an unreachable Appium URL: both skipped without opening a device session. Vortex itself blocks replay of an empty starter.
- A separate browser check against the running real-device session verified Inspect and all three element-copy actions on the Moto G32. The New file dialog was opened and cancelled, tutorial desktop/mobile layouts were inspected, no `/api/action` requests were sent, and the user's two recorded steps were preserved. Actual starter creation was tested in isolated test output, not against the user's current recording.
- Device screenshots and UI proof images remain local in `.vortex/ui-proof/` and are excluded from Git.

## Simple live inspection and IndiaMART follow-up

- Added an instant hover preview and a pinned selector/Python card with Text, ID/label and Point choices. Hover uses the captured hierarchy without API requests. Simple text/ID choices reuse the captured candidates; exact duplicate occurrences are represented with indexed XPath when needed. A delayed-inspection browser check confirms the initial suggestion appears before the server reply.
- Auto-refresh was tested with captures deliberately taking longer than its 2-second interval: requests did not overlap. Tests verify pausing for pinned selection, editing and Tutorial view; Resume live; stopping after capture failure; and disabling copying for stale targets.
- The locator list now scrolls to its top when a new control is selected. Point Python code, the selected screenshot position and the recorded coordinates are checked for agreement.
- The Moto G32 exposed an actual mapping mismatch: Appium's app window was 1080×2175, while its PNG screenshot was 1080×2400. Native capture now reads PNG dimensions first, using the full screenshot coordinate space for highlights, hit testing and point validation. A regression test covers taps below the smaller app-window height.
- A real IndiaMART browser check verified hover, text/point selection, Python copying and auto-refresh with the corrected 1080×2400 coordinate space, preserving the user's five recorded steps.
- A further real-device check used an unrecorded coordinate tap to open IndiaMART's Buy Leads tab, verified a native text selector inside the WebView as unique on the phone, and returned Home with another unrecorded point tap. Only `NATIVE_APP` was available and no DOM context was connected. The five recorded steps remained unchanged; no buyer contact action was executed.
- This implements a Maestro-style inspection experience through the existing Appium/Python stack. It does not add Maestro CLI execution or unlock unexposed WebView DOM content.
