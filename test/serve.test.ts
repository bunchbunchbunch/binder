import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import WebSocket from 'ws';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error plain JavaScript, no types
import { startRelay } from '../relay/relay.mjs';
import { Gateway } from '../src/remote/serve.js';
import { remoteCommand } from '../src/remote/config.js';
import { Handshake, Opener, generateKeyPair, seal, type KeyPair } from '../src/remote/noise.js';
import { applyPatch, type WireState } from '../src/remote/wire.js';
import { lockPath, socketPath } from '../src/remote/sockets.js';
import { FAKE_BIN, FIXTURES } from './helpers.js';

// The whole path: a phone-like client does Noise over the relay, the gateway
// checks it and starts a real `binder host` process (built from dist/), which
// runs the fake claude.

const ROOT = join(import.meta.dirname, '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 15000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await sleep(25);
  }
}

let cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f();
  cleanup = [];
});

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });
}, 120000);

async function setup(opts: { paused?: boolean } = {}) {
  const dir = mkdtempSync('/tmp/bs-');
  process.env.BINDER_STATE_DIR = join(dir, 's');
  process.env.BINDER_CLAUDE_BIN = FAKE_BIN;
  process.env.BINDER_FAKE_FIXTURE = join(FIXTURES, 'two-turns-stdin.jsonl');
  process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude');
  delete process.env.BINDER_FAKE_DELAY_MS;
  // No shared secret here: the relay tests cover it, and the gateway gets it from the proxy in production.
  const relay = await startRelay({ port: 0, host: '127.0.0.1', log: () => {} });
  cleanup.push(() => relay.close());
  const config = join(dir, 'remote.json');
  const out = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    remoteCommand(['init', '--relay', `ws://127.0.0.1:${relay.port}/relay/mac`, '--root', ROOT], config);
  } finally {
    process.stdout.write = out;
  }
  const raw = JSON.parse(readFileSync(config, 'utf8'));
  raw.notify = false;
  if (opts.paused) raw.paused = true;
  const phone = generateKeyPair();
  raw.devices = [{ name: 'test-phone', publicKey: phone.publicKey.toString('base64'), added: 'now' }];
  writeFileSync(config, JSON.stringify(raw));
  const macPublic = (await import('../src/remote/noise.js')).publicKeyOf(Buffer.from(raw.privateKey, 'base64'));
  return { dir, relay, config, phone, macPublic };
}

function gateway(config: string) {
  const gw = new Gateway(config);
  cleanup.push(() => gw.stop());
  return gw;
}

// The gateway is on the relay once it logs so; a client before that gets "computer offline".
async function connected(config: string) {
  const log = join(config, '..', 'remote.log');
  await until(() => existsSync(log) && readFileSync(log, 'utf8').includes('relay connected'));
}

type Phone = {
  ws: WebSocket;
  state: WireState | null;
  msgs: Record<string, unknown>[];
  closed: () => boolean;
  request: (t: string, f?: Record<string, unknown>) => Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>;
};

async function phone(port: number, me: KeyPair, macPublic: Buffer): Promise<Phone> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/relay/phone`);
  cleanup.push(() => ws.terminate());
  const hs = new Handshake({ initiator: true, s: me, rs: macPublic });
  let opener: Opener | null = null;
  let closed = false;
  const replies = new Map<number, (r: never) => void>();
  const p: Phone = {
    ws,
    state: null,
    msgs: [],
    closed: () => closed,
    request: (t, f = {}) => {
      const id = nextId++;
      for (const c of seal(hs.send!, JSON.stringify({ t, id, ...f }))) ws.send(c);
      return new Promise((r) => replies.set(id, r));
    },
  };
  let nextId = 1;
  ws.on('close', () => (closed = true));
  ws.on('error', () => {});
  let ready: () => void = () => {};
  const handshaken = new Promise<void>((resolve) => (ready = resolve));
  ws.on('close', () => ready());
  ws.on('message', (d) => {
    const b = Buffer.from(d as Buffer);
    if (!opener) {
      hs.readMessage(b);
      opener = new Opener(hs.receive!);
      ready();
      return;
    }
    const text = opener.open(b);
    if (text === null) return;
    const m = JSON.parse(text);
    p.msgs.push(m);
    if (m.t === 'snapshot') p.state = m.state;
    else if (m.t === 'patch' && p.state) p.state = applyPatch(p.state, m);
    else if (m.t === 'reply') replies.get(m.id)?.(m as never);
  });
  await new Promise<void>((resolve) => ws.on('open', () => resolve()));
  ws.send(hs.writeMessage(Buffer.from('{"v":1}')));
  await handshaken;
  return p;
}

describe('gateway end to end', () => {
  it('starts a session for an enrolled phone and streams it back', async () => {
    const { relay, config, phone: me, macPublic } = await setup();
    gateway(config).connect();
    await connected(config);
    const p = await phone(relay.port, me, macPublic);
    const list = await p.request('list');
    expect(list.ok).toBe(true);
    expect(list.result!.roots).toEqual([ROOT]);

    const sessionId = '00000000-0000-4000-8000-0000000000e1';
    cleanup.push(() => {
      // The host the gateway started would otherwise idle on for minutes.
      if (existsSync(lockPath(sessionId))) process.kill(Number(readFileSync(lockPath(sessionId), 'utf8')), 'SIGTERM');
    });
    const opened = await p.request('open', { cwd: ROOT, sessionId });
    expect(opened).toMatchObject({ ok: true, result: { sessionId } });
    expect(existsSync(socketPath(sessionId))).toBe(true);
    await until(() => p.state !== null);

    await p.request('send', { text: 'first prompt' });
    await until(() => p.state!.tabs[0]?.status === 'done');
    expect(JSON.stringify(p.state!.tabs[0].blocks)).toContain('A');

    const again = await p.request('list');
    const row = (again.result!.sessions as { id: string; live: boolean }[]).find((s) => s.id === sessionId);
    expect(row?.live).toBe(true);

    // The session's binder quits: the phone hears it ended, and its connection stays up.
    process.kill(Number(readFileSync(lockPath(sessionId), 'utf8')), 'SIGTERM');
    await until(() => p.msgs.some((m) => m.t === 'detached'));
    expect(p.closed()).toBe(false);
    expect((await p.request('list')).ok).toBe(true);

    // Outside the roots: refused.
    expect((await p.request('open', { cwd: '/tmp' })).ok).toBe(false);
    expect(readFileSync(join(config, '..', 'remote.log'), 'utf8')).toContain('test-phone send "first prompt"');
  }, 60000);

  it('will not start a session another program already runs', async () => {
    const { relay, config, phone: me, macPublic } = await setup();
    gateway(config).connect();
    await connected(config);
    const sessionId = '00000000-0000-4000-8000-0000000000e2';
    // Stands in for an older binder or `claude --resume` holding the session.
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', sessionId]);
    cleanup.push(() => holder.kill());
    await sleep(200);
    const p = await phone(relay.port, me, macPublic);
    const r = await p.request('open', { cwd: ROOT, sessionId, resume: true });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(`pid ${holder.pid}`);
    expect(existsSync(socketPath(sessionId))).toBe(false);
  });

  it('falls back to a host with no UI when iTerm cannot be driven', async () => {
    const { dir, relay, config, phone: me, macPublic } = await setup();
    const raw = JSON.parse(readFileSync(config, 'utf8'));
    raw.launcher = 'iterm';
    writeFileSync(config, JSON.stringify(raw));
    // An osascript that fails like a refused Automation permission.
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'osascript'), '#!/bin/sh\necho "Not authorized to send Apple events to iTerm2. (-1743)" >&2\nexit 1\n', { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    cleanup.push(() => void (process.env.PATH = path));
    gateway(config).connect();
    await connected(config);
    const p = await phone(relay.port, me, macPublic);
    const sessionId = '00000000-0000-4000-8000-0000000000e3';
    cleanup.push(() => {
      if (existsSync(lockPath(sessionId))) process.kill(Number(readFileSync(lockPath(sessionId), 'utf8')), 'SIGTERM');
    });
    expect(await p.request('open', { cwd: ROOT, sessionId })).toMatchObject({ ok: true });
    expect(readFileSync(join(config, '..', 'remote.log'), 'utf8')).toContain('-1743');
  }, 60000);

  it('refuses a phone that is not enrolled', async () => {
    const { relay, config, macPublic } = await setup();
    gateway(config).connect();
    await connected(config);
    const p = await phone(relay.port, generateKeyPair(), macPublic);
    await until(() => p.closed());
    expect(p.msgs).toEqual([]);
    expect(readFileSync(join(config, '..', 'remote.log'), 'utf8')).toContain('not enrolled');
  });

  it('tells a phone that remote control is paused', async () => {
    const { relay, config, phone: me, macPublic } = await setup({ paused: true });
    gateway(config).connect();
    await connected(config);
    const p = await phone(relay.port, me, macPublic);
    await until(() => p.closed());
    expect(p.msgs[0]).toMatchObject({ t: 'closed' });
  });
});
