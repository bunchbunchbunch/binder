import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { simDevices, simOpenApp } from '../src/main/simulator';

// Against the e2e suite's stand-in for xcrun (and for open).
const fake = resolve(__dirname, '../e2e/fakeXcrun.mjs');
const dir = mkdtempSync(join(tmpdir(), 'bg-sim-'));

describe('the simulator pane', () => {
  it('lists iPhones and iPads only, the newest iOS first by its version number', async () => {
    const state = join(dir, 'sim.json');
    writeFileSync(
      state,
      JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-26-9': [{ udid: 'A', name: 'iPhone 17', state: 'Shutdown' }],
          'com.apple.CoreSimulator.SimRuntime.iOS-26-10': [
            { udid: 'B', name: 'iPhone 17', state: 'Shutdown' },
            { udid: 'C', name: 'iPad Air', state: 'Shutdown' },
          ],
          'com.apple.CoreSimulator.SimRuntime.watchOS-26-2': [{ udid: 'D', name: 'Apple Watch', state: 'Booted' }],
          'com.apple.CoreSimulator.SimRuntime.tvOS-26-2': [{ udid: 'E', name: 'Apple TV', state: 'Shutdown' }],
        },
      }),
    );
    process.env.BINDER_XCRUN = fake;
    process.env.BINDER_FAKE_SIM = state;
    expect((await simDevices()).map((d) => `${d.name} · ${d.runtime}`)).toEqual(['iPad Air · iOS 26.10', 'iPhone 17 · iOS 26.10', 'iPhone 17 · iOS 26.9']);
  });

  it('opens the Simulator app through BINDER_OPEN', async () => {
    const log = join(dir, 'open.log');
    process.env.BINDER_OPEN = fake;
    process.env.BINDER_FAKE_SIM_LOG = log;
    simOpenApp('B');
    await expect.poll(() => (existsSync(log) ? readFileSync(log, 'utf8') : '')).toBe(JSON.stringify(['-a', 'Simulator', '--args', '-CurrentDeviceUDID', 'B']) + '\n');
  });
});
