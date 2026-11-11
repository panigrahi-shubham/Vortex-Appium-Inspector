# Real-phone acceptance checklist

The automated suite uses a simulated phone and a stand-in for Appium. This checklist covers what it cannot:
a real Android phone, a real Appium server with the UiAutomator2 driver, and your operating system.
Use an app and an account whose data may change. Note the result of each item; an item that fails is a bug
to report with the text of the notice and the Appium log (Server & setup → Copy).

## 1. Setup

- [ ] `npm run doctor` shows no FAIL. Each WARN is understood.
- [ ] `npm start` opens http://127.0.0.1:4701 and the phone appears in the list.

## 2. Appium server

- [ ] **Start Appium** reaches RUNNING, shows a PID and version, and the log shows Appium's startup lines.
- [ ] Close Vortex with Ctrl+C and start it again: the server is stopped (default) or adopted (if "Stop the owned server when Vortex closes" is off).
- [ ] Start Appium yourself in another terminal on the same port, then press **Start Appium**: Vortex offers **Connect**, and after connecting, **Stop owned server** is refused.
- [ ] End the Vortex-owned Appium from Task Manager: the header shows it within a few seconds, with the exit reason. With automatic restart on, it comes back.
- [ ] Uninstall the driver (`appium driver uninstall uiautomator2`), attach: the notice explains the cause and the fix. Reinstall it.
- [ ] Windows only: the first Start does not report "Appium exited immediately" while Appium is in fact running.

## 3. Inspect

- [ ] **Attach session** shows the current screen without resetting the app.
- [ ] Selecting a control lists locators at once; the recommended one turns to "verified on phone" shortly after.
- [ ] **Verify all on phone** matches what you expect for at least three controls (unique, ambiguous, not found).
- [ ] **Try a locator** counts the same controls as Appium finds, for an id, a text and an XPath.
- [ ] An input without a resource-id gets an anchor locator, and a Fill through it types into the right field.
- [ ] A screen with a WebView: the context list offers the DOM, or the message explains why not.

## 4. Record and replay

- [ ] Record 10 steps including Tap, Fill, a secret Fill, Assert text, Swipe, Back and Check screen.
- [ ] **Quick record** taps the control you clicked, not a neighbour, at the top, middle and bottom of the screen.
- [ ] Save as Plain and replay: PASSED, and the app did what you recorded.
- [ ] Save as POM with shared page objects, record a second test on the same screens, replay both: both PASSED.
- [ ] Long press, double tap and Open link behave on the phone as they do in the simulator.
- [ ] Run the saved Plain test directly with pytest (README, "Options and standalone replay"): PASSED.

## 5. Failure handling

- [ ] Make a step fail on purpose (edit an id in `recording.json`, save again from **Load recording**): the replay is FAILED at that step, **Repair step N** shows the failure screen, the right control is among the suggestions, and after applying it the replay passes.
- [ ] Cancel a running replay: the phone is released and you can attach again.
- [ ] Unplug the phone during a replay: the run ends with a clear result, and after reconnecting you can attach.
- [ ] Close the terminal with 5 unsaved steps, start again: the steps are restored.

## 6. Timing (optional, for the "faster than Appium Inspector" claim)

Measure on the same phone and app, three times each, and keep the medians:

- [ ] Time from clicking a control to a verified recommended locator.
- [ ] Time from Attach to a saved, passing 10-step test.
- [ ] The same two measurements with the official Appium Inspector (the second includes writing the test by hand from its recorder output).
