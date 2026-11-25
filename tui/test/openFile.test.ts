import { describe, it, expect } from 'vitest';
import { editorCommand, tabFiles, toolFile } from '../src/openFile.js';
import { renderTool } from '../src/ui/toolView.js';
import type { Block, Tab } from '../src/store.js';

const tool = (name: string, input: unknown): Block => ({ kind: 'tool_use', id: name + JSON.stringify(input), name, input, inputJson: '', final: true, children: [] });

describe('opening files', () => {
  it('adds the path to a command, or fills in {file} and {line}, quoted for sh', () => {
    expect(editorCommand('code', '/tmp/a b.ts')).toBe(`code '/tmp/a b.ts'`);
    expect(editorCommand('code -g {file}:{line}', "/tmp/it's.ts", 12)).toBe(`code -g '/tmp/it'\\''s.ts':12`);
    expect(editorCommand('zed {file}:{line}', '/tmp/x.ts')).toBe(`zed '/tmp/x.ts':1`);
  });

  it("lists the tab's files, the latest first, each once, with a Read's line", () => {
    expect(toolFile('Read', { file_path: '/r.ts', offset: 40 })).toEqual({ path: '/r.ts', tool: 'Read', line: 40 });
    expect(toolFile('Bash', { command: 'ls' })).toBeUndefined();
    const tab: Tab = {
      id: 1,
      prompt: 'p',
      status: 'done',
      earlier: [{ prompt: 'o', status: 'done', blocks: [tool('Edit', { file_path: '/a.ts' })] }],
      blocks: [tool('Read', { file_path: '/b.ts' }), tool('Write', { file_path: '/a.ts' }), tool('Patch', { changes: [{ path: '/c.ts' }, { path: '/d.ts' }] })],
    };
    expect(tabFiles(tab).map((f) => f.path)).toEqual(['/d.ts', '/c.ts', '/a.ts', '/b.ts']);
  });

  it('links a tool title\'s path to the file (OSC 8), which iTerm2 opens on Cmd+click', () => {
    const r = renderTool({ ...tool('Read', { file_path: '/private/tmp/demo/a.ts' }), kind: 'tool_use' } as Extract<Block, { kind: 'tool_use' }>, 100);
    expect(r.title).toContain('\x1b]8;;file:///private/tmp/demo/a.ts\x1b\\');
    // A # or ? in the path is part of the name, not a fragment or a query.
    const odd = renderTool({ ...tool('Read', { file_path: '/private/tmp/demo/issue #12?/a b%.ts' }), kind: 'tool_use' } as Extract<Block, { kind: 'tool_use' }>, 100);
    expect(odd.title).toContain('\x1b]8;;file:///private/tmp/demo/issue%20%2312%3F/a%20b%25.ts\x1b\\');
  });
});
