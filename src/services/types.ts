import type { AppiumInspector } from '../engines/appium/inspector.ts';
import type { Using } from '../engines/appium/webdriver.ts';
import type { LocatorParts } from '../model/recording.ts';

export type NativeView = Awaited<ReturnType<AppiumInspector['source']>>;
export type WebView = Awaited<ReturnType<AppiumInspector['webSwitch']>>;

/** One captured screen. `token` authorises exactly one action: any action or refresh replaces it. */
export type Snapshot = NativeView & { token: string; web: WebView | null; webMessage: string };

/** How an action finds its control on the device, and what is stored in the recording for the generated test. */
export type Target = { using: Using; value: string; parts: LocatorParts; title: string; index?: number };
