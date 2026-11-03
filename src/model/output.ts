// Types shared by every generator that reads the recording model.

import type { RecordedEvent } from './recording.ts';

export type Framework = 'appium';
export type Variant = 'plain' | 'pom';

export interface GeneratedFile {
  /** Path relative to the case folder, always with forward slashes. */
  path: string;
  content: string;
  framework: Framework;
  variant: Variant;
  /** 'entry' = the runnable test file; 'support' = pages, fixtures, data, config. */
  role: 'entry' | 'support';
}

export interface GenerationIssue {
  framework: Framework;
  variant: Variant;
  step: number;
  message: string;
}

export class GenerationError extends Error {
  code = 'VALIDATION';
  httpStatus = 422;
  issues: GenerationIssue[];
  constructor(issues: GenerationIssue[]) {
    super(`${issues.length} problem(s) prevent code generation: ` + issues.map((i) => `${i.framework} ${i.variant}, step ${i.step}: ${i.message}`).join('; '));
    this.issues = issues;
  }
}

export function describeEvent(e: RecordedEvent): string {
  const t = e.title ? ` "${e.title}"` : '';
  const a = e.action;
  switch (a.type) {
    case 'tap': return `Tap${t}`;
    case 'longpress': return `Long-press${t}`;
    case 'doubletap': return `Double-tap${t}`;
    case 'swipe': return `Swipe ${a.direction ?? ''}`.trim();
    case 'scroll_to': return `Scroll to${t}`;
    case 'type': return `Type into${t}${e.input?.secretEnv ? ' (sensitive)' : ''}`;
    case 'press': return `Press ${a.key ?? ''}`.trim();
    case 'wait_visible': return `Wait for${t} to appear`;
    case 'wait_hidden': return `Wait for${t} to disappear`;
    case 'sleep': return `Wait ${a.ms ?? ''} ms`;
    case 'assert': return `Check${t} (${e.check?.kind ?? ''})`;
    case 'clear': return `Clear${t}`;
    case 'hide_keyboard': return 'Hide the keyboard';
    case 'launch_app': return 'Launch the app';
    case 'close_app': return 'Close the app';
    case 'deep_link': return `Open ${a.url ?? 'deep link'}`;
    case 'wait_enabled': return `Wait until${t} is enabled`;
    case 'check_activity': return `Check the screen is ${a.activity ?? ''}`.trim();
    case 'checkpoint': return `Screenshot checkpoint "${a.name ?? 'checkpoint'}"`;
    default: return a.type;
  }
}

/** Swipe geometry from the recorded start/end points: dominant direction, distance along that axis. */
export function swipeGeometry(e: RecordedEvent): { direction: 'up' | 'down' | 'left' | 'right'; distance: number; startX: number; startY: number; durationMs?: number } | null {
  const { from, to, durationMs } = e.action;
  if (!from || !to || ![from.x, from.y, to.x, to.y].every(Number.isFinite)) return null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const vertical = Math.abs(dy) >= Math.abs(dx);
  const direction = vertical ? (dy < 0 ? 'up' : 'down') : dx < 0 ? 'left' : 'right';
  return { direction, distance: Math.round(Math.abs(vertical ? dy : dx)), startX: Math.round(from.x), startY: Math.round(from.y), ...(durationMs ? { durationMs: Math.round(durationMs) } : {}) };
}

/** True when the event acts on a recorded position rather than through a locator. */
export function isCoordinateEvent(e: RecordedEvent): boolean {
  const coordTarget = !e.target || e.target.kind === 'coordinate';
  if (coordTarget) return true;
  return e.action.type === 'tap' && e.tapStyle === 'coord';
}
