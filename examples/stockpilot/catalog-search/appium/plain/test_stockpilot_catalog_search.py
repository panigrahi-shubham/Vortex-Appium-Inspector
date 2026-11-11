"""StockPilot catalog search — recorded with Vortex Android Recorder (Appium UiAutomator2, pytest).

Run:   pytest test_stockpilot_catalog_search.py
Needs: pip install "Appium-Python-Client==6.0.12" "pytest==8.4.2"
       a running Appium server with the uiautomator2 driver, and the device connected.
Settings (environment variables): APPIUM_URL, ANDROID_UDID (optional), APP_PACKAGE, VORTEX_TIMEOUT.
Recorded on a 1080x2400 screen; coordinate steps assume that size.
Format: vortex-appium-python v1 (Plain). Recording: stockpilot-catalog-search.
"""

import os

import pytest
from appium import webdriver
from appium.options.android import UiAutomator2Options
from appium.webdriver.common.appiumby import AppiumBy
from selenium.common.exceptions import NoSuchElementException, StaleElementReferenceException, TimeoutException
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

APPIUM_URL = os.environ.get("APPIUM_URL", "http://127.0.0.1:4723")
APP_PACKAGE = os.environ.get("APP_PACKAGE", "com.stockpilot.b2b")
TIMEOUT = float(os.environ.get("VORTEX_TIMEOUT", "10"))
DEFAULT_STABLE_MS = 150
DEFAULT_MAX_SCROLLS = 8

"""Vortex reliability helpers. Embedded in exported tests; no Vortex or AI runtime required."""
import hashlib
import json
import os
import time
from contextlib import contextmanager
from pathlib import Path

from selenium.common.exceptions import NoSuchElementException, StaleElementReferenceException, TimeoutException
from selenium.webdriver.support.ui import WebDriverWait


def begin_step(driver, number, title, locator=None):
    limit = int(os.environ.get("VORTEX_STOP_AFTER_STEP", "0"))
    if limit and number > limit:
        return False
    driver._vortex_step = {"step": number, "title": title, "locator": locator}
    driver._vortex_failure = None
    return True


def _remember_locator(driver, locator):
    if hasattr(driver, "_vortex_step"):
        driver._vortex_step["locator"] = locator


def _reliability_setting(driver, key, environment, fallback):
    return os.environ.get(environment, getattr(driver, "_vortex_settings", {}).get(key, fallback))


def reliable_find(driver, locator, timeout=None, clickable=False):
    """Wait for one visible target; duplicate matches fail rather than picking the first."""
    _remember_locator(driver, locator)
    stable = {"rect": None, "since": None}
    stable_ms = float(_reliability_setting(driver, "stableMs", "VORTEX_STABLE_MS", globals().get("DEFAULT_STABLE_MS", 150)))
    def ready(d):
        elements = d.find_elements(*locator)
        if len(elements) > 1:
            raise AssertionError(f"Locator is not unique: {locator}; matched {len(elements)} elements")
        if not elements:
            return False
        try:
            element = elements[0]
            if not element.is_displayed() or (clickable and not element.is_enabled()):
                return False
            if stable_ms:
                rect = (element.id, element.rect) if d.current_context == "NATIVE_APP" else element.rect
                now = time.monotonic()
                if stable["rect"] != rect:
                    stable.update(rect=rect, since=now)
                if (now - stable["since"]) * 1000 < stable_ms:
                    return False
            return element
        except StaleElementReferenceException:
            stable.update(rect=None, since=None)
            return False
    return WebDriverWait(driver, timeout if timeout is not None else float(_reliability_setting(driver, "timeoutSec", "VORTEX_TIMEOUT", TIMEOUT)), poll_frequency=0.2).until(
        ready, f"not {'clickable' if clickable else 'visible'}: {locator}")


def tap_element(driver, locator):
    """One delivered tap on the verified element; never retry it as a coordinate tap."""
    element = reliable_find(driver, locator, clickable=True)
    if driver.current_context == "NATIVE_APP":
        settings = getattr(driver, "_vortex_settings", {})
        if settings.get("hideKeyboardBeforeTap", True) and driver.is_keyboard_shown() and element.get_attribute("package") == APP_PACKAGE:
            driver.hide_keyboard()
            element = reliable_find(driver, locator, clickable=True)
        driver.execute_script("mobile: clickGesture", {"elementId": element.id})
    else:
        element.click()


def scroll_until_visible(driver, locator, max_attempts=None, container=None, direction="down", percent=0.65):
    """Bounded semantic scrolling. Explicit swipe steps remain separate gestures.

    Native: use a unique scrollable container or an explicit viewport, relative geometry,
    and bounded hierarchy progress checks. Web: scroll the nearest overflow ancestor
    (or an explicit CSS/XPath container), using DOM offsets to detect the end.
    """
    _remember_locator(driver, locator)
    attempts = int(max_attempts if max_attempts is not None else _reliability_setting(driver, "maxScrolls", "VORTEX_MAX_SCROLLS", globals().get("DEFAULT_MAX_SCROLLS", 8)))
    if not 1 <= attempts <= 50 or direction not in ("down", "up", "left", "right") or not 0 < percent <= 1:
        raise ValueError("Invalid bounded scroll settings")
    native = driver.current_context == "NATIVE_APP"
    can_scroll = True
    unchanged = 0
    previous = None
    for attempt in range(attempts + 1):
        # A condition wait also gives asynchronously loaded content time to render at the end.
        try:
            element = reliable_find(driver, locator, timeout=min(TIMEOUT, 1.0))
            if native or _in_scroll_viewport(driver, element):
                return element
        except TimeoutException:
            pass
        if not can_scroll or attempt == attempts:
            reason = "end of scroll" if not can_scroll else "attempt limit"
            raise AssertionError(f"{locator} not visible: {reason} after {attempt} scrolls")
        if native:
            if container:
                candidates = driver.find_elements(*container)
            else:
                candidates = driver.find_elements("-android uiautomator", "new UiSelector().scrollable(true)")
            candidates = [e for e in candidates if e.is_displayed()]
            if len(candidates) > 1:
                raise AssertionError("Multiple scroll containers; select an explicit container locator")
            if container and not candidates:
                raise AssertionError(f"Scroll container not visible: {container}")
            area = _scroll_viewport(driver, candidates[0].rect if candidates else None)
            before_source = driver.page_source
            finger = {"down": "up", "up": "down", "left": "right", "right": "left"}[direction]
            result = driver.execute_script("mobile: swipeGesture", {**area, "direction": finger, "percent": percent})
            source = driver.page_source
            # Swipe commands normally return None. Older adapters may supply a boolean.
            # Changed content gets another bounded observation; repeated content detects the end.
            can_scroll = result is not False or source != before_source
            current = hashlib.sha256(source.encode("utf-8")).hexdigest()
        else:
            owner = reliable_find(driver, container) if container else None
            result = driver.execute_script("""
                let root = arguments[0], target = arguments[1], direction = arguments[2], amount = arguments[3];
                if (!root && target) {
                  for (let p = target.parentElement; p; p = p.parentElement) {
                    const s = getComputedStyle(p);
                    if (/(auto|scroll)/.test(s.overflowY + s.overflowX) &&
                        (p.scrollHeight > p.clientHeight || p.scrollWidth > p.clientWidth)) { root = p; break; }
                  }
                }
                root = root || document.scrollingElement;
                const before = [root.scrollLeft, root.scrollTop];
                const vertical = direction === 'down' || direction === 'up';
                const distance = (vertical ? root.clientHeight : root.clientWidth) * amount;
                root.scrollBy({left: vertical ? 0 : (direction === 'right' ? distance : -distance),
                               top: vertical ? (direction === 'down' ? distance : -distance) : 0, behavior: 'instant'});
                return {before, after: [root.scrollLeft, root.scrollTop]};
            """, owner, _unique_present(driver, locator), direction, percent)
            can_scroll = result["before"] != result["after"]
            current = repr(result["after"])
        unchanged = unchanged + 1 if current == previous else 0
        previous = current
        if unchanged >= 2:
            can_scroll = False
    raise AssertionError(f"{locator} not visible")


def _unique_present(driver, locator):
    found = driver.find_elements(*locator)
    if len(found) > 1:
        raise AssertionError(f"Locator is not unique: {locator}")
    return found[0] if found else None


def _in_scroll_viewport(driver, element):
    # WebDriver is_displayed() can be True below the viewport or behind overflow clipping.
    return driver.execute_script("""/* Vortex scroll visibility */
        const el = arguments[0], r = el.getBoundingClientRect();
        let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
        for (let p = el.parentElement; p; p = p.parentElement) {
            const style = getComputedStyle(p), b = p.getBoundingClientRect();
            if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left,b.left); right = Math.min(right,b.right); }
            if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top,b.top); bottom = Math.min(bottom,b.bottom); }
        }
        const x = r.left + r.width/2, y = r.top + r.height/2;
        return r.width > 0 && r.height > 0 && x >= left && x <= right && y >= top && y <= bottom;
    """, element)


def _scroll_viewport(driver, rect=None):
    size = driver.get_window_size()
    if rect is None:
        return {"left": round(size["width"] * 0.1), "top": round(size["height"] * 0.2),
                "width": round(size["width"] * 0.8), "height": round(size["height"] * 0.6)}
    # Accessibility containers can extend behind sticky app bars and Android navigation.
    # Intersect their bounds with the central gesture viewport, as for explicit recorder swipes.
    left, top = max(size["width"] * 0.1, rect["x"]), max(size["height"] * 0.2, rect["y"])
    right = min(size["width"] * 0.9, rect["x"] + rect["width"])
    bottom = min(size["height"] * 0.8, rect["y"] + rect["height"])
    if right <= left or bottom <= top:
        raise AssertionError("Scroll container is outside the visible viewport")
    width, height = right - left, bottom - top
    return {"left": round(left), "top": round(top), "width": max(1, round(width)), "height": max(1, round(height))}


def capture_failure(driver, error):
    """Best effort per artifact; failure to collect evidence never changes the test error."""
    folder = Path(os.environ.get("VORTEX_ARTIFACTS", "artifacts"))
    state = dict(getattr(driver, "_vortex_step", {}))
    state.update(error_type=type(error).__name__, error=str(error), evidence_errors=[])
    driver._vortex_failure = state
    try:
        folder.mkdir(parents=True, exist_ok=True)
        stem = f"failure-step-{state.get('step', 'setup')}-{time.time_ns()}"
        for name, getter in (("context", lambda: driver.current_context),
                             ("package", lambda: driver.current_package),
                             ("activity", lambda: driver.current_activity)):
            try:
                state[name] = getter()
            except Exception as evidence_error:
                state["evidence_errors"].append(f"{name}: {evidence_error}")
        try:
            path = folder / f"{stem}.png"
            if driver.get_screenshot_as_file(str(path)):
                state["screenshot"] = path.name
        except Exception as evidence_error:
            state["evidence_errors"].append(f"screenshot: {evidence_error}")
        try:
            suffix = ".xml" if state.get("context") == "NATIVE_APP" else ".html"
            path = folder / (stem + suffix)
            path.write_text(driver.page_source, encoding="utf-8")
            state["source"] = path.name
        except Exception as evidence_error:
            state["evidence_errors"].append(f"source: {evidence_error}")
        (folder / f"{stem}.json").write_text(json.dumps(state, indent=2, default=str), encoding="utf-8")
        with (folder / "artifacts.jsonl").open("a", encoding="utf-8") as log:
            log.write(json.dumps({"type": "failed-step", **state}, default=str) + "\n")
            log.write(json.dumps({"type": "failure-details", "file": f"{stem}.json"}) + "\n")
            if state.get("source"):
                log.write(json.dumps({"type": "page-source" if state["source"].endswith(".xml") else "dom", "file": state["source"]}) + "\n")
            if state.get("screenshot"):
                log.write(json.dumps({"type": "screenshot", "file": state["screenshot"]}) + "\n")
        driver._vortex_failure = state
    except Exception as evidence_error:
        # Even a read-only/unwritable output directory must not mask the assertion.
        try:
            error.add_note(f"Could not write failure artifacts: {evidence_error}")
        except AttributeError:
            pass


@contextmanager
def recorded_step(driver):
    try:
        yield
    except Exception as error:
        if not getattr(driver, "_vortex_failure", None):
            capture_failure(driver, error)
        raise


def cleanup_session(driver, package):
    """Attempt both cleanup operations. Report errors independently of the original failure."""
    errors = []
    for label, operation in (("terminate app", lambda: driver.terminate_app(package)), ("quit session", driver.quit)):
        try:
            operation()
        except Exception as error:
            errors.append(f"{label}: {error}")
    if errors:
        message = "; ".join(errors)
        try:
            folder = Path(os.environ.get("VORTEX_ARTIFACTS", "artifacts"))
            folder.mkdir(parents=True, exist_ok=True)
            with (folder / "artifacts.jsonl").open("a", encoding="utf-8") as log:
                log.write(json.dumps({"type": "cleanup-error", "error": message}) + "\n")
        except Exception:
            pass
        # print rather than warnings.warn: a warnings-as-errors setting must not mask the test.
        print(f"[Vortex cleanup] {message}")
        if not getattr(driver, "_vortex_failure", None):
            raise RuntimeError(f"Session cleanup failed: {message}")
    return errors



def checkpoint(driver, name):
    """Saves a screenshot checkpoint next to the run report (or in ./checkpoints when run outside Vortex)."""
    folder = os.environ.get("VORTEX_ARTIFACTS") or os.path.join(os.getcwd(), "checkpoints")
    os.makedirs(folder, exist_ok=True)
    path, n = os.path.join(folder, f"checkpoint-{name}.png"), 1
    while os.path.exists(path):  # never overwrite an earlier checkpoint
        n += 1
        path = os.path.join(folder, f"checkpoint-{name}-{n}.png")
    driver.get_screenshot_as_file(path)


def find(driver, locator):
    """Waits until the element is visible and returns it."""
    return reliable_find(driver, locator)


def find_clickable(driver, locator):
    """Waits until the element is visible and enabled and returns it."""
    return reliable_find(driver, locator, clickable=True)


def wait_condition(driver, locator, predicate, message):
    _remember_locator(driver, locator)
    last = {"text": None}
    def matches(d):
        try:
            found = d.find_elements(*locator)
            if len(found) > 1:
                raise AssertionError(f"Locator is not unique: {locator}")
            if not found:
                return False
            el = found[0]
            last["text"] = el.text
            return el.is_displayed() and predicate(el)
        except (NoSuchElementException, StaleElementReferenceException):
            return False
    try:
        WebDriverWait(driver, TIMEOUT).until(matches, f"{message}: {locator}")
    except TimeoutException:
        last_text = last["text"]
        raise AssertionError(f"{message}; last text={last_text!r}; locator={locator}") from None


def scroll_into_view(driver, locator, max_swipes=None):
    return scroll_until_visible(driver, locator, max_attempts=max_swipes)


@pytest.fixture
def driver():
    options = UiAutomator2Options()
    options.platform_name = "Android"
    options.automation_name = "UiAutomator2"
    options.no_reset = True
    options.set_capability("appium:autoLaunch", False)
    options.set_capability("appium:disableWindowAnimation", True)
    options.new_command_timeout = int(os.environ.get("VORTEX_IDLE_TIMEOUT", "300"))
    if os.environ.get("ANDROID_UDID"):
        options.udid = os.environ["ANDROID_UDID"]
    if os.environ.get("CHROMEDRIVER_EXECUTABLE"):
        options.set_capability("appium:chromedriverExecutable", os.environ["CHROMEDRIVER_EXECUTABLE"])
    elif os.environ.get("CHROMEDRIVER_DIR"):
        options.set_capability("appium:chromedriverExecutableDir", os.environ["CHROMEDRIVER_DIR"])
    drv = webdriver.Remote(APPIUM_URL, options=options)
    drv._vortex_settings = {"timeoutSec": 10, "maxScrolls": 8, "stableMs": 150, "hideKeyboardBeforeTap": True}
    try:
        # Keep hybrid WebView IDs exact and avoid idle waits on continuously updating views.
        drv.update_settings({"disableIdLocatorAutocompletion": True, "ignoreUnimportantViews": True, "waitForIdleTimeout": 0})
        yield drv
    except Exception as error:
        capture_failure(drv, error)
        raise
    finally:
        cleanup_session(drv, APP_PACKAGE)


def test_stockpilot_catalog_search(driver):
    with recorded_step(driver):
        # 1. Launch the app
        if not begin_step(driver, 1, "launch app", None):
            return
        with recorded_step(driver):
            driver.activate_app(APP_PACKAGE)
        # 2. Tap "Search products"
        if not begin_step(driver, 2, "Search products", (AppiumBy.ID, "home-search-bar")):
            return
        with recorded_step(driver):
            tap_element(driver, (AppiumBy.ID, "home-search-bar"))
        # 3. Type into "Search products, brands, SKU…"
        if not begin_step(driver, 3, "Search products, brands, SKU…", (AppiumBy.ID, "catalog-search-input")):
            return
        with recorded_step(driver):
            field = find(driver, (AppiumBy.ID, "catalog-search-input"))
            field.clear()
            field.send_keys("ghee")
        # 4. Check "ghee" (text)
        if not begin_step(driver, 4, "ghee", (AppiumBy.ID, "catalog-search-input")):
            return
        with recorded_step(driver):
            wait_condition(driver, (AppiumBy.ID, "catalog-search-input"), lambda el: el.text == "ghee", "expected text: ghee")
        # 5. Tap "DailyDew Pure Cow Ghee"
        if not begin_step(driver, 5, "DailyDew Pure Cow Ghee", (AppiumBy.ID, "product-card-SKU-10065-open")):
            return
        with recorded_step(driver):
            tap_element(driver, (AppiumBy.ID, "product-card-SKU-10065-open"))
        # 6. Check "SKU SKU-10065 · EAN 8904220065172" (contains)
        if not begin_step(driver, 6, "SKU SKU-10065 · EAN 8904220065172", (AppiumBy.ID, "product-sku")):
            return
        with recorded_step(driver):
            wait_condition(driver, (AppiumBy.ID, "product-sku"), lambda el: "SKU-10065" in el.text, "expected contains: SKU-10065")
        # 7. Screenshot checkpoint "product-detail"
        if not begin_step(driver, 7, "checkpoint", None):
            return
        with recorded_step(driver):
            checkpoint(driver, "product-detail")
        # 8. Scroll to "Write a review"
        if not begin_step(driver, 8, "Write a review", (AppiumBy.ANDROID_UIAUTOMATOR, "new UiSelector().text(\"Write a review\")")):
            return
        with recorded_step(driver):
            scroll_until_visible(driver, (AppiumBy.ANDROID_UIAUTOMATOR, "new UiSelector().text(\"Write a review\")"), max_attempts=8, container=(AppiumBy.ID, "product-scroll"), direction="down", percent=0.65)
        # 9. Check "Write a review" (visible)
        if not begin_step(driver, 9, "Write a review", (AppiumBy.ANDROID_UIAUTOMATOR, "new UiSelector().text(\"Write a review\")")):
            return
        with recorded_step(driver):
            find(driver, (AppiumBy.ANDROID_UIAUTOMATOR, "new UiSelector().text(\"Write a review\")"))
