# StockPilot catalog-search example

Generated from `samples/stockpilot-catalog-search.recording.json` by:

```powershell
node scripts/generate-stockpilot-example.ts
```

The example launches `com.stockpilot.b2b`, opens catalog search, enters and validates `ghee`, opens SKU-10065 through its explicit open control, checks the SKU on the detail screen, captures a checkpoint, scrolls toward the review section and requires `Write a review` to be visible. It does not submit a review or change cart/order data.

## Run

Use an unlocked, authorized Android device with StockPilot installed, signed in and on Home. Dismiss promotional/usage dialogs as explicit test preparation. App activation preserves navigation state; it does not reset the app to Home. The test deliberately does not dismiss arbitrary dialogs or change expected results.

Install the packages in the generated test header and start Appium with UiAutomator2. Set the device explicitly:

```powershell
$env:ANDROID_UDID = 'YOUR_ADB_SERIAL'
$env:APPIUM_URL = 'http://127.0.0.1:4723'
$env:VORTEX_ARTIFACTS = "$PWD/artifacts/stockpilot"
python -m pytest -p home_precondition catalog-search/appium/plain/test_stockpilot_catalog_search.py
# The POM variant is intentionally undiscoverable in Both mode; select it explicitly:
python -m pytest -p home_precondition catalog-search/appium/pom/tests/alt_test_stockpilot_catalog_search_pom.py
```

Run these commands from this folder. No Vortex server or AI runtime is required. On failure, inspect `failure-step-*.json`, PNG and XML/HTML in the artifact folder. A missing review element fails the scroll/check; it is never skipped.

`home_precondition.py` is an explicit, readable setup companion, outside the generated test. It wraps StockPilot activation to prepare Home in the same Appium session, including after the recorded Launch, and dismisses only the known delayed StockPilot promotion. It waits for a stable Home state. Omit `-p home_precondition` when your test harness already supplies that starting state. It does not handle device usage limits or unexpected dialogs.

For an explicitly partial run through the product-detail checkpoint, set `VORTEX_STOP_AFTER_STEP=7`. Unset it for the full acceptance scenario. A partial run does not verify the review section.
