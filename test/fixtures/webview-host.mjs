// Hosts the synthetic WebView page (samples/insights.html) in a real headless Chromium, for the simulated
// Appium server. The page sees the same viewport and pixel ratio as the
// WebView on the sample screen, so DOM bounds map to screen pixels exactly as on a phone.
//
// Needs Playwright with Chromium (`npm i -D playwright@1.63.0 && npx playwright install chromium`).
// Install Chromium before running WebView tests.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export const WEBVIEW = {
  url: 'https://insights.tradehub.example/rates',
  title: 'Market Insights',
  viewport: { width: 400, height: 750 },
  dpr: 2.7,
  /** Bounds of the android.webkit.WebView on the "insights" sample screen (screen pixels). */
  nativeBounds: { x: 0, y: 255, width: 1080, height: 2025 },
};

/** Playwright, resolved from the current folder, $VORTEX_PLAYWRIGHT or the global module path; null if absent. */
export function loadPlaywright() {
  const tries = [process.env.VORTEX_PLAYWRIGHT, path.join(process.cwd(), 'noop.js')].filter(Boolean);
  for (const t of tries) {
    try {
      const req = createRequire(t.endsWith('.js') ? t : path.join(t, 'noop.js'));
      return req('playwright');
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/** Opens the page; `samplesDir` holds insights.html. */
export async function openWebView(samplesDir) {
  const pw = loadPlaywright();
  if (!pw) throw new Error('Playwright is not installed: the simulated WebView needs it (npm i -D playwright@1.63.0 && npx playwright install chromium)');
  const html = fs.readFileSync(path.join(samplesDir, 'insights.html'), 'utf8');
  const browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: WEBVIEW.viewport, deviceScaleFactor: WEBVIEW.dpr, isMobile: true, hasTouch: true });
  await context.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
  const page = await context.newPage();
  await page.goto(WEBVIEW.url);
  return {
    page,
    async reset() {
      await page.goto(WEBVIEW.url);
    },
    async close() {
      await browser.close().catch(() => {});
    },
  };
}
