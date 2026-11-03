# Appium-only architecture

`src/server.ts` serves a loopback-only UI and JSON API. Host/origin and JSON-content checks guard mutations. The listening port is acquired before recovering server state so a duplicate launch cannot disturb an existing recorder. API bodies are capped at 2 MB.

`src/application.ts` owns a serialized command queue, recording model, snapshot tokens, saved project operations, and the handoff between Inspector and pytest. `src/engines/appium/inspector.ts` owns one UiAutomator2 session for native hierarchy, screenshots, locator verification, and WebView contexts. All device actions use that session; ADB is used for device discovery only.

`src/appium/` manages Appium process ownership, health checks, settings, session cleanup and run registration. An external server is never stopped as though it were owned. A host-wide ownership socket is acquired before real-phone inspection to prevent competing Vortex recorder instances.

`src/engines/webview/` captures DOM evidence, maps CSS coordinates to native WebView bounds, proposes CSS/XPath candidates, and selects visible windows safely. Native and DOM sources remain distinct. Missing debugging or Chromedriver errors surface as fallback messages; native inspection remains available.

`src/model/` defines versioned recordings, explicit assertions and page-object planning. `src/project/` generates Plain/POM files and safely updates only files whose checksums show they were not manually edited. `src/engines/appium/pytest-runner.ts` runs saved files inside the output directory, takes an exclusive device lease and records output, JUnit results and failure artifacts. The pytest plugin cleans up sessions opened by the run.

The recorder does one capture per successful action, with no multi-second idle polling loop. Generated tests use bounded waits and assertions. Selecting a native control uses cached hierarchy data; live verification is explicit because it can require several WebDriver round trips. Ambiguous native values are indexed rather than silently taking the first match. An unnamed input can use native XPath.

## Current beta limits

- Android / UiAutomator2 only; Python pytest output only.
- One inspected phone and one active replay at a time. Single local operator; no multi-tab synchronization beyond rejecting stale snapshot tokens.
- WebView DOM requires a context exposed by the app and a compatible Chromedriver. Cross-origin frames and multiple ambiguous pages may require manual investigation outside the automatic path.
- Native locator alternatives are shown and verified, but the recorder currently chooses its default ID/label/text/XPath. DOM selectors can be selected or entered explicitly.
- Coordinate taps depend on the original screen size. They are deliberate actions, not blind fallback retries. Native repeated-value locators depend on occurrence order.
- App navigation is not inferred. Add explicit waits/assertions for the real destination and expected update result. Arbitrary animation or server-side timing is not proven by a screenshot.
- Keep a test saved before shutdown; unsaved recordings are in memory. Crash-interrupted pytest jobs may require inspecting `.vortex/runs/` and existing Appium sessions before resuming; automatic resumption is not implemented.
- The automated validation uses a simulated Appium device. Hardware/network performance and IndiaMART product mutations need separate acceptance testing.
