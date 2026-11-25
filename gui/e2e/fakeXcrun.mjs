#!/usr/bin/env node
// Stand-in for xcrun (BINDER_XCRUN) in tests, for the simulator pane:
//   simctl list devices available -j      the devices in BINDER_FAKE_SIM (a JSON file)
//   simctl boot <udid>                    marks it booted there
//   simctl io <udid> screenshot ... FILE  copies BINDER_FAKE_SIM_IMAGE to FILE; a device
//                                         with "displays": 2 wants --display, as the real one does
// Every call's arguments are appended to BINDER_FAKE_SIM_LOG.
// It stands in for open (BINDER_OPEN) too: `open -a Simulator ...` is only logged.
// A screenshot takes BINDER_FAKE_SIM_DELAY_MS when set, as a slow device's does.
import { appendFileSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = process.env.BINDER_FAKE_SIM;
if (process.env.BINDER_FAKE_SIM_LOG) appendFileSync(process.env.BINDER_FAKE_SIM_LOG, JSON.stringify(args) + '\n');
if (args[0] === '-a') process.exit(0);
const fail = (code, message) => {
  process.stderr.write(message + '\n');
  process.exit(code);
};
if (!file || args[0] !== 'simctl') fail(1, `fake xcrun: ${args.join(' ')}`);
const state = JSON.parse(readFileSync(file, 'utf8'));
const all = Object.values(state.devices).flat();
const [, cmd, udid, op] = args;
if (cmd === 'list') {
  process.stdout.write(JSON.stringify({ devices: state.devices }));
  process.exit(0);
}
const device = all.find((d) => d.udid === udid);
if (cmd === 'boot') {
  if (!device) fail(2, 'Invalid device');
  if (device.state === 'Booted') fail(149, 'Unable to boot device in current state: Booted');
  device.state = 'Booted';
  writeFileSync(file, JSON.stringify(state));
  process.exit(0);
}
if (cmd === 'io' && op === 'screenshot') {
  if (process.env.BINDER_FAKE_SIM_DELAY_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.BINDER_FAKE_SIM_DELAY_MS));
  if (!device || device.state !== 'Booted') fail(164, 'Unable to lookup in current state: Shutdown');
  if (device.displays === 2 && !args.includes('--display=primary')) fail(22, 'An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=22):\nCannot choose between 2 displays. Specify one with --display:');
  copyFileSync(process.env.BINDER_FAKE_SIM_IMAGE, args.at(-1));
  process.exit(0);
}
fail(1, `fake xcrun: ${args.join(' ')}`);
