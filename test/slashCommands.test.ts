import { describe, it, expect } from 'vitest';
import { localCommand, matchCommands, mergeCommands } from '../src/slashCommands.js';

const child = [
  { name: 'context', description: 'Show current context usage' },
  { name: 'compact', description: 'Free up context', argumentHint: '<optional instructions>' },
  { name: 'clear', description: "the child's clear" },
  { name: 'vercel:deploy', description: 'Deploy' },
  { name: '__remote-workflow', description: 'internal' },
];

describe('slash commands', () => {
  it("merges binder's own commands over the child's, sorted by name", () => {
    const all = mergeCommands(child);
    expect(all.map((c) => c.name)).toEqual(['artifacts', 'cd', 'chrome', 'clear', 'compact', 'context', 'effort', 'exit', 'fork', 'help', 'markdown', 'mcp', 'model', 'resume', 'rewind', 'vercel:deploy']);
    expect(all.find((c) => c.name === 'clear')?.description).toMatch(/new session/);
  });

  it('matches by prefix, alias, then substring, only while the name is being typed', () => {
    const all = mergeCommands(child);
    expect(matchCommands(all, '/co').map((c) => c.name)).toEqual(['compact', 'context']);
    expect(matchCommands(all, '/quit').map((c) => c.name)).toEqual(['exit']);
    expect(matchCommands(all, '/deploy').map((c) => c.name)).toEqual(['vercel:deploy']);
    expect(matchCommands(all, '/').length).toBe(all.length);
    expect(matchCommands(all, '/compact now')).toEqual([]);
    expect(matchCommands(all, 'hello')).toEqual([]);
  });

  it('recognizes local commands by name or alias, with arguments', () => {
    expect(localCommand('/help')).toEqual({ name: 'help', args: '' });
    expect(localCommand('/resume 1234abcd')).toEqual({ name: 'resume', args: '1234abcd' });
    expect(localCommand('/new')).toEqual({ name: 'clear', args: '' });
    expect(localCommand('/quit')).toEqual({ name: 'exit', args: '' });
    expect(localCommand('/branch try it')).toEqual({ name: 'fork', args: 'try it' });
    expect(localCommand('/cd ../x')).toEqual({ name: 'cd', args: '../x' });
    expect(localCommand('/context')).toBeNull();
    expect(localCommand('help me')).toBeNull();
  });
});
