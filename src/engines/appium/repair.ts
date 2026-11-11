// Repair of a failed step: when a replay could not find a control, propose which control on the screen
// captured at the failure is most likely the one the step meant, with a locator that is unique there.
//
// The suggestion is evidence-based (shared words in the id, the same visible text, the right kind of control)
// and is never applied automatically: the tester chooses, and the saved recording is updated only then.

import { wordsOf } from '../../model/pages.ts';
import type { LocatorParts } from '../../model/recording.ts';
import { allCandidates } from './anchor-locators.ts';
import { evalXPath } from './locator-search.ts';
import { partsForCandidate, rankOffline, recommendOffline } from './native-locators.ts';
import type { Bounds, NativeNode, PageSource } from './page-source.ts';

export interface RepairSuggestion {
  /** Index of the control on the failure screen. */
  index: number;
  label: string;
  className: string;
  bounds: Bounds | null;
  /** 0..100: how closely this control resembles what the step recorded. */
  similarity: number;
  reasons: string[];
  strategy: string;
  value: string;
  python: string;
  parts: LocatorParts;
}

export interface RepairReport {
  /** How many controls the step's own locator matches on the failure screen; null when it cannot be evaluated offline. */
  originalMatches: number | null;
  suggestions: RepairSuggestion[];
}

const tokens = (s: string) => new Set(wordsOf(s, 12));
const idName = (id: string) => (id.includes(':id/') ? id.slice(id.indexOf(':id/') + 4) : id);

function overlap(a: Set<string>, b: Set<string>): { score: number; shared: string[] } {
  if (!a.size || !b.size) return { score: 0, shared: [] };
  const shared = [...a].filter((x) => b.has(x));
  return { score: shared.length / (a.size + b.size - shared.length), shared };
}

/** Words the step's locator carries: the id name, the label or text, or the quoted values inside an XPath. */
function wantedWords(parts: LocatorParts): Set<string> {
  const v = String(parts.value ?? '');
  if (parts.by === 'id') return tokens(idName(v));
  if (parts.by === 'xpath') return tokens([...v.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => idName(m[1] ?? m[2] ?? '')).join(' '));
  return tokens(v);
}

/** How many controls a stored locator matches on a captured screen; null when it cannot be evaluated offline. */
export async function countMatches(parts: LocatorParts, ps: PageSource, xml: string | null): Promise<number | null> {
  const v = String(parts.value ?? '');
  const field = parts.by === 'id' ? 'resourceId' : parts.by === 'label' ? 'contentDesc' : parts.by === 'text' ? 'text' : null;
  if (field) return ps.nodes.filter((n) => n[field] === v).length;
  if (parts.by === 'xpath' && xml) {
    try {
      return (await evalXPath(xml, ps, v)).length;
    } catch {
      return null;
    }
  }
  return null;
}

export async function suggestRepairs(step: { type: string; title: string; parts: LocatorParts }, ps: PageSource, xml: string | null, appPackage: string, max = 5): Promise<RepairReport> {
  const originalMatches = await countMatches(step.parts, ps, xml);
  const wanted = wantedWords(step.parts);
  const title = tokens(step.title);
  const typing = step.type === 'type' || step.type === 'clear';
  const scored: { node: NativeNode; similarity: number; reasons: string[] }[] = [];

  for (const n of ps.nodes) {
    if (!n.bounds || n.bounds.w <= 0 || n.bounds.h <= 0) continue;
    if (n.packageName && appPackage && n.packageName !== appPackage) continue;
    const fields = [
      { name: 'id', words: tokens(idName(n.resourceId)) },
      { name: 'text', words: tokens(n.text) },
      { name: 'label', words: tokens(n.contentDesc) },
    ];
    // A control with nothing of its own (an unnamed input) is recognised by the label just before it.
    if (!n.resourceId && !n.contentDesc && (!n.text || /EditText$/.test(n.className))) {
      const nearby = ps.nodes.slice(Math.max(0, n.index - 3), n.index).reverse().find((x) => x.text && !/EditText$/.test(x.className));
      if (nearby) fields.push({ name: 'nearby label', words: tokens(nearby.text) });
    }
    const best = (target: Set<string>) => fields.map((f) => ({ f: f.name, ...overlap(target, f.words) })).sort((a, b) => b.score - a.score)[0];
    const byName = best(wanted);
    const byTitle = n.text && n.text === step.title ? { f: 'text', score: 1, shared: [] as string[] } : best(title);
    const isInput = /EditText$/.test(n.className);
    // A tap or press needs something that reacts to it; a plain label with the same words is a weaker match.
    const pressing = ['tap', 'longpress', 'doubletap'].includes(step.type);
    const kind = typing ? (isInput ? 1 : 0) : n.flags.clickable ? 1 : pressing ? 0 : 0.5;
    if (typing && !isInput) continue; // typing into something that is not an input never works
    const similarity = 0.5 * byName.score + 0.35 * byTitle.score + 0.15 * kind;
    if (byName.score === 0 && byTitle.score === 0) continue;
    const reasons: string[] = [];
    if (byName.score > 0) reasons.push(`its ${byName.f} shares "${byName.shared.join(', ')}" with the old locator`);
    if (n.text && n.text === step.title) reasons.push(`same text "${n.text}" as when the step was recorded`);
    else if (byTitle.score > 0 && byTitle.shared.length) reasons.push(`its ${byTitle.f} shares "${byTitle.shared.join(', ')}" with the recorded name`);
    if (typing) reasons.push('it is an input field');
    else if (n.flags.clickable) reasons.push('it is clickable');
    else if (pressing) reasons.push('it is not marked clickable: check the screenshot before using it');
    scored.push({ node: n, similarity, reasons });
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  const suggestions: RepairSuggestion[] = [];
  for (const s of scored) {
    if (s.similarity < 0.3 || suggestions.length >= max) break;
    const ranked = rankOffline(s.node, ps, await allCandidates(s.node, ps, xml)).filter((c) => !(typing && (c.strategy === 'uiautomator text' || c.strategy === 'class + text')));
    const pick = recommendOffline(ranked);
    const parts = pick ? partsForCandidate(pick, s.node, ps) : null;
    if (!pick || !parts) continue; // no locator that is unique on the failure screen: not a safe suggestion
    suggestions.push({ index: s.node.index, label: s.node.text || s.node.contentDesc || idName(s.node.resourceId) || s.node.className, className: s.node.className, bounds: s.node.bounds, similarity: Math.round(s.similarity * 100), reasons: s.reasons, strategy: pick.strategy, value: pick.value, python: pick.python, parts });
  }
  return { originalMatches, suggestions };
}
