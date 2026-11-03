// WebView DOM snapshot and selector verification, run inside the WebView through WebDriver "execute"
// (Chromedriver in Appium's WEBVIEW context). Read-only: nothing in the page is modified.
//
// The snapshot walks the document and every same-origin iframe, and records for each element only what the page
// actually exposes: tag, id, classes, own text, a fixed set of attributes, explicit or implicit ARIA role and a simple
// accessible name, visibility and bounds in top-level CSS pixels. Values of password and one-time-code fields are
// never read. Cross-origin iframes cannot be entered from the parent document; they are listed as such.

export interface DomNode {
  i: number;
  parent: number | null;
  depth: number;
  /** Index into `frames` (-1 = top document). */
  frame: number;
  /** Child-element indexes from the frame document's <html> element down to this element. */
  path: number[];
  tag: string;
  id: string | null;
  classes: string[];
  /** Own visible text (direct text nodes), trimmed, max 80 chars. */
  text: string;
  /** Full text for short elements (max 120 chars). */
  fullText: string;
  attrs: Record<string, string>;
  role: string | null;
  name: string | null;
  visible: boolean;
  sensitive: boolean;
  rect: { x: number; y: number; w: number; h: number };
  /** Position among siblings with the same tag (1-based), for XPath. */
  nth: number;
  childCount: number;
}

export interface DomFrame {
  /** Element index of the <iframe>/<frame>. */
  element: number;
  /** Frame index of the document that contains the iframe element (-1 = top). */
  parentFrame: number;
  /** CSS selector of the iframe within its parent document. */
  selector: string;
  accessible: boolean;
  src: string | null;
  title: string | null;
}

export interface DomSnapshot {
  url: string;
  title: string;
  readyState: string;
  viewport: { w: number; h: number };
  dpr: number;
  nodes: DomNode[];
  frames: DomFrame[];
  truncated: boolean;
}

/** Script body for WebDriver execute/sync; returns a DomSnapshot. */
export const SNAPSHOT_SCRIPT = `
var MAX = 3000, SKIP = { SCRIPT:1, STYLE:1, META:1, LINK:1, HEAD:1, NOSCRIPT:1, TEMPLATE:1, BR:1 };
var KEEP = ['name','type','placeholder','aria-label','role','title','href','alt','for','value','aria-pressed','aria-checked','aria-expanded','aria-selected','aria-disabled','disabled','checked','readonly','src','autocomplete','inputmode','lang','contenteditable'];
var IMPLICIT = { BUTTON:'button', A:'link', SELECT:'combobox', TEXTAREA:'textbox', H1:'heading', H2:'heading', H3:'heading', H4:'heading', H5:'heading', H6:'heading', IMG:'img', NAV:'navigation', FORM:'form', UL:'list', OL:'list', LI:'listitem', TABLE:'table', P:'paragraph', IFRAME:'iframe' };
var nodes = [], frames = [], truncated = false;
function esc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\\\' + c; }); }
function role(el) {
  var r = el.getAttribute('role'); if (r) return r;
  if (el.tagName === 'INPUT') { var t = (el.getAttribute('type') || 'text').toLowerCase(); return { checkbox:'checkbox', radio:'radio', button:'button', submit:'button', reset:'button', range:'slider', search:'searchbox', email:'textbox', tel:'textbox', url:'textbox', text:'textbox', password:null, number:'spinbutton' }[t] || null; }
  if (el.tagName === 'A' && !el.hasAttribute('href')) return null;
  return IMPLICIT[el.tagName] || null;
}
function accName(el) {
  var a = el.getAttribute('aria-label'); if (a) return a.trim();
  var lb = el.getAttribute('aria-labelledby');
  if (lb) { var t = lb.split(/\\s+/).map(function (id) { var x = el.ownerDocument.getElementById(id); return x ? x.textContent.trim() : ''; }).join(' ').trim(); if (t) return t; }
  if (el.labels && el.labels.length) return el.labels[0].textContent.trim();
  var alt = el.getAttribute('alt'); if (alt) return alt.trim();
  if (/^(BUTTON|A|H[1-6]|LABEL|SUMMARY|OPTION|LI)$/.test(el.tagName)) return (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120) || null;
  var ti = el.getAttribute('title'); if (ti) return ti.trim();
  var ph = el.getAttribute('placeholder'); return ph ? ph.trim() : null;
}
function ownText(el) { var s = ''; for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3) s += c.nodeValue; return s.replace(/\\s+/g, ' ').trim().slice(0, 80); }
function walk(el, parent, depth, frame, path, offX, offY) {
  if (nodes.length >= MAX) { truncated = true; return; }
  if (SKIP[el.tagName]) return;
  var r = el.getBoundingClientRect(), view = el.ownerDocument.defaultView, st = view.getComputedStyle(el);
  var sensitive = el.tagName === 'INPUT' && (/password/i.test(el.type) || /one-time-code|cc-|current-password|new-password/i.test(el.getAttribute('autocomplete') || ''));
  var attrs = {};
  for (var k = 0; k < KEEP.length; k++) { var n = KEEP[k]; if (el.hasAttribute(n)) attrs[n] = String(el.getAttribute(n)).slice(0, 200); }
  for (var j = 0; j < el.attributes.length; j++) { var at = el.attributes[j]; if (at.name.indexOf('data-') === 0 && Object.keys(attrs).length < 24) attrs[at.name] = at.value.slice(0, 200); }
  if (sensitive) delete attrs.value;
  var nth = 1; for (var p = el.previousElementSibling; p; p = p.previousElementSibling) if (p.tagName === el.tagName) nth++;
  var full = (el.textContent || '').replace(/\\s+/g, ' ').trim();
  var me = nodes.length;
  nodes.push({ i: me, parent: parent, depth: depth, frame: frame, path: path, tag: el.tagName.toLowerCase(), id: el.id || null,
    classes: Array.prototype.slice.call(el.classList, 0, 6), text: ownText(el), fullText: full.length <= 120 ? full : '',
    attrs: attrs, role: role(el), name: accName(el), sensitive: sensitive,
    visible: r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0,
    rect: { x: r.left + offX, y: r.top + offY, w: r.width, h: r.height }, nth: nth, childCount: el.children.length });
  if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
    var fi = frames.length, doc = null;
    try { doc = el.contentDocument; } catch (e) { doc = null; }
    var sel = el.id ? '#' + esc(el.id) : el.getAttribute('name') ? el.tagName.toLowerCase() + '[name="' + el.getAttribute('name') + '"]' : el.getAttribute('title') ? el.tagName.toLowerCase() + '[title="' + el.getAttribute('title').replace(/"/g, '\\\\"') + '"]' : el.tagName.toLowerCase() + ':nth-of-type(' + nth + ')';
    frames.push({ element: me, parentFrame: frame, selector: sel, accessible: !!(doc && doc.documentElement), src: el.getAttribute('src'), title: el.getAttribute('title') });
    if (doc && doc.documentElement) walk(doc.documentElement, me, depth + 1, fi, [], r.left + offX + el.clientLeft, r.top + offY + el.clientTop);
    return;
  }
  for (var c = 0; c < el.children.length; c++) walk(el.children[c], me, depth + 1, frame, path.concat([c]), offX, offY);
}
walk(document.documentElement, null, 0, -1, [], 0, 0);
return { url: location.href, title: document.title, readyState: document.readyState, viewport: { w: window.innerWidth, h: window.innerHeight }, dpr: window.devicePixelRatio || 1, nodes: nodes, frames: frames, truncated: truncated };
`;

/**
 * Script body that checks, inside the element's own document (arguments[0] = path from <html>), how many elements a
 * CSS selector or XPath matches and whether the first match is that element. arguments[1] = [{using, value}, ...].
 * Runs in the frame the caller switched to.
 */
export const VERIFY_SCRIPT = `
var path = arguments[0], list = arguments[1];
var target = document.documentElement;
for (var i = 0; i < path.length && target; i++) target = target.children[path[i]];
return list.map(function (c) {
  var t0 = performance.now(), count = 0, first = null, error = null;
  try {
    if (c.using === 'css selector') { var all = document.querySelectorAll(c.value); count = all.length; first = all[0] || null; }
    else { var r = document.evaluate(c.value, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); count = r.snapshotLength; first = r.snapshotItem(0); }
  } catch (e) { error = String(e && e.message || e).slice(0, 200); }
  return { count: count, isTarget: !!target && first === target, ms: performance.now() - t0, error: error };
});
`;

/** Returns true when arguments[0] (an element found by WebDriver) is the element at path arguments[1]. */
export const SAME_ELEMENT_SCRIPT = `
var t = document.documentElement, p = arguments[1];
for (var i = 0; i < p.length && t; i++) t = t.children[p[i]];
return arguments[0] === t;
`;

/** Frame selectors from the top document down to the frame `frame` (empty for the top document). */
export function framePath(snap: Pick<DomSnapshot, 'frames'>, frame: number): string[] {
  const out: string[] = [];
  for (let f = frame; f >= 0; f = snap.frames[f].parentFrame) out.unshift(snap.frames[f].selector);
  return out;
}
