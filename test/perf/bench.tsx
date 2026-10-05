// Rendering benchmark: runs the real App against the fake binary replaying a
// long, busy turn into a fake TTY, and reports what the terminal would receive.
//   npx tsx test/perf/bench.tsx            (NODE_ENV=production for prod React)
// Env: BENCH_DELAY_MS (fake stream pacing, default 1), BENCH_KEYS (default 30)
import React from 'react';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink';
import { App } from '../../src/ui/App.js';
import { Session } from '../../src/session.js';
import { SessionHost } from '../../src/host.js';
import { initialState } from '../../src/store.js';
import { FAKE_BIN, FIXTURES } from '../helpers.js';
import { RENDER_OPTIONS } from '../../src/renderOptions.js';

class FakeStdout extends EventEmitter {
  constructor() { super(); this.setMaxListeners(100); }
  isTTY = true;
  columns = 120;
  rows = 45;
  bytes = 0;
  writes = 0;
  lastWriteAt = 0;
  dump: string[] | null = process.env.BENCH_DUMP ? [] : null;
  write = (data: string | Uint8Array, cb?: () => void) => {
    this.dump?.push(typeof data === 'string' ? data : Buffer.from(data).toString());
    this.bytes += typeof data === 'string' ? Buffer.byteLength(data) : data.length;
    this.writes++;
    this.lastWriteAt = performance.now();
    this.emit('wrote');
    if (typeof cb === 'function') cb();
    return true;
  };
  getColorDepth() { return 24; }
  hasColors() { return true; }
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  data: string | null = null;
  write(data: string) { this.data = data; this.emit('readable'); this.emit('data', data); }
  read() { const d = this.data; this.data = null; return d; }
  setEncoding() {} setRawMode() {} resume() {} pause() {} ref() {} unref() {}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : 0);

async function main() {
  process.env.BINDER_STATE_DIR = mkdtempSync(join(tmpdir(), 'binder-bench-'));
  process.env.BINDER_CLAUDE_BIN = FAKE_BIN;
  process.env.BINDER_FAKE_FIXTURE = join(FIXTURES, process.env.BENCH_FIXTURE ?? 'long-turn.jsonl');
  process.env.BINDER_FAKE_DELAY_MS = process.env.BENCH_DELAY_MS ?? '1';

  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const renderTimes: number[] = [];
  const session = new Session({ sessionId: '00000000-0000-4000-8000-0000000000bb', resume: false, cwd: process.cwd(), passthrough: [] });
  session.start();

  let done = false;
  session.on('event', (e) => { if (e.type === 'result') done = true; });

  const app = render(
    <App host={new SessionHost(session, initialState(session.sessionId), process.cwd(), '/nonexistent')} configDir="/nonexistent" onQuit={() => {}} />,
    {
      ...RENDER_OPTIONS,
      stdout: stdout as never, stdin: stdin as never, stderr: new FakeStdout() as never,
      patchConsole: false,
      onRender: ({ renderTime }: { renderTime: number }) => renderTimes.push(renderTime),
    },
  );
  await sleep(300);

  // Phase 1: stream the long turn.
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  const b0 = stdout.bytes, w0 = stdout.writes;
  stdin.write('run the long task');
  await sleep(30);
  stdin.write('\r');
  while (!done) await sleep(20);
  await sleep(300); // let the final frame land
  const streamMs = performance.now() - t0;
  const cpu1 = process.cpuUsage(cpu0);
  const streamRenders = renderTimes.length;
  const streamRenderTimes = renderTimes.slice();
  const streamBytes = stdout.bytes - b0, streamWrites = stdout.writes - w0;

  // Phase 2: idle for 3s with the finished tab showing.
  const iw0 = stdout.writes, ib0 = stdout.bytes, icpu0 = process.cpuUsage();
  await sleep(3000);
  const icpu = process.cpuUsage(icpu0);
  const idleWrites = stdout.writes - iw0, idleBytes = stdout.bytes - ib0;

  // Phase 3: keystroke latency over the finished long tab.
  const keys = Number(process.env.BENCH_KEYS ?? 30);
  const lat: number[] = [];
  const keyBytes0 = stdout.bytes;
  for (let i = 0; i < keys; i++) {
    const sent = performance.now();
    const echoed = new Promise<number>((resolve) => stdout.once('wrote', () => resolve(performance.now() - sent)));
    stdin.write('x');
    lat.push(await Promise.race([echoed, sleep(1000).then(() => 1000)]));
    await sleep(60);
  }
  const keyBytes = (stdout.bytes - keyBytes0) / keys;

  // Phase 4: Ctrl+E expands the 40 tool calls (one big re-layout).
  const exSent = performance.now();
  const expanded = new Promise<number>((resolve) => stdout.once('wrote', () => resolve(performance.now() - exSent)));
  stdin.write('\x05');
  const expandMs = await Promise.race([expanded, sleep(3000).then(() => 3000)]);
  await sleep(300);

  const mem = process.memoryUsage();
  const r = (n: number) => Math.round(n * 10) / 10;
  console.log(JSON.stringify({
    variant: process.env.BENCH_LABEL ?? 'current',
    nodeEnv: process.env.NODE_ENV ?? 'development',
    stream: {
      wallMs: Math.round(streamMs), cpuMs: Math.round((cpu1.user + cpu1.system) / 1000),
      renders: streamRenders, writes: streamWrites, kbWritten: Math.round(streamBytes / 1024),
      renderMsAvg: r(streamRenderTimes.reduce((a, b) => a + b, 0) / Math.max(1, streamRenderTimes.length)),
      renderMsP95: r(pct(streamRenderTimes, 0.95)), renderMsMax: r(Math.max(...streamRenderTimes)),
    },
    idle3s: { writes: idleWrites, kb: r(idleBytes / 1024), cpuMs: Math.round((icpu.user + icpu.system) / 1000) },
    keystroke: { p50Ms: r(pct(lat, 0.5)), p95Ms: r(pct(lat, 0.95)), maxMs: r(Math.max(...lat)), kbPerKey: r(keyBytes / 1024) },
    expandMs: r(expandMs),
    rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576),
  }, null, 1));

  if (stdout.dump) (await import('node:fs')).writeFileSync(process.env.BENCH_DUMP!, stdout.dump.join(''));
  await session.close();
  app.unmount();
  process.exit(0);
}

void main();
