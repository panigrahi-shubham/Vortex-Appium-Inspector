import { createHash } from 'node:crypto';
import type { LocatorParts, UiStep } from './model/recording.ts';
import type { Snapshot, Target } from './services/types.ts';

export interface ReliabilitySettings {
  timeoutSec: number;
  maxScrolls: number;
  stableMs: number;
  suggestNavigation: boolean;
  hideKeyboardBeforeTap?: boolean;
}
export const DEFAULT_RELIABILITY: ReliabilitySettings = { timeoutSec: 15, maxScrolls: 8, stableMs: 150, suggestNavigation: true, hideKeyboardBeforeTap: true };

export function reliabilitySettings(value: unknown): ReliabilitySettings {
  const v = value && typeof value === 'object' ? value as Partial<ReliabilitySettings> : {};
  const settings = { ...DEFAULT_RELIABILITY, ...v };
  for (const [key, min, max] of [['timeoutSec', 1, 120], ['maxScrolls', 1, 50], ['stableMs', 0, 2000]] as const) {
    if (!Number.isFinite(settings[key]) || settings[key] < min || settings[key] > max || !Number.isInteger(settings[key])) throw Object.assign(new Error(`Invalid reliability ${key}: expected an integer from ${min} to ${max}`), { code: 'BAD_RELIABILITY', httpStatus: 400 });
  }
  if (typeof settings.suggestNavigation !== 'boolean') throw new Error('Invalid suggestNavigation setting');
  if (typeof settings.hideKeyboardBeforeTap !== 'boolean') throw new Error('Invalid hideKeyboardBeforeTap setting');
  return settings;
}

export interface ScreenEvidence {
  identity: string;
  token: string;
  context: 'NATIVE_APP' | 'WEBVIEW';
  package: string;
  activity: string | null;
  url: string | null;
  width: number | null;
  height: number | null;
  capturedAt: string;
}
export interface NavigationSuggestion {
  id: string;
  kind: 'visible' | 'activity';
  context: 'NATIVE_APP' | 'WEBVIEW';
  title: string;
  reason: string;
  parts?: LocatorParts;
  expected?: string;
  accepted?: boolean;
  attributes?: Record<string, unknown>;
}
export interface ReliabilityEvidence {
  source?: 'recorded' | 'approved-suggestion';
  version: 2;
  settings: ReliabilitySettings;
  before: ScreenEvidence;
  after: ScreenEvidence | null;
  attributes: Record<string, unknown> | null;
  locator: { using: string; value: string; matches: number; verifiedAt: string; positional: boolean } | null;
  suggestions: NavigationSuggestion[];
}

export function screenEvidence(screen: Snapshot, pkg: string, context: 'NATIVE_APP' | 'WEBVIEW'): ScreenEvidence {
  const url = context === 'WEBVIEW' ? screen.web?.url?.split(/[?#]/)[0] ?? null : null;
  const keys = context === 'WEBVIEW' ? screen.web?.nodes.map(n => n.id).filter(Boolean) ?? [] : screen.nodes.map(n => n.resourceId).filter(Boolean);
  const activity = screen.activity ?? null;
  const identity = createHash('sha256').update(JSON.stringify([pkg, activity, context, url, [...new Set(keys)].sort()])).digest('hex').slice(0, 20);
  return { identity, token: screen.token, package: screen.package || pkg, activity, context, url, width: screen.width, height: screen.height, capturedAt: screen.capturedAt ?? new Date().toISOString() };
}

export function actionEvidence(screen: Snapshot, pkg: string, context: 'NATIVE_APP' | 'WEBVIEW', index: number, target: Target | null, settings: ReliabilitySettings, secret: boolean): ReliabilityEvidence {
  const native = screen.nodes.find(n => n.index === index);
  const web = screen.web?.nodes[index];
  let attributes: Record<string, unknown> | null = null;
  if (target) {
    if (context === 'WEBVIEW' && web) attributes = { tag: web.tag, id: web.id, attrs: web.attrs, rect: web.rect, text: secret ? '[redacted]' : web.text };
    else if (native) attributes = { class: native.className, id: native.resourceId, label: native.contentDesc, flags: native.flags, rect: native.bounds, text: secret || native.flags.password ? '[redacted]' : native.text };
  }
  // Never persist value attributes of sensitive inputs, including custom HTML input types.
  if (secret && attributes) delete attributes.attrs;
  return { version: 2, settings, before: screenEvidence(screen, pkg, context), after: null, attributes, locator: null, suggestions: [] };
}

/** Deterministic suggestions only. None is inserted into a test until explicitly approved. */
export function navigationSuggestions(before: Snapshot, after: Snapshot, step: UiStep, pkg: string): NavigationSuggestion[] {
  const e = step.reliability!;
  if (!e.settings.suggestNavigation || !e.after || e.before.identity === e.after.identity || ['assert', 'checkpoint', 'check_activity', 'close_app'].includes(step.type)) return [];
  const reason = 'The captured screen identity changed. Confirm the expected destination.';
  if (e.after.context === 'WEBVIEW' && after.web) {
    const node = after.web.nodes.find(n => n.visible && n.id && !before.web?.nodes.some(old => old.id === n.id) && after.web!.nodes.filter(other => other.id === n.id).length === 1);
    if (node?.id && /^[A-Za-z_][\w-]*$/.test(node.id)) return [{ id: `${step.id}-navigation`, kind: 'visible', context: 'WEBVIEW', parts: { by: 'css', value: `#${node.id}` }, title: node.text || node.id, reason }];
  } else {
    const node = after.nodes.find(n => n.resourceId && n.flags.displayed !== false && !/EditText/.test(n.className) && !before.nodes.some(old => old.resourceId === n.resourceId) && after.nodes.filter(other => other.resourceId === n.resourceId).length === 1);
    if (node) return [{ id: `${step.id}-navigation`, kind: 'visible', context: 'NATIVE_APP', parts: { by: 'id', value: node.resourceId }, title: node.text || node.contentDesc || node.resourceId, reason, attributes: { class: node.className, id: node.resourceId, label: node.contentDesc, text: node.text, rect: node.bounds, flags: node.flags } }];
  }
  if (e.after.activity && e.before.activity !== e.after.activity) return [{ id: `${step.id}-navigation`, kind: 'activity', context: 'NATIVE_APP', expected: `${pkg}/${e.after.activity}`, title: e.after.activity, reason }];
  return [];
}
