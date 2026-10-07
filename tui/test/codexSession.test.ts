import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexSession, codexArgs } from '../src/codex/session.js';
import type { ClaudeEvent } from '../src/events.js';
import type { PermissionRequest } from '../src/session.js';
import { replay } from '../src/eventLog.js';
import { tabText } from '../src/store.js';
import { codexSessions, findSession, upsertSession } from '../src/sessions.js';
import { SessionHost } from '../src/host.js';
import { initialState, reduce, type State } from '../src/store.js';
import { FAKE_CODEX, FIXTURES } from './helpers.js';

type Sent = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message: string } };
type Entry = { dir: 'in' | 'out'; msg: Sent };

const recording = (name: string): Entry[] =>
  readFileSync(join(FIXTURES, 'codex', name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l) => l.dir);

// A recording made up for a test, as a fixture file.
function fixture(name: string, lines: Entry[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'binder-codex-fixture-')), `${name}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

// answer.jsonl up to its first turn/start: logged in, the thread ready.
function beforeTurn(): Entry[] {
  const lines = recording('answer.jsonl');
  return lines.slice(0, lines.findIndex((l) => l.dir === 'out' && l.msg.method === 'turn/start'));
}

const LOGGED_OUT: Entry[] = [
  { dir: 'out', msg: { id: 1, method: 'initialize' } },
  { dir: 'in', msg: { id: 1, result: {} } },
  { dir: 'out', msg: { method: 'initialized' } },
  { dir: 'out', msg: { id: 2, method: 'account/read' } },
  { dir: 'in', msg: { id: 2, result: { account: null, requiresOpenaiAuth: true } } },
];

const uuidOf = (e: ClaudeEvent) => (e.type === 'command_lifecycle' ? (e as { command_uuid: string }).command_uuid : undefined);
const isToolCall = (e: ClaudeEvent) => e.type === 'assistant' && (e as { message: { content: { type: string }[] } }).message.content[0]?.type === 'tool_use';

// What the reducer makes of a session's events, as the host saw them: the
// prompt sent as `prompt` into tab 1 of a session that can steer, then the
// follow-up sent as `steer` into it (and Esc, with `interrupt`).
function settle(events: ClaudeEvent[], prompt: string, steer: string, interrupt = false): State {
  let s: State = { ...initialState('sid'), canSteer: true };
  s = reduce(s, { type: 'submit', prompt: 'p', tabId: 1 });
  s = reduce(s, { type: 'sent', tabId: 1, uuid: prompt });
  s = reduce(s, { type: 'steer', tabId: 1, prompt: 'f', uuid: steer });
  if (interrupt) s = reduce(s, { type: 'interrupt_requested' });
  return reduce(s, { type: 'events', events });
}

// A CodexSession on the fake server replaying `fixture`, with its own state dir.
function codex(fixture: string, opts: { sessionId?: string; resume?: boolean; passthrough?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'binder-codex-'));
  const inputOut = join(dir, 'input.jsonl');
  process.env.BINDER_STATE_DIR = dir;
  process.env.BINDER_FAKE_FIXTURE = fixture.startsWith('/') ? fixture : join(FIXTURES, 'codex', fixture);
  process.env.BINDER_FAKE_INPUT_OUT = inputOut;
  process.env.BINDER_FAKE_ARGS_OUT = join(dir, 'args.json');
  const sessionId = opts.sessionId ?? '00000000-0000-4000-8000-00000000c0de';
  const session = new CodexSession({ sessionId, resume: opts.resume ?? false, cwd: dir, passthrough: opts.passthrough ?? [], bin: FAKE_CODEX });
  const events: ClaudeEvent[] = [];
  session.on('event', (e) => events.push(e));
  const sent = (): Sent[] => (existsSync(inputOut) ? readFileSync(inputOut, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const next = (test: (e: ClaudeEvent) => boolean) =>
    new Promise<ClaudeEvent>((resolve) => {
      const seen = events.find(test);
      if (seen) return resolve(seen);
      const on = (e: ClaudeEvent) => {
        if (!test(e)) return;
        session.off('event', on);
        resolve(e);
      };
      session.on('event', on);
    });
  return { session, sessionId, dir, events, sent, next, result: () => next((e) => e.type === 'result') };
}

const once = <T>(emitter: { once: (ev: string, fn: (v: T) => void) => unknown }, ev: string) => new Promise<T>((resolve) => emitter.once(ev, resolve));

describe('CodexSession on the fake app-server', () => {
  it('starts a thread, streams a turn, records the thread and logs the turn for replay', async () => {
    const { session, sessionId, sent, result, events } = codex('answer.jsonl');
    const plan = once<string>(session, 'plan');
    const applied = once<{ model?: string }>(session, 'applied');
    session.start();
    expect(await plan).toBe('ChatGPT Free');
    expect((await applied).model).toBe('gpt-6-luna');
    const uuid = session.sendPrompt('In two short sentences, what is a binder clip?', 1);
    await result();
    await session.close();

    const start = sent().find((m) => m.method === 'turn/start')!;
    expect(start.params).toMatchObject({ clientUserMessageId: uuid, input: [{ type: 'text', text: 'In two short sentences, what is a binder clip?', text_elements: [] }] });
    expect(events.some((e) => e.type === 'command_lifecycle' && (e as { command_uuid: string }).command_uuid === uuid)).toBe(true);
    expect(findSession(sessionId)).toMatchObject({ agent: 'codex', threadId: '01a114dc-6251-73c2-9b9b-90a8f7277a68' });
    const tab = replay(sessionId).tabs[0];
    expect(tab.status).toBe('done');
    expect(tabText(tab)).toMatch(/^A binder clip is/);
  });

  it('asks before a command and passes the answer back', async () => {
    const { session, sent, result } = codex('approve.jsonl');
    const asked: PermissionRequest[] = [];
    session.on('permission', (req) => {
      asked.push(req);
      session.allow(req);
    });
    session.start();
    session.sendPrompt('run it', 1);
    await result();
    await session.close();
    expect(asked).toEqual([{ requestId: '0', toolName: 'Bash', toolUseId: 'exec-1a0b5997-a0f7-4dca-bf26-f254717935d9', input: { command: 'mkdir -p out && echo hello > out/note.txt' } }]);
    expect(sent().find((m) => m.id === 0 && !m.method)).toEqual({ id: 0, result: { decision: 'accept' } });
  });

  it('declines a command when denied', async () => {
    const { session, sent, result } = codex('decline.jsonl');
    session.on('permission', (req) => session.deny(req));
    session.start();
    session.sendPrompt('run it', 1);
    await result();
    await session.close();
    expect(sent().find((m) => m.id === 0 && !m.method)).toEqual({ id: 0, result: { decision: 'decline' } });
  });

  it('asks before a file edit with the patch as the tool input', async () => {
    const { session, result } = codex('edit.jsonl');
    const asked: PermissionRequest[] = [];
    session.on('permission', (req) => {
      asked.push(req);
      session.allow(req);
    });
    session.start();
    session.sendPrompt('edit it', 1);
    await result();
    await session.close();
    expect(asked[0].toolName).toBe('Patch');
    expect(asked[0].input).toMatchObject({ file_path: '/private/tmp/binder-codex-rec/edit/greeting.txt' });
  });

  it('interrupts the running turn by its id', async () => {
    const { session, sent, next, result } = codex('interrupt.jsonl');
    session.start();
    session.sendPrompt('sleep', 1);
    await next((e) => e.type === 'assistant');
    session.interrupt();
    const r = (await result()) as { is_error: boolean; subtype: string };
    await session.close();
    expect(r).toMatchObject({ is_error: true, subtype: 'interrupted' });
    expect(sent().find((m) => m.method === 'turn/interrupt')?.params).toEqual({ threadId: '01a114dc-a7cc-77d0-9434-4f8ae189456c', turnId: '01a114dc-a7e9-7562-b2aa-9ef41f234651' });
  });

  it('steers a follow-up into the running turn and reports when Codex takes it in', async () => {
    const { session, sent, next, result } = codex('steer.jsonl');
    session.start();
    session.sendPrompt('sleep then a fruit', 1);
    await next((e) => e.type === 'assistant');
    const uuid = session.steer('Name a vegetable instead of a fruit.', 1);
    await next((e) => e.type === 'command_lifecycle' && (e as { command_uuid: string }).command_uuid === uuid);
    await result();
    await session.close();
    expect(sent().find((m) => m.method === 'turn/steer')?.params).toMatchObject({ clientUserMessageId: uuid, expectedTurnId: expect.any(String) });
  });

  it('resumes the thread recorded for the session', async () => {
    const sessionId = '00000000-0000-4000-8000-00000000beef';
    const { session, sent, result, dir } = codex('resume.jsonl', { sessionId, resume: true });
    upsertSession({ id: sessionId, cwd: dir, configDir: '/x', agent: 'codex', threadId: 'thread-from-index' });
    session.start();
    session.sendPrompt('Which word did you reply with before?', 1);
    await result();
    await session.close();
    expect(sent().find((m) => m.method === 'thread/resume')?.params).toMatchObject({ threadId: 'thread-from-index', excludeTurns: true });
  });

  it('applies the permission mode as an approval policy and sandbox, and passes other flags to app-server', () => {
    expect(codexArgs(['-m', 'gpt-5.6-terra', '--permission-mode', 'plan', '-n', 'Rent', '-c', 'x=1'], {})).toEqual({ model: 'gpt-5.6-terra', mode: 'plan', name: 'Rent', serverArgs: ['-c', 'x=1'] });
    expect(codexArgs([], { permissionMode: 'bypassPermissions' }).mode).toBe('bypassPermissions');
  });

  it('answers the model panel from model/list', async () => {
    const { session } = codex('discovery.jsonl');
    session.start();
    const r = await session.request('list_models');
    await session.close();
    expect((r.models as Array<{ value: string; supportedEffortLevels: string[] }>).map((m) => m.value)).toEqual(['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna']);
    await expect(session.request('rewind_files')).rejects.toThrow();
  });

  it('reports a missing login as an exit with what to do', async () => {
    const { session } = codex(fixture('logged-out', LOGGED_OUT));
    const exit = once<{ code: number | null; stderr: string[] }>(session, 'exit');
    session.start();
    expect((await exit).stderr.at(-1)).toMatch(/not logged in: run `codex login`/);
  });

  it('starts a new thread on Ctrl+R after a first start that failed', async () => {
    const { session, sent } = codex(fixture('logged-out', LOGGED_OUT));
    const exit = once<unknown>(session, 'exit');
    session.start();
    await exit;
    // Logged in now.
    process.env.BINDER_FAKE_FIXTURE = join(FIXTURES, 'codex', 'answer.jsonl');
    const applied = once<unknown>(session, 'applied');
    session.respawn();
    await applied;
    await session.close();
    expect(sent().filter((m) => m.method?.startsWith('thread/')).map((m) => m.method)).toEqual(['thread/start']);
  });

  it('refuses server requests it does not handle, so the turn goes on', async () => {
    const question: Entry[] = [
      { dir: 'in', msg: { id: 7, method: 'item/tool/requestUserInput', params: { questions: [] } } },
      { dir: 'out', msg: { id: 7, error: { message: 'x' } } },
    ];
    const { session, sent } = codex(fixture('question', [...beforeTurn(), ...question]));
    let exited = false;
    session.on('exit', () => (exited = true));
    session.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(exited).toBe(false);
    await session.close();
    expect(sent().find((m) => m.id === 7)?.error?.message).toMatch(/does not handle item\/tool\/requestUserInput/);
  });

  it('ends a turn Codex refuses in an error, and lets go of a follow-up steered into it', async () => {
    const refused: Entry[] = [
      { dir: 'out', msg: { id: 4, method: 'turn/start' } },
      { dir: 'in', msg: { id: 4, error: { message: 'thread is busy' } } },
    ];
    const { session, events, result } = codex(fixture('refused', [...beforeTurn(), ...refused]));
    session.start();
    const prompt = session.sendPrompt('hi', 1);
    const steer = session.steer('and then', 1);
    await result();
    await session.close();
    const s = settle(events, prompt, steer);
    expect(s.tabs[0].status).toBe('error');
    expect(tabText(s.tabs[0])).toBe('codex refused the prompt: thread is busy');
    expect([s.running, s.steer, s.unstarted]).toEqual([null, undefined, undefined]);
  });

  it('lets go of a follow-up Codex took in when Esc stops the turn before it ran', async () => {
    const { session, events, next, result } = codex('steer-interrupt.jsonl');
    session.start();
    const prompt = session.sendPrompt('sleep then a fruit', 1);
    await next(isToolCall);
    const steer = session.steer('Name a vegetable instead of a fruit.', 1);
    await new Promise((r) => setTimeout(r, 100)); // Codex has answered turn/steer
    session.interrupt();
    await result();
    await session.close();
    // Ahead of the result: the turn ends interrupted, not superseded.
    expect(events.findIndex((e) => uuidOf(e) === steer)).toBeLessThan(events.findIndex((e) => e.type === 'result'));
    expect(events.find((e) => uuidOf(e) === steer)).toMatchObject({ state: 'discarded' });
    const s = settle(events, prompt, steer, true);
    expect(s.tabs[0].status).toBe('interrupted');
    expect([s.running, s.steer, s.unstarted]).toEqual([null, undefined, undefined]);
  });

  it('lets go of a follow-up whose turn ended before Codex answered turn/steer', async () => {
    const lines = recording('steer-interrupt.jsonl');
    const idOf = (method: string) => lines.find((l) => l.dir === 'out' && l.msg.method === method)!.msg.id;
    const answers = (id: number | undefined) => (l: Entry) => l.dir === 'in' && l.msg.id === id && !l.msg.method;
    const steerAnswer = lines.find(answers(idOf('turn/steer')))!;
    const ended = lines.filter((l) => l !== steerAnswer && l.msg.method !== 'turn/interrupt' && !answers(idOf('turn/interrupt'))(l));
    ended.splice(ended.findIndex((l) => l.msg.method === 'turn/completed') + 1, 0, steerAnswer);
    const { session, events, next } = codex(fixture('steer-late', ended));
    session.start();
    const prompt = session.sendPrompt('sleep then a fruit', 1);
    await next(isToolCall);
    const steer = session.steer('Name a vegetable instead of a fruit.', 1);
    await next((e) => uuidOf(e) === steer);
    await session.close();
    const s = settle(events, prompt, steer);
    expect([s.running, s.steer, s.unstarted]).toEqual([null, undefined, undefined]);
  });

  it('names a new thread from -n, as the phone starts a named session', async () => {
    const { session, sent } = codex('answer.jsonl', { passthrough: ['-n', 'Pay rent'] });
    const applied = once<unknown>(session, 'applied');
    session.start();
    await applied;
    await session.close();
    expect(sent().find((m) => m.method === 'thread/name/set')?.params).toMatchObject({ name: 'Pay rent' });
    const spawned = JSON.parse(readFileSync(join(process.env.BINDER_STATE_DIR!, 'args.json'), 'utf8'));
    expect(spawned).toEqual(['app-server']);
  });

  it('sends /model, /effort and /cd with the next turn', async () => {
    const { session, sent, result } = codex('answer.jsonl');
    session.start();
    await session.request('set_model', { model: 'gpt-5.6-terra' });
    await session.request('apply_flag_settings', { settings: { effortLevel: 'high' } });
    expect(await session.request('set_cwd', { path: '/private/tmp' })).toEqual({ status: 'ok' });
    session.sendPrompt('hi', 1);
    await result();
    await session.close();
    expect(sent().find((m) => m.method === 'turn/start')?.params).toMatchObject({ model: 'gpt-5.6-terra', effort: 'high', cwd: '/private/tmp' });
  });

  it('starts the next thread from the launch settings and the folder /cd moved to', async () => {
    const { session, sent, result } = codex('answer.jsonl');
    session.start();
    await session.request('set_model', { model: 'gpt-5.6-terra' });
    await session.request('apply_flag_settings', { settings: { effortLevel: 'high' } });
    await session.request('set_cwd', { path: '/private/tmp' });
    session.movedTo('/private/tmp');
    session.switchTo('00000000-0000-4000-8000-0000000000c1', { resume: false });
    session.sendPrompt('hi', 1);
    await result();
    await session.close();
    expect(sent().filter((m) => m.method === 'thread/start').at(-1)?.params).toMatchObject({ cwd: '/private/tmp' });
    const turn = sent().find((m) => m.method === 'turn/start')!.params!;
    expect(['model', 'effort', 'cwd'].filter((k) => k in turn)).toEqual([]);
  });

  it('lists MCP servers with their state for /mcp', async () => {
    const { session } = codex('discovery.jsonl');
    session.start();
    const r = await session.request('mcp_status');
    await session.close();
    expect(r).toEqual({ mcpServers: [{ name: 'codex_apps', status: 'connected' }] });
  });

  it('forks into a new thread under a new binder id, names it, and finds Codex sessions for /resume', async () => {
    const { session, sessionId, dir, sent } = codex('discovery.jsonl');
    const host = new SessionHost(session, initialState(sessionId), dir, '/x');
    const started = once<unknown>(session, 'applied');
    session.start();
    await started;
    upsertSession({ id: sessionId, cwd: dir, configDir: '/x', firstPrompt: 'the original' });
    // A tab to fork, as if a turn had run.
    host.dispatch({ type: 'bash_start', command: 'true', tabId: 1 });
    host.dispatch({ type: 'bash_done', tabId: 1, output: '', exitCode: 0 });
    const forked = once<unknown>(session, 'applied');
    host.fork('My fork');
    await forked;
    await new Promise((r) => setTimeout(r, 100));
    expect(() => host.setChrome(true)).toThrow('/chrome is not available in a Codex session');
    await host.close();

    // The thread the recording started, and the one its fork made.
    const recorded = recording('discovery.jsonl');
    const threadIn = (requestId: number | undefined) => (recorded.find((l) => l.dir === 'in' && l.msg.id === requestId && l.msg.result)?.msg.result?.thread as { id: string }).id;
    const requestIdOf = (method: string) => recorded.find((l) => l.dir === 'out' && l.msg.method === method)!.msg.id;
    expect(sent().find((m) => m.method === 'thread/fork')?.params).toMatchObject({ threadId: threadIn(requestIdOf('thread/start')), excludeTurns: true });
    expect(host.sessionId).not.toBe(sessionId);
    expect(findSession(host.sessionId)).toMatchObject({ agent: 'codex', threadId: threadIn(requestIdOf('thread/fork')) });
    expect(sent().find((m) => m.method === 'thread/name/set')?.params).toMatchObject({ name: 'My fork' });
    expect(codexSessions().map((s) => s.id)).toContain(sessionId);
    expect(host.findSession(sessionId.slice(0, 8))?.prompt).toBe('the original');
  });
});
