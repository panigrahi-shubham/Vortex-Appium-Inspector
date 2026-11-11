// Anchor-based locators: for a control with no id, label or text of its own (typically an unnamed input),
// find it relative to a nearby label that is unique on the screen:
//
//   //*[@text='Mobile number']/following::android.widget.EditText[1]
//
// This survives changes elsewhere on the screen, unlike an absolute XPath. Every anchor is evaluated against
// the captured screen and kept only when it selects exactly this control. Nothing here asks the device.

import { evalXPath } from './locator-search.ts';
import { candidatesFor, pyStr, xpathLiteral, type Candidate } from './native-locators.ts';
import type { NativeNode, PageSource } from './page-source.ts';

const looksDynamic = (s: string) => /\d{4,}|\b\d+[.,]\d+\b|[₹$€£]|\b\d+:\d+\b/.test(s);
const XPATH_NAME = /^[A-Za-z_][\w.-]*$/;

/** True when the control already has a simple unique locator, so an anchor would add nothing. */
function hasOwnUniqueLocator(node: NativeNode, ps: PageSource): boolean {
  const unique = (field: 'resourceId' | 'contentDesc' | 'text') => !!node[field] && ps.nodes.filter((n) => n[field] === node[field]).length === 1;
  if (unique('resourceId') || unique('contentDesc')) return true;
  // An input's text is what the test replaces, so it never counts as a locator.
  return !/EditText$/.test(node.className) && unique('text');
}

export async function anchorCandidates(node: NativeNode, ps: PageSource, xml: string | null, max = 2): Promise<Candidate[]> {
  if (!xml || !XPATH_NAME.test(node.className) || hasOwnUniqueLocator(node, ps)) return [];
  const textCount = new Map<string, number>();
  for (const n of ps.nodes) if (n.text) textCount.set(n.text, (textCount.get(n.text) ?? 0) + 1);
  const usable = (n: NativeNode) => n.index !== node.index && !!n.text && n.text.length <= 40 && textCount.get(n.text) === 1 && !/EditText$/.test(n.className) && !looksDynamic(n.text) && n.packageName === node.packageName;
  // Labels usually come just before their control; a few controls (check boxes) have the label after.
  const before = ps.nodes.slice(Math.max(0, node.index - 8), node.index).filter(usable).reverse();
  const after = ps.nodes.slice(node.index + 1, node.index + 5).filter(usable);
  const out: Candidate[] = [];
  for (const [labels, axis] of [[before, 'following'], [after, 'preceding']] as const) {
    for (const label of labels) {
      for (let k = 1; k <= 3; k++) {
        const value = `//*[@text=${xpathLiteral(label.text)}]/${axis}::${node.className}[${k}]`;
        let hit: number[];
        try {
          hit = await evalXPath(xml, ps, value);
        } catch {
          return out; // XPath evaluation is unavailable: no anchors rather than unchecked ones
        }
        if (hit.length !== 1 || hit[0] !== node.index) continue;
        out.push({
          strategy: 'xpath anchor',
          using: 'xpath',
          value,
          python: `(AppiumBy.XPATH, ${pyStr(value)})`,
          strengths: [`anchored to the label "${label.text}"`, 'not affected by controls added or removed elsewhere on the screen'],
          weaknesses: ['breaks if the label wording or language changes', 'XPath lookups are slower than id lookups'],
          localMatches: 1,
        });
        break;
      }
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Every candidate for a control: the attribute-based ones plus anchors (when the raw screen XML is available). */
export async function allCandidates(node: NativeNode, ps: PageSource, xml: string | null): Promise<Candidate[]> {
  const own = candidatesFor(node, ps);
  const anchors = await anchorCandidates(node, ps, xml);
  if (!anchors.length) return own;
  // Keep the list ordered by strategy strength: anchors go just before the absolute XPath and coordinates.
  const weak = (c: Candidate) => c.strategy === 'xpath absolute' || c.strategy === 'coordinates';
  return [...own.filter((c) => !weak(c)), ...anchors, ...own.filter(weak)];
}
