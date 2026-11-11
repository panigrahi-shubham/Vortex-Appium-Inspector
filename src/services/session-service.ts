// The Inspector session: which phone and app are attached, and the current screen capture.
// Every capture gets a new token; an action is accepted only with the token of the screen it was chosen on.

import { randomUUID } from 'node:crypto';
import { explainSessionError } from '../appium/session-hints.ts';
import { assertSerial } from '../devices/device-manager.ts';
import type { AppiumInspector } from '../engines/appium/inspector.ts';
import type { PytestRunner } from '../engines/appium/pytest-runner.ts';
import type { PageSource } from '../engines/appium/page-source.ts';
import { assertPackage, problem } from './problem.ts';
import type { RecordingStore } from './recording-store.ts';
import type { Snapshot, WebView } from './types.ts';

export interface SessionDeps {
  inspector: AppiumInspector;
  runner: PytestRunner;
  recording: RecordingStore;
  /** Called with every native capture, in order (used for locator stability). */
  onCapture?: (ps: PageSource) => void;
  /** Called when a session is attached to a different app or phone than before. */
  onTargetChange?: () => void;
}

export class SessionService {
  snapshot: Snapshot | null = null;
  serial: string | null = null;
  readonly #d: SessionDeps;

  constructor(deps: SessionDeps) {
    this.#d = deps;
  }

  async start(serial: string, pkg: string) {
    const { inspector, runner, recording } = this.#d;
    assertSerial(serial);
    assertPackage(pkg);
    if (runner.active().length) throw problem('A test is running. Wait for it or cancel it before starting inspection.', 'RUN_ACTIVE', 409);
    if (recording.steps.length && (recording.pkg !== pkg || (this.serial && this.serial !== serial))) throw problem('Save or clear this recording before switching the app or phone.', 'RECORDING_TARGET', 409);
    const changed = this.serial !== serial || recording.pkg !== pkg;
    if (inspector.status().open && changed) await inspector.stop();
    try {
      await inspector.start(serial, true);
    } catch (e) {
      // Explain the usual causes (driver missing, phone not authorised, install blocked) instead of a raw driver error.
      const known = explainSessionError((e as Error).message);
      throw known ? Object.assign(e as Error, { hint: `${known.cause} ${known.hint}`, details: { cause: known.code } }) : e;
    }
    if (changed) this.#d.onTargetChange?.();
    this.serial = serial;
    recording.pkg = pkg;
    return this.capture(true);
  }

  async stop() {
    this.snapshot = null;
    return this.#d.inspector.stop();
  }

  async capture(autoWeb = true, preferredContext?: string): Promise<Snapshot> {
    const { inspector, recording } = this.#d;
    // A failed refresh invalidates all old hit targets; no old screenshot may authorize an action.
    this.snapshot = null;
    const native = await inspector.source();
    let web: WebView | null = null;
    let webMessage = 'Native controls · ID, accessibility, text, XPath and coordinates';
    if (autoWeb && native.nodes.some((n) => /WebView$/.test(n.className))) {
      const pkg = recording.pkg;
      const context = preferredContext ?? native.contexts?.find((c) => c === `WEBVIEW_${pkg}` || c.startsWith(`WEBVIEW_${pkg}:`));
      if (context) {
        try {
          web = await inspector.webSwitch(context, { captureImage: false });
          webMessage = 'WebView DOM connected · CSS and XPath available';
        } catch (e) {
          webMessage = `DOM unavailable: ${(e as Error).message}. Use native controls or explicit coordinates.`;
        }
      } else webMessage = 'WebView detected. DOM is not exposed by this build; use native text, ID, XPath or explicit coordinates.';
    }
    this.snapshot = { ...native, token: randomUUID(), web, webMessage };
    if (native.width && native.height) recording.recordedSize = { width: native.width, height: native.height };
    try {
      this.#d.onCapture?.(inspector.cachedSource().ps);
    } catch {
      /* stability evidence is optional */
    }
    return this.snapshot;
  }

  requireScreen(token: unknown): Snapshot {
    if (!this.snapshot || token !== this.snapshot.token) throw problem('The screen changed. Refresh it and select the control again.', 'STALE_SCREEN', 409);
    return this.snapshot;
  }
}
