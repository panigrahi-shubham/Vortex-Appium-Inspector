import type { Session } from '../engines/appium/webdriver.ts';
import type { LocatorParts } from '../model/recording.ts';
import { targetFor } from './locator-service.ts';
import { delay, problem } from './problem.ts';
import type { Snapshot, Target } from './types.ts';

export function explicitScrollTarget(value: unknown, web: boolean): Target {
  const p = value as LocatorParts | undefined;
  if (!p || !p.value || typeof p.value !== 'string' || p.value.length > 4000 || !(web ? ['css', 'xpath'] : ['id', 'label', 'text', 'xpath']).includes(p.by)) throw problem('Enter a supported locator for the scroll target. Native uses ID, label, text or XPath; WebView uses CSS or XPath.');
  if (web) return { using: p.by === 'css' ? 'css selector' : 'xpath', value: p.value, parts: { by: p.by, value: p.value, frames: p.frames ?? [] }, title: p.value };
  return targetFor({ by: p.by as 'id' | 'label' | 'text' | 'xpath', value: p.value }, p.value);
}

/** Recorder equivalent of the exported Python helper. Never substitutes a swipe for a recorded gesture. */
export async function scrollUntilVisible(session: Session, target: Target, screen: Snapshot, args: Record<string, unknown>, web: boolean, maxAttempts: number): Promise<number> {
  const direction = String(args.direction || 'down');
  const percent = Number(args.percent ?? 0.65);
  if (!['up', 'down', 'left', 'right'].includes(direction) || !Number.isFinite(percent) || percent <= 0 || percent > 1) throw problem('Invalid scroll direction or distance.');
  let container = args.scrollContainer ? explicitScrollTarget(args.scrollContainer, web) : null;
  if (!web && !container) {
    let scrollable = screen.nodes.filter(n => n.flags.scrollable && n.flags.displayed !== false);
    const targetNode = screen.nodes.find(n => target.parts.by === 'id' ? n.resourceId === target.parts.value : target.parts.by === 'xpath' ? n.path === target.parts.value : false);
    let current = targetNode;
    while (current) {
      if (current.flags.scrollable) { scrollable = [current]; break; }
      current = screen.nodes.find(n => n.index === current!.parent);
    }
    if (scrollable.length > 1) throw problem('Multiple scroll containers are visible. Choose a container in Reliability settings.', 'AMBIGUOUS_SCROLL', 409);
    if (scrollable.length === 1) {
      const n = scrollable[0];
      container = targetFor(n.resourceId && screen.nodes.filter(x => x.resourceId === n.resourceId).length === 1 ? { by: 'id', value: n.resourceId } : { by: 'xpath', value: n.path }, n.resourceId || n.className);
      args.scrollContainer = container.parts;
    }
  }
  args.maxScrolls = maxAttempts;
  args.percent = percent;
  args.direction = direction;
  let canScroll = true, previous = '', unchanged = 0;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const deadline = Date.now() + 1000;
    do {
      const found = await session.findElements(target.using, target.value);
      if (found.length > 1) throw problem('Scroll target is ambiguous. Choose a unique locator.', 'NOT_UNIQUE', 409);
      if (found.length === 1 && await session.displayed(found[0])) {
        const inViewport = !web || await session.executeArgs(`
          const el=arguments[0],r=el.getBoundingClientRect();
          let left=0,top=0,right=innerWidth,bottom=innerHeight;
          for(let p=el.parentElement;p;p=p.parentElement){const s=getComputedStyle(p),b=p.getBoundingClientRect();
            if(/(auto|scroll|hidden|clip)/.test(s.overflowX)){left=Math.max(left,b.left);right=Math.min(right,b.right);}
            if(/(auto|scroll|hidden|clip)/.test(s.overflowY)){top=Math.max(top,b.top);bottom=Math.min(bottom,b.bottom);}}
          const x=r.left+r.width/2,y=r.top+r.height/2;
          return r.width>0&&r.height>0&&x>=left&&x<=right&&y>=top&&y<=bottom;
        `, [{ element: found[0] }]);
        if (inViewport) return found.length;
      }
      await delay(150);
    } while (Date.now() < deadline);
    if (!canScroll || attempt === maxAttempts) throw problem(`Control not visible: ${!canScroll ? 'end of scroll' : 'attempt limit'} after ${attempt} scrolls. Locator: ${target.value}`, 'NOT_VISIBLE', 422);
    let owner: string | null = null;
    if (container) {
      const found = await session.findElements(container.using, container.value);
      if (found.length !== 1 || !(await session.displayed(found[0]))) throw problem('Scroll container must match one visible control.', 'NOT_UNIQUE', 409);
      owner = found[0];
    }
    let current: string;
    if (web) {
      const result = await session.executeArgs(`
        const a = {owner:arguments[0],by:arguments[1],value:arguments[2],direction:arguments[3],percent:arguments[4]}; let root = a.owner;
        if (!root) {
          const matches = a.by === 'css selector' ? document.querySelectorAll(a.value) :
            (() => { const r = document.evaluate(a.value, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); return Array.from({length:r.snapshotLength}, (_,i)=>r.snapshotItem(i)); })();
          if (matches.length > 1) throw Error('Ambiguous scroll target');
          for (let p = matches[0]?.parentElement; p; p = p.parentElement) {
            if (/(auto|scroll)/.test(getComputedStyle(p).overflowY + getComputedStyle(p).overflowX) && (p.scrollHeight > p.clientHeight || p.scrollWidth > p.clientWidth)) { root = p; break; }
          }
        }
        root = root || document.scrollingElement;
        const before = [root.scrollLeft, root.scrollTop], vertical = ['up','down'].includes(a.direction);
        const distance = (vertical ? root.clientHeight : root.clientWidth) * a.percent;
        root.scrollBy({left:vertical?0:(a.direction==='right'?distance:-distance), top:vertical?(a.direction==='down'?distance:-distance):0,behavior:'instant'});
        return {before,after:[root.scrollLeft,root.scrollTop]};
      `, [owner ? { element: owner } : null, target.using, target.value, direction, percent]) as { before: number[]; after: number[] };
      current = JSON.stringify(result.after);
      canScroll = JSON.stringify(result.before) !== current;
    } else {
      const window = await session.windowRect();
      const w = window.width, h = window.height;
      const rect = owner ? await session.rect(owner) : null;
      const left = Math.max(w * 0.1, rect?.x ?? 0), top = Math.max(h * 0.2, rect?.y ?? 0);
      const width = Math.min(w * 0.9, rect ? rect.x + rect.width : w) - left;
      const height = Math.min(h * 0.8, rect ? rect.y + rect.height : h) - top;
      if (width <= 0 || height <= 0) throw problem('Scroll container is outside the visible viewport.');
      const area = { left: Math.round(left), top: Math.round(top), width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
      const beforeSource = await session.pageSource();
      const finger = { down: 'up', up: 'down', left: 'right', right: 'left' }[direction];
      const result = await session.execute('mobile: swipeGesture', { ...area, direction: finger, percent });
      current = await session.pageSource();
      canScroll = result !== false || current !== beforeSource;
    }
    unchanged = current === previous ? unchanged + 1 : 0;
    previous = current;
    if (unchanged >= 2) canScroll = false;
  }
  throw problem('Scroll target was not visible.', 'NOT_VISIBLE', 422);
}
