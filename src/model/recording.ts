// The shared, framework-neutral recording model (schema "vortex.recording", version 1).
//
// The browser UI keeps its own step objects while recording; they are converted here (`fromUiSteps`) for
// every preview and save, and converted back (`toUiSteps`) when a saved recording is reopened.
//
// Versioning: `migrateRecording` accepts every older shape and returns the current version. Older files are
// never rewritten in place; saving keeps the previous file in recording.history/.

export const RECORDING_SCHEMA = 'vortex.recording';
export const RECORDING_VERSION = 1;
import type { ReliabilityEvidence, ReliabilitySettings } from '../reliability.ts';

export type ActionType =
  | 'tap' | 'longpress' | 'doubletap' | 'swipe' | 'type' | 'scroll_to' | 'press' | 'wait_visible' | 'wait_hidden' | 'sleep' | 'assert'
  // Milestone 5
  | 'clear' | 'hide_keyboard' | 'launch_app' | 'close_app' | 'deep_link' | 'wait_enabled' | 'check_activity' | 'checkpoint';
export const ACTION_TYPES: ActionType[] = ['tap', 'longpress', 'doubletap', 'swipe', 'type', 'scroll_to', 'press', 'wait_visible', 'wait_hidden', 'sleep', 'assert', 'clear', 'hide_keyboard', 'launch_app', 'close_app', 'deep_link', 'wait_enabled', 'check_activity', 'checkpoint'];
/** Steps that act on an element and therefore need a locator. */
export const NEEDS_TARGET: ActionType[] = ['tap', 'longpress', 'doubletap', 'type', 'scroll_to', 'wait_visible', 'wait_hidden', 'assert', 'clear', 'wait_enabled'];
export type AssertionKind = 'visible' | 'hidden' | 'enabled' | 'disabled' | 'text' | 'contains' | 'checked' | 'unchecked' | 'selected' | 'unselected' | 'count';

/**
 * Recorded locator. `index` is the position among EXACT matches.
 * WebView elements use `css` or `xpath` through Chromedriver; `frames` lists the
 * CSS selectors of the iframes that contain the element, outermost first.
 */
export interface LocatorParts {
  by: 'id' | 'label' | 'text' | 'scoped' | 'css' | 'xpath';
  value?: string;
  frames?: string[];
  index?: number;
  container?: string;
  anchorText?: string;
  inner?: { by: 'id' | 'label' | 'text'; value: string } | null;
}

export interface TargetEvidence {
  type: string;
  identifier: string;
  label: string;
  text: string;
  rect: { x: number; y: number; w: number; h: number } | null;
}

export interface EventTarget {
  kind: 'testId' | 'label' | 'text' | 'scoped' | 'nth' | 'coordinate' | 'css' | 'xpath';
  parts: LocatorParts | null;
  quality: number;
  warnings: string[];
  viaAncestor: boolean;
  evidence: TargetEvidence | null;
  /** Other locators the recorder saw for this element (Inspect view), kept for later review. */
  alternatives: { kind: string; parts: LocatorParts }[];
}

export interface Assertion {
  kind: AssertionKind;
  expected?: string | number;
  target: { kind: string; parts: LocatorParts | null };
  title: string;
  source: 'user' | 'suggested';
  reason?: string;
}

export interface Screen {
  /** Page-object name; defaults to the foreground activity's short name, editable in the UI. */
  name: string;
  activity: string | null;
}

/** Which WebView a web step runs in, and the page it was recorded on. */
export interface WebViewRef {
  /** resource-id of the android.webkit.WebView, when it has one. */
  testId: string | null;
  /** Position among the WebViews on screen (0 = first). */
  index: number;
  /** Number of WebViews on screen when recorded. */
  count: number;
  url: string | null;
  title: string | null;
}

export interface RecordedEvent {
  /** Additive v2 evidence; older version-1 recordings remain readable. */
  reliability?: ReliabilityEvidence;
  id: string;
  seq: number;
  at: string;
  context: 'NATIVE_APP' | 'WEBVIEW';
  webview: WebViewRef | null;
  title: string;
  screen: Screen;
  /** Screen after the action (where post-action checks live). */
  screenAfter: Screen | null;
  action: {
    type: ActionType;
    key?: string;
    direction?: 'up' | 'down' | 'left' | 'right';
    distance?: number;
    from?: { x: number; y: number };
    to?: { x: number; y: number };
    durationMs?: number;
    ms?: number;
    /** deep_link */
    url?: string;
    /** check_activity: "package/.Activity" */
    activity?: string;
    /** checkpoint: picture name */
    name?: string;
    scrollContainer?: LocatorParts;
    maxScrolls?: number;
    percent?: number;
  };
  target: EventTarget | null;
  /** Where the user clicked; used by coordinate fallback. */
  position: { x: number; y: number } | null;
  tapStyle: 'both' | 'name' | 'coord';
  /** Check that the element is visible before acting. */
  preCheck: boolean;
  /** Typed input. Secret values are never stored: only the environment variable that supplies them. */
  input: { text?: string; secretEnv?: string; dataKey?: string } | null;
  /** For `assert` events. */
  check: { kind: AssertionKind; expected?: string | number } | null;
  /** Accepted checks after the action. */
  post: Assertion[];
  /** Suggested checks the user did not accept (kept so they can be reviewed later). */
  suggestions: Assertion[];
  observations: { settleMs: number | null };
  templateRef: string | null;
  comment: string | null;
  fallback: { strategy: 'coordinate' | 'none'; screen: { width: number; height: number } | null };
  error: string | null;
}

export interface Recording {
  reliability?: ReliabilitySettings;
  schema: typeof RECORDING_SCHEMA;
  version: number;
  id: string;
  name: string;
  module: string;
  createdAt: string;
  updatedAt: string;
  generator: { name: 'vortex-android-recorder'; version: string };
  app: { package: string };
  device: { serial: string | null; screen: { width: number; height: number } | null };
  events: RecordedEvent[];
  migratedFrom: number | null;
}

export class RecordingError extends Error {
  code = 'BAD_RECORDING';
  httpStatus = 400;
}

// ---- names -----------------------------------------------------------------------------------

const SECRET_ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
export const slug = (s: string, fallback = 'recorded-flow') => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || fallback;

/** Short activity name without package and "Activity" suffix: ".ui.MainActivity" -> "Main". */
export function screenNameFromActivity(activity: string | null | undefined): string {
  if (!activity) return 'App';
  const short = activity.split('/').pop()!.split('.').pop()!.replace(/Activity$/, '');
  return short || 'App';
}

// ---- UI steps <-> events ---------------------------------------------------------------------

/** The step objects the browser UI keeps while recording (see public/index.html). */
export interface UiStep {
  reliability?: ReliabilityEvidence;
  type: string;
  title?: string;
  target?: { kind: string; expr?: string | null; parts?: LocatorParts; quality?: number; warnings?: string[]; viaAncestor?: boolean; evidence?: TargetEvidence } | null;
  x?: number;
  y?: number;
  pre?: boolean;
  mode?: 'both' | 'name' | 'coord';
  args?: Record<string, unknown>;
  sugg?: { assertion: string; expected?: string | number; parts?: LocatorParts; kind?: string; title?: string; reason?: string; on?: boolean }[];
  post?: { assertion: string; expected?: string | number; parts?: LocatorParts; kind?: string; title?: string; reason?: string }[];
  settleMs?: number;
  asset?: string;
  screen?: Screen;
  screenAfter?: Screen | null;
  secretEnv?: string;
  dataKey?: string;
  comment?: string;
  id?: string;
  at?: string;
  context?: 'NATIVE_APP' | 'WEBVIEW';
  webview?: WebViewRef | null;
}

const toAssertion = (s: { assertion: string; expected?: string | number; parts?: LocatorParts; kind?: string; title?: string; reason?: string }, source: Assertion['source']): Assertion => ({
  kind: s.assertion as AssertionKind,
  ...(s.expected !== undefined ? { expected: s.expected } : {}),
  target: { kind: s.kind ?? (s.parts ? 'testId' : 'coordinate'), parts: s.parts ?? null },
  title: s.title ?? '',
  source,
  ...(s.reason ? { reason: s.reason } : {}),
});

export interface RecordingMeta {
  reliability?: ReliabilitySettings;
  id: string;
  name: string;
  module: string;
  appPackage: string;
  serial: string | null;
  screen: { width: number; height: number } | null;
  createdAt?: string;
  version: string;
}

export function fromUiSteps(steps: UiStep[], meta: RecordingMeta): Recording {
  const now = new Date().toISOString();
  const events = steps.map((st, i): RecordedEvent => {
    if (!ACTION_TYPES.includes(st.type as ActionType)) throw new RecordingError(`step ${i + 1}: unknown action "${st.type}"`);
    const a = st.args ?? {};
    const t = st.target;
    const secretEnv = st.secretEnv ? String(st.secretEnv).toUpperCase() : undefined;
    if (secretEnv && !SECRET_ENV.test(secretEnv)) throw new RecordingError(`step ${i + 1}: "${st.secretEnv}" is not a valid environment variable name (A-Z, 0-9, _)`);
    const accepted = st.post ?? (st.sugg ?? []).filter((s) => s.on);
    const rejected = (st.sugg ?? []).filter((s) => !s.on);
    const screen = st.screen ?? { name: 'App', activity: null };
    return {
      ...(st.reliability ? { reliability: structuredClone(st.reliability) } : {}),
      id: st.id ?? `e${i + 1}`,
      seq: i + 1,
      at: st.at ?? now,
      context: st.context === 'WEBVIEW' ? 'WEBVIEW' : 'NATIVE_APP',
      webview: st.context === 'WEBVIEW' ? (st.webview ?? { testId: null, index: 0, count: 1, url: null, title: null }) : null,
      title: st.title ?? '',
      screen,
      screenAfter: st.screenAfter ?? null,
      action: {
        type: st.type as ActionType,
        ...(a.key !== undefined ? { key: String(a.key).toUpperCase() } : {}),
        ...(a.direction !== undefined ? { direction: a.direction as RecordedEvent['action']['direction'] } : {}),
        ...(a.distance !== undefined ? { distance: Number(a.distance) } : {}),
        ...(a.from ? { from: a.from as { x: number; y: number } } : {}),
        ...(a.to ? { to: a.to as { x: number; y: number } } : {}),
        ...(a.duration !== undefined ? { durationMs: Number(a.duration) } : {}),
        ...(a.ms !== undefined ? { ms: Number(a.ms) } : {}),
        ...(a.url !== undefined ? { url: String(a.url) } : {}),
        ...(a.activity !== undefined ? { activity: String(a.activity) } : {}),
        ...(a.name !== undefined ? { name: String(a.name) } : {}),
        ...(a.scrollContainer ? { scrollContainer: a.scrollContainer as LocatorParts } : {}),
        ...(a.maxScrolls !== undefined ? { maxScrolls: Number(a.maxScrolls) } : {}),
        ...(a.percent !== undefined ? { percent: Number(a.percent) } : {}),
      },
      target: t
        ? {
            kind: t.kind as EventTarget['kind'],
            parts: t.parts ?? null,
            quality: t.quality ?? 0,
            warnings: t.warnings ?? [],
            viaAncestor: !!t.viaAncestor,
            evidence: t.evidence ?? null,
            alternatives: [],
          }
        : null,
      position: Number.isFinite(st.x) && Number.isFinite(st.y) ? { x: st.x!, y: st.y! } : null,
      tapStyle: st.context === 'WEBVIEW' ? 'name' : st.mode ?? (t?.kind === 'coordinate' ? 'coord' : 'both'),
      preCheck: st.pre !== false,
      input: st.type === 'type' ? (secretEnv ? { secretEnv, ...(st.dataKey ? { dataKey: st.dataKey } : {}) } : { text: String(a.text ?? ''), ...(st.dataKey ? { dataKey: st.dataKey } : {}) }) : null,
      check: st.type === 'assert' ? { kind: String(a.assertion) as AssertionKind, ...(a.expected !== undefined ? { expected: a.expected as string | number } : {}) } : null,
      post: accepted.map((s) => toAssertion(s, 'suggested')),
      suggestions: rejected.map((s) => toAssertion(s, 'suggested')),
      observations: { settleMs: Number.isFinite(st.settleMs) ? st.settleMs! : null },
      templateRef: st.asset ? `assets/templates/${st.asset}` : null,
      comment: st.comment ?? null,
      fallback: { strategy: st.mode === 'name' ? 'none' : 'coordinate', screen: meta.screen },
      error: null,
    };
  });
  return {
    ...(meta.reliability ? { reliability: meta.reliability } : {}),
    schema: RECORDING_SCHEMA,
    version: RECORDING_VERSION,
    id: meta.id,
    name: meta.name || 'recorded flow',
    module: meta.module,
    createdAt: meta.createdAt ?? now,
    updatedAt: now,
    generator: { name: 'vortex-android-recorder', version: meta.version },
    app: { package: meta.appPackage },
    device: { serial: meta.serial, screen: meta.screen },
    events,
    migratedFrom: null,
  };
}

/** Back to the UI's step objects, so a saved recording can be reopened, edited and regenerated. */
export function toUiSteps(rec: Recording): UiStep[] {
  return rec.events.map((e) => {
    const a = e.action;
    const args: Record<string, unknown> = {};
    if (a.key) args.key = a.key;
    if (a.direction) args.direction = a.direction;
    if (a.distance !== undefined) args.distance = a.distance;
    if (a.from) args.from = a.from;
    if (a.to) args.to = a.to;
    if (a.durationMs !== undefined) args.duration = a.durationMs;
    if (a.ms !== undefined) args.ms = a.ms;
    if (a.url !== undefined) args.url = a.url;
    if (a.activity !== undefined) args.activity = a.activity;
    if (a.name !== undefined) args.name = a.name;
    if (a.scrollContainer) args.scrollContainer = a.scrollContainer;
    if (a.maxScrolls !== undefined) args.maxScrolls = a.maxScrolls;
    if (a.percent !== undefined) args.percent = a.percent;
    if (e.input?.text !== undefined) args.text = e.input.text;
    if (e.check) {
      args.assertion = e.check.kind;
      if (e.check.expected !== undefined) args.expected = e.check.expected;
    }
    const sugg = [
      ...e.post.map((p) => ({ assertion: p.kind, expected: p.expected, parts: p.target.parts ?? undefined, kind: p.target.kind, title: p.title, reason: p.reason ?? 'accepted', on: true })),
      ...e.suggestions.map((p) => ({ assertion: p.kind, expected: p.expected, parts: p.target.parts ?? undefined, kind: p.target.kind, title: p.title, reason: p.reason ?? 'suggested', on: false })),
    ];
    return {
      ...(e.reliability ? { reliability: structuredClone(e.reliability) } : {}),
      id: e.id,
      at: e.at,
      type: a.type,
      title: e.title,
      target: e.target ? { kind: e.target.kind, expr: null, parts: e.target.parts ?? undefined, quality: e.target.quality, warnings: e.target.warnings, viaAncestor: e.target.viaAncestor, evidence: e.target.evidence ?? undefined } : null,
      ...(e.position ? { x: e.position.x, y: e.position.y } : {}),
      pre: e.preCheck,
      mode: e.tapStyle,
      args,
      sugg,
      ...(e.observations.settleMs !== null ? { settleMs: e.observations.settleMs } : {}),
      ...(e.templateRef ? { asset: e.templateRef.split('/').pop() } : {}),
      screen: e.screen,
      screenAfter: e.screenAfter,
      ...(e.input?.secretEnv ? { secretEnv: e.input.secretEnv } : {}),
      ...(e.input?.dataKey ? { dataKey: e.input.dataKey } : {}),
      ...(e.comment ? { comment: e.comment } : {}),
      ...(e.context === 'WEBVIEW' ? { context: 'WEBVIEW' as const, webview: e.webview } : {}),
    };
  });
}

// ---- migration and validation ----------------------------------------------------------------

/**
 * Returns a current-version Recording from any supported input:
 *  - version 1 recordings (validated);
 *  - version 0: a bare array of UI steps, or `{ steps: [...] }` (browser autosave / TPHub v0.1 dumps).
 * Newer versions are refused instead of being guessed at.
 */
export function migrateRecording(input: unknown, meta?: Partial<RecordingMeta>): Recording {
  const obj = input as { schema?: string; version?: number; steps?: UiStep[] } | UiStep[];
  if (Array.isArray(obj) || (obj && typeof obj === 'object' && Array.isArray((obj as { steps?: unknown }).steps) && !(obj as { schema?: string }).schema)) {
    const steps = Array.isArray(obj) ? obj : (obj as { steps: UiStep[] }).steps;
    const rec = fromUiSteps(steps, {
      id: meta?.id ?? 'migrated',
      name: meta?.name ?? 'recorded flow',
      module: meta?.module ?? 'default',
      appPackage: meta?.appPackage ?? 'com.yourname.tradehub',
      serial: meta?.serial ?? null,
      screen: meta?.screen ?? null,
      version: meta?.version ?? 'unknown',
    });
    return { ...rec, migratedFrom: 0 };
  }
  if (!obj || typeof obj !== 'object' || (obj as { schema?: string }).schema !== RECORDING_SCHEMA) throw new RecordingError('not a Vortex recording (missing schema "vortex.recording")');
  const v = (obj as { version?: number }).version;
  if (v === RECORDING_VERSION) return validateRecording(obj as Recording);
  if (typeof v === 'number' && v > RECORDING_VERSION) throw new RecordingError(`this recording was made by a newer Vortex (format version ${v}); this version reads up to ${RECORDING_VERSION}`);
  throw new RecordingError(`unsupported recording version ${String(v)}`);
}

export function validateRecording(r: Recording): Recording {
  const problems: string[] = [];
  if (typeof r.id !== 'string' || !r.id) problems.push('id');
  if (typeof r.name !== 'string') problems.push('name');
  if (!r.app || typeof r.app.package !== 'string') problems.push('app.package');
  if (!Array.isArray(r.events)) problems.push('events');
  else r.events.forEach((e, i) => {
    if (!e || !ACTION_TYPES.includes(e.action?.type)) problems.push(`events[${i}].action.type`);
    if (e?.input?.secretEnv && e.input.text !== undefined) problems.push(`events[${i}].input: a secret must not store its value`);
    if (e?.context === 'WEBVIEW' && !e.webview) problems.push(`events[${i}].webview: a WebView step needs its WebView`);
    if (e && !e.context) (e as RecordedEvent).context = 'NATIVE_APP'; // files written before Milestone 4
    if (e && e.webview === undefined) (e as RecordedEvent).webview = null;
  });
  if (problems.length) throw new RecordingError(`invalid recording: ${problems.join(', ')}`);
  return r;
}
