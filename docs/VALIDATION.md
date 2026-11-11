# V1.0.0 validation — 11 November 2026

The extracted v1.0.0 source was merged into the original `vortex-appium-recorder` project. Existing dependencies, generated tests and runtime state were preserved. Replaced source files were backed up locally; the extracted package and device artifacts are excluded from Git.

## Windows automated checks

- Node.js 24.15.0: `npm run typecheck` passed.
- `npm test` from the merged original folder: **92 passed, 0 failed, 0 skipped**.
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
