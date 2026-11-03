// ADB device discovery and device details (model, Android version, screen, density, CPU ABIs).
// ABIs are reported exactly as the device lists them; nothing here guesses that a problem is caused by the ABI.

import { execFile } from 'node:child_process';

export type Transport = 'usb' | 'emulator' | 'network' | 'unknown';
export type Abi = 'arm64-v8a' | 'armeabi-v7a' | 'armeabi' | 'x86' | 'x86_64' | 'riscv64' | string;

export interface AdbDevice {
  serial: string;
  /** device | offline | unauthorized | no permissions | ... exactly as adb prints it */
  state: string;
  transport: Transport;
  model: string | null;
  product: string | null;
  deviceName: string | null;
  transportId: string | null;
}

export interface DeviceDetails extends AdbDevice {
  manufacturer: string | null;
  androidVersion: string | null;
  sdk: number | null;
  primaryAbi: Abi | null;
  abis: Abi[];
  abiFamily: 'arm' | 'x86' | 'mixed' | 'other' | 'unknown';
  screen: { width: number; height: number; overridden: boolean } | null;
  density: { dpi: number; overridden: boolean } | null;
  isEmulator: boolean;
}

const SERIAL = /^[A-Za-z0-9._:-]{1,128}$/;
export const assertSerial = (s: unknown): string => {
  const v = String(s ?? '');
  if (!SERIAL.test(v)) throw new Error(`invalid device serial: ${v}`);
  return v;
};

/** Parses `adb devices -l`. */
export function parseAdbDevices(out: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('List of devices') || line.startsWith('*')) continue;
    const m = /^(\S+)\s+(no permissions|unauthorized|offline|device|recovery|sideload|bootloader|host|authorizing|connecting|unknown)\b(.*)$/.exec(line);
    if (!m) continue;
    const [, serial, state, rest] = m;
    const kv: Record<string, string> = {};
    for (const part of rest.trim().split(/\s+/)) {
      const i = part.indexOf(':');
      if (i > 0) kv[part.slice(0, i)] = part.slice(i + 1);
    }
    let transport: Transport = 'unknown';
    if (/^emulator-\d+$/.test(serial)) transport = 'emulator';
    else if (kv.usb) transport = 'usb';
    else if (/^[\d.]+:\d+$/.test(serial) || serial.includes('._adb-tls-connect.')) transport = 'network';
    devices.push({ serial, state, transport, model: kv.model ?? null, product: kv.product ?? null, deviceName: kv.device ?? null, transportId: kv.transport_id ?? null });
  }
  return devices;
}

/** Parses `adb shell getprop` output: lines like `[ro.product.model]: [Pixel 7]`. */
export function parseGetprop(out: string): Map<string, string> {
  const props = new Map<string, string>();
  const re = /^\[([^\]]+)\]:\s*\[(.*)\]\s*$/;
  for (const line of out.split(/\r?\n/)) {
    const m = re.exec(line.trim());
    if (m) props.set(m[1], m[2]);
  }
  return props;
}

export function parseWmSize(out: string): { width: number; height: number; overridden: boolean } | null {
  const o = /Override size:\s*(\d+)x(\d+)/.exec(out);
  if (o) return { width: +o[1], height: +o[2], overridden: true };
  const p = /Physical size:\s*(\d+)x(\d+)/.exec(out);
  return p ? { width: +p[1], height: +p[2], overridden: false } : null;
}

export function parseWmDensity(out: string): { dpi: number; overridden: boolean } | null {
  const o = /Override density:\s*(\d+)/.exec(out);
  if (o) return { dpi: +o[1], overridden: true };
  const p = /Physical density:\s*(\d+)/.exec(out);
  return p ? { dpi: +p[1], overridden: false } : null;
}

export function abiFamily(abis: string[]): DeviceDetails['abiFamily'] {
  if (!abis.length) return 'unknown';
  const arm = abis.some((a) => a.startsWith('arm'));
  const x86 = abis.some((a) => a === 'x86' || a === 'x86_64');
  if (arm && x86) return 'mixed';
  if (arm) return 'arm';
  if (x86) return 'x86';
  return 'other';
}

export function detailsFrom(dev: AdbDevice, props: Map<string, string>, wmSize: string, wmDensity: string): DeviceDetails {
  const list = (props.get('ro.product.cpu.abilist') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const primary = props.get('ro.product.cpu.abi') || list[0] || null;
  const abis = list.length ? list : primary ? [primary] : [];
  const sdk = Number(props.get('ro.build.version.sdk'));
  const qemu = props.get('ro.kernel.qemu') === '1' || props.get('ro.boot.qemu') === '1';
  return {
    ...dev,
    model: props.get('ro.product.model') || dev.model,
    manufacturer: props.get('ro.product.manufacturer') || null,
    androidVersion: props.get('ro.build.version.release') || null,
    sdk: Number.isFinite(sdk) && sdk > 0 ? sdk : null,
    primaryAbi: primary,
    abis,
    abiFamily: abiFamily(abis),
    screen: parseWmSize(wmSize),
    density: parseWmDensity(wmDensity),
    isEmulator: dev.transport === 'emulator' || qemu,
  };
}

export type Adb = (args: string[]) => Promise<string>;

export const defaultAdb: Adb = (args) =>
  new Promise((resolve, reject) => {
    execFile('adb', args, { encoding: 'utf8', windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
        reject(new Error(missing ? 'adb was not found on PATH. Install Android platform-tools and reopen the terminal.' : `adb ${args.join(' ')} failed: ${(stderr || err.message).trim()}`));
      } else resolve(stdout);
    });
  });

export function createDeviceManager(adb: Adb = defaultAdb) {
  return {
    async list(): Promise<AdbDevice[]> {
      return parseAdbDevices(await adb(['devices', '-l']));
    },
    async details(serial: string): Promise<DeviceDetails> {
      assertSerial(serial);
      const dev = (await this.list()).find((d) => d.serial === serial);
      if (!dev) throw new Error(`Device ${serial} is not connected.`);
      if (dev.state !== 'device') {
        throw new Error(dev.state === 'unauthorized' ? `Device ${serial} is unauthorized: accept the USB debugging prompt on the phone.` : `Device ${serial} is ${dev.state}.`);
      }
      const [props, size, density] = await Promise.all([
        adb(['-s', serial, 'shell', 'getprop']),
        adb(['-s', serial, 'shell', 'wm', 'size']).catch(() => ''),
        adb(['-s', serial, 'shell', 'wm', 'density']).catch(() => ''),
      ]);
      return detailsFrom(dev, parseGetprop(props), size, density);
    },
  };
}
