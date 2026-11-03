// Parses a view tree into a flat list of nodes.
// Supported inputs:
//   1. Synthetic sample JSON ({ status, data: { elements: [...] } })
//   2. `adb uiautomator dump` XML (fallback)

export function decodeBuffer(raw) {
  if (!Buffer.isBuffer(raw)) return String(raw);
  // PowerShell's ">" redirect writes UTF-16 LE with a BOM; handle it so users can feed such files to `check`.
  if (raw.length > 1 && raw[0] === 0xff && raw[1] === 0xfe) return raw.toString('utf16le');
  return raw.toString('utf8');
}

export function parseTree(raw) {
  const s = decodeBuffer(raw).replace(/^\uFEFF/, '').trim();
  if (!s) throw new Error('empty tree output');
  const roots = s.startsWith('<') ? parseXml(s) : parseJson(s);
  return flatten(roots);
}

function parseJson(s) {
  let obj;
  try {
    obj = JSON.parse(s);
  } catch (e) {
    throw new Error('tree output is not valid JSON: ' + e.message);
  }
  const list = obj?.data?.elements ?? obj?.elements ?? (Array.isArray(obj) ? obj : null);
  if (!list) throw new Error('unrecognised tree JSON (expected data.elements)');
  return list.map(fromJsonNode);
}

function fromJsonNode(e) {
  return {
    ref: e.ref || '',
    type: e.type || '',
    text: e.text || '',
    label: e.label || '',
    identifier: e.identifier || '',
    placeholder: e.placeholder || '',
    rect: { x: e.rect?.x ?? 0, y: e.rect?.y ?? 0, w: e.rect?.width ?? 0, h: e.rect?.height ?? 0 },
    selected: !!e.selected,
    checked: e.checked === undefined ? null : !!e.checked,
    enabled: e.enabled === undefined ? true : !!e.enabled,
    children: (e.children || []).map(fromJsonNode),
  };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(v) {
  return String(v ?? '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()];
  });
}

function parseAttrs(str) {
  const out = {};
  const re = /([\w:.-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(str))) out[m[1]] = decodeEntities(m[2]);
  return out;
}

function boundsToRect(b) {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(b || '');
  if (!m) return { x: 0, y: 0, w: 0, h: 0 };
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function parseXml(s) {
  const start = s.indexOf('<?xml');
  const end = s.lastIndexOf('</hierarchy>');
  const body = start >= 0 && end > 0 ? s.slice(start, end + 12) : s;
  const re = /<node\b((?:[^>"]|"[^"]*")*?)(\/?)>|<\/node>/g;
  const roots = [];
  const stack = [];
  let m;
  while ((m = re.exec(body))) {
    if (m[0] === '</node>') {
      stack.pop();
      continue;
    }
    const a = parseAttrs(m[1]);
    const node = {
      ref: '',
      type: a.class || '',
      text: a.text || '',
      label: a['content-desc'] || '',
      identifier: a['resource-id'] || '',
      placeholder: '',
      rect: boundsToRect(a.bounds),
      selected: a.selected === 'true',
      checked: a.checkable === 'true' ? a.checked === 'true' : null,
      enabled: a.enabled !== 'false',
      children: [],
    };
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
    if (m[2] !== '/') stack.push(node);
  }
  if (!roots.length) throw new Error('no <node> elements found in uiautomator output (screen may be secure or empty)');
  return roots;
}

function flatten(roots) {
  const nodes = [];
  const walk = (n, parentId, depth) => {
    const id = nodes.length;
    const { children, ...rest } = n;
    nodes.push({ ...rest, id, parentId, depth, childIds: [] });
    if (parentId !== null) nodes[parentId].childIds.push(id);
    (children || []).forEach((c) => walk(c, id, depth + 1));
  };
  roots.forEach((r) => walk(r, null, 0));
  return nodes;
}

// ---- app subtree filtering ------------------------------------------------

// Packages whose dialogs we keep (runtime permission prompts, system pickers).
const SYSTEM_OK = [
  'com.android.permissioncontroller',
  'com.google.android.permissioncontroller',
  'com.google.android.providers.media.module',
  'com.android.documentsui',
  'com.google.android.documentsui',
];
const NEVER_APP = new Set(['android', 'com.android.systemui']);

export function detectPackage(nodes) {
  const counts = new Map();
  for (const n of nodes) {
    const i = n.identifier.indexOf(':id/');
    if (i > 0) {
      const p = n.identifier.slice(0, i);
      if (!NEVER_APP.has(p)) counts.set(p, (counts.get(p) || 0) + 1);
    }
  }
  let best = null;
  for (const [p, c] of counts) if (!best || c > best[1]) best = [p, c];
  return best ? best[0] : null;
}

// Keeps only the top-level subtrees that belong to the app under test (or a system permission/picker dialog).
// This drops the status bar, navigation bar and any overlay (for example a screen-recorder widget).
export function appNodes(nodes, pkg, extraPackages = []) {
  const prefixes = [pkg, ...SYSTEM_OK, ...extraPackages].filter(Boolean).map((p) => p + ':id/');
  const has = (n) => prefixes.some((p) => n.identifier.startsWith(p));
  const subtreeHas = (id) => has(nodes[id]) || nodes[id].childIds.some(subtreeHas);
  const keep = new Set();
  const collect = (id) => {
    keep.add(id);
    nodes[id].childIds.forEach(collect);
  };
  nodes.filter((n) => n.parentId === null && subtreeHas(n.id)).forEach((r) => collect(r.id));
  return reindex(nodes.filter((n) => keep.has(n.id)));
}

function reindex(list) {
  const map = new Map(list.map((n, i) => [n.id, i]));
  return list.map((n, i) => ({
    ...n,
    id: i,
    parentId: n.parentId === null ? null : map.get(n.parentId) ?? null,
    childIds: n.childIds.map((c) => map.get(c)).filter((c) => c !== undefined),
  }));
}

export function hashNodes(nodes) {
  return nodes.map((n) => `${n.identifier}|${n.text}|${n.label}|${n.rect.x},${n.rect.y},${n.rect.w},${n.rect.h}|${n.selected}|${n.checked}|${n.enabled}`).join('\n');
}

// Re-nests a flat sample node list in its original JSON shape.
export function toNested(nodes) {
  const conv = (n) => {
    const o = { ref: n.ref || `@e${n.id + 1}`, type: n.type, text: n.text };
    if (n.label) o.label = n.label;
    if (n.identifier) o.identifier = n.identifier;
    if (n.placeholder) o.placeholder = n.placeholder;
    o.rect = { x: n.rect.x, y: n.rect.y, width: n.rect.w, height: n.rect.h };
    if (n.selected) o.selected = true;
    if (n.checked !== null) o.checked = n.checked;
    if (n.childIds.length) o.children = n.childIds.map((c) => conv(nodes[c]));
    return o;
  };
  return { status: 'ok', data: { elements: nodes.filter((n) => n.parentId === null).map(conv) } };
}
