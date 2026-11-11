// Locators for the current screen: instant ranking (with anchors, stability and replay evidence), the one
// lookup that confirms a recommendation on the phone, live search, and the target an action will use.

import { allCandidates } from '../engines/appium/anchor-locators.ts';
import type { AppiumInspector } from '../engines/appium/inspector.ts';
import { searchLocal, type SearchUsing } from '../engines/appium/locator-search.ts';
import { partsForCandidate, rankOffline, recommendOffline, xpathLiteral } from '../engines/appium/native-locators.ts';
import { applyStability, CaptureHistory } from '../engines/appium/stability.ts';
import { webCandidates } from '../engines/webview/web-locators.ts';
import type { DomSnapshot } from '../engines/webview/dom.ts';
import type { LocatorParts } from '../model/recording.ts';
import type { LocatorHistory } from './locator-history.ts';
import { problem } from './problem.ts';
import type { RecordingStore } from './recording-store.ts';
import type { SessionService } from './session-service.ts';
import type { Snapshot, Target } from './types.ts';

const ATTR = { id: 'resource-id', label: 'content-desc', text: 'text' } as const;

/** The device lookup for a stored locator. Repeated values are addressed by position. */
function targetFor(parts: { by: 'id' | 'label' | 'text' | 'xpath'; value: string; index?: number }, title: string): Target {
  if (parts.by === 'xpath') return { using: 'xpath', value: parts.value, parts, title };
  if (parts.index !== undefined) return { using: 'xpath', value: `(//*[@${ATTR[parts.by]}=${xpathLiteral(parts.value)}])[${parts.index + 1}]`, parts, title };
  if (parts.by === 'text') return { using: '-android uiautomator', value: `new UiSelector().text(${JSON.stringify(parts.value)})`, parts, title };
  return { using: parts.by === 'id' ? 'id' : 'accessibility id', value: parts.value, parts, title };
}

export class LocatorService {
  readonly captures = new CaptureHistory();
  readonly #inspector: AppiumInspector;
  readonly #session: SessionService;
  readonly #history: LocatorHistory;
  readonly #recording: RecordingStore;

  constructor(d: { inspector: AppiumInspector; session: SessionService; history: LocatorHistory; recording: RecordingStore }) {
    this.#inspector = d.inspector;
    this.#session = d.session;
    this.#history = d.history;
    this.#recording = d.recording;
  }

  /** Candidates of a native control, best first, from the captured screen only. */
  async ranked(index: number) {
    const { ps, xml } = this.#inspector.cachedSource();
    const node = ps.nodes[index];
    if (!node) throw problem('Select a control on the current screen.');
    const base = rankOffline(node, ps, await allCandidates(node, ps, xml));
    const candidates = applyStability(base, node, this.captures, (c) => {
      const parts = partsForCandidate(c, node, ps);
      return parts ? this.#history.get(this.#recording.pkg, parts as LocatorParts) : null;
    });
    return { node, ps, candidates, recommended: recommendOffline(candidates) };
  }

  /**
   * The locator an action on this control uses. With `chosen`, exactly the candidate the tester picked;
   * otherwise ID, then label, then text, then an anchor to a nearby label, and only then the absolute XPath.
   */
  async nativeTarget(index: number, screen: Snapshot, chosen?: { strategy: string; value: string } | null): Promise<Target> {
    const n = screen.nodes.find((x) => x.index === index);
    if (!n) throw problem('Select a control on the current screen.');
    if (chosen) {
      const { node, ps, candidates } = await this.ranked(index);
      const cand = candidates.find((c) => c.strategy === chosen.strategy && c.value === chosen.value);
      if (!cand) throw problem('Choose one of the locators listed for this control.');
      const parts = partsForCandidate(cand, node, ps);
      if (!parts) throw problem('That locator cannot be replayed as an element lookup. Use Coordinate tap for a point tap.');
      return targetFor(parts, n.text || n.contentDesc || parts.value);
    }
    const fields = [['resourceId', 'id'], ['contentDesc', 'label'], ['text', 'text']] as const;
    for (const [field, by] of fields) {
      if (field === 'text' && /EditText$/.test(n.className)) continue; // typing replaces an input's text
      const value = n[field];
      if (!value) continue;
      const matches = screen.nodes.filter((x) => x[field] === value);
      return targetFor({ by, value, ...(matches.length > 1 ? { index: matches.findIndex((x) => x.index === index) } : {}) }, n.text || n.contentDesc || value);
    }
    // No id, label or usable text. Prefer a locator anchored to a nearby label over the absolute path.
    const { candidates } = await this.ranked(index);
    const anchor = candidates.find((c) => c.strategy === 'xpath anchor');
    if (anchor) {
      const label = /@text=(?:'([^']*)'|"([^"]*)")/.exec(anchor.value);
      return { using: 'xpath', value: anchor.value, parts: { by: 'xpath', value: anchor.value }, title: label ? `${label[1] ?? label[2]} field` : n.className };
    }
    return { using: 'xpath', value: n.path, parts: { by: 'xpath', value: n.path }, title: n.className };
  }

  async inspect(body: Record<string, unknown>) {
    const screen = this.#session.requireScreen(body.token);
    const index = Number(body.index);
    if (body.context === 'WEBVIEW') {
      if (!screen.web) throw problem('No WebView DOM is available.');
      const n = screen.web.nodes[index];
      if (!n) throw problem('No such DOM control.');
      if (body.verify) return this.#inspector.webLocators(index);
      return { node: n, candidates: webCandidates(screen.web as unknown as DomSnapshot, n) };
    }
    if (!body.verify) {
      // Instant: ranked from the screen already in memory, no device round trip.
      const { node, candidates, recommended } = await this.ranked(index);
      return { node, candidates, recommended, target: await this.nativeTarget(index, screen) };
    }
    return this.#native(() => this.#inspector.locators(index));
  }

  /** Checks one native candidate on the device (one lookup), used to confirm the instant recommendation. */
  async verifyOne(body: Record<string, unknown>) {
    this.#session.requireScreen(body.token);
    return this.#native(async () => ({ candidate: await this.#inspector.verifyOne(Number(body.index), String(body.strategy), String(body.value)) }));
  }

  /** Evaluates a locator against the captured screen (no device round trip) and returns the matching controls. */
  async search(body: Record<string, unknown>) {
    this.#session.requireScreen(body.token);
    if (body.context === 'WEBVIEW') throw problem('Locator search works on native controls. Switch the context to Native.');
    const { ps, xml } = this.#inspector.cachedSource();
    return searchLocal(ps, xml, String(body.using || 'auto') as SearchUsing, String(body.value ?? ''));
  }

  /** Runs a device lookup in the native context and puts the WebView context back afterwards. */
  async #native<T>(fn: () => Promise<T>): Promise<T> {
    const session = this.#inspector.session(), previous = await session.currentContext();
    if (previous !== 'NATIVE_APP') await session.switchContext('NATIVE_APP');
    try {
      return await fn();
    } finally {
      if (previous !== 'NATIVE_APP') await session.switchContext(previous);
    }
  }
}
