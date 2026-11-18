"""StockPilot catalog search — recorded with Vortex Android Recorder (Appium UiAutomator2, pytest).

Run:   pytest test_stockpilot_catalog_search.py
Keep vortex_stockpilot_catalog_search_support.py beside this test (shared fixtures and reliability helpers).
Needs: pip install "Appium-Python-Client==6.0.12" "pytest==8.4.2"
       a running Appium server with the uiautomator2 driver, and the device connected.
Settings (environment variables): APPIUM_URL, ANDROID_UDID (optional), APP_PACKAGE, VORTEX_TIMEOUT.
Recorded on a 1080x2400 screen; coordinate steps assume that size.
Format: vortex-appium-python v1 (Plain). Recording: stockpilot-catalog-search.
"""

from vortex_stockpilot_catalog_search_support import (
    APP_PACKAGE,
    AppiumBy,
    begin_step,
    checkpoint,
    driver,
    find,
    recorded_step,
    scroll_until_visible,
    tap_element,
    wait_condition,
)


def test_stockpilot_catalog_search(driver):
    with recorded_step(driver):
        # 1. Launch the app
        if not begin_step(driver, 1, "launch app", None):
            return
        driver.activate_app(APP_PACKAGE)
        # 2. Tap "Search products"
        if not begin_step(driver, 2, "Search products", (AppiumBy.ID, "home-search-bar")):
            return
        tap_element(driver, (AppiumBy.ID, "home-search-bar"))
        # 3. Type into "Search products, brands, SKU…"
        if not begin_step(driver, 3, "Search products, brands, SKU…", (AppiumBy.ID, "catalog-search-input")):
            return
        field = find(driver, (AppiumBy.ID, "catalog-search-input"))
        field.clear()
        field.send_keys("ghee")
        # 4. Check "ghee" (text)
        if not begin_step(driver, 4, "ghee", (AppiumBy.ID, "catalog-search-input")):
            return
        wait_condition(driver, (AppiumBy.ID, "catalog-search-input"), lambda el: el.text == "ghee", "expected text: ghee")
        # 5. Tap "DailyDew Pure Cow Ghee"
        if not begin_step(driver, 5, "DailyDew Pure Cow Ghee", (AppiumBy.ID, "product-card-SKU-10065-open")):
            return
        tap_element(driver, (AppiumBy.ID, "product-card-SKU-10065-open"))
        # 6. Check "SKU SKU-10065 · EAN 8904220065172" (contains)
        if not begin_step(driver, 6, "SKU SKU-10065 · EAN 8904220065172", (AppiumBy.ID, "product-sku")):
            return
        wait_condition(driver, (AppiumBy.ID, "product-sku"), lambda el: "SKU-10065" in el.text, "expected contains: SKU-10065")
        # 7. Screenshot checkpoint "product-detail"
        if not begin_step(driver, 7, "checkpoint", None):
            return
        checkpoint(driver, "product-detail")
        # 8. Scroll to "Write a review"
        if not begin_step(driver, 8, "Write a review", (AppiumBy.ANDROID_UIAUTOMATOR, "new UiSelector().text(\"Write a review\")")):
            return
        scroll_until_visible(driver, (AppiumBy.ANDROID_UIAUTOMATOR, "new UiSelector().text(\"Write a review\")"), max_attempts=8, container=(AppiumBy.ID, "product-scroll"), direction="down", percent=0.65)
        # 9. Check "Write a review" (visible)
        if not begin_step(driver, 9, "Write a review", (AppiumBy.ANDROID_UIAUTOMATOR, "new UiSelector().text(\"Write a review\")")):
            return
        find(driver, (AppiumBy.ANDROID_UIAUTOMATOR, "new UiSelector().text(\"Write a review\")"))
