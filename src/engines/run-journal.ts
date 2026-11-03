// Journal of runs in progress. A run is written here when its process starts and removed when it finishes, so a run
// that was in progress when the recorder crashed can be found on the next start and cleaned up safely: its process is
// stopped only if the recorded identity (PID + start time + command line) still matches, and only the Appium sessions
// that run itself created are closed.

import fs from 'node:fs';
import path from 'node:path';
import type { ProcessIdentity } from '../appium/process-inspector.ts';

export interface JournalEntry {
  id: string;
  engine: 'appium';
  label: string;
  dir: string;
  serial: string;
  startedAt: string;
  process: ProcessIdentity | null;
  recorderPid?: number;
}

const folder = (runsDir: string) => path.join(runsDir, 'active');
const file = (runsDir: string, id: string) => path.join(folder(runsDir), `${id.replace(/[^A-Za-z0-9-]/g, '')}.json`);

export function journalBegin(runsDir: string, e: JournalEntry) {
  try {
    fs.mkdirSync(folder(runsDir), { recursive: true });
    fs.writeFileSync(file(runsDir, e.id), JSON.stringify({ ...e, recorderPid: process.pid }, null, 2));
  } catch {
    /* best effort: the run still works without a journal */
  }
}

export function recorderStillAlive(entry: JournalEntry): boolean {
  if (!Number.isInteger(entry.recorderPid) || entry.recorderPid! <= 0) return false;
  try { process.kill(entry.recorderPid!, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export function journalEnd(runsDir: string, id: string) {
  try {
    fs.rmSync(file(runsDir, id), { force: true });
  } catch {
    /* ignore */
  }
}

export function journalPending(runsDir: string): JournalEntry[] {
  try {
    return fs.readdirSync(folder(runsDir)).filter((f) => f.endsWith('.json')).flatMap((f) => {
      try {
        return [JSON.parse(fs.readFileSync(path.join(folder(runsDir), f), 'utf8')) as JournalEntry];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}
