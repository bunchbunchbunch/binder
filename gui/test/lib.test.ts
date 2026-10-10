import { describe, it, expect } from 'vitest';
import type { WireBlock } from '../src/shared/wire';
import { lastToolIndex, splitWork, turnVerb, ultrathinkParts, workSummary } from '../src/renderer/src/lib/work';
import { diffLines, withContext } from '../src/renderer/src/lib/diff';
import { commonPrefix, localCommand, matchCommands, visibleCommands, wordAt } from '../src/renderer/src/lib/commands';
import { elapsed, fmtTokens, modelDisplayName } from '../src/renderer/src/lib/format';
import { findModel, stepEffort, stepModel } from '../src/renderer/src/lib/models';

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
