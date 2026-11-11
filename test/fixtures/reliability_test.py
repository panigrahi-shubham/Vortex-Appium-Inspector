"""Execute the actual exported helpers against deterministic driver behavior."""
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
TIMEOUT = 0.05
APP_PACKAGE = "com.stockpilot.b2b"
exec(compile((ROOT / "src/engines/appium/python/reliability.py").read_text(encoding="utf-8"), "reliability.py", "exec"))


class Element:
    id = "target"
    rect = {"x": 50, "y": 50, "width": 100, "height": 40}
    def is_displayed(self): return True
    def is_enabled(self): return True
    def click(self): self.clicked = True
    def get_attribute(self, name): return APP_PACKAGE if name == "package" else None


class Driver:
    current_context = "NATIVE_APP"
    current_package = "com.stockpilot.b2b"
    current_activity = ".MainActivity"
    page_source = "<hierarchy/>"
    def __init__(self):
        self.elements, self.gestures, self.lookups = [], [], 0
        self.scroll_result = False
    def find_elements(self, by, value):
        self.lookups += 1
        if "scrollable(true)" in value: return []
        return self.elements
    def get_window_size(self): return {"width": 1080, "height": 2400}
    def execute_script(self, script, *args):
        self.gestures.append((script, args))
        return self.scroll_result
    def get_screenshot_as_file(self, file):
        Path(file).write_bytes(b"screenshot")
        return True
    def terminate_app(self, package): pass
    def quit(self): pass
    def is_keyboard_shown(self): return False


class ReliabilityTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"VORTEX_STABLE_MS": "0", "VORTEX_STOP_AFTER_STEP": "0"})
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_duplicates_fail_without_acting(self):
        d = Driver(); d.elements = [Element(), Element()]
        with self.assertRaisesRegex(AssertionError, "not unique"):
            reliable_find(d, ("id", "product"))
        self.assertEqual(d.gestures, [])

    def test_missing_tap_target_never_uses_coordinates(self):
        d = Driver()
        with self.assertRaises(TimeoutException): tap_element(d, ("id", "missing"))
        self.assertEqual(d.gestures, [])

    def test_delivered_tap_error_is_not_retried(self):
        d = Driver(); d.elements = [Element()]
        def broken(script, *args):
            d.gestures.append((script, args))
            raise RuntimeError("delivered tap failed")
        d.execute_script = broken
        with self.assertRaisesRegex(RuntimeError, "delivered tap failed"): tap_element(d, ("id", "target"))
        self.assertEqual(len(d.gestures), 1)
        self.assertEqual(d.gestures[0][1][0], {"elementId": "target"})

    def test_web_tap_uses_dom_click_without_native_gesture(self):
        d = Driver(); d.current_context = "WEBVIEW_test"; d.elements = [Element()]
        tap_element(d, ("css selector", "#target"))
        self.assertTrue(d.elements[0].clicked)
        self.assertEqual(d.gestures, [])

    def test_keyboard_is_dismissed_before_the_single_target_tap(self):
        d = Driver(); d.elements = [Element()]; order = []
        d.is_keyboard_shown = lambda: True
        d.hide_keyboard = lambda: order.append("hide keyboard")
        original = d.execute_script
        def tap(*args): order.append("tap"); return original(*args)
        d.execute_script = tap
        tap_element(d, ("id", "target"))
        self.assertEqual(order, ["hide keyboard", "tap"])
        self.assertEqual(len(d.gestures), 1)

    def test_delayed_rendering_is_polled(self):
        d = Driver(); lookup = d.find_elements
        def delayed(*args):
            if d.lookups >= 2: d.elements = [Element()]
            return lookup(*args)
        d.find_elements = delayed
        self.assertIsInstance(reliable_find(d, ("id", "delayed"), timeout=1), Element)
        self.assertGreaterEqual(d.lookups, 3)

    def test_native_scroll_detects_end_and_does_not_swipe_again(self):
        d = Driver()
        with self.assertRaisesRegex(AssertionError, "end of scroll after 1 scrolls"):
            scroll_until_visible(d, ("id", "Write a review"), max_attempts=8)
        self.assertEqual(len(d.gestures), 1)
        self.assertEqual(d.gestures[0][0], "mobile: swipeGesture")
        self.assertEqual(d.gestures[0][1][0]["height"], 1440)
        self.assertEqual(d.gestures[0][1][0]["direction"], "up")

    def test_scroll_waits_for_target_after_last_gesture(self):
        d = Driver()
        def gesture(*args):
            d.elements = [Element()]
            return False
        d.execute_script = gesture
        self.assertIsInstance(scroll_until_visible(d, ("id", "review")), Element)

    def test_virtual_container_bounds_are_clipped_to_viewport(self):
        d = Driver()
        area = _scroll_viewport(d, {"x": 0, "y": 248, "width": 1080, "height": 5000})
        self.assertLess(area["top"] + area["height"], 2400)
        self.assertLessEqual(area["top"] + area["height"], 2400 * 0.8, "avoid the sticky purchase bar")
        self.assertGreater(area["top"], 248)
        self.assertNotIn("elementId", area)

    def test_unchanged_native_content_stops_without_exhausting_budget(self):
        d = Driver(); d.scroll_result = None
        with self.assertRaisesRegex(AssertionError, "end of scroll after 3 scrolls"):
            scroll_until_visible(d, ("id", "missing"), max_attempts=8)
        self.assertEqual(len(d.gestures), 3)

    def test_scroll_attempts_are_bounded(self):
        d = Driver(); d.scroll_result = True
        def gesture(*args):
            d.gestures.append(args)
            d.page_source += "x"
            return True
        d.execute_script = gesture
        with self.assertRaisesRegex(AssertionError, "attempt limit after 2 scrolls"):
            scroll_until_visible(d, ("id", "review"), max_attempts=2)
        self.assertEqual(len(d.gestures), 2)

    def test_web_scroll_uses_dom_and_detects_end(self):
        d = Driver(); d.current_context = "WEBVIEW_com.stockpilot.b2b"
        d.scroll_result = {"before": [0, 500], "after": [0, 500]}
        with self.assertRaisesRegex(AssertionError, "end of scroll"):
            scroll_until_visible(d, ("css selector", "#review"))
        self.assertIn("document.scrollingElement", d.gestures[0][0])
        self.assertNotIn("mobile: scrollGesture", d.gestures[0][0])

    def test_web_displayed_but_clipped_target_is_actually_scrolled(self):
        d = Driver(); d.current_context = "WEBVIEW_test"; d.elements = [Element()]
        inside = False
        def execute(script, *args):
            nonlocal inside
            if "Vortex scroll visibility" in script:
                return inside
            d.gestures.append((script, args))
            inside = True
            return {"before": [0, 0], "after": [0, 300]}
        d.execute_script = execute
        self.assertIsInstance(scroll_until_visible(d, ("css selector", "#review")), Element)
        self.assertEqual(len(d.gestures), 1, "is_displayed alone must not pass the scroll")

    def test_ambiguous_container_fails_without_gesture(self):
        d = Driver(); original = d.find_elements
        d.find_elements = lambda by, value: [Element(), Element()] if value == "container" else original(by, value)
        with self.assertRaisesRegex(AssertionError, "Multiple scroll containers"):
            scroll_until_visible(d, ("id", "missing"), container=("id", "container"))
        self.assertEqual(d.gestures, [])

    def test_checkpoint_stops_without_skipping_an_assertion(self):
        d = Driver()
        with patch.dict(os.environ, {"VORTEX_STOP_AFTER_STEP": "3"}):
            self.assertTrue(begin_step(d, 3, "Checkpoint"))
            self.assertFalse(begin_step(d, 4, "Later assertion"))
            self.assertEqual(d._vortex_step["step"], 3)

    def test_missing_review_fails_and_captures_evidence(self):
        d = Driver()
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {"VORTEX_ARTIFACTS": folder}):
            begin_step(d, 8, "Verify Write a review", ("id", "review"))
            with self.assertRaisesRegex(TimeoutException, "not visible"):
                with recorded_step(d): reliable_find(d, ("id", "review"))
            state = json.loads(next(Path(folder).glob("failure-step-8-*.json")).read_text())
            self.assertEqual(state["step"], 8)
            self.assertEqual(state["context"], "NATIVE_APP")
            self.assertEqual(state["package"], "com.stockpilot.b2b")
            self.assertEqual(state["locator"], ["id", "review"])
            self.assertTrue((Path(folder) / state["source"]).exists())
            self.assertTrue((Path(folder) / state["screenshot"]).exists())

    def test_web_failure_keeps_dom_and_context(self):
        d = Driver(); d.current_context = "WEBVIEW_com.stockpilot.b2b"; d.page_source = "<html>Missing review</html>"
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {"VORTEX_ARTIFACTS": folder}):
            begin_step(d, 8, "Review", ("css selector", "#review"))
            capture_failure(d, AssertionError("missing"))
            self.assertTrue(d._vortex_failure["source"].endswith(".html"))
            self.assertEqual(d._vortex_failure["context"], d.current_context)

    def test_artifact_and_cleanup_errors_do_not_mask_assertion(self):
        d = Driver(); calls = []
        def broken_quit(): calls.append("quit"); raise RuntimeError("quit failed")
        d.quit = broken_quit
        with tempfile.TemporaryDirectory() as folder:
            blocked = Path(folder) / "file"; blocked.write_text("cannot be a directory")
            with patch.dict(os.environ, {"VORTEX_ARTIFACTS": str(blocked)}):
                with self.assertRaisesRegex(AssertionError, "original"):
                    with recorded_step(d): raise AssertionError("original")
                # A capture that cannot write still marks the original failure before cleanup.
                d._vortex_failure = {"error": "original"}
                self.assertEqual(len(cleanup_session(d, "com.stockpilot.b2b")), 1)
        self.assertEqual(calls, ["quit"])

    def test_cleanup_failure_is_reported_when_test_did_not_fail(self):
        d = Driver()
        d.terminate_app = lambda package: (_ for _ in ()).throw(RuntimeError("terminate failed"))
        calls = []; d.quit = lambda: calls.append("quit")
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {"VORTEX_ARTIFACTS": folder}):
            with self.assertRaisesRegex(RuntimeError, "Session cleanup failed"):
                cleanup_session(d, "com.stockpilot.b2b")
        self.assertEqual(calls, ["quit"])


if __name__ == "__main__": unittest.main()
