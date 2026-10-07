import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commonPrefix, completeCommand, completePath, wordAt } from '../src/complete.js';
import { addHistory, loadHistory } from '../src/history.js';
import { initialState, reduce, type State } from '../src/store.js';
import { replayTranscript, summarize } from '../src/transcripts.js';
import { sessionArtifacts } from '../src/artifacts.js';
import { parseArgs } from '../src/cli.js';
import { buildArgs } from '../src/claudeProcess.js';
import { tabLines, type PendingPrompt } from '../src/ui/tabLines.js';

const result = { type: 'result', subtype: 'success', is_error: false, duration_ms: 5, num_turns: 1 };

describe('completion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'binder-complete-'));
  mkdirSync(join(dir, 'alpine'));
  writeFileSync(join(dir, 'alpha.txt'), '');
  writeFileSync(join(dir, 'alpine', 'peak.md'), '');
  writeFileSync(join(dir, '.hidden'), '');

  it('finds the word before the cursor', () => {
    expect(wordAt('cat src/u', 9)).toEqual({ start: 4, word: 'src/u' });
    expect(wordAt('cat ', 4)).toEqual({ start: 4, word: '' });
  });
  it('completes paths as typed, marking directories, hiding dotfiles unless asked', () => {
    expect(completePath('al', dir)).toEqual(['alpha.txt', 'alpine/']);
    expect(completePath('alpine/p', dir)).toEqual(['alpine/peak.md']);
    expect(completePath('.h', dir)).toEqual(['.hidden']);
    expect(completePath('', dir)).not.toContain('.hidden');
    expect(completePath(dir + '/alph', '/')).toEqual([dir + '/alpha.txt']);
    expect(completePath('nope/x', dir)).toEqual([]);
  });
  it('completes commands from PATH and finds the common prefix', () => {
    expect(completeCommand('l')).toContain('ls');
    expect(commonPrefix(['alpha.txt', 'alpine/'])).toBe('alp');
    expect(commonPrefix([])).toBe('');
  });
});

describe('prompt history', () => {
  beforeEach(() => {
    process.env.BINDER_STATE_DIR = mkdtempSync(join(tmpdir(), 'binder-hist-'));
  });
  it('keeps prompts per directory, oldest first, without repeats in a row', () => {
    addHistory('/a', 'one');
    addHistory('/b', 'elsewhere');
    addHistory('/a', 'two');
    addHistory('/a', 'two');
    expect(loadHistory('/a')).toEqual(['one', 'two']);
    expect(loadHistory('/b')).toEqual(['elsewhere']);
  });
});

function send(state: State, prompt: string, uuid: string, followupTab?: number): State {
  if (followupTab) {
    state = reduce(state, { type: 'followup', tabId: followupTab, prompt });
    state = reduce(state, { type: 'sent', tabId: followupTab, uuid });
  } else {
    state = reduce(state, { type: 'submit', prompt });
    state = reduce(state, { type: 'sent', tabId: state.tabs[state.tabs.length - 1].id, uuid });
  }
  return reduce(state, { type: 'event', event: result });
}

describe('rewind in the store', () => {
  it('drops the target turn and every later one, across tabs', () => {
    let s = initialState('s');
    s = send(s, 'first', 'u1');
    s = send(s, 'second', 'u2');
    s = send(s, 'more in tab 1', 'u3', 1);
    s = send(s, 'third', 'u4');
    expect(s.tabs.map((t) => t.prompt)).toEqual(['more in tab 1', 'second', 'third']);
    s = reduce(s, { type: 'rewind', uuid: 'u2' });
    // Tab 1 loses its later turn and shows its first again; tabs 2 and 3 go.
    expect(s.tabs.map((t) => [t.id, t.prompt, t.earlier.length])).toEqual([[1, 'first', 0]]);
    expect(s.active).toBe(0);
  });
});

describe('bash tabs in the store', () => {
  it('shows the output and queues it for the model until the next prompt', () => {
    let s = initialState('s');
    s = reduce(s, { type: 'bash_start', command: 'echo hi', tabId: 1 });
    expect(s.tabs[0]).toMatchObject({ prompt: '!echo hi', status: 'running', bash: true });
    s = reduce(s, { type: 'bash_done', tabId: 1, output: 'hi\n', exitCode: 0 });
    expect(s.tabs[0].status).toBe('done');
    expect(s.tabs[0].blocks[0]).toMatchObject({ kind: 'text', text: '```\nhi\n```' });
    expect(s.bashContext).toEqual(['<bash-input>echo hi</bash-input>\n<bash-stdout>hi</bash-stdout>']);
    s = reduce(s, { type: 'bash_start', command: 'false', tabId: 2 });
    s = reduce(s, { type: 'bash_done', tabId: 2, output: '', exitCode: 1 });
    expect(s.tabs[1].status).toBe('error');
    s = send(s, 'next', 'u1');
    expect(s.bashContext).toEqual([]);
  });
});

describe('Claude Code transcripts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'binder-transcript-'));
  const path = join(dir, 'abc.jsonl');
  const lines = [
    { type: 'user', isMeta: true, message: { content: 'caveat' } },
    { type: 'user', cwd: '/proj', gitBranch: 'feat', uuid: 'p1', timestamp: '2026-10-04T10:00:00Z', message: { content: 'fix the bug' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }] } },
    { type: 'assistant', timestamp: '2026-10-04T10:00:04Z', message: { content: [{ type: 'text', text: 'Fixed.' }] } },
    { type: 'user', uuid: 'p2', message: { content: '<command-name>/context</command-name><command-args></command-args>' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'usage table' }] } },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  it('summarizes a session for the picker', () => {
    expect(summarize(path)).toMatchObject({ id: 'abc', cwd: '/proj', branch: 'feat', prompt: 'fix the bug' });
  });
  it('replays it as one tab with a turn per prompt', () => {
    const s = replayTranscript('abc', path);
    expect(s.tabs).toHaveLength(1);
    const [tab] = s.tabs;
    expect(tab.earlier.map((t) => [t.prompt, t.uuid, t.status])).toEqual([['fix the bug', 'p1', 'done']]);
    expect(tab.earlier[0].blocks.map((b) => b.kind)).toEqual(['tool_use', 'text']);
    expect(tab.earlier[0].result?.durationMs).toBe(4000);
    expect([tab.prompt, tab.uuid, tab.status]).toEqual(['/context', 'p2', 'done']);
    expect(s.running).toBeNull();
  });
});

describe('artifacts', () => {
  it('collects artifact links from tool results and text, one per link', () => {
    let s = initialState('s');
    s = reduce(s, { type: 'submit', prompt: 'publish' });
    s = reduce(s, { type: 'sent', tabId: 1 });
    s = reduce(s, {
      type: 'event',
      event: { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'Artifact', input: { title: 'Report' } }] } },
    });
    s = reduce(s, {
      type: 'event',
      event: { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Published https://claude.ai/code/artifact/abc-123 ok' }] } },
    });
    s = reduce(s, {
      type: 'event',
      event: { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'See https://claude.ai/code/artifact/abc-123 and https://claude.ai/artifact/zzz' }] } },
    });
    expect(sessionArtifacts(s.tabs)).toEqual([
      { url: 'https://claude.ai/code/artifact/abc-123', title: 'Report', tabId: 1 },
      { url: 'https://claude.ai/artifact/zzz', title: 'artifact', tabId: 1 },
    ]);
  });
});

describe('forking', () => {
  it('parses --fork-session into a new id that resumes the original as a fork', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const r = parseArgs(['-r', id, '--fork-session'], '/x');
    expect(r).toMatchObject({ resume: true, forkFrom: id });
    expect((r as { sessionId: string }).sessionId).not.toBe(id);
    expect(parseArgs(['--fork-session'], '/x')).toHaveProperty('error');
    expect(buildArgs({ sessionId: 'new', resume: true, passthrough: [], forkFrom: 'old' })).toEqual(expect.arrayContaining(['--resume', 'old', '--fork-session', '--session-id', 'new']));
  });
});

describe('queued prompt hints', () => {
  const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  const lines = (status: 'queued' | 'done', pending: PendingPrompt[], editing?: string) =>
    plain(tabLines({ id: 1, prompt: 'open', status, blocks: [], earlier: [] }, { width: 100, detail: false, expanded: false, renderText: () => [], pending, editing }).lines);
  const UP = '↑ in an empty prompt to edit or remove it';
  const EDITING = 'editing below · enter saves, or removes it if emptied · esc cancels';

  it("goes under a new tab's queued prompt", () => {
    expect(lines('queued', [])).toEqual(['│ open', '', 'queued, waiting for the current turn to finish', UP]);
  });

  it('goes under the last queued follow-up only, the one Up opens', () => {
    const out = lines('done', [{ prompt: 'a', sending: false }, { prompt: 'b', sending: false }]);
    expect(out.filter((l) => l === UP)).toHaveLength(1);
    expect(out.slice(-2)).toEqual(['queued, sends when the current turn finishes (in this tab)', UP]);
    // A new tab with a follow-up queued into it: the follow-up is last.
    const both = lines('queued', [{ prompt: 'a', sending: false }]);
    expect(both.indexOf(UP)).toBe(both.length - 1);
  });

  it('says how to save the one open in the prompt, and is not offered for a message being sent now', () => {
    const out = lines('done', [{ prompt: 'a', sending: false }, { prompt: 'b', sending: false }], 'a');
    expect(out[out.indexOf('│ a') + 2]).toBe(EDITING);
    expect(out).not.toContain(UP);
    expect(lines('done', [{ prompt: 'now', sending: true }])).not.toContain(UP);
  });
});
