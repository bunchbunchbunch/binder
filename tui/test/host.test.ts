import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/session.js';
import { SessionHost } from '../src/host.js';
import { HostServer } from '../src/remote/hostServer.js';
import { hostRequest } from '../src/remote/hostClient.js';
import { binderConfig } from '../src/config.js';
import { initialState } from '../src/store.js';
import { FAKE_BIN, FIXTURES } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await sleep(20);
  }
}

const configBefore = process.env.BINDER_CONFIG;
let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f();
  cleanup = [];
  process.env.BINDER_CONFIG = configBefore;
});

// A session and its host on fake claude, in a state dir of its own (short: the socket path must stay under 104 bytes).
function open(fixture: string, opts: { env?: Record<string, string>; passthrough?: string[]; cwd?: string; config?: object } = {}) {
  const dir = mkdtempSync('/tmp/bh-');
  const input = join(dir, 'input.jsonl');
  const argsOut = join(dir, 'args.json');
  Object.assign(process.env, { BINDER_STATE_DIR: dir, BINDER_CLAUDE_BIN: FAKE_BIN, BINDER_FAKE_FIXTURE: fixture.startsWith('/') ? fixture : join(FIXTURES, fixture), BINDER_FAKE_INPUT_OUT: input, BINDER_FAKE_ARGS_OUT: argsOut });
  for (const k of ['BINDER_FAKE_DELAY_MS', 'BINDER_FAKE_ANSWERS_OUT', 'BINDER_FAKE_CAPS', 'BINDER_FAKE_FAST_REASON', 'BINDER_FAKE_REFUSE_MODES', 'BINDER_FAKE_PLUGINS']) delete process.env[k];
  Object.assign(process.env, opts.env);
  const config = join(dir, 'config.json');
  if (opts.config) writeFileSync(config, JSON.stringify(opts.config));
  process.env.BINDER_CONFIG = config;
  const id = randomUUID();
  const cwd = opts.cwd ?? dir;
  const session = new Session({ sessionId: id, resume: false, cwd, passthrough: opts.passthrough ?? [] });
  session.start();
  const host = new SessionHost(session, initialState(id), cwd, join(dir, 'claude'));
  cleanup.push(() => host.close());
  const sent = () => (existsSync(input) ? readFileSync(input, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const requests = (subtype: string) => sent().filter((m) => m.type === 'control_request' && m.request.subtype === subtype).map((m) => m.request);
  const answer = (requestId: string) => sent().find((m) => m.type === 'control_response' && m.response.request_id === requestId)?.response.response;
  const args = () => JSON.parse(readFileSync(argsOut, 'utf8')) as string[];
  return { dir, config, session, host, sent, requests, answer, args };
}

// A fixture of one turn per workflow request: what Claude Code sends for a re-run by name or by script path.
function workflowFixture(dir: string, calls: Array<{ input: Record<string, unknown>; description: string }>): string {
  const lines = calls.flatMap(({ input, description }, i) => [
    { type: 'system', subtype: 'init', cwd: dir, tools: ['Workflow'], model: 'claude-opus-5-5', permissionMode: 'default', session_id: 'fake' },
    { type: 'assistant', message: { id: `m${i}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `toolu_${i}`, name: 'Workflow', input }] }, parent_tool_use_id: null, uuid: `a${i}`, session_id: 'fake' },
    { type: 'control_request', request_id: `perm-${i}`, request: { subtype: 'can_use_tool', tool_name: 'Workflow', input, description, tool_use_id: `toolu_${i}` } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: 'Workflow launched in background.' }] }, parent_tool_use_id: null, uuid: `u${i}`, session_id: 'fake' },
    { type: 'result', subtype: 'success', is_error: false, duration_ms: 1, num_turns: 1, result: 'ok', session_id: 'fake' },
  ]);
  const file = join(dir, 'workflows.jsonl');
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

describe('permission answers', () => {
  it("allow the tool only on one of the prompt's own choices", async () => {
    const t = open('permission-suggestions.jsonl');
    t.host.send('make a folder');
    await until(() => t.host.state.question !== undefined);
    const { requestId } = t.host.state.question!;
    expect(() => t.host.answer(requestId, {})).toThrow('Not a choice on this prompt: (none)');
    expect(() => t.host.answer(requestId, { 'Allow Bash?': 'Sure' })).toThrow('Not a choice on this prompt: Sure');
    await sleep(100);
    expect(t.answer(requestId)).toBeUndefined();
    expect(t.host.state.question?.requestId).toBe(requestId);
    t.host.answer(requestId, { 'Allow Bash?': 'Allow' });
    await until(() => t.answer(requestId) !== undefined);
    expect(t.answer(requestId).behavior).toBe('allow');
  });

  it('refuse a permission mode that is not one, naming those there are', async () => {
    const t = open('two-turns-stdin.jsonl');
    await expect(t.host.setPermissionMode('bogus')).rejects.toThrow('Not a permission mode: bogus (one of default, acceptEdits, plan, auto, dontAsk, bypassPermissions)');
    await t.host.setPermissionMode('acceptEdits');
    expect(t.requests('set_permission_mode').map((r) => r.mode)).toEqual(['acceptEdits']);
  });
});

describe('plan mode entered before the first turn', () => {
  it('in a session started in bypass mode, offers bypass back, and the choice is allowed once (session-scoped)', async () => {
    const t = open('plan-approval.jsonl', { passthrough: ['--permission-mode', 'bypassPermissions'] });
    await t.host.setPermissionMode('plan');
    t.host.send('plan a hello file');
    await until(() => t.host.state.question !== undefined);
    const q = t.host.state.question!;
    expect(q.questions[0].options[0].label).toBe('Yes, and bypass permissions');
    t.host.answer(q.requestId, { 'Ready to code?': 'Yes, and bypass permissions' });
    await until(() => t.answer(q.requestId) !== undefined);
    expect(t.answer(q.requestId)).toMatchObject({ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }], decisionClassification: 'user_temporary' });
  });
});

describe('the workflow card', () => {
  it('names a re-run by name, and says what a re-run by script path does, from the request', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'binder-wf-')));
    const fixture = workflowFixture(dir, [
      { input: { name: 'find-flaky-tests' }, description: 'Find flaky tests and propose fixes' },
      { input: { scriptPath: '/private/tmp/demo/.claude/workflows/run-1/script.js' }, description: 'Find flaky tests and propose fixes' },
    ]);
    const t = open(fixture);
    t.host.send('run it again');
    await until(() => t.host.state.question !== undefined);
    expect(t.host.state.question!.workflow).toEqual({ name: 'find-flaky-tests', description: 'Find flaky tests and propose fixes', phases: [] });
    expect(t.host.state.question!.questions[0].question).toBe('Run the workflow find-flaky-tests?');
    t.host.answer(t.host.state.question!.requestId, { x: 'Run once' });
    await until(() => t.host.state.running === null && t.host.state.question === undefined);
    t.host.send('and by its script');
    await until(() => t.host.state.question !== undefined);
    expect(t.host.state.question!.workflow).toEqual({ description: 'Find flaky tests and propose fixes', phases: [] });
  });

  it('leaves out "Always allow workflows" when always allow is off', async () => {
    const t = open('workflow.jsonl', { config: { alwaysAllow: false } });
    t.host.send('run a workflow');
    await until(() => t.host.state.question !== undefined);
    const q = t.host.state.question!;
    expect(q.questions[0].options.map((o) => o.label)).toEqual(['Run once', 'Deny']);
    expect(() => t.host.answer(q.requestId, { x: 'Always allow workflows' })).toThrow('Not a choice on this prompt');
  });
});

describe('plugin changes', () => {
  it('load into the session once its running turn ends, not into the turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'binder-plugins-'));
    const state = join(dir, 'plugins.json');
    writeFileSync(state, JSON.stringify({ installed: [{ id: 'formatter@market', version: '1.0.0', scope: 'user', enabled: true }], available: [] }));
    const t = open('two-turns-stdin.jsonl', { env: { BINDER_FAKE_PLUGINS: state, BINDER_FAKE_DELAY_MS: '150' } });
    t.host.send('first prompt');
    await until(() => t.host.state.running !== null);
    expect(await t.host.pluginAction('disable', 'formatter@market')).toBe('Successfully disabled plugin: formatter (scope: user). It loads when this turn ends');
    expect(t.host.state.running).not.toBeNull();
    expect(t.requests('reload_plugins')).toEqual([]);
    await until(() => t.host.state.running === null);
    await until(() => t.requests('reload_plugins').length === 1);
  });
});

describe('side questions', () => {
  it("do not send binder's own no-answer placeholder back as history", async () => {
    const t = open('two-turns-stdin.jsonl');
    const none = 'No answer for this side question. Try again, or ask in the conversation.';
    await t.host.sideQuestion('and now?', [{ question: 'first?', response: none }, { question: 'second?', response: 'An answer' }]);
    expect(t.requests('side_question')).toEqual([{ subtype: 'side_question', question: 'and now?', history: [{ question: 'second?', response: 'An answer' }] }]);
  });
});

describe('fast mode from config.json that cannot serve', () => {
  it('is not asked for once the child says why, so the first toggle tries again and says why', async () => {
    const t = open('two-turns-stdin.jsonl', { config: { fastMode: true }, env: { BINDER_FAKE_FAST_REASON: 'extra_usage_disabled' } });
    await until(() => t.host.state.fastMode === 'off');
    expect(t.session.fastMode).toBe(false);
    expect(await t.host.setFastMode()).toBe('Fast mode requires usage credits: turn on extra usage for your account');
  });
});

describe('config.json without a restart', () => {
  it('a change reaches the next session (/clear included), not the open one', async () => {
    const t = open('two-turns-stdin.jsonl', { config: {} });
    await until(() => existsSync(join(t.dir, 'args.json')));
    expect(t.args()).not.toContain('--permission-mode');
    writeFileSync(t.config, JSON.stringify({ permissionMode: 'plan', sideChat: false, alwaysAllow: false }));
    // Read again at once...
    expect(binderConfig().sideChat).toBe(false);
    // ...but the open session keeps what it started with.
    expect(t.host.config).toEqual({});
    t.host.clear();
    expect(t.host.config).toEqual({ permissionMode: 'plan', sideChat: false, alwaysAllow: false });
    await until(() => t.args().includes('--permission-mode'));
    expect(t.args()).toEqual(expect.arrayContaining(['--permission-mode', 'plan']));
  });

  it("a file that stops parsing leaves the last good settings; the diff base is read at each diff request", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'binder-diffbase-')));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', repo, ...args]);
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-qm', 'one');
    git('branch', 'old');
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    git('commit', '-qam', 'two');
    const t = open('two-turns-stdin.jsonl', { cwd: repo, config: {} });
    const server = new HostServer(t.host);
    await server.listen();
    cleanup.push(() => server.close());
    const diff = async () => (await hostRequest(t.host.sessionId, 'diff')) as { base: string; files: unknown[] };
    expect(await diff()).toMatchObject({ base: 'HEAD', files: [] });
    writeFileSync(t.config, JSON.stringify({ diffBase: 'old' }));
    expect(await diff()).toMatchObject({ base: 'old', files: [expect.objectContaining({ path: 'a.txt' })] });
    writeFileSync(t.config, '{ "diffBase": ');
    expect(binderConfig().diffBase).toBe('old');
    writeFileSync(t.config, '{}');
    expect(await diff()).toMatchObject({ base: 'HEAD', files: [] });
  });
});
