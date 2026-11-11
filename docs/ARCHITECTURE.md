# Appium-only architecture

`src/server.ts` serves a loopback-only UI and JSON API. Host/origin and JSON-content checks guard mutations. The listening port is acquired before recovering server state so a duplicate launch cannot disturb an existing recorder. API bodies are capped at 2 MB.

`src/application.ts` owns a serialized command queue, recording model, snapshot tokens, saved project operations, and the handoff between Inspector and pytest. `src/engines/appium/inspector.ts` owns one UiAutomator2 session for native hierarchy, screenshots, locator verification, and WebView contexts. All device actions use that session; ADB is used for device discovery only.

`src/appium/` manages Appium process ownership, health checks, settings, session cleanup and run registration. An external server is never stopped as though it were owned. `preflight.ts` is the read-only setup check, `android-env.ts` finds the Android SDK for the Appium child process, and `session-hints.ts` maps known attach failures to a cause and a next step (unknown failures stay unexplained). A host-wide ownership socket is acquired before real-phone inspection to prevent competing Vortex recorder instances.

`src/engines/webview/` captures DOM evidence, maps CSS coordinates to native WebView bounds, proposes CSS/XPath candidates, and selects visible windows safely. Native and DOM sources remain distinct. Missing debugging or Chromedriver errors surface as fallback messages; native inspection remains available.

`src/model/` defines versioned recordings, explicit assertions and page-object planning. `src/project/` generates Plain/POM files and safely updates only files whose checksums show they were not manually edited. `src/engines/appium/pytest-runner.ts` runs saved files inside the output directory, takes an exclusive device lease and records output, JUnit results and failure artifacts. The pytest plugin cleans up sessions opened by the run.

The recorder does one capture per successful action, with no multi-second idle polling loop. Generated tests use bounded waits and assertions. Selecting a native control uses cached hierarchy data; live verification is explicit because it can require several WebDriver round trips. Ambiguous native values are indexed rather than silently taking the first match. An unnamed input can use native XPath.

## Structure since 1.0.0

```
src/server.ts            route table, static files, server-sent events (/api/events)
src/application.ts       wires the services; one serial queue for everything that touches the phone
src/services/
  session-service.ts     attached phone and app, the current capture and its one-use token
  locator-service.ts     ranking (anchors, stability, replay evidence), verification, search, action target
  action-runner.ts       performs an action on the phone and records the step
  recording-store.ts     the steps, autosave, undo / delete / move / edit
  project-service.ts     generate, save, load, replay, shared page library, repair, screen page objects
  setup-service.ts       setup check, Python detection, Appium log
  locator-history.ts     what replays showed about each locator (<state-dir>/locator-history.json)
src/appium/              Appium process ownership, health, settings, setup check, attach hints
src/engines/appium/      UiAutomator2 session, locators, code generation, pytest runner
src/engines/webview/     WebView DOM inspection
src/project/             saved cases, manifests, shared page library on disk
src/simulator/           the simulated phone used by --mock and by the tests
```

- **Server states**: `starting → running ⇄ unhealthy → exited`, plus `stopping` during a requested stop and `unreachable` for an external server that stops answering. Only a server that was `running` or `unhealthy` is restarted automatically; one that dies while `starting` has a setup problem to fix first.
- **Live status** carries no data. The stream says "something changed" and the page reads `/api/status`. Every POST announces a change; a 2-second watcher catches changes nobody announced (a health check, a run that ends).
- **Anchor locators** (`anchor-locators.ts`) are generated only for controls without a unique id, label or text, and are kept only when the XPath selects exactly that control on the captured screen.
- **Stability** (`stability.ts`) changes a candidate's score and notes, never its status: "unique on this screen" still means counted on the capture, "verified" still means the phone confirmed it.
- **Repair** (`repair.ts`) reads the page source the pytest plugin saved at the failure. A suggestion needs a locator unique on that screen; a typing step is matched only to inputs. Applying a suggestion goes through the normal save path, so edited files are preserved as `.vortex-new`.
- **Shared page library** (`src/project/shared-library.ts`, `<out>/_shared/`): the library is append-only. Saving a test seeds the page registry with the names the library already has, so a new test can add locators and methods but never rename existing ones. Tests import the shared package through their `conftest.py`.

## Added in 0.2.0

- `src/engines/appium/native-locators.ts` ranks candidates offline (`rankOffline`) from the cached page source; `inspector.verifyOne` confirms a single candidate on the device. Offline results are labelled "unique on this screen", never "verified".
- `src/engines/appium/locator-search.ts` evaluates ID, text, class, UiSelector chains and XPath 1.0 against the cached page source (XPath through `xpath` and `@xmldom/xmldom`, the only runtime packages). Selectors it cannot evaluate are reported as device-only.
- `src/engines/appium/screen-page.ts` builds a page object from one captured screen. It never writes an absolute XPath; controls without a stable locator are listed as skipped.
- `Application.persist/restore` autosave the unsaved recording to `<state-dir>/autosave.json`. A secret step stores only its environment variable name, so the value is in no file.
- Every API error has one shape: `{ error, code, hint, details }`. `details.log` carries the Appium log tail on a failed start; `details.suggestedPort` the next free port.

## Current limits

- Android / UiAutomator2 only; Python pytest output only.
- One inspected phone and one active replay at a time. Single local operator; no multi-tab synchronization beyond rejecting stale snapshot tokens.
- WebView DOM requires a context exposed by the app and a compatible Chromedriver. Cross-origin frames and multiple ambiguous pages may require manual investigation outside the automatic path.
- Repair suggestions are ranked by resemblance (id words, visible text, kind of control). They are suggestions: the screenshot and the activity shown with them are how a wrong-screen failure is recognised. Repair is offered for replays started in the current recorder session.
- The shared page library is per app package and append-only: nothing is removed when a test is deleted. If you move a shared-page test out of the output folder, set `VORTEX_SHARED_PAGES`.
- Stability across captures needs at least three resource-ids on a screen to recognise it as "the same screen".
- Automatic restart is opt-in and applies only to servers Vortex started.
- A chosen native locator is stored as ID, label, text or XPath; UiSelector-only forms are converted to those. DOM selectors can be selected or entered explicitly.
- Locator search and instant ranking describe the captured screen. A count can differ on the device if the screen changed since the capture; refresh first.
- Page objects are generated from one capture and are not checked on the device. Row-addressed locators follow list order.
- Coordinate taps depend on the original screen size. They are deliberate actions, not blind fallback retries. Native repeated-value locators depend on occurrence order.
- App navigation is not inferred. Add explicit waits/assertions for the real destination and expected update result. Arbitrary animation or server-side timing is not proven by a screenshot.
- Unsaved recordings are autosaved, but a test must be saved before it can be replayed. Crash-interrupted pytest jobs may require inspecting `.vortex/runs/` and existing Appium sessions before resuming; automatic resumption is not implemented.
- The GitHub Actions workflow covers Linux and Windows; its remote result is separate from local validation.
- Typecheck and all 92 automated tests pass on Windows, including real PowerShell process lookup and process lifecycle checks. The double-click launcher was not separately exercised.
- Automated validation uses a simulated Appium device. Separate physical-device smoke results are in [VALIDATION.md](VALIDATION.md). Other devices, hardware/network performance and IndiaMART product mutations need separate acceptance testing.
