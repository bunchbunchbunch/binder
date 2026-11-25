import { describe, it, expect } from 'vitest';
import type { PrStatus, WireBlock, WireTab } from '../src/shared/wire';
import { lastToolIndex, splitWork, turnVerb, ultrathinkParts, workSummary } from '../src/renderer/src/lib/work';
import { diffLines, unifiedDiffRows, withContext } from '../src/renderer/src/lib/diff';
import { commonPrefix, localCommand, matchCommands, visibleCommands, wordAt } from '../src/renderer/src/lib/commands';
import { elapsed, fmtCost, fmtTokens, modelDisplayName } from '../src/renderer/src/lib/format';
import { findModel, stepEffort, stepModel } from '../src/renderer/src/lib/models';
import { sessionChecklist } from '../src/renderer/src/lib/checklist';
import { tabsFindings } from '../src/renderer/src/lib/findings';
import { prBadge } from '../src/renderer/src/components/StatusBar';

const text = (t: string, final = true): WireBlock => ({ kind: 'text', text: t, final });
const tool = (name: string, result = true): WireBlock => ({ kind: 'tool_use', id: name, name, input: {}, final: true, children: [], ...(result && { result: { content: 'ok', isError: false } }) });
const think: WireBlock = { kind: 'thinking', text: 'hmm', final: true };

describe('work and response', () => {
  it('folds thinking and tools up to the last tool call; every text block stays in the response', () => {
    const blocks = [think, text('Let me look.'), tool('Read'), tool('Edit'), text('Done.')];
    const { work, response } = splitWork(blocks);
    expect(work).toEqual([think, blocks[2], blocks[3]]);
    expect(response.map((b) => (b as { text: string }).text)).toEqual(['Let me look.', 'Done.']);
    expect(workSummary(work)).toBe('2 tool calls, 1 thought');
    expect(lastToolIndex(blocks)).toBe(3);
  });

  it('leaves a pending AskUserQuestion out of the work', () => {
    expect(lastToolIndex([tool('Read'), tool('AskUserQuestion', false)])).toBe(0);
  });

  it('names what a running turn is doing', () => {
    expect(turnVerb([tool('Bash', false)], '', false)).toBe('Running Bash');
    expect(turnVerb([text('x', false)], '', false)).toBe('Writing');
    expect(turnVerb([], 'compacting', false)).toBe('Compacting');
    expect(turnVerb([think], 'requesting', false)).toBe('Waiting for API');
    expect(turnVerb([think], '', false)).toBe('Thinking');
    expect(turnVerb([], '', true)).toBe('Interrupting');
  });

  it('finds ultrathink for the rainbow letters', () => {
    expect(ultrathinkParts('please ultrathink here')).toEqual([
      { text: 'please ', rainbow: false },
      { text: 'ultrathink', rainbow: true },
      { text: ' here', rainbow: false },
    ]);
  });
});

describe('cost', () => {
  it('shows dollars to the cent, and less than a cent as such', () => {
    expect(fmtCost(0.004)).toBe('<$0.01');
    expect(fmtCost(0.42)).toBe('$0.42');
    expect(fmtCost(12.3)).toBe('$12.30');
  });
});

describe('diff', () => {
  it('marks changed lines and collapses far context', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n');
    const after = ['a', 'b', 'c', 'D', 'e', 'f', 'g'].join('\n');
    const rows = withContext(diffLines(before, after), 1);
    expect(rows).toEqual([
      { kind: 'skip', count: 2 },
      { kind: 'same', text: 'c' },
      { kind: 'del', text: 'd' },
      { kind: 'add', text: 'D' },
      { kind: 'same', text: 'e' },
      { kind: 'skip', count: 2 },
    ]);
  });
  it("reads Codex's unified diffs: hunks, the lines between them, and new files", () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c', '@@ -10,2 +10,3 @@', ' j', '+J', ' k', '\\ No newline at end of file', ''].join('\n');
    expect(unifiedDiffRows(diff, 'update')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'same', text: 'c' },
      { kind: 'skip', count: 6 },
      { kind: 'same', text: 'j' },
      { kind: 'add', text: 'J' },
      { kind: 'same', text: 'k' },
    ]);
    expect(unifiedDiffRows('one\ntwo\n', 'add')).toEqual([
      { kind: 'add', text: 'one' },
      { kind: 'add', text: 'two' },
    ]);
    expect(unifiedDiffRows('@@ -0,0 +1,1 @@\n+only\n', 'add')).toEqual([{ kind: 'add', text: 'only' }]);
    expect(unifiedDiffRows('', 'update')).toEqual([]);
  });
});

describe('commands', () => {
  const commands = [
    { name: 'model', description: '' },
    { name: 'mcp', description: '' },
    { name: 'clear', description: '', aliases: ['reset', 'new'] },
    { name: 'markdown', description: '' },
    { name: 'compact', description: '' },
  ];

  it('matches prefixes first, then substrings, and aliases', () => {
    expect(matchCommands(commands, '/m').map((c) => c.name)).toEqual(['model', 'mcp', 'markdown', 'compact']);
    expect(matchCommands(commands, '/re').map((c) => c.name)).toEqual(['clear']);
    expect(matchCommands(commands, '/model x')).toEqual([]);
  });

  it('puts an exact name or alias first, so Enter runs it', () => {
    const more = [...commands, { name: 'permission-mode', description: '', aliases: ['mode'] }];
    expect(matchCommands(more, '/mode').map((c) => c.name)).toEqual(['permission-mode', 'model']);
    expect(matchCommands(more, '/mcp').map((c) => c.name)).toEqual(['mcp']);
    expect(matchCommands(more, '/new').map((c) => c.name)).toEqual(['clear']);
  });

  it("hides the TUI's markdown switch", () => {
    expect(visibleCommands(commands).map((c) => c.name)).not.toContain('markdown');
  });

  it('knows its own commands by name and alias, with arguments', () => {
    expect(localCommand('/new')).toEqual({ name: 'clear', args: '' });
    expect(localCommand('/cd ~/code')).toEqual({ name: 'cd', args: '~/code' });
    expect(localCommand('/compact')).toBeNull();
    expect(localCommand('hello')).toBeNull();
  });

  it('finds the word before the cursor and a common prefix', () => {
    expect(wordAt('look at @src/ui', 15)).toEqual({ start: 8, word: '@src/ui' });
    expect(commonPrefix(['src/ui/', 'src/util.ts'])).toBe('src/u');
  });
});

describe('format', () => {
  it('names models and durations like the TUI', () => {
    expect(modelDisplayName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelDisplayName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(elapsed(75000)).toBe('1m 15s');
    expect(elapsed(43_384_000)).toBe('12h 3m');
    expect(fmtTokens(49512)).toBe('49.5k');
    expect(fmtTokens(812)).toBe('812');
  });
});

describe("pi's model and effort steps", () => {
  // As Claude Code lists them: "default" and "opus" are the same model.
  const models = [
    { value: 'default', resolvedModel: 'claude-opus-5-5', supportedEffortLevels: ['low', 'high', 'max'] },
    { value: 'opus', resolvedModel: 'claude-opus-5-5', supportedEffortLevels: ['low', 'high', 'max'] },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', supportedEffortLevels: ['low', 'high'] },
    { value: 'claude-haiku-4-5-20251001', resolvedModel: 'claude-haiku-4-5-20251001' },
  ];

  it('steps through each model once, either way, wrapping around', () => {
    expect(stepModel(models, 'claude-opus-5-5', 1)?.value).toBe('sonnet');
    expect(stepModel(models, 'opus', 1)?.value).toBe('sonnet');
    expect(stepModel(models, 'sonnet', -1)?.value).toBe('default');
    expect(stepModel(models, 'claude-haiku-4-5-20251001', 1)?.value).toBe('default');
    expect(stepModel(models, 'default', -1)?.value).toBe('claude-haiku-4-5-20251001');
    // A model not in the list: forward starts at the first, back at the last.
    expect(stepModel(models, 'gone', 1)?.value).toBe('default');
    expect(stepModel(models, null, -1)?.value).toBe('claude-haiku-4-5-20251001');
    expect(stepModel([], 'opus', 1)).toBeUndefined();
  });

  it("steps through the model's effort levels, starting at the first when the current one is not among them", () => {
    expect(stepEffort(findModel(models, 'claude-opus-5-5'), 'high')).toBe('max');
    expect(stepEffort(findModel(models, 'opus'), 'max')).toBe('low');
    expect(stepEffort(findModel(models, 'sonnet'), 'xhigh')).toBe('low');
    expect(stepEffort(findModel(models, 'sonnet'), null)).toBe('low');
    expect(stepEffort(findModel(models, 'claude-haiku-4-5-20251001'), 'high')).toBeUndefined();
  });
});

describe('the pinned todos', () => {
  const todo = (id: string, content: string): WireBlock => ({ kind: 'tool_use', id, name: 'TodoWrite', input: { todos: [{ content, status: 'pending' }] }, final: true, children: [], result: { content: 'ok', isError: false } });
  const turn = (seq: number | undefined, block: WireBlock) => ({ prompt: 'p', status: 'done' as const, blocks: [block], ...(seq !== undefined && { seq }) });

  it('takes the latest list in send order, across tabs', () => {
    // Tab 1 was sent first, then tab 2, then a follow-up into tab 1.
    const tabs: WireTab[] = [
      { id: 1, ...turn(3, todo('c', 'follow-up')), earlier: [turn(1, todo('a', 'first'))] },
      { id: 2, ...turn(2, todo('b', 'second')), earlier: [] },
    ];
    expect(sessionChecklist(tabs)?.items.map((i) => i.text)).toEqual(['follow-up']);
    // An older host sends no order: tabs as they were made.
    const old = tabs.map((t) => ({ ...turn(undefined, t.blocks[0]), id: t.id, earlier: t.earlier.map((e) => turn(undefined, e.blocks[0])) }));
    expect(sessionChecklist(old)?.items.map((i) => i.text)).toEqual(['second']);
  });
});

describe('findings', () => {
  it("names the review's turn, so a later review with the same text starts fresh", () => {
    const review = { prompt: '/code-review', status: 'done' as const, blocks: [{ kind: 'text' as const, text: '1 finding:\n\n1. 🔴 Important `calc.js:3`: Off by one', final: true }] };
    const fix = { prompt: 'Fix this finding', status: 'done' as const, blocks: [] };
    expect(tabsFindings([{ id: 1, ...fix, earlier: [review] }], 0)).toMatchObject({ tabId: 1, turn: 0 });
    expect(tabsFindings([{ id: 1, ...review, earlier: [review, fix] }], 0)).toMatchObject({ tabId: 1, turn: 2 });
  });
});

describe('the PR badge', () => {
  const pr = (checks: Partial<PrStatus['checks']>, more: Partial<PrStatus> = {}): PrStatus => ({ number: 12, title: 't', url: 'u', state: 'OPEN', draft: false, head: 'h', mergeable: 'MERGEABLE', review: '', checks: { passing: 0, failing: [], pending: 0, ...checks }, ...more });

  it('is green only for passing checks; none, or only skipped ones, is neutral; changes requested is red', () => {
    expect(prBadge(pr({ passing: 3 }))).toEqual({ tone: 'passing', mark: '✓' });
    expect(prBadge(pr({}))).toEqual({ tone: 'neutral', mark: '' });
    expect(prBadge(pr({ passing: 3 }, { review: 'CHANGES_REQUESTED' }))).toEqual({ tone: 'failing', mark: '✓' });
    expect(prBadge(pr({ failing: ['lint', 'test'], passing: 1 }))).toEqual({ tone: 'failing', mark: '✗ 2' });
    expect(prBadge(pr({ pending: 1, passing: 1 }))).toEqual({ tone: 'pending', mark: '◐' });
    expect(prBadge(pr({ passing: 1 }, { state: 'MERGED' }))).toEqual({ tone: 'merged', mark: 'merged' });
  });
});
