// Saved tests: generating and saving code, loading a saved recording, replay, the shared page library,
// page objects for a whole screen, and repairing a step whose control was not found.

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { anchorCandidates } from '../engines/appium/anchor-locators.ts';
import type { AppiumInspector } from '../engines/appium/inspector.ts';
import { parsePageSource } from '../engines/appium/page-source.ts';
import type { PytestRunner, RunResult } from '../engines/appium/pytest-runner.ts';
import { SHARED_PAGES_DIR } from '../engines/appium/python-project.ts';
import { countMatches, suggestRepairs } from '../engines/appium/repair.ts';
import { buildScreenPage } from '../engines/appium/screen-page.ts';
import { fromUiSteps, slug, type LocatorParts, type UiStep } from '../model/recording.ts';
import { buildCase, caseDir, readCaseRecording, readManifest, saveCase, type CaseRef, type Manifest, type Mode, type SharedOutput } from '../project/project.ts';
import { pendingLibraryReview, readLibrary, writeLibrary } from '../project/shared-library.ts';
import type { LocatorHistory } from './locator-history.ts';
import { assertPackage, problem, VERSION } from './problem.ts';
import type { RecordingStore } from './recording-store.ts';
import type { SessionService } from './session-service.ts';

export interface ProjectDeps {
  outDir: string;
  inspector: AppiumInspector;
  runner: PytestRunner;
  session: SessionService;
  recording: RecordingStore;
  history: LocatorHistory;
}

interface BuildInput {
  steps: UiStep[];
  recordingId: string;
  name: string;
  ref: CaseRef;
  pkg: string;
  serial: string | null;
  size: { width: number; height: number } | null;
  mode: Mode;
  target: 'plain' | 'pom';
  sharedPages: boolean;
}

/** A saved POM test uses the shared library when it has no base page of its own. */
const usesSharedPages = (m: Manifest | null) => !!m && m.mode !== 'plain' && !Object.keys(m.files).some((f) => /^appium\/pom\/pages\/[^/]+\/base_page\.py$/.test(f));
const GENERATOR = `vortex-appium-inspector ${VERSION}`;

export class ProjectService {
  readonly #d: ProjectDeps;
  /** Which saved test each run started in this session belongs to (needed for history and repair). */
  readonly #runRefs = new Map<string, CaseRef>();

  constructor(deps: ProjectDeps) {
    this.#d = deps;
  }

  // ---- generate and save -----------------------------------------------------------------------

  #build(input: BuildInput) {
    const recording = fromUiSteps(input.steps, { id: input.recordingId, name: input.name, module: input.ref.module, appPackage: input.pkg, serial: input.serial, screen: input.size, version: VERSION });
    const library = input.sharedPages && input.mode !== 'plain' ? readLibrary(this.#d.outDir, input.pkg) : null;
    const built = buildCase(recording, input.ref, { frameworks: ['appium'], mode: input.mode, target: input.target, size: input.size, library });
    if (built.issues.length) throw Object.assign(problem('Fix the recording before generation.', 'VALIDATION', 422), { issues: built.issues });
    return { ref: input.ref, recording, mode: input.mode, ...built };
  }

  #save(input: BuildInput) {
    const built = this.#build(input);
    const saved = saveCase(this.#d.outDir, built.ref, { ...built, frameworks: ['appium'], assets: [], generator: GENERATOR });
    const library = built.shared ? writeLibrary(this.#d.outDir, input.pkg, built.shared) : null;
    // A shared page edited by hand is reported like an edited file of the test itself.
    if (library) saved.conflicts.push(...library.conflicts.map((f) => ({ path: `_shared/${f}`, newFile: `_shared/${f}.vortex-new`, reason: 'edited' as const })));
    return { ...built, saved, library };
  }

  #current(body: Record<string, unknown>): BuildInput {
    const { recording, session } = this.#d;
    if (!recording.steps.length) throw problem('Record at least one step before saving.');
    const name = String(body.name || 'recorded flow');
    return {
      steps: recording.steps,
      recordingId: recording.recordingId,
      name,
      ref: { module: slug(String(body.module || 'general')), case: slug(name) },
      pkg: recording.pkg,
      serial: session.serial,
      size: recording.recordedSize,
      mode: body.mode === 'pom' ? 'pom' : body.mode === 'both' ? 'both' : 'plain',
      target: body.target === 'pom' ? 'pom' : 'plain',
      sharedPages: body.sharedPages === true,
    };
  }

  /** Shared page files shown in the preview, with the path they will have under the output folder. */
  #sharedPreview(built: { shared: SharedOutput | null }) {
    return (built.shared?.files ?? []).map((f) => ({ path: `_shared/${f.path}`, content: f.content, framework: 'appium' as const, variant: 'pom' as const, role: 'support' as const }));
  }

  build(body: Record<string, unknown>) {
    const built = this.#build(this.#current(body));
    return { ...built, sharedFiles: this.#sharedPreview(built) };
  }

  save(body: Record<string, unknown>) {
    const result = this.#save(this.#current(body));
    return { ...result, sharedFiles: this.#sharedPreview(result) };
  }

  /** Creates a saved, empty starter without overwriting a case or discarding steps on failure. */
  create(body: Record<string, unknown>) {
    const { recording, session, runner, inspector, outDir } = this.#d;
    if (runner.active().length) throw problem('Wait for the active replay before creating a file.', 'RUN_ACTIVE', 409);
    const name = String(body.name ?? '').trim();
    const module = String(body.module ?? '').trim();
    if (!name || !module) throw problem('Enter a test name and module.');
    const pkg = String(body.pkg || recording.pkg);
    assertPackage(pkg);
    if (inspector.status().open && recording.pkg !== pkg) throw problem('Detach before creating a file for a different app.', 'RECORDING_TARGET', 409);
    const ref = { module: slug(module), case: slug(name) };
    if (fs.existsSync(caseDir(outDir, ref))) throw problem('A test with this name already exists in that module. Choose another name or load the saved test.', 'TEST_EXISTS', 409);
    const input: BuildInput = {
      steps: [], recordingId: randomUUID(), name, ref, pkg, serial: session.serial,
      size: recording.recordedSize, mode: body.mode === 'pom' ? 'pom' : body.mode === 'both' ? 'both' : 'plain',
      target: 'plain', sharedPages: false,
    };
    const result = this.#save(input);
    recording.replace({ steps: [], pkg, recordingId: input.recordingId, recordedSize: input.size });
    return { ...result, steps: [], sharedFiles: [], name, module: ref.module, pkg };
  }

  load(body: { module: unknown; case: unknown }) {
    const { runner, inspector, recording, outDir } = this.#d;
    if (runner.active().length) throw problem('Wait for the active replay before loading another test.', 'RUN_ACTIVE', 409);
    const loaded = readCaseRecording(outDir, { module: String(body.module), case: String(body.case) });
    if (inspector.status().open && recording.pkg !== loaded.recording.app.package) throw problem('Detach the current session before loading a different app.', 'RECORDING_TARGET', 409);
    recording.replace({ steps: loaded.steps, pkg: loaded.recording.app.package, recordingId: loaded.recording.id, recordedSize: loaded.recording.device.screen });
    return { steps: recording.steps, name: loaded.recording.name, module: loaded.recording.module, pkg: recording.pkg, mode: loaded.manifest?.mode || 'plain', sharedPages: usesSharedPages(loaded.manifest ?? null) };
  }

  // ---- replay ------------------------------------------------------------------------------------

  async run(body: { module: unknown; case: unknown }) {
    const { runner, session, recording, outDir } = this.#d;
    if (runner.active().length) throw problem('A test is already running.', 'RUN_ACTIVE', 409);
    const ref = { module: String(body.module), case: String(body.case) };
    const dir = caseDir(outDir, ref), manifest = readManifest(dir);
    if (!manifest) throw problem('Save this test first.');
    if (!readCaseRecording(outDir, ref).steps.length) throw problem('This file is an empty starter. Record at least one step and Save test before replaying.', 'EMPTY_TEST', 409);
    if (!session.serial || !recording.pkg) throw problem('Connect a phone and app first.');
    const entries = Object.entries(manifest.files).filter(([, v]) => v.role === 'entry' && v.discoverable);
    if (Object.keys(manifest.files).some((p) => fs.existsSync(path.join(dir, p + '.vortex-new')))) throw problem('This case has edited files awaiting review. Resolve .vortex-new files before replay.', 'PENDING_REVIEW', 409);
    if (usesSharedPages(manifest)) {
      const pending = pendingLibraryReview(outDir);
      if (pending.length) throw problem(`The shared page library has edited files awaiting review: ${pending.join(', ')}. Merge or replace them, delete the .vortex-new files, then replay.`, 'PENDING_REVIEW', 409);
    }
    if (entries.length !== 1) throw problem('The saved test needs exactly one active entry file.');
    // The recorder session is explicitly handed off to pytest; the Appium server stays warm.
    await session.stop();
    const started = await runner.start({ testsDir: outDir, file: path.relative(outDir, path.join(dir, entries[0][0])), serial: session.serial, appPackage: recording.pkg, timeoutMs: 15 * 60_000 });
    this.#runRefs.set(started.id, ref);
    const pkg = recording.pkg;
    void runner.wait(started.id).then((result) => this.#remember(started.id, ref, pkg, result)).catch(() => {});
    return started;
  }

  /**
   * The recorded step a replay failed in, from a label such as `7. Check "Role" (text)`.
   * `locatorSuspect` is true when the failure says the control did not appear or could not be used: both are
   * what a test reports when its locator matches nothing (a tap waits for "clickable" and times out).
   */
  #failedStepNumber(result: RunResult): { number: number; locatorSuspect: boolean } | null {
    const f = result.failed.find((x) => x.step);
    const n = f?.step ? Number(/^(\d+)\./.exec(f.step)?.[1]) : NaN;
    const kind = f?.diagnosis?.kind;
    return f && Number.isInteger(n) && n > 0 ? { number: n, locatorSuspect: kind === 'element-not-found' || kind === 'element-not-interactable' } : null;
  }

  /** The screen the pytest plugin saved when the test failed, if it did. */
  #failureScreen(runId: string, result: RunResult) {
    const file = result.artifacts.find((a) => a.type === 'page-source' && a.file && /^[\w.-]+$/.test(a.file))?.file;
    if (!file) return null;
    const xml = fs.readFileSync(path.join(this.#d.runner.get(runId).dir, file), 'utf8');
    return { xml, ps: parsePageSource(xml) };
  }

  /** Records which locators a replay found, for locator ranking. Only clear evidence is kept. */
  async #remember(runId: string, ref: CaseRef, pkg: string, result: RunResult) {
    try {
      const steps = readCaseRecording(this.#d.outDir, ref).steps;
      const failed = this.#failedStepNumber(result);
      let reached: number;
      if (result.status === 'passed') reached = steps.length;
      else if (result.status === 'failed' && failed) reached = failed.number - 1;
      else return; // cancelled, timed out, import error: nothing is known about the locators
      const native = (s: UiStep): LocatorParts | null => (s.context !== 'WEBVIEW' && s.target?.parts && s.target.kind !== 'coordinate' ? (s.target.parts as LocatorParts) : null);
      const outcomes: { parts: LocatorParts; found: boolean }[] = [];
      steps.slice(0, reached).forEach((s) => {
        const parts = native(s);
        // A step that asserts absence proves nothing about whether the locator finds the control.
        if (parts && !(s.type === 'wait_hidden' || (s.type === 'assert' && s.args?.assertion === 'hidden'))) outcomes.push({ parts, found: true });
      });
      if (failed?.locatorSuspect && steps[failed.number - 1]) {
        // "Not found" is recorded only when the screen saved at the failure shows the locator matching nothing.
        const parts = native(steps[failed.number - 1]);
        const screen = parts ? this.#failureScreen(runId, result) : null;
        if (parts && screen && (await countMatches(parts, screen.ps, screen.xml)) === 0) outcomes.push({ parts, found: false });
      }
      this.#d.history.record(pkg, outcomes);
    } catch (e) {
      console.error('[vortex] could not record replay evidence:', (e as Error).message);
    }
  }

  // ---- repair a failed step ----------------------------------------------------------------------

  async #repairContext(runId: unknown) {
    const { runner, outDir } = this.#d;
    const id = String(runId ?? '');
    const run = runner.get(id);
    const ref = this.#runRefs.get(id);
    if (!ref) throw problem('Repair is available for a replay started in this session. Run the saved test again.', 'NO_REPAIR', 409);
    if (!run.result) throw problem('The replay is still running.', 'RUN_ACTIVE', 409);
    const failed = this.#failedStepNumber(run.result);
    if (!failed) throw problem('The replay did not fail in a recorded step, so there is no step to repair.', 'NO_REPAIR', 409);
    if (!failed.locatorSuspect) throw problem(`Step ${failed.number} failed for another reason than a missing control (see the run result). Repair only replaces locators.`, 'NO_REPAIR', 409);
    const loaded = readCaseRecording(outDir, ref);
    const step = loaded.steps[failed.number - 1];
    const parts = step?.context !== 'WEBVIEW' && step?.target?.kind !== 'coordinate' ? (step?.target?.parts as LocatorParts | undefined) : undefined;
    if (!step || !parts) throw problem(`Step ${failed.number} has no native locator to repair.`, 'NO_REPAIR', 409);
    const screen = this.#failureScreen(id, run.result);
    if (!screen) throw problem('The replay did not save the screen at the failure, so no replacement can be suggested. Attach, open that screen and record the step again.', 'NO_REPAIR', 409);
    const { xml, ps } = screen;
    const report = await suggestRepairs({ type: step.type, title: step.title ?? '', parts }, ps, xml, loaded.recording.app.package);
    const pngFile = run.result.artifacts.find((a) => a.type === 'screenshot' && a.file && /^[\w.-]+$/.test(a.file))?.file;
    // Which screen the app was on when the test failed (written by the pytest plugin), to spot a wrong-screen failure.
    let activity: string | null = null;
    try {
      for (const line of fs.readFileSync(path.join(run.dir, 'artifacts.jsonl'), 'utf8').split('\n')) {
        const rec = line.trim() ? (JSON.parse(line) as { type?: string; activity?: string }) : null;
        if (rec?.type === 'state' && rec.activity) activity = rec.activity;
      }
    } catch {
      /* optional */
    }
    return { id, ref, loaded, step, parts, number: failed.number, ps, report, activity, pngFile: pngFile ? path.join(run.dir, pngFile) : null };
  }

  /** Suggests replacement locators for the step a replay could not find, from the screen saved at the failure. */
  async repairSuggest(body: Record<string, unknown>) {
    const c = await this.#repairContext(body.id);
    let img: string | null = null;
    try {
      if (c.pngFile) img = `data:image/png;base64,${fs.readFileSync(c.pngFile).toString('base64')}`;
    } catch {
      /* the screenshot is optional */
    }
    return {
      runId: c.id,
      ref: c.ref,
      step: { number: c.number, type: c.step.type, title: c.step.title, locator: `${c.parts.by}: ${c.parts.value}${c.parts.index !== undefined ? ` [${c.parts.index + 1}]` : ''}` },
      originalMatches: c.report.originalMatches,
      /** Screen (activity) the app showed when the test failed. A repair is right only if this is the screen the step was recorded on. */
      activity: c.activity,
      note:
        c.report.originalMatches === 1
          ? 'The old locator matches exactly one control on the screen saved at the failure. The locator is probably not the cause: the control may have been covered or disabled, or the screen appeared late. Add a wait or an assertion before this step.'
          : null,
      suggestions: c.report.suggestions.map(({ parts: _parts, ...s }) => s),
      screen: { width: c.ps.width, height: c.ps.height, img },
    };
  }

  /** Replaces the failed step's locator with the chosen suggestion and saves the test again. */
  async repairApply(body: Record<string, unknown>) {
    const { outDir, recording } = this.#d;
    const c = await this.#repairContext(body.id);
    const pick = c.report.suggestions.find((s) => s.index === Number(body.index) && s.strategy === body.strategy && s.value === body.value);
    if (!pick) throw problem('Choose one of the suggested locators.');
    const manifest = c.loaded.manifest ?? readManifest(caseDir(outDir, c.ref));
    if (!manifest) throw problem('The saved test has no manifest. Save it again from the recorder.');
    const steps = c.loaded.steps.map((s, i) => (i === c.number - 1 ? { ...s, target: { kind: pick.parts.by === 'id' ? 'testId' : pick.parts.by, parts: pick.parts } } : s)) as UiStep[];
    const result = this.#save({
      steps,
      recordingId: c.loaded.recording.id,
      name: c.loaded.recording.name,
      ref: c.ref,
      pkg: c.loaded.recording.app.package,
      serial: c.loaded.recording.device.serial,
      size: c.loaded.recording.device.screen,
      mode: manifest.mode,
      target: manifest.target === 'pom' ? 'pom' : 'plain',
      sharedPages: usesSharedPages(manifest),
    });
    // Keep the recording open in the recorder in step with the file that was just saved.
    if (recording.recordingId === c.loaded.recording.id && recording.steps.length === steps.length) recording.replace({ steps, pkg: recording.pkg, recordingId: recording.recordingId, recordedSize: recording.recordedSize });
    return { ref: c.ref, step: c.number, locator: `${pick.strategy}: ${pick.value}`, conflicts: result.saved.conflicts, steps: recording.steps };
  }

  // ---- page object for a whole screen ----------------------------------------------------------

  /** Builds a page object for every usable control on the captured screen; `save` writes it under <out>/screens. */
  async screenPage(body: Record<string, unknown>) {
    const { session, recording, inspector, outDir } = this.#d;
    session.requireScreen(body.token);
    if (!recording.pkg) throw problem('Attach to an app first.');
    const { ps, xml } = inspector.cachedSource();
    // Controls with no id or label of their own can still be found from a nearby label.
    const anchors = new Map<number, { value: string; label: string }>();
    for (const n of ps.nodes) {
      if (n.resourceId || n.contentDesc || !(n.flags.clickable || n.flags.checkable || /EditText$/.test(n.className))) continue;
      const [anchor] = await anchorCandidates(n, ps, xml, 1);
      const label = anchor && /@text=(?:'([^']*)'|"([^"]*)")/.exec(anchor.value);
      if (anchor && label) anchors.set(n.index, { value: anchor.value, label: label[1] ?? label[2] ?? '' });
    }
    const page = buildScreenPage(ps, { name: String(body.name || 'screen').slice(0, 60), pkg: recording.pkg }, anchors);
    if (!body.save) return { ...page, saved: null, conflict: false };
    if (!page.elements.length) throw problem('No control with a stable locator was found on this screen, so there is nothing to save.');
    const dir = path.join(outDir, 'screens'), file = path.join(dir, page.fileName);
    if (path.dirname(path.resolve(file)) !== path.resolve(dir)) throw problem('Invalid screen name.');
    fs.mkdirSync(dir, { recursive: true });
    // Never overwrite a page object that was edited by hand: put the new version beside it for review.
    const conflict = fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== page.content;
    const target = conflict ? `${file}.vortex-new` : file;
    fs.writeFileSync(target, page.content, 'utf8');
    return { ...page, saved: path.relative(outDir, target).split(path.sep).join('/'), conflict };
  }
}

export { SHARED_PAGES_DIR };
