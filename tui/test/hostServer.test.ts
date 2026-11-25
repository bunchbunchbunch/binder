import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { Session } from '../src/session.js';
import { SessionHost } from '../src/host.js';
import { HostServer } from '../src/remote/hostServer.js';
import { onLines } from '../src/lines.js';
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
  for (const k of ['BINDER_FAKE_DELAY_MS', 'BINDER_FAKE_ANSWERS_OUT', 'BINDER_FAKE_INPUT_OUT', 'BINDER_FAKE_CAPS', 'BINDER_FAKE_FAST_REASON', 'BINDER_FAKE_REFUSE_MODES']) delete process.env[k];
  Object.assign(process.env, env);
  return stateDir;
}

async function startHost(sessionId: string, stateDir: string, cwd = process.cwd()) {
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
  onLines(socket, (line) => {
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

  it('switches fast mode and the permission mode, and answers a prompt with an "always allow" choice', async () => {
    const stateDir = setup('permission-suggestions.jsonl', { BINDER_FAKE_REFUSE_MODES: 'plan' });
    const answersOut = join(stateDir, 'answers.json');
    process.env.BINDER_FAKE_ANSWERS_OUT = answersOut;
    const id = '00000000-0000-4000-8000-0000000000b3';
    await startHost(id, stateDir);
    const v = viewer(id);
    await until(() => v.state !== null);
    expect((await v.request('set_fast_mode')).result).toEqual({ message: 'Fast mode on' });
    await until(() => v.state!.fastMode === 'on');
    expect((await v.request('set_fast_mode', { on: false })).result).toEqual({ message: 'Fast mode off' });
    await until(() => v.state!.fastMode === 'off');
    expect((await v.request('cycle_mode')).result).toEqual({ message: 'Permission mode: accept edits' });
    expect((await v.request('cycle_mode')).result).toEqual({ message: 'Permission mode: auto mode' });
    await until(() => v.state!.permissionMode === 'auto');

    await v.request('send', { text: 'make a folder' });
    await until(() => v.state!.question !== null);
    const q = v.state!.question!;
    expect(q.kind).toBe('permission');
    const labels = q.questions[0].options.map((o) => o.label);
    expect(labels).toEqual(['Allow', 'Always allow Bash(mkdir -p alpha && echo made)', 'Allow, and accept all edits from now on', 'Deny']);
    await v.request('answer', { requestId: q.requestId, answers: { 'Allow Bash?': labels[1] } });
    await until(() => existsSync(answersOut));
    expect(JSON.parse(readFileSync(answersOut, 'utf8')).response.response.updatedPermissions[0].rules).toEqual([{ toolName: 'Bash', ruleContent: 'mkdir -p alpha && echo made' }]);
  });

  it('reports itself outdated, and restarts only where the host process allows it and only when idle', async () => {
    const stateDir = setup('two-turns-stdin.jsonl', { BINDER_FAKE_DELAY_MS: '150' });
    const id = '00000000-0000-4000-8000-0000000000b4';
    const cwd = process.cwd();
    const session = new Session({ sessionId: id, resume: false, cwd, passthrough: [] });
    const host = new SessionHost(session, initialState(id), cwd, join(stateDir, 'claude'));
    let restarts = 0;
    const server = new HostServer(host, { restart: () => void restarts++ });
    session.start();
    await server.listen();
    cleanup.push(async () => {
      server.close();
      await host.close();
    });
    const v = viewer(id);
    await until(() => v.state !== null);
    expect(v.state!.outdated).toBe(false);
    server.markOutdated();
    await until(() => v.state!.outdated === true);

    await v.request('send', { text: 'first prompt' });
    await until(() => v.state!.running !== null);
    expect(await v.request('restart_host')).toMatchObject({ ok: false, error: 'Wait until the session is idle' });
    await until(() => v.state!.running === null);
    expect((await v.request('restart_host')).ok).toBe(true);
    await until(() => restarts === 1);
  });

  it('refuses restart_host in a host without a restart (the terminal app)', async () => {
    const stateDir = setup('two-turns-stdin.jsonl');
    const id = '00000000-0000-4000-8000-0000000000b5';
    await startHost(id, stateDir);
    const v = viewer(id);
    await until(() => v.state !== null);
    expect(await v.request('restart_host')).toMatchObject({ ok: false, error: 'This session runs in the terminal app; restart binder there' });
  });

  it('sends a plan in full with its choices, and a choice approves it with the mode', async () => {
    const stateDir = setup('plan-approval.jsonl');
    const answersOut = join(stateDir, 'answers.json');
    process.env.BINDER_FAKE_ANSWERS_OUT = answersOut;
    const id = '00000000-0000-4000-8000-0000000000b6';
    await startHost(id, stateDir);
    const v = viewer(id);
    await until(() => v.state !== null);
    await v.request('send', { text: 'plan it' });
    await until(() => v.state!.question !== null);
    const q = v.state!.question!;
    expect(q.kind).toBe('permission');
    expect(q.plan).toMatch(/^# Add hello\.txt/);
    expect(q.questions[0].options.map((o) => o.label)).toEqual(['Yes, and use auto mode', 'Yes, and auto-accept edits', 'Yes, and manually approve edits', 'No, keep planning']);
    await v.request('answer', { requestId: q.requestId, answers: { 'Ready to code?': 'Yes, and use auto mode' } });
    await until(() => existsSync(answersOut));
    expect(JSON.parse(readFileSync(answersOut, 'utf8')).response.response.updatedPermissions).toEqual([{ type: 'setMode', mode: 'auto', destination: 'session' }]);
  });

  it('sends an image on request: a tool result\'s, and one sent with a prompt', async () => {
    const stateDir = setup('image-result.jsonl');
    const id = '00000000-0000-4000-8000-0000000000b7';
    await startHost(id, stateDir);
    const v = viewer(id);
    await until(() => v.state !== null);
    const png = readFileSync(join(FIXTURES, 'orange.png')).toString('base64');
    await v.request('send', { text: 'look at this', images: [{ mediaType: 'image/png', data: png }] });
    await until(() => v.state!.tabs[0]?.status === 'done');
    expect(v.state!.tabs[0].images).toEqual([{ mediaType: 'image/png', bytes: 176 }]);
    expect((await v.request('image', { tabId: 1, toolUseId: 'toolu_img', index: 0 })).result).toEqual({ mediaType: 'image/png', data: png });
    expect((await v.request('image', { tabId: 1, turn: 0, index: 0 })).result).toEqual({ mediaType: 'image/png', data: png });
    expect((await v.request('image', { tabId: 1, toolUseId: 'toolu_img', index: 1 })).error).toBe('No such image');
  });

  it('edits and removes queued prompts, and refuses one already sent', async () => {
    const stateDir = setup('two-turns-stdin.jsonl', { BINDER_FAKE_DELAY_MS: '100' });
    const id = '00000000-0000-4000-8000-0000000000a8';
    await startHost(id, stateDir);
    const v = viewer(id);
    await until(() => v.state !== null);
    for (const text of ['first prompt', 'second prompt', 'third prompt']) await v.request('send', { text });
    await until(() => v.state!.queue.length === 2);
    expect((await v.request('edit_queued', { tabId: 2, prompt: 'second prompt', text: 'second, edited' })).ok).toBe(true);
    expect((await v.request('edit_queued', { tabId: 3, prompt: 'third prompt', text: '' })).ok).toBe(true);
    await until(() => v.state!.queue.length === 1 && v.state!.tabs.length === 2);
    expect(v.state!.queue).toEqual([{ tabId: 2, prompt: 'second, edited', followup: false }]);
    expect(v.state!.tabs[1].prompt).toBe('second, edited');
    expect(await v.request('edit_queued', { tabId: 1, prompt: 'first prompt', text: 'too late' })).toMatchObject({ ok: false, error: 'That prompt is no longer queued' });
  });

  it('tells a viewer that attaches mid-turn when the turn started', async () => {
    const stateDir = setup('two-turns-stdin.jsonl', { BINDER_FAKE_DELAY_MS: '100' });
    const id = '00000000-0000-4000-8000-0000000000a9';
    await startHost(id, stateDir);
    const v = viewer(id);
    await until(() => v.state !== null);
    expect(v.state!.runningSince).toBeNull();
    const sent = Date.now();
    await v.request('send', { text: 'first prompt' });
    await until(() => v.state!.runningSince !== null);
    const since = v.state!.runningSince!;
    expect(since).toBeGreaterThanOrEqual(sent);
    await sleep(150);
    const late = viewer(id);
    await until(() => late.state !== null);
    expect(late.state!.running).toBe(1);
    expect(late.state!.runningSince).toBe(since);
    await until(() => v.state!.running === null);
    expect(v.state!.runningSince).toBeNull();
  });

  it('answers info without attaching', async () => {
    const stateDir = setup('two-turns-stdin.jsonl');
    const id = '00000000-0000-4000-8000-0000000000a3';
    await startHost(id, stateDir);
    const v = viewer(id, { t: 'hello', want: 'info' });
    await until(() => v.msgs.length > 0);
    expect(v.msgs[0]).toMatchObject({ t: 'info', sessionId: id, cwd: process.cwd(), running: false, pid: process.pid });
  });

  it('serves the panels: MCP sign-in, Chrome status, and a rewind preview', async () => {
    const stateDir = setup('two-turns-stdin.jsonl');
    const id = '00000000-0000-4000-8000-0000000000a7';
    await startHost(id, stateDir);
    const v = viewer(id);
    await until(() => v.state !== null);
    expect((await v.request('mcp_authenticate', { server: 'notion' })).result).toEqual({ authUrl: 'https://auth.example/notion' });
    expect((await v.request('mcp_clear_auth', { server: 'notion' })).ok).toBe(true);
    expect((await v.request('chrome_status')).result).toMatchObject({ status: { installed: true, connected: false } });
    expect((await v.request('rewind_preview', { uuid: 'u1' })).result).toEqual({ canRewind: true, files: 1, error: null });
  });

  it("cycles the model and the effort level one press at a time, as pi's Ctrl+P and Shift+Tab do", async () => {
    const stateDir = setup('two-turns-stdin.jsonl');
    const id = '00000000-0000-4000-8000-0000000000aa';
    const { host } = await startHost(id, stateDir);
    await until(() => host.state.model === 'claude-opus-5-5' && host.effort === 'xhigh');
    // Two presses at once take two steps; the second wraps around to the first model.
    expect(await Promise.all([host.cycleModel(1), host.cycleModel(1)])).toEqual(['Model: Haiku 4.5', 'Model: Opus 5.5']);
    expect(await host.cycleModel(-1)).toBe('Model: Haiku 4.5');
    expect(host.state.model).toBe('claude-haiku-4-5-20251001');
    await expect(host.cycleEffort()).rejects.toThrow('Haiku 4.5 has no effort levels');
    await host.cycleModel(1);
    // xhigh is not one of this model's levels, so the cycle starts at the first.
    expect(await Promise.all([host.cycleEffort(), host.cycleEffort()])).toEqual(['Effort: low', 'Effort: medium']);
    expect(host.effort).toBe('medium');
  });

  it('names the model an alias stands for, as the next turn would', async () => {
    const stateDir = setup('two-turns-stdin.jsonl');
    const id = '00000000-0000-4000-8000-0000000000ab';
    await startHost(id, stateDir);
    const v = viewer(id);
    await until(() => v.state?.model === 'claude-opus-5-5');
    expect((await v.request('set_model', { model: 'haiku' })).ok).toBe(true);
    await until(() => v.state!.model === 'claude-haiku-4-5-20251001');
    expect((await v.request('set_model', { model: 'default' })).ok).toBe(true);
    await until(() => v.state!.model === 'claude-opus-5-5');
    // A name the child does not list stays as given.
    expect((await v.request('set_model', { model: 'claude-opus-4-8' })).ok).toBe(true);
    await until(() => v.state!.model === 'claude-opus-4-8');
  });

  it('switches the permission mode, showing the one Claude Code reports', async () => {
    const stateDir = setup('two-turns-stdin.jsonl');
    const id = '00000000-0000-4000-8000-0000000000ac';
    await startHost(id, stateDir);
    const v = viewer(id);
    await until(() => v.state !== null);
    expect((await v.request('set_permission_mode', { mode: 'plan' })).ok).toBe(true);
    await until(() => v.state!.permissionMode === 'plan');
    expect((await v.request('set_permission_mode', { mode: 'manual' })).ok).toBe(true);
    await until(() => v.state!.permissionMode === 'default');
  });

  it('names the session for every viewer', async () => {
    const stateDir = setup('two-turns-stdin.jsonl');
    const id = '00000000-0000-4000-8000-0000000000ad';
    await startHost(id, stateDir);
    const a = viewer(id);
    const b = viewer(id);
    await until(() => a.state !== null && b.state !== null);
    expect(a.state!.title).toBeNull();
    expect(await a.request('rename', { title: '  ' })).toMatchObject({ ok: false, error: 'Give the session a title: /rename <title>' });
    expect((await a.request('rename', { title: ' Pay\trent ' })).ok).toBe(true);
    // As the child tidied it.
    await until(() => a.state!.title === 'Pay rent' && b.state!.title === 'Pay rent');
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

  it('refuses file_write while config.json turns file editing off; reads still work', async () => {
    const stateDir = setup('two-turns-stdin.jsonl');
    const dir = realpathSync(mkdtempSync('/tmp/bx-'));
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    const was = process.env.BINDER_CONFIG;
    const config = join(stateDir, 'config.json');
    process.env.BINDER_CONFIG = config;
    cleanup.push(() => void (process.env.BINDER_CONFIG = was));
    writeFileSync(config, JSON.stringify({ fileEditing: false }));
    const id = '00000000-0000-4000-8000-0000000000b1';
    await startHost(id, stateDir, dir);
    const v = viewer(id);
    await until(() => v.state !== null);
    expect(await v.request('file_write', { path: 'a.txt', text: 'two\n' })).toMatchObject({ ok: false, error: 'File editing is off (fileEditing in config.json)' });
    expect(await v.request('file_write', { path: 'b.txt', text: 'new\n' })).toMatchObject({ ok: false });
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one\n');
    expect(existsSync(join(dir, 'b.txt'))).toBe(false);
    expect((await v.request('file_read', { path: 'a.txt' })).result).toMatchObject({ text: 'one\n' });
    // Turned back on while the host runs.
    writeFileSync(config, '{}');
    expect(await v.request('file_write', { path: 'a.txt', text: 'two\n' })).toMatchObject({ ok: true });
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('two\n');
  });

  it('answers a request over the line cap with an error, and keeps the viewer attached', async () => {
    const stateDir = setup('two-turns-stdin.jsonl');
    const id = '00000000-0000-4000-8000-0000000000b2';
    await startHost(id, stateDir);
    const v = viewer(id);
    await until(() => v.state !== null);
    const reply = (n: number) => v.msgs.find((m) => m.t === 'reply' && m.id === n);
    // A 32 MB PDF as base64 fits; the Mac app writes the id last, after the attachments.
    v.socket.write(JSON.stringify({ pad: 'x'.repeat(45 * 1024 * 1024), t: 'history', id: 900 }) + '\n');
    await until(() => reply(900) !== undefined, 20000);
    expect(reply(900)).toMatchObject({ ok: true });
    const over = 'x'.repeat(64 * 1024 * 1024);
    v.socket.write(JSON.stringify({ pad: over, t: 'history', id: 901 }) + '\n');
    await until(() => reply(901) !== undefined, 20000);
    expect(reply(901)).toEqual({ t: 'reply', id: 901, ok: false, error: 'Too big to send: 64.0 MB, over the 64 MB limit' });
    // With no id to answer, a notice says why.
    v.socket.write(JSON.stringify({ t: 'history', pad: over }) + '\n');
    await until(() => v.msgs.some((m) => m.t === 'notice'), 20000);
    expect(v.msgs.find((m) => m.t === 'notice')).toEqual({ t: 'notice', text: 'Too big to send: 64.0 MB, over the 64 MB limit' });
    expect((await v.request('history')).ok).toBe(true);
  }, 60000);

  // U+2028 and U+2029 are legal, unescaped, inside JSON strings, and since
  // Node 24 readline ends a line at each: a line holding one must stay whole.
  it('keeps U+2028 and U+2029 whole in a viewer\'s prompt and in what claude says', async () => {
    const said = 'A\u2028B\u2029C';
    const fixture = join(mkdtempSync('/tmp/bx-'), 'sep.jsonl');
    writeFileSync(fixture, readFileSync(join(FIXTURES, 'two-turns-stdin.jsonl'), 'utf8').replaceAll('"text":"A"', `"text":"${said}"`));
    const stateDir = setup('two-turns-stdin.jsonl', { BINDER_FAKE_FIXTURE: fixture });
    const id = '00000000-0000-4000-8000-0000000000b3';
    const { host } = await startHost(id, stateDir);
    const v = viewer(id);
    await until(() => v.state !== null);
    // What claude says, read from its stdout.
    expect((await v.request('send', { text: 'go' })).ok).toBe(true);
    await until(() => JSON.stringify(v.state!.tabs[0] ?? null).includes(said));
    expect(JSON.stringify(roundTrip(wireState({ state: host.state, cwd: host.cwd, effort: host.effort })).tabs[0])).toContain(said);
    // A viewer's prompt, read from the socket. (The fake claude's own stdin
    // reader may cut it, so this waits for the host, not for a reply.)
    const prompt = 'Line one\u2028Line two\u2029end';
    expect((await v.request('send', { text: prompt })).ok).toBe(true);
    await until(() => v.state!.tabs[1]?.prompt === prompt);
    expect(roundTrip(wireState({ state: host.state, cwd: host.cwd, effort: host.effort })).tabs[1].prompt).toBe(prompt);
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
