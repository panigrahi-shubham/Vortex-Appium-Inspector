// Minimal HTTP calls to an Appium server: readiness and session deletion. No other dependencies.

export interface AppiumStatus {
  ready: boolean;
  version: string | null;
  message: string;
}

export interface AppiumHttp {
  status(host: string, port: number, timeoutMs?: number): Promise<AppiumStatus | null>;
  deleteSession(host: string, port: number, sessionId: string, timeoutMs?: number): Promise<void>;
}

const urlHost = (host: string) => (host.includes(':') && !host.startsWith('[') ? `[${host}]` : host);

export const SESSION_ID = /^[A-Za-z0-9-]{1,128}$/;

export function createAppiumHttp(fetchFn: typeof fetch = fetch): AppiumHttp {
  return {
    async status(host, port, timeoutMs = 2_000) {
      try {
        const r = await fetchFn(`http://${urlHost(host)}:${port}/status`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!r.ok) return null;
        const j = (await r.json()) as { value?: { ready?: boolean; message?: string; build?: { version?: string } } };
        if (!j || typeof j !== 'object' || !j.value) return null; // something answers, but it is not Appium
        return { ready: j.value.ready !== false, version: j.value.build?.version ?? null, message: j.value.message ?? '' };
      } catch {
        return null;
      }
    },
    async deleteSession(host, port, sessionId, timeoutMs = 10_000) {
      if (!SESSION_ID.test(sessionId)) throw new Error('invalid session id');
      const r = await fetchFn(`http://${urlHost(host)}:${port}/session/${sessionId}`, { method: 'DELETE', signal: AbortSignal.timeout(timeoutMs) });
      // 404 means the session is already gone, which is the state we want.
      if (!r.ok && r.status !== 404) throw new Error(`DELETE /session/${sessionId} returned HTTP ${r.status}`);
    },
  };
}

/** Appium releases this build has been checked against. Others may work but are reported as unverified. */
export function compatibility(version: string | null): { ok: boolean; note: string } {
  if (!version) return { ok: false, note: 'version unknown' };
  const major = Number(version.split('.')[0]);
  if (major === 3 || major === 2) return { ok: true, note: `Appium ${version}` };
  return { ok: false, note: `Appium ${version} has not been verified with Vortex (expected 2.x or 3.x)` };
}
