// Vortex Appium Inspector: browser UI. No framework and no build step.
// Sections: state and helpers · screen and tree · locators · locator search · actions · recording ·
// generation and replay · server and setup · shortcuts · start-up.

const $ = (id) => document.getElementById(id);

// ---- state and helpers -----------------------------------------------------------------------

let screen = null, // last captured screen (with its one-use token)
  selected = null, // control picked in the tree or on the screenshot
  point = null, // last clicked screenshot point, in device pixels
  chosen = null, // native locator the tester picked for the next action: { strategy, value }
  locatorToCopy = null,
  defaultLocatorToCopy = null,
  currentCandidates = [],
  steps = [],
  generated = [],
  activeRun = null,
  busy = false,
  savedRef = null,
  searchHits = null, // Set of control indexes matching the locator search, or null when the box is empty
  searchSeq = 0,
  autoRefreshTimer = null,
  lastCaptureAt = null;

function notice(text, error = false) {
  $("notice").textContent = text;
  $("notice").classList.toggle("error", error);
}

/** Calls the local API. A failure throws an Error carrying the server's whole answer in `data`. */
async function api(url, body) {
  const res = await fetch(
    "/api/" + url,
    body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  const data = await res.json();
  if (!res.ok) {
    if (data.steps) {
      steps = data.steps;
      renderSteps();
    }
    if (data.applied !== undefined) {
      screen = null;
      clearOverlays();
    }
    const err = Error([data.error, data.hint, ...(data.issues || []).map((i) => `Step ${i.step}: ${i.message}`)].filter(Boolean).join("\n"));
    err.data = data;
    throw err;
  }
  return data;
}

/** Runs one user action at a time; buttons are disabled meanwhile so a slow phone cannot be double-clicked. */
async function task(fn) {
  if (busy) return;
  busy = true;
  document.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    await fn();
  } catch (e) {
    notice(e.message, true);
    showFailureEvidence(e);
  } finally {
    busy = false;
    document.querySelectorAll("button").forEach((b) => (b.disabled = false));
    updateCopyButtons();
    updateLiveStatus();
  }
}

const isNative = () => $("context").value === "NATIVE_APP";
const label = (n) => n.text || n.contentDesc || n.resourceId || n.className;
const pct = (v, total) => `${((v / total) * 100).toFixed(1)}%`;

function updateCopyButtons() {
  const canCopy = screen && locatorToCopy && (selected || ($("coordinates").checked && point));
  $("copyLocator").disabled = busy || !canCopy;
  $("copyPython").disabled = busy || !canCopy;
  $("copyElement").disabled = busy || !screen || !selected;
  $("copyCode").disabled = busy || !generated.some((f) => f.path === $("files").value);
  $("simpleText").disabled = busy || !screen || !isNative() || !selected?.text;
  $("simpleId").disabled = busy || !screen || !isNative() || !(selected?.resourceId || selected?.contentDesc);
  $("simplePoint").disabled = busy || !screen || !point;
  renderSimpleInspector();
}

async function copyText(text, message) {
  if (!text) throw Error("Select an element or generated file first.");
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Some local browser profiles deny Clipboard API access; keep a manual-copy fallback.
    const previous = document.activeElement;
    const field = document.createElement("textarea");
    field.value = text;
    field.className = "clipboard-fallback";
    document.body.append(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    previous?.focus();
    if (!copied) throw Error("Clipboard access was blocked. Select the locator or file code and press Ctrl+C.");
  }
  $("copyStatus").textContent = message;
  notice(message);
}

const pythonLookup = (locator) => {
  if (locator.using === "coordinates") {
    const [x, y] = locator.value.split(",").map(Number);
    return `driver.execute_script("mobile: clickGesture", {"x": ${x}, "y": ${y}})`;
  }
  const by = { id: "ID", "accessibility id": "ACCESSIBILITY_ID", xpath: "XPATH", "-android uiautomator": "ANDROID_UIAUTOMATOR", "class name": "CLASS_NAME", "css selector": "CSS_SELECTOR" }[locator.using];
  if (!by) throw Error("This locator cannot be copied as a Python lookup.");
  return `driver.find_element(AppiumBy.${by}, ${JSON.stringify(locator.value)})`;
};
$("copyLocator").onclick = () => task(() => copyText(locatorToCopy?.value, "Locator copied to clipboard."));
$("copyPython").onclick = () => task(() => copyText(pythonLookup(locatorToCopy), locatorToCopy.using === "coordinates" ? "Point-tap Python copied to clipboard." : "Python lookup copied. Import AppiumBy from appium.webdriver.common.appiumby."));
$("copyElement").onclick = () => task(() => copyText(JSON.stringify({ context: $("context").value, element: selected, locator: locatorToCopy }, null, 2), "Element details copied as JSON."));
$("copyCode").onclick = () => task(() => copyText(generated.find((f) => f.path === $("files").value)?.content, "File code copied to clipboard."));

// Immediate suggestions use only the captured hierarchy; they never claim live verification.
function xpathString(value) {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return "concat(" + value.split("'").map((part) => `'${part}'`).join(`, "'", `) + ")";
}
function lookupForField(node, field) {
  const value = node[field];
  const attr = { resourceId: "resource-id", contentDesc: "content-desc", text: "text" }[field];
  const matches = screen.nodes.filter((n) => n[field] === value);
  if (matches.length > 1) return { using: "xpath", value: `(//*[@${attr}=${xpathString(value)}])[${matches.findIndex((n) => n.index === node.index) + 1}]` };
  return field === "text" ? { using: "-android uiautomator", value: `new UiSelector().text(${JSON.stringify(value)})` }
    : { using: field === "resourceId" ? "id" : "accessibility id", value };
}
function quickLocator(node) {
  if (!isNative()) return null;
  const field = node.resourceId ? "resourceId" : node.contentDesc ? "contentDesc" : node.text && !/EditText$/.test(node.className) ? "text" : null;
  return field ? lookupForField(node, field) : { using: "xpath", value: node.path };
}
function renderSimpleInspector() {
  const locator = screen && (selected || ($("coordinates").checked && point)) ? locatorToCopy : null;
  $("bestLocatorKind").textContent = locator ? ({ id: "ID", "accessibility id": "Label", "-android uiautomator": "Text / UiSelector", xpath: "XPath", "css selector": "CSS", coordinates: "Point" }[locator.using] || "Selected locator") : "Simple inspect";
  $("bestLocatorValue").textContent = locator?.value || "Select an element on the phone image or in the tree.";
  $("bestLocatorPython").textContent = locator ? pythonLookup(locator) : "";
  $("bestLocatorNote").textContent = locator?.using === "coordinates"
    ? `Point at ${pct(point.x, screen.width)}, ${pct(point.y, screen.height)}. Layout-dependent; use Tap to execute. Points are not element assertions.`
    : "From the captured screen. Text and ID can work in WebViews without DOM access. Expand all locators for verification.";
}
function usePoint() {
  if (!screen || !point) return;
  $("coordinates").checked = true;
  chosen = null;
  locatorToCopy = { using: "coordinates", value: `${point.x},${point.y}` };
  $("selector").value = `point: ${locatorToCopy.value}`;
  updateCopyButtons();
  showPoint();
}
$("simplePoint").onclick = () => {
  usePoint();
  notice("Point selected. Copy Python for the tap code, or click Tap to execute and record it.");
};
for (const [id, kind] of [["simpleText", "text"], ["simpleId", "id"]]) $(id).onclick = () => {
  if (busy || !screen || !selected || !isNative()) return;
  const strategy = kind === "text" ? "uiautomator text" : selected.resourceId ? "id" : "accessibility id";
  const candidate = currentCandidates.find((c) => c.strategy === strategy);
  if (!candidate) return notice(`This control does not expose a usable ${kind} selector.`, true);
  $("coordinates").checked = false;
  chosen = { strategy: candidate.strategy, value: candidate.value };
  locatorToCopy = lookupForField(selected, kind === "text" ? "text" : selected.resourceId ? "resourceId" : "contentDesc");
  $("selector").value = `${locatorToCopy.using}: ${locatorToCopy.value}`;
  for (const b of $("locators").children) b.classList.toggle("active", b.dataset.strategy === candidate.strategy && b.dataset.value === candidate.value);
  updateCopyButtons();
  notice(`${kind === "text" ? "Text" : "ID / label"} selected. Copy it, or choose an action to record.`);
};
$("coordinates").onchange = () => {
  if ($("coordinates").checked) {
    if (point) usePoint();
    else {
      locatorToCopy = null;
      $("selector").value = "";
      updateCopyButtons();
      notice("Click a position on the phone image to choose a point tap.");
    }
  }
  else {
    chosen = null;
    locatorToCopy = defaultLocatorToCopy;
    $("selector").value = locatorToCopy ? `${locatorToCopy.using}: ${locatorToCopy.value}` : "";
    updateCopyButtons();
  }
};

// ---- screen and tree -------------------------------------------------------------------------

function nodes() {
  return isNative()
    ? screen?.nodes || []
    : (screen?.web?.nodes || []).map((n) => ({
        ...n,
        index: n.i,
        bounds: n.screen,
        className: n.tag,
        text: n.text,
        resourceId: n.attrs?.id || "",
        contentDesc: n.attrs?.["aria-label"] || "",
      }));
}

function boxStyle(r) {
  return {
    left: pct(r.x, screen.width),
    top: pct(r.y, screen.height),
    width: pct(r.w, screen.width),
    height: pct(r.h, screen.height),
  };
}

function highlight(n) {
  const r = n?.bounds;
  const h = $("highlight");
  if (!r || !screen?.width || !screen?.height) {
    h.style.display = "none";
    return;
  }
  Object.assign(h.style, { display: "block", ...boxStyle(r) });
}

function drawMatches(indexes) {
  $("matches").replaceChildren();
  if (!screen?.width || !screen?.height) return;
  const byIndex = new Map(nodes().map((n) => [n.index, n]));
  for (const i of indexes.slice(0, 200)) {
    const r = byIndex.get(i)?.bounds;
    if (!r || r.w <= 0 || r.h <= 0) continue;
    const box = document.createElement("div");
    box.className = "match";
    Object.assign(box.style, boxStyle(r));
    $("matches").append(box);
  }
}

function clearOverlays() {
  $("highlight").style.display = "none";
  $("hoverHighlight").style.display = "none";
  $("hoverLocator").textContent = "Move over the phone image for an instant locator preview. Click to select and copy.";
  $("matches").replaceChildren();
}

function renderScreen(fresh) {
  screen = fresh;
  selected = null;
  point = null;
  chosen = null;
  locatorToCopy = null;
  defaultLocatorToCopy = null;
  currentCandidates = [];
  $("copyStatus").textContent = "Select an element, then choose Text, ID / label or Point to copy.";
  updateCopyButtons();
  searchHits = null;
  $("selected").textContent = "No control selected";
  $("selector").value = "";
  $("locators").replaceChildren();
  clearOverlays();
  if (!fresh) {
    updateLiveStatus();
    return;
  }
  $("screenshot").src = fresh.img;
  $("dimensions").textContent = `${fresh.width} × ${fresh.height}`;
  $("webStatus").textContent = fresh.webMessage;
  $("webStatus").classList.toggle("fallback", !!fresh.webMessage?.includes("DOM is not exposed") || !!fresh.webMessage?.includes("DOM unavailable"));
  const previous = $("context").value;
  $("context").replaceChildren(new Option("Native controls", "NATIVE_APP"));
  if (fresh.web) $("context").add(new Option(`DOM · ${fresh.web.context}`, fresh.web.context));
  $("context").value = fresh.web ? (previous === "NATIVE_APP" ? "NATIVE_APP" : fresh.web.context) : "NATIVE_APP";
  if (fresh.web && previous === "NATIVE_APP" && $("autoWeb").checked) $("context").value = fresh.web.context;
  renderTree();
  // The screen changed: re-evaluate whatever is in the locator search box against the new capture.
  if ($("locatorSearch").value.trim()) runSearch();
  lastCaptureAt = new Date();
  updateLiveStatus();
}

function renderTree() {
  const native = isNative();
  $("using").hidden = native;
  $("selector").readOnly = native;
  $("selector").placeholder = native ? "Select a control, then click a locator above to use it" : "Choose or enter a CSS / XPath locator";
  const query = $("search").value.toLowerCase();
  $("tree").replaceChildren();
  for (const n of nodes()) {
    if (searchHits && !searchHits.has(n.index)) continue;
    if (query && ![n.text, n.resourceId, n.contentDesc, n.className].join(" ").toLowerCase().includes(query)) continue;
    const b = document.createElement("button");
    const title = document.createElement("span");
    title.textContent = label(n);
    const detail = document.createElement("small");
    detail.textContent = `${n.className} · ${n.resourceId || "no resource ID"}`;
    b.append(title, detail);
    b.classList.toggle("active", selected?.index === n.index);
    b.onclick = () => task(() => choose(n));
    $("tree").append(b);
  }
}

function showPoint() {
  $("point").textContent = point
    ? `Screen point (${point.x}, ${point.y}) · ${pct(point.x, screen.width)}, ${pct(point.y, screen.height)}`
    : "";
}

// ---- locators --------------------------------------------------------------------------------

/** Selecting is instant: candidates are ranked from the captured screen. The phone is asked about one only. */
async function choose(n) {
  selected = n;
  chosen = null;
  locatorToCopy = null;
  defaultLocatorToCopy = null;
  currentCandidates = [];
  const r = n.bounds;
  if (r) {
    point = { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) };
    highlight(n);
  }
  renderTree();
  $("selected").textContent = `${label(n)}\n${n.className}\n${r ? `Bounds ${r.x}, ${r.y} · ${r.w} × ${r.h}` : ""}`;
  $("secret").checked = !!n.flags?.password;
  locatorToCopy = quickLocator(n);
  $("locators").replaceChildren();
  updateCopyButtons();
  const token = screen.token;
  const context = $("context").value;
  const result = await api("inspect", { token, index: n.index, context: isNative() ? "NATIVE_APP" : "WEBVIEW" });
  if (screen?.token !== token || selected?.index !== n.index || $("context").value !== context) return;
  renderLocators(result.candidates, result.recommended);
  if (result.target) {
    $("selector").value = `${result.target.using}: ${result.target.value}`;
    locatorToCopy = { using: result.target.using, value: result.target.value };
    defaultLocatorToCopy = locatorToCopy;
  }
  if ($("coordinates").checked) usePoint();
  $("copyStatus").textContent = "Selected. Copy the locator, Python or element details.";
  updateCopyButtons();
  showPoint();
  if (isNative() && result.recommended) confirmOnPhone(token, n.index, result.recommended);
  $("actionCenter").scrollIntoView({ block: "nearest" });
}

/** Background check of the recommended locator: one lookup on the phone, never blocking the tester. */
async function confirmOnPhone(token, index, candidate) {
  try {
    const { candidate: v } = await api("inspect/verify", { token, index, strategy: candidate.strategy, value: candidate.value });
    if (screen?.token !== token || selected?.index !== index) return;
    for (const b of $("locators").children) {
      if (b.dataset.strategy === v.strategy && b.dataset.value === v.value) {
        b.querySelector(".state").textContent = stateText(v);
        b.classList.toggle("ok", v.status === "verified-unique");
        b.classList.toggle("bad", v.status !== "verified-unique");
      }
    }
  } catch {
    // The screen moved on (an action ran) or the phone was busy: the instant ranking stays as it is.
  }
}

function stateText(c) {
  const ms = c.resolutionMs !== null && c.resolutionMs !== undefined ? ` in ${c.resolutionMs} ms` : "";
  switch (c.status) {
    case "local-unique":
      return "unique on this screen";
    case "local-ambiguous":
      return `${c.localMatches} share this value`;
    case "verified-unique":
      return `verified on phone${ms}`;
    case "ambiguous":
      return `${c.matchCount} matches on phone`;
    case "not-found":
      return "not found on phone";
    case "wrong-target":
      return "matches a different control";
    case "error":
      return "could not be checked";
    case "not-checked":
    case "not-verifiable":
      return "not an element lookup";
    default:
      return c.status || "";
  }
}

function renderLocators(candidates, recommended) {
  currentCandidates = candidates;
  $("locators").replaceChildren();
  const native = isNative();
  for (const c of candidates) {
    const b = document.createElement("button");
    b.dataset.strategy = c.strategy;
    b.dataset.value = c.value;
    const head = document.createElement("span");
    const best = recommended && c.strategy === recommended.strategy && c.value === recommended.value;
    head.textContent = `${best ? "★ " : ""}${c.strategy}${c.score !== undefined ? ` · score ${c.score}` : ""} · `;
    const state = document.createElement("span");
    state.className = "state";
    state.textContent = stateText(c);
    head.append(state);
    const value = document.createElement("small");
    value.textContent = c.value;
    b.append(head, value);
    b.title = [...(c.scoreNotes || []), ...(c.weaknesses || []).map((w) => "⚠ " + w)].join("\n");
    b.onclick = () => {
      if (!native) {
        $("coordinates").checked = false;
        $("selector").value = c.value;
        $("using").value = c.using;
        locatorToCopy = { using: c.using, value: c.value };
        updateCopyButtons();
        return;
      }
      if (!c.using) {
        usePoint();
        notice("Point tap selected. Copy Python for its tap code, or click Tap to execute.");
        return;
      }
      $("coordinates").checked = false;
      const same = chosen && chosen.strategy === c.strategy && chosen.value === c.value;
      chosen = same ? null : { strategy: c.strategy, value: c.value };
      locatorToCopy = same ? defaultLocatorToCopy : { using: c.using, value: c.value };
      updateCopyButtons();
      for (const other of $("locators").children) other.classList.toggle("active", !same && other === b);
      $("selector").value = same ? "" : `${c.strategy}: ${c.value}`;
      notice(same ? "Back to the default locator for this control." : "The next action and the generated test will use this locator.");
    };
    $("locators").append(b);
  }
  if (!native && candidates.length) {
    $("selector").value = candidates[0].value;
    $("using").value = candidates[0].using;
    locatorToCopy = { using: candidates[0].using, value: candidates[0].value };
  }
  $("locators").scrollTop = 0;
}

// ---- locator search --------------------------------------------------------------------------

const SEARCH_HELP = "Matches are counted on the captured screen, instantly, without asking the phone.";

async function runSearch() {
  const value = $("locatorSearch").value.trim();
  const seq = ++searchSeq;
  if (!value) {
    searchHits = null;
    $("matches").replaceChildren();
    $("searchResult").textContent = SEARCH_HELP;
    renderTree();
    return;
  }
  if (!screen) {
    $("searchResult").textContent = "Attach a session first.";
    return;
  }
  if (!isNative()) {
    $("searchResult").textContent = "Locator search works on native controls. Switch the context to Native.";
    return;
  }
  try {
    const r = await api("locator/search", { token: screen.token, using: $("searchUsing").value, value, context: "NATIVE_APP" });
    if (seq !== searchSeq) return; // a newer keystroke already answered
    searchHits = new Set(r.indexes);
    drawMatches(r.indexes);
    renderTree();
    const count = r.count === 1 ? "1 match · unique" : `${r.count} matches`;
    $("searchResult").textContent = r.error
      ? r.error
      : `${count} · ${r.using} · ${r.ms} ms on the captured screen${r.python ? ` · ${r.python}` : ""}${r.count ? " · Enter selects the first" : ""}`;
    $("searchResult").classList.toggle("error", !!r.error && !r.deviceOnly);
  } catch (e) {
    if (seq === searchSeq) $("searchResult").textContent = e.message.split("\n")[0];
  }
}

let searchTimer = null;
function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 120);
}

// ---- actions ---------------------------------------------------------------------------------

function actionArgs() {
  if (!screen) throw Error("Attach a session and refresh the phone first.");
  const web = !isNative();
  return {
    token: screen.token,
    index: selected?.index,
    context: web ? "WEBVIEW" : "NATIVE_APP",
    coordinate: $("coordinates").checked,
    x: point?.x,
    y: point?.y,
    using: web ? $("using").value : undefined,
    value: web ? $("selector").value : undefined,
    locator: !web && chosen ? chosen : undefined,
    record: $("record").checked,
    autoWeb: $("autoWeb").checked,
  };
}

async function act(type, args = {}, extra = {}) {
  const data = await api("action", { ...actionArgs(), ...extra, type, args });
  steps = data.steps;
  renderScreen(data.screen);
  renderSteps();
  savedRef = null;
  renderGenerated([]);
  notice(
    `Completed ${type.replaceAll("_", " ")} in ${(data.durationMs / 1000).toFixed(1)} s. ${$("record").checked ? "Step recorded." : "Recording paused."}`,
  );
}

function fill() {
  const secret = $("secret").checked;
  return act("type", { text: $("text").value }, secret ? { secretEnv: $("secretEnv").value } : {}).then(() => {
    if (secret) $("text").value = ""; // do not leave a password sitting in the page
  });
}

const actionPanes = {
  tap: ["actionTapTab", "actionTapPane"], type: ["actionTypeTab", "actionTypePane"],
  assert: ["actionAssertTab", "actionAssertPane"], more: ["actionMoreTab", "actionMorePane"],
};
function showActionPane(kind, focus = false) {
  for (const [name, [tab, pane]] of Object.entries(actionPanes)) {
    $(pane).hidden = name !== kind;
    $(tab).setAttribute("aria-selected", String(name === kind));
    $(tab).tabIndex = name === kind ? 0 : -1;
  }
  if (focus && kind === "type") $("text").focus();
  else if (focus && kind === "assert") $("assertion").focus();
  $("actionCenter").scrollIntoView({ block: "nearest" });
}
for (const [kind, [tab]] of Object.entries(actionPanes)) {
  $(tab).onclick = () => showActionPane(kind, true);
  $(tab).onkeydown = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const kinds = Object.keys(actionPanes), index = kinds.indexOf(kind);
    const next = event.key === "Home" ? kinds[0] : event.key === "End" ? kinds.at(-1) : kinds[(index + (event.key === "ArrowRight" ? 1 : -1) + kinds.length) % kinds.length];
    showActionPane(next);
    $(actionPanes[next][0]).focus();
  };
}

function hitAt(p) {
  return nodes()
    .filter((n) => {
      const b = n.bounds;
      return b && b.w > 0 && b.h > 0 && p.x >= b.x && p.x < b.x + b.w && p.y >= b.y && p.y < b.y + b.h;
    })
    .sort((a, b) => a.bounds.w * a.bounds.h - b.bounds.w * b.bounds.h)[0];
}

function imagePoint(event) {
  const rect = $("screenshot").getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(screen.width - 1, Math.floor((event.clientX - rect.left) / rect.width * screen.width))),
    y: Math.max(0, Math.min(screen.height - 1, Math.floor((event.clientY - rect.top) / rect.height * screen.height))),
  };
}
$("screenshot").onmousemove = (event) => {
  if (!screen || busy || $("quick").checked) return;
  const p = imagePoint(event);
  const hit = hitAt(p);
  const preview = hit ? quickLocator(hit) : null;
  $("hoverLocator").textContent = preview ? `${preview.using}: ${preview.value} · Click to select`
    : hit ? `${label(hit)} · Click for DOM locators` : `Point: ${p.x},${p.y} · Click, then Use point`;
  const box = $("hoverHighlight");
  if (hit?.bounds) Object.assign(box.style, { display: "block", ...boxStyle(hit.bounds) });
  else box.style.display = "none";
};
$("screenshot").onmouseleave = () => {
  $("hoverHighlight").style.display = "none";
};

$("screenshot").onclick = (e) =>
  task(async () => {
    if (!screen) return;
    const clicked = imagePoint(e);
    point = clicked;
    const hit = hitAt(clicked);

    // Quick record: one click is one recorded step.
    if ($("quick").checked) {
      if ($("coordinates").checked) return act("tap");
      if (!hit) {
        notice("No accessible control at this point. Tick Coordinate tap to tap the point itself.", true);
        return;
      }
      if (/EditText$|^(input|textarea)$/i.test(hit.className)) {
        await choose(hit);
        showActionPane("type", true);
        notice("Type the text and press Enter to fill this field.");
        return;
      }
      if (!isNative()) await choose(hit); // a DOM control needs its selector before it can be tapped
      else {
        selected = hit;
        chosen = null;
        highlight(hit);
      }
      return act("tap");
    }

    if (hit) await choose(hit);
    else {
      selected = null;
      chosen = null;
      locatorToCopy = null;
      defaultLocatorToCopy = null;
      currentCandidates = [];
      $("locators").replaceChildren();
      $("selector").value = "";
      $("selected").textContent = "No accessible control at this point. Explicit coordinate tap is available.";
    }
    point = clicked;
    if ($("coordinates").checked) usePoint();
    updateCopyButtons();
    showPoint();
  });

$("tap").onclick = () => task(() => act("tap"));
$("longpress").onclick = () => task(() => act("longpress"));
$("doubletap").onclick = () => task(() => act("doubletap"));
$("fill").onclick = () => task(fill);
$("text").onkeydown = (e) => {
  if (e.key === "Enter") task(fill);
};
$("clear").onclick = () => task(() => act("clear"));
$("scrollTo").onclick = () => task(() => act("scroll_to"));
const assertNow = (assertion = $("assertion").value) =>
  act("assert", { assertion, expected: assertion === "count" ? Number($("expected").value) : $("expected").value });
$("assert").onclick = () => task(() => assertNow());
document
  .querySelectorAll("[data-global]")
  .forEach((b) => (b.onclick = () => task(() => act(b.dataset.global, b.dataset.key ? { key: b.dataset.key } : {}))));
document.querySelectorAll("[data-swipe]").forEach((b) => (b.onclick = () => task(() => act("swipe", { direction: b.dataset.swipe }))));
$("wait").onclick = () => task(() => act("sleep", { ms: 1500 }));
$("deepLink").onclick = () => task(() => act("deep_link", { url: $("extraValue").value }));
$("checkpoint").onclick = () => task(() => act("checkpoint", { name: $("extraValue").value }));
$("checkScreen").onclick = () => task(() => act("check_activity"));
$("verify").onclick = () =>
  task(async () => {
    if (!selected) throw Error("Select a control first.");
    const r = await api("inspect", { token: screen.token, index: selected.index, context: isNative() ? "NATIVE_APP" : "WEBVIEW", verify: true });
    renderLocators(r.candidates, r.recommended);
    notice("Every locator was checked on the phone.");
  });

// ---- recording -------------------------------------------------------------------------------

function stepText(s, i) {
  let tail = "";
  if (s.type === "type") tail = s.secretEnv ? ` = $${s.secretEnv} (secret)` : ` = ${s.args?.text ?? ""}`;
  else if (s.type === "assert") tail = ` · ${s.args.assertion}${s.args.expected !== undefined ? " " + s.args.expected : ""}`;
  else if (s.type === "deep_link") tail = ` · ${s.args?.url ?? ""}`;
  else if (s.type === "checkpoint") tail = ` · ${s.args?.name ?? ""}`;
  else if (s.type === "check_activity") tail = ` · ${s.args?.activity ?? ""}`;
  else if (s.type === "sleep") tail = ` · ${s.args?.ms ?? ""} ms`;
  return `${i + 1}. ${s.type.replaceAll("_", " ")} · ${s.title}${tail}`;
}

function renderSteps() {
  $("stepCount").textContent = steps.length;
  $("steps").replaceChildren();
  const change = (url, body, message) =>
    task(async () => {
      steps = (await api(url, body)).steps;
      renderSteps();
      savedRef = null;
      notice(message);
    });
  steps.forEach((s, i) => {
    const row = document.createElement("p");
    const text = document.createElement("span");
    text.textContent = stepText(s, i);
    const tools = document.createElement("span");
    tools.className = "step-tools";
    const button = (symbol, title, enabled, fn) => {
      const b = document.createElement("button");
      b.textContent = symbol;
      b.title = title;
      b.hidden = !enabled;
      b.onclick = fn;
      tools.append(b);
    };
    const editable = (s.type === "type" && !s.secretEnv) || s.type === "sleep" || s.type === "deep_link" || s.type === "checkpoint" || (s.type === "assert" && ["text", "contains", "count"].includes(s.args?.assertion));
    button("✎", "Edit this step's value", editable, () => {
      const current = s.type === "type" ? s.args?.text : s.type === "sleep" ? s.args?.ms : s.type === "deep_link" ? s.args?.url : s.type === "checkpoint" ? s.args?.name : s.args?.expected;
      const value = prompt(`New value for step ${i + 1}`, current ?? "");
      if (value !== null) change("recording/edit", { index: i, value }, "Step updated. Phone state was not changed.");
    });
    button("↑", "Move up", i > 0, () => change("recording/move", { from: i, to: i - 1 }, "Step moved. Phone state was not changed."));
    button("↓", "Move down", i < steps.length - 1, () => change("recording/move", { from: i, to: i + 1 }, "Step moved. Phone state was not changed."));
    button("✕", "Delete this step", true, () => change("recording/delete", { index: i }, "Step deleted. Phone state was not undone."));
    row.append(text, tools);
    $("steps").append(row);
  });
}

$("undo").onclick = () =>
  task(async () => {
    steps = (await api("recording/undo", {})).steps;
    renderSteps();
    savedRef = null;
    notice("Removed the last recorded step. Phone state was not undone.");
  });
$("reset").onclick = () =>
  task(async () => {
    if (!confirm("Clear all recorded steps? Saved files remain.")) return;
    steps = (await api("recording/clear", {})).steps;
    renderSteps();
    savedRef = null;
    $("saved").value = "";
    renderGenerated([]);
    notice("Recording cleared.");
  });

// ---- generation and replay -------------------------------------------------------------------

function config() {
  return { name: $("name").value, module: $("module").value, mode: $("mode").value, sharedPages: $("sharedPages").checked && $("mode").value !== "plain" };
}
/** The test's own files, followed by the shared page files it uses (when page objects are shared). */
const allFiles = (r) => [...r.files, ...(r.sharedFiles || [])];
function renderGenerated(files) {
  generated = files;
  $("files").replaceChildren(...generated.map((f) => new Option(f.path, f.path)));
  renderCode();
}
function renderCode() {
  $("code").textContent = generated.find((f) => f.path === $("files").value)?.content || "Create a new file, or record steps and click Preview to see your Python test.";
  updateCopyButtons();
}

$("newFile").onclick = () => {
  if (activeRun) return notice("Wait for the running test to finish before creating a file.", true);
  $("newFileName").value = "";
  $("newFileModule").value = $("module").value || "general";
  $("newFileMode").value = $("mode").value;
  $("newFileExisting").hidden = !steps.length;
  $("discardForNew").checked = false;
  $("newFileError").textContent = "";
  $("newFileDialog").showModal();
  $("newFileName").focus();
};
$("newFileClose").onclick = () => $("newFileDialog").close();
$("newFileForm").onsubmit = (event) => {
  event.preventDefault();
  if (steps.length && !$("discardForNew").checked) {
    $("newFileError").textContent = "Save your current recording first, or tick the checkbox to discard its steps.";
    return;
  }
  task(async () => {
    try {
      const r = await api("new", { name: $("newFileName").value, module: $("newFileModule").value, mode: $("newFileMode").value, pkg: $("pkg").value });
      steps = r.steps;
      $("name").value = r.name;
      $("module").value = r.module;
      $("mode").value = r.mode;
      $("sharedPages").checked = false;
      $("pageName").value = "";
      $("record").checked = true;
      $("quick").checked = false;
      $("quick").onchange();
      $("output").textContent = "New starter file. Record steps and Save test before replaying.";
      $("repair").replaceChildren();
      $("repair").hidden = true;
      await status();
      savedRef = r.ref;
      $("saved").value = JSON.stringify(r.ref);
      renderGenerated(allFiles(r));
      $("newFileDialog").close();
      notice(`Created ${r.ref.module}/${r.ref.case}. Record actions, then Save test to update this starter.`);
    } catch (e) {
      $("newFileError").textContent = e.message;
      throw e;
    }
  });
};
function renderSaved(project) {
  const old = $("saved").value;
  $("saved").replaceChildren(new Option("Choose a saved test", ""));
  for (const m of project.modules) {
    for (const c of m.cases) $("saved").add(new Option(`${c.module}/${c.case}`, JSON.stringify({ module: c.module, case: c.case })));
  }
  if ([...$("saved").options].some((o) => o.value === old)) $("saved").value = old;
}

$("preview").onclick = () => task(async () => renderGenerated(allFiles(await api("generate", config()))));
$("save").onclick = () =>
  task(async () => {
    const r = await api("save", config());
    renderGenerated(allFiles(r));
    await status();
    if (r.saved.conflicts.length) {
      savedRef = null;
      notice("Edited files were preserved. Review .vortex-new files in the output folder before replay.", true);
      return;
    }
    savedRef = r.ref;
    $("saved").value = JSON.stringify(savedRef);
    notice(`Saved ${r.ref.module}/${r.ref.case} in generated. Ready to replay.`);
  });
$("files").onchange = renderCode;

async function screenPage(save) {
  if (!screen) throw Error("Attach a session and refresh the phone first.");
  const name = $("pageName").value.trim() || "screen";
  const r = await api("screen-page", { token: screen.token, name, save });
  renderGenerated([{ path: `screens/${r.fileName}${save ? "" : " (preview)"}`, content: r.content }]);
  const skipped = r.skipped.length ? ` ${r.skipped.length} skipped for lack of a stable locator.` : "";
  if (!save) notice(`${r.className}: ${r.elements.length} controls from this screen.${skipped} Built from the captured screen; nothing was checked on the phone.`);
  else if (r.conflict) notice(`An edited ${r.fileName} already exists, so the new version was saved beside it as ${r.saved} in the output folder.`, true);
  else notice(`Saved ${r.saved} in the output folder (${r.elements.length} controls).${skipped}`);
}
$("pagePreview").onclick = () => task(() => screenPage(false));
$("pageSave").onclick = () => task(() => screenPage(true));

$("run").onclick = () =>
  task(async () => {
    const ref = $("saved").value ? JSON.parse($("saved").value) : savedRef;
    if (!ref) throw Error("Save a test or choose a saved test first.");
    if (!confirm("Run the saved test on the connected phone? The Inspector session will close and the test may change app data.")) return;
    const r = await api("run", ref);
    $("repair").hidden = true;
    activeRun = r.id;
    screen = null;
    notice("Replay running. The Inspector handed its device session to pytest.");
    pollRun();
  });
async function pollRun() {
  if (!activeRun) return;
  try {
    const r = await api("runs/" + activeRun);
    $("output").textContent = `${r.status.toUpperCase()}\n${r.output}\n${r.result ? JSON.stringify(r.result, null, 2) : ""}`;
    if (r.result) {
      const finished = activeRun;
      activeRun = null;
      await status();
      notice(`Replay ${r.status}: ${r.result.summary}`, r.status !== "passed");
      offerRepair(finished, r.result);
    } else setTimeout(pollRun, 1000);
  } catch (e) {
    notice(e.message, true);
    activeRun = null;
  }
}
$("cancel").onclick = () =>
  task(async () => {
    if (activeRun) await api("cancel", { id: activeRun });
  });

for (const id of ["name", "module", "mode", "sharedPages"])
  $(id).onchange = () => {
    savedRef = null;
  };
$("saved").after(Object.assign(document.createElement("button"), { id: "load", textContent: "Load recording" }));
$("load").onclick = () =>
  task(async () => {
    if (!$("saved").value) throw Error("Choose a saved test first.");
    if (steps.length && !confirm("Replace the current in-memory recording with this saved test?")) return;
    const ref = JSON.parse($("saved").value),
      r = await api("load", ref);
    steps = r.steps;
    $("name").value = r.name;
    $("module").value = r.module;
    $("pkg").value = r.pkg;
    $("mode").value = r.mode;
    $("sharedPages").checked = !!r.sharedPages;
    savedRef = ref;
    renderSteps();
    notice("Saved recording loaded. Attach or refresh to continue recording.");
  });

// ---- server and setup ------------------------------------------------------------------------

function serverLine(m) {
  const a = m.server;
  if (!a) {
    const d = m.detectedExternal;
    return d
      ? `Not connected. An Appium server${d.version ? ` ${d.version}` : ""} is already running on port ${d.port}: use Connect existing.`
      : "Not connected. Start Appium, or connect to one you started yourself.";
  }
  const owner = a.ownership === "vortex" ? (a.recovered ? "started by Vortex (re-verified after a restart)" : "started by Vortex") : "external server (Vortex will never stop it)";
  const parts = [a.state.toUpperCase(), owner, `${a.host}:${a.port}`];
  if (a.version) parts.push(`Appium ${a.version}`);
  if (a.pid) parts.push(`PID ${a.pid}`);
  let line = parts.join(" · ");
  if (a.compatible && !a.compatible.ok) line += `\n${a.compatible.note}`;
  if (a.exit) line += `\nStopped at ${new Date(a.exit.at).toLocaleTimeString()} (exit code ${a.exit.code ?? "none"}${a.exit.signal ? `, signal ${a.exit.signal}` : ""}). Open the log below for the reason.`;
  return line;
}

async function status() {
  const s = await api("status");
  const state = s.server.server?.state || "disconnected";
  $("status").textContent = `Appium: ${state}${s.server.server ? ` on ${s.server.server.port}` : ""} · ${s.session.open ? "session attached" : "session closed"}`;
  $("status").classList.toggle("error", ["exited", "unhealthy", "unreachable"].includes(state));
  steps = s.steps;
  renderSteps();
  renderSaved(s.project);
  $("history").replaceChildren();
  for (const r of s.history.slice(0, 6)) {
    const p = document.createElement("div");
    p.textContent = `${r.status} · ${r.file} · ${(r.durationMs / 1000).toFixed(1)} s`;
    $("history").append(p);
  }
  if ($("serverDialog").open) renderServer(s);
  return s;
}

function renderServer(s) {
  const m = s.server;
  $("serverState").textContent = serverLine(m);
  $("serverState").classList.toggle("error", !!m.server && ["exited", "unhealthy", "unreachable"].includes(m.server.state));
  $("serverNotices").textContent = m.notices.slice(-4).map((n) => n.replace(/^\S+ /, "• ")).join("\n");
}

function fillSettings(settings) {
  $("appiumPort").value = settings.port;
  $("appiumPath").value = settings.appiumPath || "";
  $("startTimeout").value = Math.round(settings.serverStartupTimeoutMs / 1000);
  $("sessionTimeout").value = Math.round(settings.sessionStartupTimeoutMs / 1000);
  $("chromedriver").value = settings.chromedriverExecutable || "";
  $("basePath").value = settings.basePath || "/";
  $("stopOnExit").checked = settings.stopOwnedOnExit;
  $("autoRestart").checked = !!settings.autoRestart;
}

async function loadLog() {
  const r = await api("server/logs?lines=200");
  $("serverLog").textContent = r.lines.length
    ? r.lines.join("\n")
    : "No log yet. The log of a server started by Vortex appears here, including when it fails to start.";
  $("serverLog").scrollTop = $("serverLog").scrollHeight;
}

/** When Appium fails, show the evidence: its log tail, and a one-click way out of a busy port. */
function showFailureEvidence(e) {
  const d = e?.data;
  if (!d) return;
  const log = d.details?.log;
  if (Array.isArray(log) && log.length) {
    $("serverLog").textContent = log.join("\n");
    if (!$("serverDialog").open) notice(`${e.message}\nOpen Server & setup to read the Appium log.`, true);
  }
  const offer = $("serverOffer");
  offer.replaceChildren();
  offer.hidden = true;
  const add = (text, fn) => {
    const b = document.createElement("button");
    b.className = "primary";
    b.textContent = text;
    b.onclick = () => task(fn);
    offer.append(b);
    offer.hidden = false;
  };
  if (d.code === "PORT_HAS_EXTERNAL_APPIUM") add(`Connect to the Appium already on port ${d.details?.port ?? $("appiumPort").value}`, () => serverCall("connect"));
  if (d.code === "PORT_IN_USE" && d.details?.suggestedPort)
    add(`Start on port ${d.details.suggestedPort} instead`, async () => {
      $("appiumPort").value = d.details.suggestedPort;
      await api("server/settings", { port: Number(d.details.suggestedPort) });
      await serverCall("start");
    });
}

const SERVER_DONE = {
  start: "Appium is running.",
  connect: "Connected to the existing Appium server.",
  restart: "Appium was restarted.",
  stop: "The Vortex-owned Appium server was stopped.",
  disconnect: "Disconnected. The external server keeps running.",
};
async function serverCall(endpoint) {
  $("serverOffer").hidden = true;
  try {
    await api("server/" + endpoint, { port: Number($("appiumPort").value) });
  } finally {
    // Success or failure, show what the server is doing now and what it logged.
    renderServer(await status());
    await loadLog().catch(() => {});
  }
  notice(SERVER_DONE[endpoint]);
}
for (const [id, endpoint] of [
  ["serverStart", "start"],
  ["serverConnect", "connect"],
  ["serverRestart", "restart"],
  ["serverStop", "stop"],
  ["serverDisconnect", "disconnect"],
])
  $(id).onclick = () => task(() => serverCall(endpoint));

$("setup").onclick = () =>
  task(async () => {
    $("serverDialog").showModal();
    const s = await status();
    renderServer(s);
    fillSettings(s.server.settings);
    await loadLog();
  });
$("dialogClose").onclick = () => $("serverDialog").close();
$("logRefresh").onclick = () => task(loadLog);
$("logCopy").onclick = () =>
  task(async () => {
    await navigator.clipboard.writeText($("serverLog").textContent);
    notice("Appium log copied.");
  });

$("preflight").onclick = () =>
  task(async () => {
    $("checks").textContent = "Checking…";
    const r = await api("preflight");
    $("checks").replaceChildren();
    for (const c of r.checks) {
      const row = document.createElement("div");
      row.className = `check ${c.status}`;
      const badge = document.createElement("b");
      badge.textContent = { ok: "OK", warn: "WARN", fail: "FIX" }[c.status];
      const text = document.createElement("span");
      text.textContent = `${c.label}: ${c.detail}`;
      row.append(badge, text);
      if (c.fix) {
        const fix = document.createElement("code");
        fix.textContent = c.fix;
        row.append(fix);
      }
      $("checks").append(row);
    }
    notice(r.blocked ? "Setup check: some items need fixing before a real phone can be used." : r.ok ? "Setup check: everything is in place." : "Setup check: ready, with warnings.", r.blocked);
  });

$("settings").onclick = () =>
  task(async () => {
    await api("server/settings", {
      port: Number($("appiumPort").value),
      appiumPath: $("appiumPath").value.trim(),
      serverStartupTimeoutMs: Number($("startTimeout").value) * 1000,
      sessionStartupTimeoutMs: Number($("sessionTimeout").value) * 1000,
      chromedriverExecutable: $("chromedriver").value.trim(),
      basePath: $("basePath").value.trim() || "/",
      stopOwnedOnExit: $("stopOnExit").checked,
      autoRestart: $("autoRestart").checked,
    });
    notice("Settings saved. A new Appium path or port applies at the next start; Chromedriver applies at the next attach.");
  });

// ---- connection ------------------------------------------------------------------------------

async function discover() {
  let list;
  try {
    list = await api("devices");
  } catch (e) {
    // Usually adb is missing. Say so in the list and keep the rest of the page working.
    $("device").replaceChildren(new Option("Phones could not be listed: run the setup check", ""));
    throw e;
  }
  $("device").replaceChildren(
    ...list.filter((d) => d.state === "device").map((d) => new Option(`${d.model || "Android"} · ${d.serial}`, d.serial)),
  );
  if (!$("device").options.length) $("device").add(new Option("No authorized phones found", ""));
}
$("devices").onclick = () => task(discover);
$("attach").onclick = () =>
  task(async () => {
    renderScreen(await api("session/start", { serial: $("device").value, pkg: $("pkg").value }));
    await status();
    notice("Session attached. Select a control, then choose an action.");
  });
$("detach").onclick = () =>
  task(async () => {
    await api("session/stop", {});
    renderScreen(null);
    await status();
    notice("Inspector session closed.");
  });
const refresh = async () => {
  screen = null;
  renderScreen(await api("screen", { autoWeb: $("autoWeb").checked }));
  notice("Screen refreshed.");
};
$("refresh").onclick = () => task(refresh);
$("context").onchange = () => {
  selected = null;
  point = null;
  chosen = null;
  locatorToCopy = null;
  defaultLocatorToCopy = null;
  currentCandidates = [];
  $("selected").textContent = "No control selected";
  updateCopyButtons();
  clearOverlays();
  $("selector").value = "";
  $("locators").replaceChildren();
  renderTree();
  if ($("locatorSearch").value.trim()) runSearch();
};
$("search").oninput = renderTree;
$("locatorSearch").oninput = scheduleSearch;
$("searchUsing").onchange = runSearch;
$("locatorSearch").onkeydown = (e) => {
  if (e.key !== "Enter" || !searchHits?.size) return;
  const first = nodes().find((n) => searchHits.has(n.index));
  if (first) task(() => choose(first));
};
$("quick").onchange = () => {
  $("inspectMode").setAttribute("aria-pressed", String(!$("quick").checked));
  $("inspectMode").classList.toggle("primary", !$("quick").checked);
  $("inspectHint").textContent = $("quick").checked
    ? "Quick record: clicking the screenshot performs an action. Click Inspect element to return to selecting and copying."
    : "Inspect mode: click an element on the phone image or in the tree. Its locators appear in the middle panel.";
  $("phone").classList.toggle("quick", $("quick").checked);
  $("point").textContent = $("quick").checked
    ? "Quick record is on: a click taps the control on the phone and records the step. Click a text field, type, press Enter."
    : "Click the screenshot to inspect a control. Selecting never taps the phone.";
};
$("inspectMode").onclick = () => {
  $("coordinates").checked = false;
  $("coordinates").onchange();
  $("quick").checked = false;
  $("quick").onchange();
  notice("Inspect mode is on. Click an element on the phone image or in the tree, then use Copy locator, Copy Python or Copy element.");
};
$("selector").oninput = () => {
  if (!isNative()) locatorToCopy = $("selector").value ? { using: $("using").value, value: $("selector").value } : null;
  updateCopyButtons();
};
$("using").onchange = $("selector").oninput;

// Live captures share the same exclusive task queue as actions. A pinned selection stays stable for copying.
function livePauseReason() {
  if (!screen || activeRun) return "Waiting for an attached Inspector screen";
  if (document.hidden || $("inspectorView").hidden) return "Paused while the Inspector is hidden";
  if (selected || point) return "Paused for inspection";
  const focused = document.activeElement;
  if (focused?.closest("#inspectorView") && focused.matches('input:not([type="checkbox"]), textarea, select')) return "Paused while editing";
  if (document.querySelector("dialog[open]")) return "Paused while a dialog is open";
  return "";
}
function updateLiveStatus() {
  const enabled = $("autoRefresh").checked;
  const reason = enabled ? livePauseReason() : "";
  $("liveScreenStatus").textContent = !enabled ? "Manual refresh. Enable auto-refresh to follow changes made on the phone."
    : reason ? `${reason}. ${reason.includes("inspection") || reason.includes("editing") ? "Choose Resume live to continue." : ""}`
    : `Live screen · ${lastCaptureAt ? "updated " + lastCaptureAt.toLocaleTimeString() : "waiting for capture"}`;
  $("resumeLive").hidden = !enabled || !screen || !reason.includes("inspection") && !reason.includes("editing");
}
async function captureLiveScreen() {
  if (!$("autoRefresh").checked || busy) return;
  if (livePauseReason()) return updateLiveStatus();
  await task(async () => {
    $("liveScreenStatus").textContent = "Refreshing the phone screen…";
    try {
      renderScreen(await api("screen", { autoWeb: $("autoWeb").checked }));
    } catch (e) {
      $("autoRefresh").checked = false;
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
      renderScreen(null);
      throw e;
    }
  });
}
function scheduleLiveScreen() {
  clearInterval(autoRefreshTimer);
  autoRefreshTimer = null;
  if ($("autoRefresh").checked) {
    autoRefreshTimer = setInterval(captureLiveScreen, Number($("refreshInterval").value));
    captureLiveScreen();
  }
  updateLiveStatus();
}
$("autoRefresh").onchange = scheduleLiveScreen;
$("refreshInterval").onchange = () => {
  $("refreshInterval").blur();
  scheduleLiveScreen();
};
$("resumeLive").onclick = () => {
  $("inspectMode").focus();
  renderScreen(screen);
  captureLiveScreen();
};

// Tutorial navigation never sends device commands, including when following a guide button.
function showWorkspace(tutorial) {
  $("inspectorView").hidden = tutorial;
  $("tutorialView").hidden = !tutorial;
  for (const [id, active] of [["inspectorTab", !tutorial], ["tutorialTab", tutorial]]) {
    $(id).setAttribute("aria-selected", String(active));
    $(id).tabIndex = active ? 0 : -1;
  }
  updateLiveStatus();
}
$("inspectorTab").onclick = () => showWorkspace(false);
$("tutorialTab").onclick = () => showWorkspace(true);
document.querySelectorAll('.workspace-tabs [role="tab"]').forEach((tab) => tab.addEventListener("keydown", (e) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  e.stopPropagation();
  const tutorial = e.key === "End" || (e.key !== "Home" && tab.id !== "tutorialTab");
  showWorkspace(tutorial);
  $(tutorial ? "tutorialTab" : "inspectorTab").focus();
}));
document.querySelectorAll("[data-guide-target]").forEach((button) => {
  button.onclick = () => {
    showWorkspace(false);
    const target = $(button.dataset.guideTarget);
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.focus({ preventScroll: true });
  };
});

// ---- repair a failed step --------------------------------------------------------------------

/** After a replay that could not find a control: offer replacement locators from the screen saved at the failure. */
function offerRepair(runId, result) {
  const box = $("repair");
  box.replaceChildren();
  box.hidden = true;
  // A missing control is reported as "did not appear" or, for a tap that waits for it, "could not be used".
  const failure = (result.failed || []).find((f) => f.step && ["element-not-found", "element-not-interactable"].includes(f.diagnosis?.kind));
  if (!failure) return;
  const b = document.createElement("button");
  b.className = "primary";
  b.textContent = `Repair step ${failure.step.split(".")[0]}: find its control again`;
  b.onclick = () => task(() => showRepair(runId));
  box.append(b);
  box.hidden = false;
}

async function showRepair(runId) {
  const r = await api("repair/suggest", { id: runId });
  const box = $("repair");
  box.replaceChildren();
  const head = document.createElement("p");
  head.textContent = `Step ${r.step.number} (${r.step.type.replaceAll("_", " ")} · ${r.step.title}) used ${r.step.locator}. On the screen saved at the failure it matches ${r.originalMatches ?? "an unknown number of"} control${r.originalMatches === 1 ? "" : "s"}.`;
  box.append(head);
  const caution = document.createElement("p");
  caution.className = "muted";
  caution.textContent = `${r.activity ? `The app was on ${r.activity} when the test failed. ` : ""}Check the picture: if this is not the screen where you recorded the step, the test went wrong earlier, and a new locator here would be the wrong fix.`;
  box.append(caution);
  if (r.note) {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = r.note;
    box.append(note);
  }
  // The screen saved at the failure, with every suggested control outlined and numbered.
  if (r.screen.img && r.screen.width && r.screen.height) {
    const shot = document.createElement("div");
    shot.className = "repair-shot";
    const img = document.createElement("img");
    img.src = r.screen.img;
    img.alt = "Screen when the test failed";
    shot.append(img);
    r.suggestions.forEach((s, i) => {
      if (!s.bounds) return;
      const mark = document.createElement("div");
      mark.className = "match";
      mark.textContent = String(i + 1);
      Object.assign(mark.style, {
        left: pct(s.bounds.x, r.screen.width),
        top: pct(s.bounds.y, r.screen.height),
        width: pct(s.bounds.w, r.screen.width),
        height: pct(s.bounds.h, r.screen.height),
      });
      shot.append(mark);
    });
    box.append(shot);
  }
  if (!r.suggestions.length) {
    const none = document.createElement("p");
    none.className = "muted";
    none.textContent = "No control on that screen resembles the recorded one closely enough to suggest. Attach, open the screen and record the step again.";
    box.append(none);
  }
  for (const [i, s] of r.suggestions.entries()) {
    const row = document.createElement("div");
    row.className = "suggestion";
    const text = document.createElement("span");
    text.textContent = `${i + 1}. ${s.label} · ${s.similarity}% similar · ${s.reasons.join("; ")}\n${s.strategy}: ${s.value}`;
    const apply = document.createElement("button");
    apply.textContent = "Use this locator";
    apply.onclick = () =>
      task(async () => {
        const done = await api("repair/apply", { id: runId, index: s.index, strategy: s.strategy, value: s.value });
        steps = done.steps;
        renderSteps();
        await status();
        box.replaceChildren();
        box.hidden = true;
        if (done.conflicts.length) notice(`Step ${done.step} was updated, but edited files were preserved. Review the .vortex-new files before replay.`, true);
        else notice(`Step ${done.step} now uses ${done.locator}. The test was saved again: run it to confirm.`);
      });
    row.append(text, apply);
    box.append(row);
  }
  notice(r.suggestions.length ? "Choose the control this step meant. Nothing changes until you pick one." : "No replacement could be suggested.", !r.suggestions.length);
}

// ---- live status -----------------------------------------------------------------------------
// The server says "something changed"; the page then reads the status as usual. If the stream cannot be
// opened the page still works: every action refreshes what it changed.

let liveTimer = null;
function liveRefresh() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(async () => {
    if (busy) return liveRefresh(); // an action is in flight: it will render its own result first
    try {
      await status();
      if ($("serverDialog").open) await loadLog();
    } catch {
      // the recorder is restarting or stopped: the next event tries again
    }
  }, 150);
}
try {
  new EventSource("/api/events").addEventListener("change", liveRefresh);
} catch {
  // no live updates in this browser
}

// ---- shortcuts -------------------------------------------------------------------------------

$("shortcuts").onclick = () => $("shortcutsDialog").showModal();
$("shortcutsClose").onclick = () => $("shortcutsDialog").close();
document.addEventListener("keydown", (e) => {
  if ($("inspectorView").hidden) return;
  if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector("dialog[open]")) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
  const run = {
    "/": () => { $("advancedInspect").open = true; $("locatorSearch").focus(); },
    q: () => {
      $("quick").checked = !$("quick").checked;
      $("quick").onchange();
    },
    t: () => { showActionPane("tap"); task(() => act("tap")); },
    f: () => showActionPane("type", true),
    a: () => { showActionPane("assert"); task(() => assertNow("visible")); },
    v: () => { $("advancedInspect").open = true; $("verify").click(); },
    r: () => task(refresh),
    u: () => $("undo").click(),
    s: () => $("save").click(),
    "?": () => $("shortcutsDialog").showModal(),
  }[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (!run) return;
  e.preventDefault();
  run();
});

// ---- start-up --------------------------------------------------------------------------------

await task(async () => {
  let listError = null;
  await discover().catch((e) => (listError = e));
  const s = await status();
  if (s.pkg) $("pkg").value = s.pkg;
  if (s.screen) renderScreen(s.screen);
  if (s.active.length) {
    activeRun = s.active[0].id;
    pollRun();
  }
  if (s.restored && !s.session.open) {
    const when = s.restored.savedAt ? ` from ${new Date(s.restored.savedAt).toLocaleString()}` : "";
    notice(`Restored ${s.restored.steps} unsaved step${s.restored.steps === 1 ? "" : "s"}${when}. Attach to continue, save it, or Clear to start again.`);
  } else if (listError) notice(`${listError.message}\nOpen Server & setup and run the setup check.`, true);
  else notice(s.session.open ? "Attached. Select a control to inspect." : "Start or connect Appium in Server & setup, then attach your phone.");
});
