"""StockPilot catalog search (POM): recorded with Vortex Android Recorder (Appium UiAutomator2, pytest).

Run:   pytest tests/test_stockpilot_catalog_search_pom.py   (from the appium/pom folder)
Needs: pip install "Appium-Python-Client==6.0.12" "pytest==8.4.2"
       a running Appium server with the uiautomator2 driver, and the device connected.
Format: vortex-appium-python v1 (POM). Recording: stockpilot-catalog-search.
"""

from appium.webdriver.common.appiumby import AppiumBy

from stockpilot_catalog_search_pages.base_page import begin_step, recorded_step, ID, APP_PACKAGE, checkpoint
from stockpilot_catalog_search_pages.data import DATA


def test_stockpilot_catalog_search_pom(driver, main_page):
    with recorded_step(driver):
        # 1. Launch the app
        if not begin_step(driver, 1, "launch app", None):
            return
        with recorded_step(driver):
            driver.activate_app(APP_PACKAGE)
        # 2. Tap "Search products"
        if not begin_step(driver, 2, "Search products", main_page.SEARCH_PRODUCTS):
            return
        with recorded_step(driver):
            main_page.tap_search_products()
        # 3. Type into "Search products, brands, SKU…"
        if not begin_step(driver, 3, "Search products, brands, SKU…", main_page.SEARCH_PRODUCTS_BRANDS_SKU):
            return
        with recorded_step(driver):
            main_page.fill_search_products_brands_sku(DATA["search_products_brands_sku"])
        # 4. Check "ghee" (text)
        if not begin_step(driver, 4, "ghee", main_page.SEARCH_PRODUCTS_BRANDS_SKU):
            return
        with recorded_step(driver):
            main_page.expect_text(main_page.SEARCH_PRODUCTS_BRANDS_SKU, "ghee")
        # 5. Tap "DailyDew Pure Cow Ghee"
        if not begin_step(driver, 5, "DailyDew Pure Cow Ghee", main_page.DAILY_DEW_PURE_COW):
            return
        with recorded_step(driver):
            main_page.tap_daily_dew_pure_cow()
        # 6. Check "SKU SKU-10065 · EAN 8904220065172" (contains)
        if not begin_step(driver, 6, "SKU SKU-10065 · EAN 8904220065172", main_page.SKU_SKU_10065_EAN):
            return
        with recorded_step(driver):
            main_page.expect_contains(main_page.SKU_SKU_10065_EAN, "SKU-10065")
        # 7. Screenshot checkpoint "product-detail"
        if not begin_step(driver, 7, "checkpoint", None):
            return
        with recorded_step(driver):
            checkpoint(driver, "product-detail")
        # 8. Scroll to "Write a review"
        if not begin_step(driver, 8, "Write a review", main_page.WRITE_REVIEW):
            return
        with recorded_step(driver):
            main_page.scroll_to_write_review(max_swipes=8, container=(AppiumBy.ID, "product-scroll"), direction="down", percent=0.65)
        # 9. Check "Write a review" (visible)
        if not begin_step(driver, 9, "Write a review", main_page.WRITE_REVIEW):
            return
        with recorded_step(driver):
            main_page.expect_visible(main_page.WRITE_REVIEW)
