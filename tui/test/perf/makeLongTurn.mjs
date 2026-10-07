#!/usr/bin/env node
// Generates a synthetic stream-json fixture for one long, busy turn: thinking,
// N tool calls with results, then a long markdown answer streamed in small
// deltas, the way the API chunks real output.
//   node test/perf/makeLongTurn.mjs [tools=40] [answerRepeats=6] > fixtures/long-turn.jsonl
import { readFileSync } from 'node:fs';

const tools = Number(process.argv[2] ?? 40);
const repeats = Number(process.argv[3] ?? 6);
const sid = 'perf-session';
const cwd = '/work/binder'; // fixed, so the fixture never carries whoever generated it
const out = [];
const emit = (o) => out.push(JSON.stringify({ session_id: sid, parent_tool_use_id: null, ...o }));
const chunks = (text, size = 12) => Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));

emit({ type: 'system', subtype: 'init', cwd, model: 'claude-opus-5-5', permissionMode: 'bypassPermissions' });
emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.12, resetsAt: 1791057000 }, seven_day: { utilization: 0.2, resetsAt: 1791075600 } } } });

let msg = 0;
function streamBlock(index, block, deltaType, field, text) {
  emit({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: block } });
  for (const c of chunks(text)) emit({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: deltaType, [field]: c } } });
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index } });
}
const usage = { input_tokens: 2, cache_creation_input_tokens: 500, cache_read_input_tokens: 40000, output_tokens: 300 };

// Thinking, then tool calls one assistant message each.
const thinking = 'I need to look at the renderer, run the tests, and then edit a couple of files. '.repeat(8);
msg++;
emit({ type: 'stream_event', event: { type: 'message_start', message: { id: `msg_${msg}`, role: 'assistant', content: [] } } });
streamBlock(0, { type: 'thinking', thinking: '' }, 'thinking_delta', 'thinking', thinking);
emit({ type: 'assistant', message: { id: `msg_${msg}`, role: 'assistant', content: [{ type: 'thinking', thinking }], usage } });

const kinds = ['Read', 'Bash', 'Edit', 'Grep', 'Write'];
for (let i = 0; i < tools; i++) {
  const name = kinds[i % kinds.length];
  const id = `toolu_${i}`;
  const input = {
    Read: { file_path: `${cwd}/src/ui/file${i}.ts` },
    Bash: { command: `npm test -- --run case${i}`, description: `Run test case ${i}` },
    Edit: { file_path: `${cwd}/src/ui/file${i}.ts`, old_string: Array.from({ length: 12 }, (_, k) => `  const value${k} = compute(${k});`).join('\n'), new_string: Array.from({ length: 12 }, (_, k) => k % 3 ? `  const value${k} = compute(${k});` : `  const value${k} = computeFaster(${k}, cache);`).join('\n') },
    Grep: { pattern: `renderMarkdown${i}`, path: 'src' },
    Write: { file_path: `${cwd}/src/ui/gen${i}.ts`, content: Array.from({ length: 30 }, (_, k) => `export function f${k}(x: number): number { return x * ${k} + ${i}; }`).join('\n') },
  }[name];
  const result = {
    Read: Array.from({ length: 80 }, (_, k) => `${k + 1}\tline ${k} of file ${i}`).join('\n'),
    Bash: Array.from({ length: 40 }, (_, k) => ` ✓ test ${k} passed (${k}ms)`).join('\n'),
    Edit: 'The file has been updated successfully.',
    Grep: Array.from({ length: 12 }, (_, k) => `src/ui/file${k}.ts:${k * 7}`).join('\n'),
    Write: 'File created successfully',
  }[name];
  msg++;
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id: `msg_${msg}`, role: 'assistant', content: [] } } });
  streamBlock(0, { type: 'tool_use', id, name, input: {} }, 'input_json_delta', 'partial_json', JSON.stringify(input));
  emit({ type: 'assistant', message: { id: `msg_${msg}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }], usage } });
  emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] } });
}

// The long markdown answer.
const sample = readFileSync(new URL('../../fixtures/sample.md', import.meta.url), 'utf8');
const answer = Array.from({ length: repeats }, () => sample).join('\n\n');
msg++;
emit({ type: 'stream_event', event: { type: 'message_start', message: { id: `msg_${msg}`, role: 'assistant', content: [] } } });
streamBlock(0, { type: 'text', text: '' }, 'text_delta', 'text', answer);
emit({ type: 'assistant', message: { id: `msg_${msg}`, role: 'assistant', content: [{ type: 'text', text: answer }], usage } });
emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 90000, num_turns: tools + 2, result: answer, total_cost_usd: 0 });

process.stdout.write(out.join('\n') + '\n');
