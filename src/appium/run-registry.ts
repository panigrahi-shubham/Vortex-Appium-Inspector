// Tracks test runs that depend on an Appium server, so the server cannot be stopped under a running test
// and so a run is failed (never left hanging) if its server dies.

export interface RunHandle {
  id: string;
  serverId: string;
  label: string;
  startedAt: string;
  /** Asks the runner to stop. Must resolve once the run has stopped (or give up). */
  cancel: () => Promise<void>;
  /** Called when the server the run depends on is gone. The runner must fail the run. */
  onServerLost: (reason: string) => void;
}

export interface RunSummary {
  id: string;
  serverId: string;
  label: string;
  startedAt: string;
}

export class RunRegistry {
  #runs = new Map<string, RunHandle>();

  register(run: RunHandle): { complete: () => void } {
    if (this.#runs.has(run.id)) throw new Error(`run ${run.id} is already registered`);
    this.#runs.set(run.id, run);
    return { complete: () => void this.#runs.delete(run.id) };
  }

  activeFor(serverId: string): RunSummary[] {
    return [...this.#runs.values()].filter((r) => r.serverId === serverId).map(({ id, serverId: s, label, startedAt }) => ({ id, serverId: s, label, startedAt }));
  }

  all(): RunSummary[] {
    return [...this.#runs.values()].map(({ id, serverId, label, startedAt }) => ({ id, serverId, label, startedAt }));
  }

  async cancelFor(serverId: string, timeoutMs: number): Promise<{ id: string; ok: boolean; detail: string }[]> {
    const runs = [...this.#runs.values()].filter((r) => r.serverId === serverId);
    return Promise.all(
      runs.map(async (r) => {
        try {
          await withTimeout(r.cancel(), timeoutMs, `run ${r.id} did not stop within ${timeoutMs} ms`);
          this.#runs.delete(r.id);
          return { id: r.id, ok: true, detail: 'cancelled' };
        } catch (e) {
          return { id: r.id, ok: false, detail: (e as Error).message };
        }
      }),
    );
  }

  /** The server died: tell every dependent run, then forget them. Returns the ids that were failed. */
  failFor(serverId: string, reason: string): string[] {
    const ids: string[] = [];
    for (const r of [...this.#runs.values()]) {
      if (r.serverId !== serverId) continue;
      try {
        r.onServerLost(reason);
      } catch {
        /* a broken listener must not stop the others */
      }
      this.#runs.delete(r.id);
      ids.push(r.id);
    }
    return ids;
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
