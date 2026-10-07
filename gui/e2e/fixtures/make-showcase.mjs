#!/usr/bin/env node
// Writes showcase.jsonl: a stream-json fixture for bindertui's fake claude
// (test/fakeClaude.mjs replays one turn per prompt). Turn 1 has thinking,
// interim text, Read, Grep, Edit, Bash and TodoWrite calls, then streams a
// Markdown-heavy answer. Turn 2 is a short reply, for a second tab.
//
//   node e2e/fixtures/make-showcase.mjs > e2e/fixtures/showcase.jsonl

const SID = 'showcase-session';
const lines = [];
const emit = (e) => lines.push(JSON.stringify({ session_id: SID, parent_tool_use_id: null, ...e }));
let msg = 0;
const assistant = (content) => emit({ type: 'assistant', message: { id: `msg_${++msg}`, role: 'assistant', model: 'claude-opus-5-5', content } });
const toolResult = (id, content, isError = false) => emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });

function streamText(text, chunk = 48) {
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id: `msg_${++msg}`, role: 'assistant', content: [] } } });
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  for (let i = 0; i < text.length; i += chunk) emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + chunk) } } });
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  emit({ type: 'assistant', message: { id: `msg_${msg}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 12, cache_read_input_tokens: 48210, cache_creation_input_tokens: 1310 } } });
}

const init = () => emit({ type: 'system', subtype: 'init', cwd: '/Users/me/code/app', model: 'claude-opus-5-5', permissionMode: 'acceptEdits' });
const limits = () =>
  emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.34, resetsAt: 1791057000 }, seven_day: { utilization: 0.61, resetsAt: 1791075600 } } } });

const ANSWER = `# Table rendering

Tables were measured in **characters**, not *display columns*, so a cell holding an emoji or CJK text pushed its row out of line. The fix measures with \`stringWidth\` and wraps long cells instead of cutting them. See [the issue](https://github.com/example/app/issues/42) for the original report.

## What changed

1. \`measure()\` uses display width
2. Cells wrap at the column width
   - Words stay whole when they fit
   - A word longer than the column breaks at the edge
3. The header row repeats after a page break

### Checklist

- [x] Width-aware measuring
- [x] Wrapping long cells
- [ ] Right-to-left scripts

## Before and after

| Case | Before | After | Notes |
|---|:---:|---:|---|
| ASCII only | aligned | aligned | unchanged |
| Emoji 👍 | off by one | aligned | width 2 |
| 漢字 | off by two | aligned | width 2 each |
| Long cell | cut | wrapped | keeps every word |

\`\`\`typescript
export function measure(cells: string[][]): number[] {
  const widths: number[] = [];
  for (const row of cells) {
    row.forEach((cell, i) => {
      // Display width, not length: emoji and CJK take two columns.
      widths[i] = Math.max(widths[i] ?? 0, stringWidth(cell));
    });
  }
  return widths;
}
\`\`\`

Run the suite to check it:

\`\`\`bash
npm test -- table
\`\`\`

> The tests cover all four cases above, including a cell longer than the terminal.

![Alignment before and after](https://example.com/table-alignment.png)

---

That's it: **12 tests pass**, and the one remaining item (right-to-left text) needs a separate change.
`;

// Turn 1
init();
limits();
assistant([{ type: 'thinking', thinking: 'The user says tables misalign. Likely the width calculation uses string length. Let me read the table renderer and find where widths are measured, then fix it and run the tests.' }]);
assistant([{ type: 'text', text: "I'll start with the table renderer." }]);
assistant([{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/Users/me/code/app/src/table.ts' } }]);
toolResult('toolu_read', Array.from({ length: 64 }, (_, i) => `${i + 1}\tline ${i + 1} of table.ts`).join('\n'));
assistant([{ type: 'tool_use', id: 'toolu_grep', name: 'Grep', input: { pattern: 'cell.length', path: '/Users/me/code/app/src' } }]);
toolResult('toolu_grep', 'src/table.ts\nsrc/wrap.ts\nsrc/layout.ts');
assistant([
  {
    type: 'tool_use',
    id: 'toolu_edit',
    name: 'Edit',
    input: {
      file_path: '/Users/me/code/app/src/table.ts',
      old_string: 'export function measure(cells: string[][]): number[] {\n  const widths: number[] = [];\n  for (const row of cells) {\n    row.forEach((cell, i) => {\n      widths[i] = Math.max(widths[i] ?? 0, cell.length);\n    });\n  }\n  return widths;\n}',
      new_string: 'export function measure(cells: string[][]): number[] {\n  const widths: number[] = [];\n  for (const row of cells) {\n    row.forEach((cell, i) => {\n      // Display width, not length: emoji and CJK take two columns.\n      widths[i] = Math.max(widths[i] ?? 0, stringWidth(cell));\n    });\n  }\n  return widths;\n}',
    },
  },
]);
toolResult('toolu_edit', 'The file /Users/me/code/app/src/table.ts has been updated successfully.');
assistant([{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'npm test -- table', description: 'Run the table tests' } }]);
toolResult(
  'toolu_bash',
  ['> app@1.0.0 test', '> vitest run table', '', ' ✓ test/table.test.ts (12 tests) 41ms', '   ✓ measures ASCII', '   ✓ measures emoji as two columns', '   ✓ measures CJK as two columns', '   ✓ wraps long cells', '   ✓ keeps words whole', '', ' Test Files  1 passed (1)', '      Tests  12 passed (12)', '   Duration  412ms'].join('\n'),
);
assistant([
  {
    type: 'tool_use',
    id: 'toolu_todo',
    name: 'TodoWrite',
    input: {
      todos: [
        { content: 'Measure cells by display width', status: 'completed', activeForm: 'Measuring' },
        { content: 'Wrap long cells', status: 'completed', activeForm: 'Wrapping' },
        { content: 'Support right-to-left scripts', status: 'pending', activeForm: 'Supporting RTL' },
      ],
    },
  },
]);
toolResult('toolu_todo', 'Todos have been modified successfully.');
streamText(ANSWER);
emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 48200, num_turns: 6, total_cost_usd: 0, result: ANSWER });

// Turn 2
init();
streamText('Tables now measure cells by **display width**, so emoji and CJK text line up, and long cells wrap instead of being cut.');
emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 3100, num_turns: 1, total_cost_usd: 0 });

process.stdout.write(lines.join('\n') + '\n');
