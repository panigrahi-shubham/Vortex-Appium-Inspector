# Reliability Engine v2

This upgrade targets the current Appium inspector. The separate MobileWright repository, runtime and generated formats were not modified. This remains the Appium/Python edition; no second device owner or AI runtime is introduced.

## Recording and compatibility

The existing version-1 recording schema gains optional `reliability` evidence and settings. New actions capture before/after screen fingerprints, package/activity, context, screenshot geometry, timestamp, selected attributes and live locator match counts. Password/secret text is redacted. Accepted navigation suggestions are marked as snapshot-derived checks, not fabricated device verification. Version-0 UI arrays and older version-1 recordings still migrate through the existing utilities; historical evidence is not invented.

Stable unique IDs, accessibility labels and text precede anchored and absolute XPath. Element actions require one live target; explicit count and absence assertions retain their collection/absence semantics. Selected fallback values are checked during recording and replay. Native locators and WebView CSS/XPath remain separate. There is no automatic locator substitution, assertion removal or expected-value rewriting. Existing `both` tap records remain readable but no longer silently fall back to coordinates when the locator fails. Use an explicit point tap for that intent.

Navigation detection compares captured activity, context, URL and stable identifiers. New destination controls are proposed as checks; **Add navigation check** inserts an explicit assertion only after tester approval. Detection is evidence from captures, not proof of business success. Slow transitions or pages with identical identifier sets still need an explicit destination assertion.

## Python helpers and output

`src/engines/appium/python/reliability.py` is embedded by the existing Plain and POM generators. Exports run with Appium, Selenium and pytest alone.

- `reliable_find()` polls for one visible/enabled target and optionally stable bounds. Native element identities are included in stability checks. No unconditional waits are synthesized. Legacy explicitly recorded pauses remain available.
- `tap_element()` delivers one verified native element gesture or a WebView DOM click. It never retries a delivered tap as coordinates. Keyboard preparation is conditional, limited to native app controls, and configurable for keyboard-focused tests.
- `scroll_until_visible()` uses bounded attempts, a chosen or unambiguous native container, clipped viewport-relative gesture areas and repeated-source end detection. The central gesture area avoids sticky top/bottom bars. WebView scrolling uses an explicit container or the target's nearest overflow ancestor, with DOM offset end detection. DOM display alone does not pass scrolling: the target's center must be inside the viewport and ancestor overflow clipping. Multiple possible native containers require an explicit choice. A target is checked after the final gesture; absence and ambiguity fail. Explicit swipe events remain their original gestures.
- `recorded_step()` and `capture_failure()` retain step/title, failed locator, original error, context, package/activity, screenshot, hierarchy or DOM. Evidence collection errors are recorded independently. Failure evidence is collected before leaving a failing WebView/frame.
- `cleanup_session()` attempts both app termination and session deletion. Cleanup failures are recorded and do not mask an existing failure; cleanup failure after an otherwise passing test is raised.

Plain pytest and optional private/shared POM formats remain available. Shared page objects use per-driver reliability settings so one saved case cannot silently change another case's timeout/profile. Python compilation and AST policy checks run in memory before preview/export writes files; unavailable Python is a setup error, not a skipped validation.

## Playback scope

The recorder's **Playback scope** selects a saved checkpoint. Replay starts at step 1, executes assertions through that checkpoint, then returns before later steps. The runner explicitly labels the result partial and does not credit later locators with passing replay evidence. Checkpoint playback requires regenerated v2 Python; older saved code is refused until regenerated. Existing hand edits remain protected by `.vortex-new` review.

This is run-through-checkpoint playback, not session resume or replay starting in the middle. Launch/activate does not reset navigation or business data. Prepare the recorded start screen explicitly.

## Validation

Windows validation on 11 November 2026 used Node 24.15.0, Python 3.14.4 and the installed pytest 9.2.0. No AI runtime or API credentials were needed.

- Pre-change baseline: **99 passed, 0 failed, 0 skipped**.
- Full automated suite: **112 passed, 0 failed, 0 skipped** (`npm test`). It includes actual HTTP/process lifecycle checks, browser UI tests and generated pytest execution against simulated Appium endpoints.
- After the final WebView viewport/container refinements: **12 focused unit/integration regressions passed, 0 failed, 0 skipped**. Both Plain and POM Native → WebView → Native replay ran against real headless Chromium, including scrolling an initially clipped DOM target inside a nested overflow container. Fixture installation persists across page reloads; the scroll position is reset before replay so this proves the exported helper actually scrolls.
- Final collection-count compatibility regression: **1 integration test passed**, executing Plain and POM replay with both default and explicitly chosen duplicate-ID collection locators. Collection assertions remain valid; the same ambiguous locators remain rejected for element actions. The screen-page export regression also passed after compilation was added to that export path.
- The Python helper regression fixture contains **19 unittest cases**, executed inside the unit suite: delayed rendering, uniqueness, no coordinate retry after a failed delivered tap, keyboard preparation, native bounds/progress/end detection, clipped WebView targets, checkpoint scope, failure files and cleanup behavior. An additional generated-WebView test preserves the original error and DOM context when returning to Native also fails.
- `npm run typecheck`, `node --check public/app.js` and `git diff --check` passed. Python compilation and AST policy checks passed for all seven generated Python example files. These policy checks are not a complete Python type/API linter.
- Browser reliability settings, suggestion approval, explicit off-screen scroll target and checkpoint playback were exercised through the UI. Desktop and 390×844 mobile layouts were captured; the mobile page has no horizontal overflow. Checkpoint replay was required to report **PASSED** as well as its partial scope.

### Physical StockPilot acceptance

The attached Moto G32 (Android 13), Appium 3.9.0 and the existing UiAutomator2 driver were used. The full nine-step example includes the requested catalog flow plus a product-detail checkpoint. It checks `ghee`, the detail-screen SKU `SKU-10065`, and the required visible `Write a review` target.

- Standalone generated Plain pytest: **1 passed in 34.63 s**.
- Standalone generated POM pytest: **1 passed in 43.32 s**.
- Final recorder/API acceptance with the updated live server: **7 action/check operations passed**, including native semantic scrolling and the mandatory review assertion. Recording was paused; all **9 original steps were preserved**, and the phone returned to StockPilot Home. Saving the case then passed compilation/AST checks with **0 file conflicts**.

Preparation explicitly establishes Home and closes the known StockPilot promotion. The example's optional `home_precondition.py` wraps activation so its delayed promotion is handled after Launch too; it does not modify locators, expected values or mandatory assertions. Device usage reminders require separate handling. One subsequent Plain rerun stopped in this setup precondition when a usage reminder covered the app; it was a setup error, not a passing acceptance result.

Real-device failures during development exposed keyboard dismissal consuming the first catalog tap and scroll gestures beginning on the sticky purchase bar. The detail assertion caught the failed navigation; viewport clipping fixed the gesture area. Earlier failures retained step JSON, screenshot and hierarchy evidence. Missing-review and renamed-locator negative regressions remain hard failures; none skips the review assertion.

Real StockPilot checks used **NATIVE_APP** accessibility. Production WebView DOM was not exposed on this build; DOM execution was verified with Chromium fixtures, not a debug StockPilot build. Local phone screenshots, account state and logs remain in ignored `.vortex` directories and are excluded from the source distribution.

## Limits

Physical-device validation covers the attached Moto G32 only. DOM access still requires an exposed WebView debugging context and a compatible Chromedriver; native accessible text/IDs and deliberate coordinates remain usable when DOM is unavailable. Native source-progress detection can be affected by continuously changing content; the attempt limit still bounds scrolling. Virtualized lists, nested WebView overflow containers with absent targets, cross-origin frames and sticky overlays may need an explicit container or a different recorded gesture. A visible screenshot alone does not prove a server-side business operation succeeded.
