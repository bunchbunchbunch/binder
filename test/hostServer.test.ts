import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { Session } from '../src/session.js';
import { SessionHost } from '../src/host.js';
import { HostServer } from '../src/remote/hostServer.js';
import { liveElsewhere, lockPath, socketPath } from '../src/remote/sockets.js';
import { applyPatch, wireState, type WireState } from '../src/remote/wire.js';
import { initialState } from '../src/store.js';
import { FAKE_BIN, FIXTURES } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const roundTrip = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await sleep(20);
  }
}

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f();
  cleanup = [];
});

function setup(fixture: string, env: Record<string, string> = {}) {
  // Short: a unix socket path must stay under 104 bytes.
  const stateDir = mkdtempSync('/tmp/bx-');
  process.env.BINDER_STATE_DIR = stateDir;
  process.env.BINDER_CLAUDE_BIN = FAKE_BIN;
  process.env.BINDER_FAKE_FIXTURE = join(FIXTURES, fixture);
  for (const k of ['BINDER_FAKE_DELAY_MS', 'BINDER_FAKE_ANSWERS_OUT', 'BINDER_FAKE_INPUT_OUT', 'BINDER_FAKE_CAPS']) delete process.env[k];
  Object.assign(process.env, env);
  return stateDir;
}

async function startHost(sessionId: string, stateDir: string) {
  const cwd = process.cwd();
  const session = new Session({ sessionId, resume: false, cwd, passthrough: [] });
  const host = new SessionHost(session, initialState(sessionId), cwd, join(stateDir, 'claude'));
  const server = new HostServer(host);
  session.start();
  await server.listen();
  cleanup.push(async () => {
    server.close();
    await host.close();
  });
  return { host, server };
}

type Viewer = {
  msgs: Record<string, unknown>[];
  state: WireState | null;
  socket: Socket;
  request: (t: string, fields?: Record<string, unknown>) => Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>;
};

function viewer(sessionId: string, hello: Record<string, unknown> = { t: 'hello', want: 'attach' }): Viewer {
  const socket = connect(socketPath(sessionId));
  const replies = new Map<number, (r: never) => void>();
  const v: Viewer = {
    msgs: [],
    state: null,
    socket,
    request: (t, fields = {}) => {
      const id = nextId++;
      socket.write(JSON.stringify({ t, id, ...fields }) + '\n');
      return new Promise((r) => replies.set(id, r));
    },
  };
  let nextId = 1;
  socket.on('error', () => {});
  createInterface({ input: socket }).on('error', () => {}).on('line', (line) => {
    const m = JSON.parse(line);
    v.msgs.push(m);
    if (m.t === 'snapshot') v.state = m.state;
    else if (m.t === 'patch' && v.state) v.state = applyPatch(v.state, m);
    else if (m.t === 'reply') replies.get(m.id)?.(m as never);
  });
  socket.write(JSON.stringify(hello) + '\n');
  cleanup.push(() => void socket.destroy());
  return v;
}

describe('host server', () => {
  it('keeps two viewers in step with the host', async () => {
    const stateDir = setup('two-turns-stdin.jsonl');
    const id = '00000000-0000-4000-8000-0000000000a1';
    const { host } = await startHost(id, stateDir);
    const a = viewer(id);
    const b = viewer(id);
    await until(() => a.state !== null && b.state !== null);

    expect((await a.request('send', { text: 'first prompt' })).result).toEqual({ tabId: 1 });
    await until(() => a.state!.tabs[0]?.status === 'done' && b.state!.tabs[0]?.status === 'done');
    await b.request('send', { text: 'second prompt' });
    await until(() => a.state!.tabs[1]?.status === 'done' && b.state!.tabs[1]?.status === 'done' && a.state!.running === null && b.state!.running === null);
    await sleep(200); // the last patch
    const truth = roundTrip(wireState({ state: host.state, cwd: host.cwd, effort: host.effort }));
    expect(roundTrip(a.state)).toEqual(truth);
    expect(roundTrip(b.state)).toEqual(truth);
    expect(truth.tabs.map((t) => t.prompt)).toEqual(['first prompt', 'second prompt']);
  });

  it('lets either viewer answer a question, and it closes for both', async () => {
    const stateDir = setup('ask-and-interrupt.jsonl', { BINDER_FAKE_DELAY_MS: '5' });
    const answersOut = join(stateDir, 'answers.json');
    process.env.BINDER_FAKE_ANSWERS_OUT = answersOut;
    const id = '00000000-0000-4000-8000-0000000000a2';
    await startHost(id, stateDir);
    const a = viewer(id);
    const b = viewer(id);
    await until(() => a.state !== null && b.state !== null);
    await a.request('send', { text: 'ask me a color' });
    await until(() => a.state!.question !== null && b.state!.question !== null);
    const q = b.state!.question!;
    expect(q.kind).toBe('ask');
    expect(q.questions[0].question).toBe('Which color do you prefer?');
    expect((await b.request('answer', { requestId: q.requestId, answers: { 'Which color do you prefer?': 'Blue' } })).ok).toBe(true);
    await until(() => a.state!.question === null && b.state!.question === null);
    expect(JSON.parse(readFileSync(answersOut, 'utf8')).response.response.updatedInput.answers).toEqual({ 'Which color do you prefer?': 'Blue' });
    // A stale answer is refused.
    expect((await a.request('answer', { requestId: q.requestId, answers: {} })).ok).toBe(false);
  });

  it('answers info without attaching', async () => {
    const stateDir = setup('two-turns-stdin.jsonl');
    const id = '00000000-0000-4000-8000-0000000000a3';
    await startHost(id, stateDir);
    const v = viewer(id, { t: 'hello', want: 'info' });
    await until(() => v.msgs.length > 0);
    expect(v.msgs[0]).toMatchObject({ t: 'info', sessionId: id, cwd: process.cwd(), running: false, pid: process.pid });
  });

  it('refuses a viewer whose roots do not hold the session, and a cd outside them', async () => {
    const stateDir = setup('two-turns-stdin.jsonl');
    const id = '00000000-0000-4000-8000-0000000000a4';
    await startHost(id, stateDir);
    const out = viewer(id, { t: 'hello', want: 'attach', roots: ['/nonexistent-root'] });
    await until(() => out.msgs.length > 0);
    expect(out.msgs[0]).toMatchObject({ t: 'error' });
    const inside = viewer(id, { t: 'hello', want: 'attach', roots: [process.cwd()] });
    await until(() => inside.state !== null);
    expect((await inside.request('cd', { path: '/' })).result).toMatchObject({ status: 'rejected' });
  });

  it('holds the session against a second binder', async () => {
    const stateDir = setup('two-turns-stdin.jsonl');
    const id = '00000000-0000-4000-8000-0000000000a5';
    // Another live process owns it.
    const other: ChildProcess = spawn('sleep', ['10']);
    cleanup.push(() => void other.kill());
    writeFileSync(socketPath(id), '');
    writeFileSync(lockPath(id), String(other.pid));
    expect(liveElsewhere(id)).toBe(other.pid);
    await expect(startHost(id, stateDir)).rejects.toThrow(/open in another binder/);
    other.kill();
    await sleep(100);
    expect(liveElsewhere(id)).toBeUndefined();
  });

  it('moves its socket and resends a snapshot after /clear', async () => {
    const stateDir = setup('two-turns-stdin.jsonl');
    const id = '00000000-0000-4000-8000-0000000000a6';
    const { host } = await startHost(id, stateDir);
    const v = viewer(id);
    await until(() => v.state !== null);
    await v.request('send', { text: 'first prompt' });
    await until(() => v.state!.tabs[0]?.status === 'done' && v.state!.running === null);
    const r = await v.request('clear');
    expect(r.ok).toBe(true);
    const next = r.result!.sessionId as string;
    expect(next).not.toBe(id);
    await until(() => v.state!.sessionId === next && v.state!.tabs.length === 0);
    await until(() => existsSync(socketPath(next)) && !existsSync(socketPath(id)));
    expect(host.sessionId).toBe(next);
  });
});
