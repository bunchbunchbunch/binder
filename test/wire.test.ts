import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initialState, reduce, type State } from '../src/store.js';
import { parseEventLine, type ClaudeEvent } from '../src/events.js';
import { applyPatch, diff, wireState, type Source, type WireState } from '../src/remote/wire.js';
import { FIXTURES } from './helpers.js';

const roundTrip = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

function events(fixture: string): ClaudeEvent[] {
  return readFileSync(join(FIXTURES, fixture), 'utf8')
    .split('\n')
    .map(parseEventLine)
    .filter((e): e is ClaudeEvent => e !== null);
}

// Drives the reducer through `fixture` in batches, patching a client copy
// after each batch, and checks the copy always equals a fresh snapshot.
function replayWithPatches(fixture: string, batch: number, prompts: string[]) {
  let state: State = initialState('s1');
  let src: Source = { state, cwd: '/w' };
  let client: WireState = roundTrip(wireState(src));
  let bytes = 0;
  const step = (next: State) => {
    const nextSrc = { state: next, cwd: '/w' };
    const patch = diff(src, nextSrc);
    if (patch) {
      const wire = JSON.stringify(patch);
      bytes += wire.length;
      client = applyPatch(client, JSON.parse(wire));
    }
    src = nextSrc;
    state = next;
    expect(roundTrip(client)).toEqual(roundTrip(wireState(src)));
  };
  const all = events(fixture);
  let turn = 0;
  const send = () => {
    let s = reduce(state, { type: 'submit', prompt: prompts[turn] ?? `prompt ${turn}`, tabId: turn + 1 });
    s = reduce(s, { type: 'sent', tabId: turn + 1, uuid: `u${turn}` });
    turn++;
    step(s);
  };
  send();
  for (let i = 0; i < all.length; i += batch) {
    const chunk = all.slice(i, i + batch);
    step(reduce(state, { type: 'events', events: chunk }));
    if (chunk.some((e) => e.type === 'result') && i + batch < all.length) send();
  }
  return { client, bytes, state };
}

describe('wire patches', () => {
  it('keep a client copy equal to the snapshot through a long streamed turn', () => {
    const { client, bytes, state } = replayWithPatches('long-turn.jsonl', 7, ['go']);
    expect(client.tabs[0].status).toBe('done');
    // Streaming text goes as appends, so the patches stay near the transcript's size.
    const full = JSON.stringify(wireState({ state, cwd: '/w' })).length;
    expect(bytes).toBeLessThan(full * 4);
  });

  it('keep up across several turns, one event at a time', () => {
    replayWithPatches('two-turns-stdin.jsonl', 1, ['one', 'two']);
  });

  it('carry a question and its answer', () => {
    let state = initialState('s1');
    const before: Source = { state, cwd: '/w' };
    state = reduce(state, { type: 'question', question: { requestId: 'r1', toolName: 'Bash', toolInput: { command: 'rm -rf build' }, questions: [{ question: 'Allow Bash?', options: [{ label: 'Allow' }, { label: 'Deny' }] }] } });
    const p = diff(before, { state, cwd: '/w' })!;
    expect(p.meta?.question).toMatchObject({ requestId: 'r1', kind: 'permission', toolName: 'Bash', toolInput: { command: 'rm -rf build' } });
    const after = reduce(state, { type: 'question_answered' });
    expect(diff({ state, cwd: '/w' }, { state: after, cwd: '/w' })!.meta).toEqual({ question: null });
  });

  it('cut long tool output and inputs', () => {
    let state = reduce(initialState('s1'), { type: 'submit', prompt: 'p', tabId: 1 });
    state = reduce(state, { type: 'sent', tabId: 1, uuid: 'u' });
    state = reduce(state, {
      type: 'events',
      events: [
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/a', content: 'x'.repeat(10000) } }] } } as ClaudeEvent,
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'y'.repeat(9000) }] } } as ClaudeEvent,
      ],
    });
    const block = wireState({ state, cwd: '/w' }).tabs[0].blocks[0];
    if (block.kind !== 'tool_use') throw new Error('expected a tool call');
    expect(block.result).toMatchObject({ length: 9000 });
    expect(block.result!.content.length).toBe(4000);
    expect((block.input as { content: string }).content.length).toBeLessThan(2100);
    expect((block.input as { file_path: string }).file_path).toBe('/a');
  });
});
