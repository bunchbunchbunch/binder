import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import stringWidth from 'string-width';
import { renderMarkdown } from '../src/ui/markdown.js';
import { fitColumns } from '../src/ui/md/table.js';
import { diffLines, withContext } from '../src/ui/diff.js';
import { renderTool } from '../src/ui/toolView.js';
import { FIXTURES } from './helpers.js';
import { setMarkdownStyle } from '../src/ui/md/theme.js';
import { BIG_BOTTOM, BIG_TOP, bigText, flattenBig, setBigText, setBigViewport, stampRows, unstampRows } from '../src/ui/lineAttrs.js';
import type { DOMElement } from 'ink';

const strip = (s: string) => s.replace(/\x1b\[[0-9;:]*[A-Za-z]/g, '').replace(/\x1b\]8;;[^\x1b\x07]*(?:\x1b\\|\x07)/g, '');
const lines = (md: string, w = 60) => renderMarkdown(md, w).split('\n');
const plain = (md: string, w = 60) => lines(md, w).map(strip);

describe('markdown renderer', () => {
  it('never produces a line wider than the requested width', () => {
    for (const f of ['sample.md', 'edge.md']) {
      const md = readFileSync(join(FIXTURES, f), 'utf8');
      for (const w of [40, 72, 120]) {
        const over = renderMarkdown(md, w).split('\n').filter((l) => stringWidth(l) > w);
        expect(over, `${f} at ${w}`).toEqual([]);
      }
    }
  });

  it('styles headings by level', () => {
    const out = plain('# One\n\n## Two\n\n### Three\n\n#### Four', 30);
    expect(out[0]).toBe('One');
    expect(out[1]).toBe('━'.repeat(30));
    expect(out[3]).toBe('Two');
    expect(out[4]).toBe('───'); // rule matches the text width
    expect(out[6]).toBe('▍ Three');
    expect(out[8]).toBe('Four');
    expect(renderMarkdown('# One', 30)).toContain('\x1b[1m'); // bold
    expect(renderMarkdown('# One', 30)).toMatch(/\x1b\[38;2;255;213;128m/); // h1 gold
  });

  it('renders inline styles with explicit off codes, not resets', () => {
    const out = renderMarkdown('a **b** *c* ~~d~~ `e`', 60);
    expect(out).not.toContain('\x1b[0m');
    expect(out).toMatch(/\x1b\[1m(\x1b\[[0-9;]*m)*b\x1b\[22m/);
    expect(out).toContain('\x1b[3mc\x1b[23m');
    expect(out).toContain('\x1b[9m');
    expect(strip(out)).toBe('a b c d  e ');
  });

  it('wraps paragraphs at word boundaries', () => {
    const out = plain('one two three four five six seven eight nine ten', 20);
    expect(out).toEqual(['one two three four', 'five six seven eight', 'nine ten']);
  });

  it('renders bullets, numbering, nesting and task boxes', () => {
    const out = plain('- a\n- b\n  - c\n\n5. five\n6. six\n\n- [x] done\n- [ ] todo', 40);
    expect(out).toEqual(['• a', '• b', '  ◦ c', '', '5. five', '6. six', '', '☑ done', '☐ todo']);
  });

  it('indents wrapped list items under their text', () => {
    const out = plain('1. ' + 'word '.repeat(12).trim(), 30);
    expect(out[0]).toMatch(/^1\. word/);
    expect(out[1]).toMatch(/^   word/);
  });

  it('draws tables with borders, alignment and wrapped cells', () => {
    const md = '| L | C | R |\n|:--|:-:|--:|\n| left | mid | 42 |\n| a very long cell that wraps | x | 1 |';
    const out = plain(md, 36);
    expect(out[0]).toMatch(/^╭─+┬─+┬─+╮$/);
    expect(out[1]).toMatch(/^│ L +│ +C +│ +R │$/);
    expect(out[2]).toMatch(/^├─+┼─+┼─+┤$/);
    expect(out[3]).toMatch(/│ left +│ mid +│ +42 │$/);
    expect(out[4]).toMatch(/^├─+┼─+┼─+┤$/); // rule between body rows
    expect(out.at(-1)).toMatch(/^╰─+┴─+┴─+╯$/);
    expect(out.length).toBeGreaterThan(6); // the long cell wrapped to extra rows
    for (const l of out) expect(stringWidth(l)).toBeLessThanOrEqual(36);
  });

  it('puts code on a padded band with a language label and keeps indentation', () => {
    const out = lines('```ts\nif (x) {\n  y();\n}\n```', 40);
    expect(strip(out[0]).trimEnd().endsWith('ts')).toBe(true);
    expect(strip(out[1])).toBe(' if (x) {'.padEnd(40));
    expect(strip(out[2])).toBe('   y();'.padEnd(40));
    expect(out[1]).toContain('\x1b[48;2;'); // background band
    expect(out[1]).toContain('\x1b[38;2;198;120;221m'); // keyword color from the code theme
  });

  it('renders blockquotes with a bar and links as OSC 8 hyperlinks', () => {
    const q = plain('> quoted\n> text', 40);
    expect(q).toEqual(['▎ quoted text']);
    const link = renderMarkdown('[docs](https://example.com/docs)', 60);
    expect(link).toMatch(/\x1b\]8;;https:\/\/example\.com\/docs\x1b\\(\x1b\[[0-9;]*m)*docs/);
    expect(strip(link)).toBe('docs (example.com/docs)');
    expect(strip(renderMarkdown('<https://x.test>', 60))).toBe('https://x.test');
  });

  it('survives partial documents while streaming', () => {
    const md = readFileSync(join(FIXTURES, 'sample.md'), 'utf8');
    for (let i = 1; i < md.length; i += 37) {
      expect(() => renderMarkdown(md.slice(0, i), 80)).not.toThrow();
    }
    expect(plain('```python\ndef f(x):\n    return x +', 40)[1]).toBe(' def f(x):'.padEnd(40));
  });

  it('is fast enough to run on every stream tick', () => {
    const md = readFileSync(join(FIXTURES, 'sample.md'), 'utf8').repeat(5);
    renderMarkdown(md, 100); // warm up and load the highlighter
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) renderMarkdown(md, 100);
    expect((performance.now() - t0) / 5).toBeLessThan(60);
  });
});

describe('table column fitting', () => {
  it('shrinks the widest columns first and respects the minimum', () => {
    expect(fitColumns([10, 30, 5], 45)).toEqual([10, 30, 5]);
    expect(fitColumns([10, 30, 5], 30)).toEqual([10, 15, 5]);
    expect(fitColumns([10, 30, 5], 6)).toEqual([3, 3, 3]);
  });
});

describe('diff', () => {
  it('finds changed lines and collapses unchanged context', () => {
    const d = diffLines('a\nb\nc\nd\ne\nf\ng', 'a\nb\nc\nX\ne\nf\ng');
    expect(d.filter((l) => l.kind !== 'same')).toEqual([{ kind: 'del', text: 'd' }, { kind: 'add', text: 'X' }]);
    const ctx = withContext(d, 1);
    expect(ctx[0]).toEqual({ kind: 'skip', count: 2 });
    expect(ctx.at(-1)).toEqual({ kind: 'skip', count: 2 });
  });
});

describe('tool views', () => {
  const tool = (name: string, input: unknown, content?: string) => ({
    kind: 'tool_use' as const, id: 't', name, input, inputJson: '', final: true, children: [],
    result: content === undefined ? undefined : { content, isError: false },
  });
  it('renders Edit as a diff and Bash with its output', () => {
    const edit = renderTool(tool('Edit', { file_path: '/x/a.ts', old_string: 'one\ntwo', new_string: 'one\n2' }, 'ok'), 60);
    expect(strip(edit.title)).toBe('Edit /x/a.ts');
    expect(edit.body.map(strip)).toEqual(['  one', '- two', '+ 2']);
    const bash = renderTool(tool('Bash', { command: 'ls  -la', description: 'List' }, 'a\nb'), 60);
    expect(strip(bash.title)).toBe('Bash ls -la  List');
    expect(bash.body.map(strip)).toEqual(['a', 'b']);
  });
  it('renders a Codex Patch as its unified diff', () => {
    const one = renderTool(tool('Patch', { file_path: '/x/a.txt', changes: [{ path: '/x/a.txt', kind: 'update', diff: '@@ -1,2 +1,2 @@\n keep\n-hello\n+goodbye\n@@ -9 +9 @@\n-x\n+y\n' }] }, ''), 60);
    expect(strip(one.title)).toBe('Patch /x/a.txt');
    expect(one.body.map(strip)).toEqual(['  keep', '- hello', '+ goodbye', '  ⋯', '- x', '+ y']);
    const two = renderTool(tool('Patch', { changes: [{ path: '/x/new.txt', kind: 'add', diff: 'line\n' }, { path: '/x/old.txt', kind: 'delete', diff: '' }] }, ''), 60);
    expect(strip(two.title)).toBe('Patch 2 files');
    expect(two.body.map(strip)).toEqual(['/x/new.txt (new)', '+ line', '/x/old.txt (deleted)']);
  });
  it('renders TodoWrite as a checklist and Read as a one-liner', () => {
    const todo = renderTool(tool('TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }] }, 'ok'), 60);
    expect(strip(todo.title)).toBe('Todos 1/3 done');
    expect(todo.body.map(strip)).toEqual(['☑ a', '◐ b', '☐ c']);
    const read = renderTool(tool('Read', { file_path: '/x/a.ts', offset: 10, limit: 5 }, '1\n2\n3'), 60);
    expect(strip(read.title)).toBe('Read /x/a.ts lines 10-14 · 3 lines');
    expect(read.body).toEqual([]);
  });
});

describe('vivid markdown style', () => {
  const hadBigText = bigText;
  beforeEach(() => {
    setMarkdownStyle('vivid');
    setBigText(true);
  });
  afterEach(() => {
    setMarkdownStyle('classic');
    setBigText(hadBigText);
  });

  it('never produces a line wider than the requested width', () => {
    for (const f of ['sample.md', 'edge.md']) {
      const md = readFileSync(join(FIXTURES, f), 'utf8');
      for (const w of [40, 72, 120]) {
        const over = renderMarkdown(md, w).split('\n').filter((l) => stringWidth(l) > w);
        expect(over, `${f} at ${w}`).toEqual([]);
      }
    }
  });

  it('puts H1 and H2 on double-height row pairs that fit half the width', () => {
    const out = lines('# One two three four\n\n## Two\n\n### Three', 20);
    expect(out.slice(0, 4).map(strip)).toEqual([BIG_TOP + 'One two', BIG_BOTTOM + 'One two', BIG_TOP + 'three four', BIG_BOTTOM + 'three four']);
    expect(strip(out[4])).toBe('─'.repeat(20)); // H1 rule across the page
    expect(out.slice(6, 8).map(strip)).toEqual([BIG_TOP + 'Two', BIG_BOTTOM + 'Two']);
    expect(strip(out[9])).toBe('Three');
  });

  it('draws a bold gold H1 over a regular-weight blue H2', () => {
    const out = lines('# One\n\n## Two', 30);
    expect(out[0]).toMatch(/\x1b\[1m\x1b\[38;2;255;213;128m/);
    expect(out[4]).toMatch(/\x1b\[38;2;124;196;255m/);
    expect(out[4]).not.toContain('\x1b[1m');
  });

  it('keeps headings one row high where the terminal lacks them, or under a quote', () => {
    setBigText(false);
    expect(plain('## Two', 20)).toEqual(['Two', '───']);
    expect(renderMarkdown('## Two', 20)).toContain('\x1b[1m'); // bold at normal size
    setBigText(true);
    expect(renderMarkdown('> ## Quoted', 20)).not.toContain(BIG_TOP);
  });

  it('hides link URLs and draws tables as striped rows', () => {
    expect(plain('[docs](https://example.com/docs)', 40)).toEqual(['docs']);
    const md = '| Key | Value |\n|---|---|\n| one | 1 |\n| two | 2 |';
    expect(plain(md, 40)).toEqual([' Key   Value ', ' one   1     ', ' two   2     ']);
    const out = lines(md, 40);
    expect(out[0]).toContain('\x1b[48;2;45;51;59m'); // shaded header
    expect(out[1]).not.toContain('\x1b[48;2;'); // plain row
    expect(out[2]).toContain('\x1b[48;2;26;31;38m'); // striped row
  });

  it('caps the measure at 100 columns', () => {
    const out = plain('word '.repeat(60).trim(), 160);
    expect(Math.max(...out.map((l) => l.length))).toBeLessThanOrEqual(100);
  });
});

describe('double-height rows', () => {
  afterEach(() => setBigViewport(null));

  it('folds big headings to one row for prefixed views', () => {
    expect(flattenBig(['a', BIG_TOP + 'H', BIG_BOTTOM + 'H', 'b'])).toEqual(['a', 'H', 'b']);
  });

  it('stamps heading rows at frame end and resets them at the next frame start', () => {
    const text = { nodeName: '#text', nodeValue: `a\n${BIG_TOP}H\n${BIG_BOTTOM}H\nb` };
    const viewport = { nodeName: 'ink-box', childNodes: [text], yogaNode: { getComputedTop: () => 2 }, parentNode: undefined };
    setBigViewport(viewport as unknown as DOMElement);
    expect(stampRows()).toBe('\x1b7\x1b[4;1H\x1b#3\x1b[5;1H\x1b#4\x1b8');
    expect(unstampRows()).toBe('\x1b7\x1b[4;1H\x1b#5\x1b[5;1H\x1b#5\x1b8');
    expect(unstampRows()).toBe('');
  });

  it('leaves the rows under a box drawn over the viewport alone', () => {
    const text = { nodeName: '#text', nodeValue: `${BIG_TOP}H\n${BIG_BOTTOM}H\n${BIG_TOP}J\n${BIG_BOTTOM}J` };
    const parent = { nodeName: 'ink-box', childNodes: [] as unknown[], yogaNode: { getComputedTop: () => 0 }, parentNode: undefined };
    const viewport = { nodeName: 'ink-box', style: {}, childNodes: [text], yogaNode: { getComputedTop: () => 2 }, parentNode: parent };
    const cover = { nodeName: 'ink-box', style: { position: 'absolute' }, childNodes: [], yogaNode: { getComputedTop: () => 3, getComputedHeight: () => 2 }, parentNode: parent };
    parent.childNodes.push(viewport, cover);
    setBigViewport(viewport as unknown as DOMElement);
    expect(stampRows()).toBe('\x1b7\x1b[3;1H\x1b#3\x1b[6;1H\x1b#4\x1b8');
    unstampRows();
  });
});
