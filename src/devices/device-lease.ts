// One owner per device at a time. The ADB recorder, an Appium inspection session and a test run all drive
// the phone's UI; two of them at once give wrong results (and `uiautomator dump` fails while UiAutomator2 runs).

export interface LeaseOwner {
  kind: 'run' | 'inspector' | 'recorder';
  id: string;
  label: string;
}

export class DeviceBusyError extends Error {
  code = 'DEVICE_BUSY';
  httpStatus = 409;
  owner: LeaseOwner;
  constructor(serial: string, owner: LeaseOwner) {
    super(`Device ${serial} is in use by ${owner.kind === 'run' ? `test run "${owner.label}"` : owner.kind === 'recorder' ? 'a recorder action' : 'the Appium Inspector'}. ${owner.kind === 'run' ? 'Wait for it to finish or cancel it' : owner.kind === 'recorder' ? 'Wait for the action to finish' : 'Close the Inspector'} first.`);
    this.owner = owner;
  }
}

export class DeviceLeases {
  #leases = new Map<string, LeaseOwner>();

  acquire(serial: string, owner: LeaseOwner): () => void {
    const cur = this.#leases.get(serial);
    if (cur && !(cur.kind === owner.kind && cur.id === owner.id)) throw new DeviceBusyError(serial, cur);
    this.#leases.set(serial, owner);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.#leases.get(serial)?.id === owner.id) this.#leases.delete(serial);
    };
  }

  holder(serial: string): LeaseOwner | null {
    return this.#leases.get(serial) ?? null;
  }

  /** Throws when someone other than `allow` holds the device. */
  assertFree(serial: string, allow?: { kind: string; id: string }) {
    const cur = this.#leases.get(serial);
    if (cur && !(allow && cur.kind === allow.kind && cur.id === allow.id)) throw new DeviceBusyError(serial, cur);
  }

  all() {
    return [...this.#leases.entries()].map(([serial, owner]) => ({ serial, ...owner }));
  }
}
