"""Explicit StockPilot Home/promotion preparation for this example only.

Load with ``python -m pytest -p home_precondition ...`` from this folder.
The setup wraps app activation so the known delayed promotion is handled after
Launch as well. It never changes test locators, assertions or expected values.
"""
import time
import pytest
from selenium.webdriver.support.ui import WebDriverWait


def prepare_home(driver):
    stable_since = None
    def observed(d):
        nonlocal stable_since
        promo = d.find_elements("id", "promo-modal-close")
        if promo:
            stable_since = None
            return ("promo", promo)
        home = d.find_elements("id", "home-search-bar")
        if home:
            if stable_since is None:
                stable_since = time.monotonic()
            if time.monotonic() - stable_since >= 2:
                return ("home", home)
            return False
        stable_since = None
        return ("navigate", []) if d.find_elements("id", "header-title") else False
    for _ in range(5):
        state, elements = WebDriverWait(driver, 10, poll_frequency=0.2).until(observed, "StockPilot Home or known promotion did not appear")
        if state == "home":
            return
        assert driver.current_package == "com.stockpilot.b2b", "Unexpected app during preparation"
        if state == "promo":
            assert len(elements) == 1, "Ambiguous promotion close control"
            driver.execute_script("mobile: clickGesture", {"elementId": elements[0].id})
            WebDriverWait(driver, 10).until(lambda d: not d.find_elements("id", "promo-modal-close"))
        else:
            driver.press_keycode(4)
    raise AssertionError("StockPilot Home precondition was not reached")


@pytest.fixture(autouse=True)
def stockpilot_home_precondition(driver):
    original_activate = driver.activate_app
    def activate_with_home(package):
        original_activate(package)
        if package == "com.stockpilot.b2b":
            prepare_home(driver)
    driver.activate_app = activate_with_home
    try:
        driver.activate_app("com.stockpilot.b2b")
        yield
    finally:
        driver.activate_app = original_activate
