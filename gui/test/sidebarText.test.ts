import { describe, it, expect } from 'vitest';
import type { WireState, WireTab } from '../src/shared/wire';
import { DEFAULT_SIDEBAR, renderTemplate, sessionFields, sessionStatus, shortDuration, sidebarText, usesField, type SessionFacts } from '../src/renderer/src/lib/sidebarText';

const tab = (id: number, prompt: string, extra: Partial<WireTab> = {}): WireTab => ({ id, prompt, status: 'done', blocks: [], earlier: [], ...extra });

const state = (extra: Partial<WireState> = {}): WireState => ({
  sessionId: 's1',
  cwd: '/Users/me/code/bindertui',
  model: 'claude-opus-5-5',
  permissionMode: null,
  usage: null,
  contextTokens: 45200,
  running: null,
  activity: '',
  interrupting: false,
  canSteer: false,
  queue: [],
  steer: null,
  question: null,
  childExit: null,
  effort: 'high',
  tabs: [tab(1, 'Fix the login bug\nmore'), tab(2, 'Now add tests')],
  ...extra,
});

const facts = (extra: Partial<SessionFacts> = {}): SessionFacts => ({
  state: state(),
  cwd: '/Users/me/code/bindertui',
  title: 'Fix the login bug',
  problem: false,
  unseen: false,
  runningSince: null,
  lastTurnMs: 95000,
  ...extra,
});

const question = { requestId: 'q', kind: 'ask' as const, questions: [] };

describe('sidebar templates', () => {
  const values = { status: '⏳', elapsed: '3m', modelLetter: 'O', model: '', script: '', folder: 'binder', branch: '', waiting: '' };

  it('puts fields in and collapses the spaces empty ones leave', () => {
    expect(renderTemplate('{status} {elapsed} {model} {folder}', values)).toBe('⏳ 3m binder');
    expect(renderTemplate('{model} {folder}', values)).toBe('binder');
  });

  it('shows text in ( ) only when a field inside has a value', () => {
    expect(renderTemplate('{status} ([{modelLetter}]) ({model} · ){folder}', values)).toBe('⏳ [O] binder');
    expect(renderTemplate('{folder}( · {branch})( · {waiting})', values)).toBe('binder');
    expect(renderTemplate('{folder}( · {branch}( {status}))', values)).toBe('binder · ⏳');
    expect(renderTemplate('(plain) {folder}', values)).toBe('plain binder');
  });

  it('takes the first field with a value from {a|b}', () => {
    expect(renderTemplate('{script|folder}', values)).toBe('binder');
    expect(renderTemplate('{script | branch}', values)).toBe('');
    expect(renderTemplate('({script|branch} ·) x', values)).toBe('x');
  });

  it('leaves unknown fields, escapes and stray braces as written', () => {
    expect(renderTemplate('{foldr} {folder}', values)).toBe('{foldr} binder');
    expect(renderTemplate('\\({folder}\\) \\{x\\}', values)).toBe('(binder) {x}');
    expect(renderTemplate('a { b ) c', values)).toBe('a { b ) c');
    expect(renderTemplate('({folder}', values)).toBe('binder');
  });

  it('knows which fields a template uses', () => {
    expect(usesField('{status} ({branch|script})', 'script')).toBe(true);
    expect(usesField('{status} \\{script\\}', 'script')).toBe(false);
  });
});

describe('a session row', () => {
  it('shows the status, the turn time and the first prompt, then the folder, by default', () => {
    expect(sidebarText(DEFAULT_SIDEBAR, facts(), 0)).toEqual({ title: '1m Fix the login bug', subtitle: 'bindertui' });
    expect(sidebarText(DEFAULT_SIDEBAR, facts({ state: state({ running: 2, question }), runningSince: 0 }), 12_000)).toEqual({ title: '❓ 0m Fix the login bug', subtitle: 'bindertui · waiting for you' });
    expect(sidebarText(DEFAULT_SIDEBAR, facts({ state: null, lastTurnMs: null, title: 'New session' }), 0).title).toBe('New session');
  });

  it('falls back to the first prompt when the title comes out empty', () => {
    expect(sidebarText({ title: '{script}', subtitle: '' }, facts(), 0)).toEqual({ title: 'Fix the login bug', subtitle: '' });
  });

  it('has a status for each state, most urgent first', () => {
    expect(sessionStatus(facts())).toBe('');
    expect(sessionStatus(facts({ unseen: true }))).toBe('done');
    expect(sessionStatus(facts({ unseen: true, state: state({ backgroundTasks: [{ id: 't', type: 'agent', description: 'x' }] }) }))).toBe('background');
    expect(sessionStatus(facts({ state: state({ running: 2 }) }))).toBe('working');
    expect(sessionStatus(facts({ state: state({ running: 2, question }) }))).toBe('waiting');
    expect(sessionStatus(facts({ problem: true, state: state({ running: 2 }) }))).toBe('stopped');
  });

  it('fills the fields from the session', () => {
    const running = state({ running: 2, activity: 'thinking', tabs: [tab(1, 'Fix the login bug'), tab(2, 'Now add tests', { status: 'running', blocks: [{ kind: 'tool_use', id: 'b', name: 'Bash', input: {}, final: true, children: [] }] })] });
    const f = sessionFields(facts({ state: running, runningSince: 1000, branch: 'main', script: 'Login fix/bindertui' }), 1000 + 125000);
    expect(f).toMatchObject({
      status: '⏳',
      prompt: 'Now add tests',
      folder: 'bindertui',
      branch: 'main',
      model: 'Opus 5.5',
      modelLetter: 'O',
      effort: 'high',
      elapsed: '2m',
      activity: 'Running Bash',
      context: '45.2k',
      tabs: '2',
      tasks: '',
      script: 'Login fix/bindertui',
    });
    // Idle: the last turn's length, no activity.
    expect(sessionFields(facts(), 0)).toMatchObject({ elapsed: '1m', activity: '', prompt: 'Now add tests' });
    expect(sessionFields(facts({ state: null, lastTurnMs: null }), 0)).toMatchObject({ elapsed: '', model: '', modelLetter: '', tabs: '' });
  });

  it('writes durations in whole minutes, rounded down', () => {
    expect([0, 59_999, 60_000, 179_000, 3_599_000, 3_600_000, 3_900_000].map(shortDuration)).toEqual(['0m', '0m', '1m', '2m', '59m', '1h0m', '1h5m']);
  });

  it('copies an iTerm tab title', () => {
    const t = { title: '{status} {elapsed} ([{modelLetter}]) {script|folder}', subtitle: '' };
    const f = facts({ unseen: true, script: 'Login fix/bindertui' });
    expect(sidebarText(t, f, 0)).toEqual({ title: '✅ 1m [O] Login fix/bindertui', subtitle: '' });
    expect(sidebarText(t, facts({ state: null, lastTurnMs: null }), 0).title).toBe('bindertui');
  });
});
