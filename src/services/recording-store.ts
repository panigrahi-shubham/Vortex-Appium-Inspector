// The recording being built: its steps, the app it belongs to, and the autosave that lets an unsaved
// recording survive a crash or a closed terminal.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkpointName } from '../engines/appium/python-codegen.ts';
import type { UiStep } from '../model/recording.ts';
import { problem } from './problem.ts';

type Size = { width: number; height: number };

export class RecordingStore {
  steps: UiStep[] = [];
  recordingId: string = randomUUID();
  /** Package of the app the steps were recorded on. */
  pkg = '';
  recordedSize: Size | null = null;
  /** Set when an unsaved recording from an earlier run was restored on startup. */
  restored: { steps: number; savedAt: string } | null = null;
  readonly #file: string;

  constructor(stateDir: string) {
    this.#file = path.join(path.resolve(stateDir), 'autosave.json');
  }

  /** Best effort: a failed autosave must never fail the action that was just recorded. */
  persist() {
    try {
      if (!this.steps.length) {
        fs.rmSync(this.#file, { force: true });
        return;
      }
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), recordingId: this.recordingId, pkg: this.pkg, recordedSize: this.recordedSize, steps: this.steps }) + '\n', 'utf8');
      fs.renameSync(tmp, this.#file);
    } catch (e) {
      console.error('[vortex] autosave failed:', (e as Error).message);
    }
  }

  restore() {
    try {
      if (!fs.existsSync(this.#file)) return;
      const raw = JSON.parse(fs.readFileSync(this.#file, 'utf8')) as { version?: number; savedAt?: string; recordingId?: string; pkg?: string; recordedSize?: Size | null; steps?: UiStep[] };
      if (raw.version !== 1 || !Array.isArray(raw.steps) || !raw.steps.length) return;
      this.steps = raw.steps;
      this.pkg = String(raw.pkg || '');
      this.recordingId = String(raw.recordingId || randomUUID());
      this.recordedSize = raw.recordedSize ?? null;
      this.restored = { steps: raw.steps.length, savedAt: String(raw.savedAt || '') };
    } catch (e) {
      console.error('[vortex] could not restore the autosaved recording:', (e as Error).message);
    }
  }

  add(step: UiStep) {
    this.steps.push(step);
    this.persist();
  }

  /** Replaces the whole recording, for example when a saved test is loaded. */
  replace(next: { steps: UiStep[]; pkg: string; recordingId: string; recordedSize: Size | null }) {
    Object.assign(this, next);
    this.restored = null;
    this.persist();
  }

  undo() {
    this.steps.pop();
    this.persist();
    return { steps: this.steps };
  }

  clear() {
    this.steps = [];
    this.recordingId = randomUUID();
    this.restored = null;
    this.persist();
    return { steps: this.steps };
  }

  #index(value: unknown): number {
    const i = Number(value);
    if (!Number.isInteger(i) || i < 0 || i >= this.steps.length) throw problem('No such recorded step.');
    return i;
  }

  deleteStep(index: unknown) {
    this.steps.splice(this.#index(index), 1);
    this.persist();
    return { steps: this.steps };
  }

  moveStep(from: unknown, to: unknown) {
    const a = this.#index(from), b = this.#index(to);
    const [step] = this.steps.splice(a, 1);
    this.steps.splice(b, 0, step);
    this.persist();
    return { steps: this.steps };
  }

  /**
   * Changes the value of a recorded step without touching the phone: the text of a Fill, the expected value of
   * a check, the length of a wait, a deep link URL or a checkpoint name. Locators are changed by re-recording.
   */
  editStep(index: unknown, value: unknown) {
    const step = this.steps[this.#index(index)];
    const args = (step.args ??= {});
    const text = String(value ?? '');
    if (step.type === 'type') {
      if (step.secretEnv) {
        const name = text.trim().toUpperCase();
        if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) throw problem('Name the secret like an environment variable, for example VORTEX_SECRET_PASSWORD.');
        step.secretEnv = name;
      } else args.text = text;
    } else if (step.type === 'assert') {
      const kind = String(args.assertion);
      if (kind === 'count') {
        if (!/^\d+$/.test(text.trim())) throw problem('Count must be a whole number.');
        args.expected = Number(text.trim());
      } else if (kind === 'text' || kind === 'contains') args.expected = text;
      else throw problem(`A "${kind}" check has no value to edit.`);
    } else if (step.type === 'sleep') {
      const ms = Number(text);
      if (!Number.isFinite(ms) || ms < 0 || ms > 30_000) throw problem('Enter the wait in milliseconds, from 0 to 30000.');
      args.ms = Math.round(ms);
    } else if (step.type === 'deep_link') {
      if (!/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(text.trim())) throw problem('Enter a full link, for example myapp://orders/42 or https://example.com/path.');
      args.url = text.trim();
    } else if (step.type === 'checkpoint') args.name = checkpointName(text);
    else throw problem(`A "${step.type.replaceAll('_', ' ')}" step has no value to edit. Delete it and record it again.`);
    this.persist();
    return { steps: this.steps };
  }
}
