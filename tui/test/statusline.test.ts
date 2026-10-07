import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildPayload, modelDisplayName, readStatusLineCommand, runStatusLine, fallbackStatusLine } from '../src/statusline.js';
import { visibleTabs, tabLabel, turnVerb, elapsed } from '../src/ui/tabLayout.js';
import { toolSummary } from '../src/ui/toolSummary.js';
import { parseArgs } from '../src/cli.js';

const usage = { five_hour: { utilization: 0.05, resetsAt: 1791057000 }, seven_day: { utilization: 0.09, resetsAt: 1791075600 } };

describe('statusline', () => {
  it('derives display names from model ids', () => {
    expect(modelDisplayName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelDisplayName('claude-fable-5-1')).toBe('Fable 5.1');
    expect(modelDisplayName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelDisplayName(undefined)).toBe('');
  });

  it('builds the payload the statusline script expects', () => {
    const p = buildPayload({ sessionId: 's', model: 'claude-haiku-4-5-20251001', cwd: '/x', usage }) as { rate_limits: Record<string, { used_percentage: number; resets_at: number }> };
    expect(p.rate_limits.five_hour).toEqual({ used_percentage: 5, resets_at: 1791057000 });
    expect(p.rate_limits.seven_day).toEqual({ used_percentage: 9, resets_at: 1791075600 });
    expect(buildPayload({ sessionId: 's', cwd: '/x' }).rate_limits).toEqual({});
  });

  it('falls back to a plain bar, naming the config dir only when it is not the default', () => {
    const line = fallbackStatusLine('/home/u/.claude-alt', { sessionId: 's', model: 'claude-opus-5-5', cwd: '/x', usage });
    expect(line).toBe('claude-alt │ /x │ Opus 5.5 │ 5h 5% 7d 9%');
    expect(fallbackStatusLine(join(homedir(), '.claude'), { sessionId: 's', model: 'claude-opus-5-5', cwd: '/x' })).toBe('/x │ Opus 5.5');
  });

  const userConfig = join(homedir(), '.claude');
  const userCommand = readStatusLineCommand(userConfig);
  it.skipIf(!userCommand || !existsSync(join(homedir(), '.claude', 'statusline.sh')))(
    "renders both percentages through the user's own statusline command",
    async () => {
      const out = await runStatusLine(userCommand!, buildPayload({ sessionId: 's', model: 'claude-haiku-4-5-20251001', cwd: process.cwd(), usage }), process.cwd());
      expect(out).toMatch(/5%/);
      expect(out).toMatch(/9%/);
      expect(out).toMatch(/Haiku 4\.5/);
    },
  );
});

describe('tab layout', () => {
  const tab = (id: number, prompt: string) => ({ id, prompt, status: 'done' as const, blocks: [], earlier: [] });
  it('truncates long prompts and keeps the first line', () => {
    expect(tabLabel(tab(3, 'a very long prompt that keeps going and going\nsecond line'), 0)).toBe('3 ● a very long prompt that…');
  });
  it('windows around the active tab when they overflow', () => {
    const labels = Array.from({ length: 10 }, (_, i) => `${i + 1} ● prompt number ${i + 1}`);
    const r = visibleTabs(labels, 7, 60);
    expect(r.indices).toContain(7);
    expect(r.indices.length).toBeLessThan(10);
    expect(r.left).toBe(true);
    const all = visibleTabs(labels, 0, 1000);
    expect(all.indices.length).toBe(10);
    expect(all.left).toBe(false);
    expect(all.right).toBe(false);
  });
  it('names what a running turn is doing', () => {
    const bash = { kind: 'tool_use' as const, id: 't1', name: 'Bash', input: {}, inputJson: '', final: true, children: [] };
    expect(turnVerb([], '', false)).toBe('Thinking');
    expect(turnVerb([{ kind: 'thinking', text: '', final: false }], 'requesting', false)).toBe('Thinking');
    expect(turnVerb([bash], '', false)).toBe('Running Bash');
    expect(turnVerb([{ ...bash, result: { content: 'ok', isError: false } }], '', false)).toBe('Thinking');
    expect(turnVerb([{ kind: 'text', text: 'Here', final: false }], '', false)).toBe('Writing');
    expect(turnVerb([bash], 'compacting', false)).toBe('Compacting');
    expect(turnVerb([bash], '', true)).toBe('Interrupting');
  });
  it('formats elapsed time in whole seconds', () => {
    expect(elapsed(900)).toBe('0s');
    expect(elapsed(12_400)).toBe('12s');
    expect(elapsed(125_000)).toBe('2m 5s');
  });
});

describe('tool summary', () => {
  it('picks the most descriptive argument', () => {
    expect(toolSummary('Bash', { command: 'npm  test', description: 'Run tests' }, '')).toBe('Bash(npm test)');
    expect(toolSummary('Read', { file_path: '/a/b.ts' }, '')).toBe('Read(/a/b.ts)');
    expect(toolSummary('Edit', {}, '{"file_path":"/a"')).toBe('Edit({"file_path":"/a"…)');
    expect(toolSummary('TodoWrite', { todos: [] }, '')).toBe('TodoWrite');
  });
});

describe('cli args', () => {
  it('parses new, resume, and passthrough forms', () => {
    const fresh = parseArgs([], '/x');
    expect('sessionId' in fresh && fresh.resume).toBe(false);
    const id = '02232ac7-3258-44d3-9d52-cb1978d3ab6e';
    expect(parseArgs([id], '/x')).toEqual({ sessionId: id, resume: true, passthrough: [] });
    expect(parseArgs(['-r', id, '--', '--model', 'opus'], '/x')).toEqual({ sessionId: id, resume: true, passthrough: ['--model', 'opus'] });
    expect(parseArgs(['bogus'], '/x')).toHaveProperty('error');
    expect(parseArgs(['-r', 'nope'], '/x')).toHaveProperty('error');
  });

  it('starts a new session with a chosen id and a draft prompt', () => {
    const id = '02232ac7-3258-44d3-9d52-cb1978d3ab6e';
    expect(parseArgs(['--session-id', id, '--draft', 'Pay rent', '--', '-n', 'Rent'], '/x')).toEqual({
      sessionId: id,
      resume: false,
      draft: 'Pay rent',
      passthrough: ['-n', 'Rent'],
    });
    expect(parseArgs(['--session-id', 'nope'], '/x')).toHaveProperty('error');
    expect(parseArgs(['--session-id'], '/x')).toHaveProperty('error');
    expect(parseArgs(['--draft'], '/x')).toHaveProperty('error');
  });
});

describe('work split', () => {
  it('separates tool work from the trailing response and hides a pending question', async () => {
    const { splitWork, workSummary } = await import('../src/ui/workSplit.js');
    const blocks = [
      { kind: 'thinking' as const, text: 'hmm', final: true },
      { kind: 'tool_use' as const, id: 't1', name: 'Bash', input: {}, inputJson: '', final: true, children: [], result: { content: 'ok', isError: false } },
      { kind: 'text' as const, text: 'Done.', final: true },
      { kind: 'tool_use' as const, id: 't2', name: 'AskUserQuestion', input: {}, inputJson: '', final: true, children: [] },
    ];
    const { work, response } = splitWork(blocks);
    expect(work.map((b) => b.kind)).toEqual(['thinking', 'tool_use']);
    expect(response.map((b) => b.kind)).toEqual(['text']);
    expect(workSummary(work)).toBe('1 tool call, 1 thought');
    expect(splitWork([{ kind: 'text', text: 'hi', final: true }]).work).toEqual([]);
  });

  it('keeps an answer in the response when tool calls follow it', async () => {
    const { splitWork, workSummary } = await import('../src/ui/workSplit.js');
    const tool = (id: string) => ({ kind: 'tool_use' as const, id, name: 'Bash', input: {}, inputJson: '', final: true, children: [], result: { content: 'ok', isError: false } });
    const blocks = [
      tool('t1'),
      { kind: 'text' as const, text: 'Here is the answer.', final: true },
      tool('t2'),
      tool('t3'),
      { kind: 'text' as const, text: 'Also logged it.', final: true },
    ];
    const { work, response } = splitWork(blocks);
    expect(response.map((b) => b.kind === 'text' && b.text)).toEqual(['Here is the answer.', 'Also logged it.']);
    expect(work.map((b) => b.kind)).toEqual(['tool_use', 'tool_use', 'tool_use']);
    expect(workSummary(work)).toBe('3 tool calls');
  });
});

describe('word movement', () => {
  it('jumps over words and the separators between them', async () => {
    const { prevWord, nextWord } = await import('../src/ui/editor.js');
    const t = 'fix the login-bug, then  test';
    expect(nextWord(t, 0)).toBe(3);
    expect(nextWord(t, 3)).toBe(7);
    expect(nextWord(t, 7)).toBe(13); // "login"
    expect(nextWord(t, 13)).toBe(17); // "bug"
    expect(nextWord(t, t.length)).toBe(t.length);
    expect(prevWord(t, t.length)).toBe(t.length - 4);
    expect(prevWord(t, 25)).toBe(19); // from after "then  " back to "then"
    expect(prevWord(t, 0)).toBe(0);
  });
});
