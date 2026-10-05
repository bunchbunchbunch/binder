// Run with FORCE_COLOR=3 when piping to a file, or Ink drops its colors.
// Render a synthetic finished tab (tool calls + markdown response) to ANSI.
//   npx tsx test/manual/renderTab.tsx [width] > out.ans
import React from 'react';
import { Box, renderToString } from 'ink';
import { readFileSync } from 'node:fs';
import { TabView } from '../../src/ui/TabView.js';
import type { Block, Tab } from '../../src/store.js';

const width = Number(process.argv[2] ?? 100);
const tool = (name: string, input: unknown, result?: string, isError = false): Block => ({
  kind: 'tool_use', id: name, name, input, inputJson: '', final: true, children: [],
  result: result === undefined ? undefined : { content: result, isError },
});

const blocks: Block[] = [
  { kind: 'thinking', text: 'The user wants the renderer tested. I should look at the file first.', final: true },
  tool('Read', { file_path: process.cwd() + '/src/ui/markdown.ts' }, Array.from({ length: 14 }, (_, i) => `${i + 1}\tline`).join('\n')),
  tool('Grep', { pattern: 'renderMarkdown', path: 'src' }, 'src/ui/markdown.ts:5\nsrc/ui/TabView.tsx:4\nsrc/ui/TabView.tsx:48'),
  tool('Bash', { command: 'npm test', description: 'Run the test suite' }, ' RUN  v5.0.3\n Test Files  4 passed (4)\n      Tests  26 passed (26)\n   Duration  1.9s\n extra line 1\n extra line 2\n extra line 3'),
  tool('Edit', {
    file_path: process.cwd() + '/src/ui/markdown.ts',
    old_string: "import { Marked } from 'marked';\nimport { markedTerminal } from 'marked-terminal';\n\nconst cache = new Map<number, Marked>();\n\nexport function renderMarkdown(text: string, width: number): string {\n  const w = Math.max(20, width);",
    new_string: "import { renderMarkdown as render } from './md/render.js';\n\nexport function renderMarkdown(text: string, width: number): string {\n  const w = Math.max(20, width);",
  }, 'The file has been updated.'),
  tool('Write', { file_path: process.cwd() + '/src/ui/md/theme.ts', content: "export const theme = {\n  h1: { bold: true, fg: '#FFD580' },\n  h2: { bold: true, fg: '#7CC4FF' },\n};\n" }, 'File created successfully'),
  tool('TodoWrite', { todos: [
    { content: 'Replace marked-terminal with a lexer-based renderer', status: 'completed' },
    { content: 'Render tool calls with diffs', status: 'in_progress' },
    { content: 'Screenshot and review', status: 'pending' },
  ] }, 'Todos have been modified successfully'),
  tool('Bash', { command: 'npm run build' }, 'error TS2345: Argument of type string is not assignable', true),
  tool('Task', { description: 'Review the diff', subagent_type: 'Explore' }, 'Looks fine. Two nits about naming.'),
  { kind: 'text', text: readFileSync('fixtures/sample.md', 'utf8').split('\n## Comparison')[0], final: true },
];

const tab: Tab = { id: 1, prompt: 'Replace the markdown renderer and show me the result', status: 'done', blocks, result: { durationMs: 42000, costUsd: 0, numTurns: 9, isError: false } };

const out = renderToString(
  <Box width={width} height={200} flexDirection="column">
    <TabView tab={tab} width={width} detail={process.env.DETAIL === '1'} scrollActive={false} questionPending={false} expandedOverride={true} />
  </Box>,
  { columns: width },
);
process.stdout.write(out.replace(/\s+$/, '') + '\n');
