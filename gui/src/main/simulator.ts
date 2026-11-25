import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The simulator pane (/simulator): an iOS Simulator device beside the session,
// through Xcode's simctl (BINDER_XCRUN stands in for xcrun in tests). Its
// screen refreshes by capture (simctl io screenshot, to a file: simctl takes
// no stdout), about once a second; the Simulator app is where you tap.

export type SimDevice = { udid: string; name: string; runtime: string; booted: boolean };

const xcrun = () => process.env.BINDER_XCRUN || 'xcrun';

function simctl(args: string[], timeout = 30_000): Promise<string> {
  return new Promise((done, fail) => {
    execFile(xcrun(), ['simctl', ...args], { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, out, errOut) => {
      if (err) fail(new Error(String(errOut || err.message).trim() || 'simctl failed'));
      else done(String(out));
    });
  });
}

// "com.apple.CoreSimulator.SimRuntime.iOS-26-2" → "iOS 26.2".
const runtimeName = (id: string) => {
  const m = /SimRuntime\.(\w+?)-(\d+)-(\d+)/.exec(id);
  return m ? `${m[1]} ${m[2]}.${m[3]}` : id;
};

/** The iPhones and iPads Xcode has (iOS runtimes), booted ones first, then the newest runtime's. */
export async function simDevices(): Promise<SimDevice[]> {
  let all: Record<string, Array<{ udid: string; name: string; state: string }>>;
  try {
    all = (JSON.parse(await simctl(['list', 'devices', 'available', '-j'])) as { devices: typeof all }).devices;
  } catch (e) {
    throw new Error(/ENOENT|unable to find utility/i.test((e as Error).message) ? 'No iOS Simulator here: install Xcode and its iOS platform' : (e as Error).message);
  }
  const ios = Object.entries(all).filter(([rt]) => /SimRuntime\.iOS-/.test(rt));
  const rows = ios.flatMap(([rt, list]) => list.map((d) => ({ udid: d.udid, name: d.name, runtime: runtimeName(rt), booted: d.state === 'Booted' })));
  // Major, then minor, as numbers: iOS 26.10 is newer than 26.9.
  const version = (r: string) => {
    const m = /(\d+)\.(\d+)/.exec(r);
    return m ? Number(m[1]) * 1000 + Number(m[2]) : 0;
  };
  return rows.sort((a, b) => Number(b.booted) - Number(a.booted) || version(b.runtime) - version(a.runtime) || a.name.localeCompare(b.name));
}

/** Boots a device (no window: the Simulator app shows it when opened). */
export async function simBoot(udid: string): Promise<void> {
  try {
    await simctl(['boot', udid], 120_000);
  } catch (e) {
    if (!/current state: Booted/.test((e as Error).message)) throw e;
  }
}

// Devices with more than one screen take --display.
const twoScreens = new Set<string>();
let shots: string | null = null;

/** The device's screen as it is now. */
export async function simShot(udid: string, type: 'jpeg' | 'png'): Promise<{ mediaType: string; data: string }> {
  shots ??= mkdtempSync(join(tmpdir(), 'binder-sim-'));
  const file = join(shots, `${udid}.${type}`);
  const take = () => simctl(['io', udid, 'screenshot', ...(twoScreens.has(udid) ? ['--display=primary'] : []), `--type=${type}`, file]);
  try {
    await take();
  } catch (e) {
    if (twoScreens.has(udid) || !/Cannot choose between/.test((e as Error).message)) throw new Error((e as Error).message.split('\n').pop() ?? 'No capture');
    twoScreens.add(udid);
    await take();
  }
  return { mediaType: `image/${type}`, data: readFileSync(file).toString('base64') };
}

/** The Simulator app, on this device: where you tap and type (BINDER_OPEN stands in for open in tests). */
export function simOpenApp(udid: string): void {
  execFile(process.env.BINDER_OPEN || 'open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', udid], () => {});
}
