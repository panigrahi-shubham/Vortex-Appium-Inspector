// An append-only index of finished runs (both engines), so the history list can find reports that live in
// case folders (<case>/reports/<id>/) as well as in the recorder's own runs folder.

import fs from 'node:fs';
import path from 'node:path';

export interface RunIndexEntry {
  id: string;
  engine: 'appium';
  label: string;
  dir: string;
  status: string;
  summary: string;
  startedAt: string;
  durationMs: number;
}

export class RunIndex {
  readonly file: string;
  constructor(file: string) {
    this.file = file;
  }

  add(e: RunIndexEntry) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(e) + '\n');
    } catch {
      /* history is best-effort; result.json in the report folder is the record */
    }
  }

  list(limit = 50): RunIndexEntry[] {
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
    const out: RunIndexEntry[] = [];
    for (const l of lines.reverse()) {
      try {
        out.push(JSON.parse(l) as RunIndexEntry);
      } catch {
        /* skip a damaged line */
      }
      if (out.length >= limit) break;
    }
    return out;
  }
}

/** "# N. ..." (Python) or "// N. ..." (TypeScript) comment above a line inside the test body. */
export function stepAbove(fileText: string, line: number, bodyStart: RegExp, comment: RegExp): string | null {
  const lines = fileText.split(/\r?\n/);
  const start = lines.findIndex((l) => bodyStart.test(l));
  if (start < 0 || line - 1 <= start) return null;
  for (let i = Math.min(line - 1, lines.length - 1); i > start; i--) {
    const m = comment.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}
