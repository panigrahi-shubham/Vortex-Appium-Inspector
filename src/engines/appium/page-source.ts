// Parses the XML page source returned by Appium UiAutomator2 (`GET /session/:id/source`).
// Element tags are class names (<android.widget.TextView ...>); attributes carry the native properties.
// Only properties actually present in the XML are reported; nothing is invented.

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NativeNode {
  index: number;
  parent: number | null;
  depth: number;
  children: number[];
  tag: string;
  className: string;
  resourceId: string;
  text: string;
  contentDesc: string;
  packageName: string;
  bounds: Bounds | null;
  /** Boolean properties exactly as present in the source; missing ones are absent. */
  flags: Partial<Record<'clickable' | 'enabled' | 'checkable' | 'checked' | 'selected' | 'focused' | 'focusable' | 'scrollable' | 'long-clickable' | 'password' | 'displayed', boolean>>;
  /** Absolute XPath with positions among same-tag siblings, e.g. /hierarchy/android.widget.FrameLayout[1]/... */
  path: string;
  attrs: Record<string, string>;
}

export interface PageSource {
  nodes: NativeNode[];
  width: number | null;
  height: number | null;
  rotation: number | null;
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (v: string) =>
  v.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()],
  );

function attrsOf(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:.-]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]] = decode(m[2]);
  return out;
}

export function parseBounds(b: string | undefined): Bounds | null {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(b ?? '');
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

const FLAG_NAMES = ['clickable', 'enabled', 'checkable', 'checked', 'selected', 'focused', 'focusable', 'scrollable', 'long-clickable', 'password', 'displayed'] as const;

export function parsePageSource(xml: string): PageSource {
  const src = xml.replace(/^﻿/, '');
  const tagRe = /<(\/?)([A-Za-z_][\w.$-]*)((?:[^>"]|"[^"]*")*?)(\/?)>/g;
  const nodes: NativeNode[] = [];
  const stack: { idx: number | null; tag: string; counts: Map<string, number>; path: string }[] = [];
  let root: { width: number | null; height: number | null; rotation: number | null } = { width: null, height: null, rotation: null };
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(src))) {
    const [, closing, tag, rawAttrs, selfClose] = m;
    if (closing) {
      stack.pop();
      continue;
    }
    if (tag === 'hierarchy') {
      const a = attrsOf(rawAttrs);
      root = { width: a.width ? Number(a.width) : null, height: a.height ? Number(a.height) : null, rotation: a.rotation ? Number(a.rotation) : null };
      if (!selfClose) stack.push({ idx: null, tag, counts: new Map(), path: '/hierarchy' });
      continue;
    }
    const a = attrsOf(rawAttrs);
    const parentFrame = stack[stack.length - 1];
    const pos = (parentFrame?.counts.get(tag) ?? 0) + 1;
    parentFrame?.counts.set(tag, pos);
    const path = `${parentFrame?.path ?? ''}/${tag}[${pos}]`;
    const flags: NativeNode['flags'] = {};
    for (const f of FLAG_NAMES) if (a[f] !== undefined) flags[f] = a[f] === 'true';
    const node: NativeNode = {
      index: nodes.length,
      parent: parentFrame?.idx ?? null,
      depth: stack.filter((s) => s.idx !== null).length,
      children: [],
      tag,
      className: a.class ?? tag,
      resourceId: a['resource-id'] ?? '',
      text: a.text ?? '',
      contentDesc: a['content-desc'] ?? '',
      packageName: a.package ?? '',
      bounds: parseBounds(a.bounds),
      flags,
      path,
      attrs: a,
    };
    if (node.parent !== null) nodes[node.parent].children.push(node.index);
    nodes.push(node);
    if (!selfClose) stack.push({ idx: node.index, tag, counts: new Map(), path });
  }
  if (!nodes.length) throw new Error('The page source contains no elements (the screen may be secure, or the app is not in the foreground).');
  return { nodes, ...root };
}

/** Deepest element containing the point, later siblings first (drawn on top). */
export function hitTest(ps: PageSource, x: number, y: number): NativeNode | null {
  const inside = (n: NativeNode) => !!n.bounds && n.bounds.w > 0 && n.bounds.h > 0 && x >= n.bounds.x && x < n.bounds.x + n.bounds.w && y >= n.bounds.y && y < n.bounds.y + n.bounds.h;
  const down = (ids: number[]): NativeNode | null => {
    for (let i = ids.length - 1; i >= 0; i--) {
      const n = ps.nodes[ids[i]];
      if (inside(n)) return down(n.children) ?? n;
    }
    return null;
  };
  return down(ps.nodes.filter((n) => n.parent === null).map((n) => n.index));
}
