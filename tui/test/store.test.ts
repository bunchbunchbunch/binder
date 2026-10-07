import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initialState, reduce, nextToSend, tabText, type State } from '../src/store.js';
import type { ClaudeEvent } from '../src/events.js';
import { FIXTURES } from './helpers.js';

function fixture(name: string): ClaudeEvent[] {
  return readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function play(state: State, events: ClaudeEvent[]): State {
  return events.reduce((s, event) => reduce(s, { type: 'event', event }), state);
}

describe('store', () => {
  it('turns a streamed single turn into one done tab whose text matches the result', () => {
    const events = fixture('single-turn-partial.jsonl');
    let s = reduce(initialState('sid'), { type: 'submit', prompt: 'Reply with just: ok' });
    expect(s.tabs[0].status).toBe('queued');
    expect(nextToSend(s)?.tabId).toBe(1);
    s = reduce(s, { type: 'sent', tabId: 1 });
    expect(s.tabs[0].status).toBe('running');

    // Mid-stream: the thinking block was already finalized by its `assistant`
    // line, the text block has streamed but is not final yet.
    const firstTextDelta = events.findIndex(
      (e) => e.type === 'stream_event' && (e as { event: { delta?: { type: string } } }).event.delta?.type === 'text_delta',
    );
    const mid = play(s, events.slice(0, firstTextDelta + 1));
    expect(mid.tabs[0].blocks.map((b) => [b.kind, b.final])).toEqual([['thinking', true], ['text', false]]);
    expect(tabText(mid.tabs[0])).toBe('ok');

    const done = play(s, events);
    const tab = done.tabs[0];
    expect(tab.status).toBe('done');
    expect(tab.blocks.map((b) => [b.kind, b.final])).toEqual([['thinking', true], ['text', true]]);
    expect(tabText(tab)).toBe(tab.result?.text);
    expect(done.running).toBeNull();
    expect(done.model).toBe('claude-haiku-4-5-20251001');
    expect(done.usage?.five_hour?.utilization).toBe(0.01);
    expect(done.usage?.seven_day?.resetsAt).toBe(1791075600);
  });

  it('queues a second prompt until the first result arrives', () => {
    const events = fixture('two-turns-stdin.jsonl');
    const firstResult = events.findIndex((e) => e.type === 'result');
    let s = reduce(initialState('sid'), { type: 'submit', prompt: 'A' });
    s = reduce(s, { type: 'sent', tabId: 1 });
    s = reduce(s, { type: 'submit', prompt: 'B' });
    expect(s.tabs.map((t) => t.status)).toEqual(['running', 'queued']);
    expect(s.active).toBe(1);
    expect(nextToSend(s)).toBeUndefined();

    s = play(s, events.slice(0, firstResult));
    expect(nextToSend(s)).toBeUndefined();
    s = play(s, events.slice(firstResult, firstResult + 1));
    expect(s.tabs[0].status).toBe('done');
    expect(nextToSend(s)?.tabId).toBe(2);

    s = reduce(s, { type: 'sent', tabId: 2 });
    s = play(s, events.slice(firstResult + 1));
    expect(s.tabs[1].status).toBe('done');
    expect(tabText(s.tabs[1])).toMatch(/ok2/);
    expect(tabText(s.tabs[0])).toBe('A');
  });

  it('attaches tool results and nests subagent output under the tool block', () => {
    let s = reduce(initialState('sid'), { type: 'submit', prompt: 'run' });
    s = reduce(s, { type: 'sent', tabId: 1 });
    const assistant = (content: unknown, parent: string | null = null): ClaudeEvent =>
      ({ type: 'assistant', message: { role: 'assistant', content }, parent_tool_use_id: parent }) as ClaudeEvent;
    s = play(s, [
      assistant([{ type: 'tool_use', id: 't1', name: 'Agent', input: { prompt: 'x' } }]),
      assistant([{ type: 'text', text: 'sub says hi' }], 't1'),
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'agent done' }] }] }, parent_tool_use_id: null } as ClaudeEvent,
    ]);
    const tool = s.tabs[0].blocks[0];
    expect(tool.kind).toBe('tool_use');
    if (tool.kind !== 'tool_use') return;
    expect(tool.name).toBe('Agent');
    expect(tool.result).toEqual({ content: 'agent done', isError: false });
    expect(tool.children).toEqual([{ kind: 'text', text: 'sub says hi', final: true }]);
  });

  it('marks the tab interrupted when a result follows an interrupt request', () => {
    let s = reduce(initialState('sid'), { type: 'submit', prompt: 'long' });
    s = reduce(s, { type: 'sent', tabId: 1 });
    s = reduce(s, { type: 'interrupt_requested' });
    s = play(s, [{ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, num_turns: 1, session_id: 'sid' } as ClaudeEvent]);
    expect(s.tabs[0].status).toBe('interrupted');
    expect(s.interrupting).toBe(false);
  });

  it('shows an error result message when nothing streamed', () => {
    let s = reduce(initialState('sid'), { type: 'submit', prompt: 'x' });
    s = reduce(s, { type: 'sent', tabId: 1 });
    s = play(s, [{ type: 'result', subtype: 'error', is_error: true, duration_ms: 1, num_turns: 0, result: 'boom', session_id: 'sid' } as ClaudeEvent]);
    expect(s.tabs[0].status).toBe('error');
    expect(tabText(s.tabs[0])).toBe('boom');
  });

  it('sends a Ctrl+Enter follow-up into the same tab after its turn ends', () => {
    const events = fixture('two-turns-stdin.jsonl');
    const firstResult = events.findIndex((e) => e.type === 'result');
    let s = reduce(initialState('sid'), { type: 'submit', prompt: 'A' });
    s = reduce(s, { type: 'sent', tabId: 1 });
    s = play(s, events.slice(0, firstResult + 1));
    s = reduce(s, { type: 'followup', tabId: 1, prompt: 'B' });
    expect(nextToSend(s)).toMatchObject({ tabId: 1, prompt: 'B', followup: true });
    s = reduce(s, { type: 'sent', tabId: 1 });
    expect(s.tabs[0]).toMatchObject({ prompt: 'B', status: 'running', blocks: [] });
    s = play(s, events.slice(firstResult + 1));
    expect(s.tabs).toHaveLength(1);
    const tab = s.tabs[0];
    expect(tab.earlier.map((t) => [t.prompt, t.status])).toEqual([['A', 'done']]);
    expect(tabText(tab.earlier[0] as typeof tab)).toBe('A');
    expect([tab.prompt, tab.status]).toEqual(['B', 'done']);
    expect(tabText(tab)).toMatch(/ok2/);
  });

  // Recorded from claude 2.1.289: a message sent mid-turn plus an interrupt
  // with send_now stops the turn, then runs the message as the next turn.
  it('Ctrl+Enter on a running tab (send now): the stopped turn moves into the tab history', () => {
    const events = fixture('steer-sendnow.jsonl');
    const uuid = 'aa2cbc52-f680-4bf2-a47b-cf765b1610d8';
    const sentAt = events.findIndex((e) => e.type === 'command_lifecycle' && (e as { command_uuid: string }).command_uuid === uuid);
    const firstResult = events.findIndex((e) => e.type === 'result');
    let s = reduce(initialState('sid'), { type: 'submit', prompt: 'run sleep' });
    s = reduce(s, { type: 'sent', tabId: 1 });
    s = play(s, events.slice(0, sentAt));
    expect(s.canSteer).toBe(true);
    s = reduce(s, { type: 'steer', tabId: 1, prompt: 'also say PINEAPPLE', uuid });
    s = reduce(s, { type: 'submit', prompt: 'another tab' });
    s = reduce(s, { type: 'select', index: 0 });

    // The stopped turn's result must not let the queued tab go first.
    s = play(s, events.slice(sentAt, firstResult + 1));
    expect(s.tabs[0].status).toBe('superseded');
    expect(nextToSend(s)).toBeUndefined();

    s = play(s, events.slice(firstResult + 1));
    const tab = s.tabs[0];
    expect(tab.earlier.map((t) => [t.prompt, t.status])).toEqual([['run sleep', 'superseded']]);
    expect([tab.prompt, tab.status]).toEqual(['also say PINEAPPLE', 'done']);
    expect(tabText(tab)).toMatch(/PINEAPPLE/);
    expect(s.steer).toBeUndefined();
    expect(nextToSend(s)?.tabId).toBe(2);
  });

  // Recorded from claude 2.1.289: without send_now, a mid-turn message is
  // taken into the running turn at the next tool boundary; one result ends both.
  it('a mid-turn message taken into the running turn splits the tab at the point it started', () => {
    const events = fixture('steer-fold.jsonl');
    const uuid = '9e7159b4-be1b-4a81-bb6a-1a6624183824';
    const sentAt = events.findIndex((e) => e.type === 'command_lifecycle' && (e as { command_uuid: string }).command_uuid === uuid);
    let s = reduce(initialState('sid'), { type: 'submit', prompt: 'run sleep' });
    s = reduce(s, { type: 'sent', tabId: 1 });
    s = play(s, events.slice(0, sentAt));
    s = reduce(s, { type: 'steer', tabId: 1, prompt: 'also say PINEAPPLE', uuid });
    s = play(s, events.slice(sentAt));
    const tab = s.tabs[0];
    expect(tab.earlier.map((t) => [t.prompt, t.status])).toEqual([['run sleep', 'superseded']]);
    expect(tab.earlier[0].blocks.some((b) => b.kind === 'tool_use' && b.result?.content === 'FIRST-DONE')).toBe(true);
    expect([tab.prompt, tab.status]).toEqual(['also say PINEAPPLE', 'done']);
    expect(tabText(tab)).toMatch(/PINEAPPLE/);
    expect(s.running).toBeNull();
    expect(s.steer).toBeUndefined();
  });

  it('cycles tab selection', () => {
    let s = initialState('sid');
    for (const p of ['a', 'b', 'c']) s = reduce(s, { type: 'submit', prompt: p });
    expect(s.active).toBe(2);
    s = reduce(s, { type: 'select_relative', delta: 1 });
    expect(s.active).toBe(0);
    s = reduce(s, { type: 'select_relative', delta: -1 });
    expect(s.active).toBe(2);
    s = reduce(s, { type: 'select', index: 99 });
    expect(s.active).toBe(2);
  });
});

describe('editing a queued prompt', () => {
  // Tab 1 running; tab 2 done with follow-up 'B' queued into it; tab 3 queued.
  const busy = () => {
    let s = reduce(initialState('sid'), { type: 'submit', prompt: 'one' });
    s = reduce(s, { type: 'sent', tabId: 1 });
    s = reduce(s, { type: 'submit', prompt: 'two' });
    s = reduce(s, { type: 'followup', tabId: 2, prompt: 'B' });
    return reduce(s, { type: 'submit', prompt: 'three' });
  };

  it("changes a new tab's prompt in place, and the tab's title with it", () => {
    const s = reduce(busy(), { type: 'edit_queued', tabId: 3, prompt: 'three', text: 'THREE' });
    expect(s.queue.map((q) => [q.tabId, q.prompt])).toEqual([[2, 'two'], [2, 'B'], [3, 'THREE']]);
    expect(s.tabs.map((t) => t.prompt)).toEqual(['one', 'two', 'THREE']);
  });

  it('changes a follow-up in place, leaving its tab alone', () => {
    const before = busy();
    const s = reduce(before, { type: 'edit_queued', tabId: 2, prompt: 'B', text: 'BB' });
    expect(s.queue.map((q) => [q.tabId, q.prompt, q.followup])).toEqual([[2, 'two', false], [2, 'BB', true], [3, 'three', false]]);
    expect(s.tabs).toBe(before.tabs);
  });

  it('removes a follow-up', () => {
    const s = reduce(busy(), { type: 'edit_queued', tabId: 2, prompt: 'B', text: '' });
    expect(s.queue.map((q) => q.prompt)).toEqual(['two', 'three']);
    expect(s.tabs).toHaveLength(3);
  });

  it("removes a new tab's prompt with its tab and what was queued into it, keeping the active tab in view", () => {
    let s = reduce(busy(), { type: 'select', index: 2 });
    s = reduce(s, { type: 'edit_queued', tabId: 2, prompt: 'two', text: '' });
    expect(s.queue.map((q) => q.prompt)).toEqual(['three']);
    expect(s.tabs.map((t) => t.id)).toEqual([1, 3]);
    expect(s.active).toBe(1); // still tab 3
    s = reduce(s, { type: 'edit_queued', tabId: 3, prompt: 'three', text: '' });
    expect(s.tabs.map((t) => t.id)).toEqual([1]);
    expect(s.active).toBe(0);
    expect(s.queue).toEqual([]);
  });

  it('leaves the state alone once the prompt has been sent', () => {
    const s = busy();
    expect(reduce(s, { type: 'edit_queued', tabId: 1, prompt: 'one', text: 'x' })).toBe(s);
    expect(reduce(s, { type: 'edit_queued', tabId: 3, prompt: 'not this', text: '' })).toBe(s);
  });
});

// With --prompt-suggestions the child writes the next prompt it predicts
// after a turn's result (shape recorded from the real binary).
describe('prompt suggestions', () => {
  const suggestion = { type: 'prompt_suggestion', suggestion: 'write tests', uuid: 'u1', session_id: 'sid' } as ClaudeEvent;
  const finished = () => {
    const s = reduce(reduce(initialState('sid'), { type: 'submit', prompt: 'Reply with just: ok' }), { type: 'sent', tabId: 1 });
    return play(s, fixture('single-turn-partial.jsonl'));
  };

  it('keeps the suggestion that follows a turn until anything is sent', () => {
    const s = reduce(finished(), { type: 'event', event: suggestion });
    expect(s.suggestion).toBe('write tests');
    expect(reduce(s, { type: 'submit', prompt: 'write tests' }).suggestion).toBeUndefined();
    expect(reduce(s, { type: 'followup', tabId: 1, prompt: 'more' }).suggestion).toBeUndefined();
    expect(reduce(s, { type: 'steer', tabId: 1, prompt: 'more', uuid: 'u2' }).suggestion).toBeUndefined();
    expect(reduce(s, { type: 'bash_start', command: 'ls' }).suggestion).toBeUndefined();
  });

  it('drops one that arrives after the next prompt was queued', () => {
    const queued = reduce(finished(), { type: 'submit', prompt: 'next' });
    expect(reduce(queued, { type: 'event', event: suggestion }).suggestion).toBeUndefined();
  });

  it('clears it when the child starts a turn of its own', () => {
    const s = reduce(finished(), { type: 'event', event: suggestion });
    const init = { type: 'system', subtype: 'init', session_id: 'sid', cwd: '/private/tmp', model: 'm', permissionMode: 'default' } as ClaudeEvent;
    expect(reduce(s, { type: 'event', event: init }).suggestion).toBeUndefined();
  });
});

describe('permission mode', () => {
  // Claude can switch modes mid-turn (EnterPlanMode, ExitPlanMode); the
  // footer should change then, not at the next turn's init.
  it('follows a mode change reported in a status event', () => {
    const events = fixture('plan-after-bypass.jsonl');
    const at = (uuid: string) => events.findIndex((e) => (e as { uuid?: string }).uuid === uuid) + 1;
    expect(play(initialState('sid'), events.slice(0, 1)).permissionMode).toBe('bypassPermissions');
    expect(play(initialState('sid'), events.slice(0, at('s1'))).permissionMode).toBe('plan');
    expect(play(initialState('sid'), events.slice(0, at('u2'))).permissionMode).toBe('plan');
    expect(play(initialState('sid'), events.slice(0, at('s2'))).permissionMode).toBe('bypassPermissions');
  });

  it('keeps the mode through status events that do not carry one', () => {
    const s = play(initialState('sid'), fixture('plan-after-bypass.jsonl').slice(0, 3));
    expect(play(s, [{ type: 'system', subtype: 'status', status: 'requesting' } as ClaudeEvent]).permissionMode).toBe('plan');
  });
});

// Recorded from the real binary: a prompt starts background work and the turn
// ends; when the work finishes the child starts a turn of its own about it.
describe('background work', () => {
  // Plays an event-log fixture (child events and binder's hc_prompt markers)
  // the way the host does, checking each prompt could be sent when it was.
  function drive(name: string, until?: (e: Record<string, unknown>) => boolean): State {
    let s = initialState('sid');
    for (const e of fixture(name) as unknown as Record<string, unknown>[]) {
      if (e.type === 'hc_prompt') {
        s = reduce(s, { type: 'submit', prompt: String(e.prompt), tabId: Number(e.tabId) });
        expect(nextToSend(s)?.tabId).toBe(e.tabId);
        s = reduce(s, { type: 'sent', tabId: Number(e.tabId), uuid: String(e.uuid) });
      } else {
        s = reduce(s, { type: 'event', event: e as unknown as ClaudeEvent });
      }
      if (until?.(e)) break;
    }
    return s;
  }

  it('shows the turn the child starts when a background shell finishes, in the tab that launched it', () => {
    const idle = drive('background-bash.jsonl', (e) => e.type === 'result');
    expect(idle.running).toBeNull();
    expect(idle.backgroundTasks).toEqual([{ id: 'bifp3kil2', type: 'local_bash', description: 'sleep 8; echo BG_DONE' }]);

    const s = drive('background-bash.jsonl');
    expect(s.tabs).toHaveLength(1);
    const tab = s.tabs[0];
    expect(tab.earlier.map((t) => [t.status, t.result?.text])).toEqual([['done', 'started']]);
    expect(tab).toMatchObject({ auto: true, prompt: 'Background task finished: sleep 8; echo BG_DONE', status: 'done' });
    expect(tabText(tab)).toBe('BG_DONE');
    expect(s.running).toBeNull();
    expect(s.backgroundTasks).toEqual([]);
  });

  it("keeps a background agent's work under its Agent call after the turn ends, then shows its report", () => {
    const s = drive('background-agent.jsonl');
    const tab = s.tabs[0];
    const agent = tab.earlier[0].blocks.find((b) => b.kind === 'tool_use' && b.name === 'Agent');
    if (agent?.kind !== 'tool_use') throw new Error('no Agent call');
    // Everything after its first thinking block arrived once the turn had ended.
    expect(agent.children.map((b) => (b.kind === 'tool_use' ? [b.name, b.result?.content] : [b.kind, b.text]))).toEqual([
      ['thinking', ''],
      ['Bash', 'AGENT_DONE'],
      ['thinking', ''],
      ['text', 'AGENT_DONE'],
    ]);
    expect(tab).toMatchObject({ auto: true, prompt: 'Background task finished: slow echo', status: 'done' });
    expect(tabText(tab)).toBe('AGENT_DONE');
  });

  it("a prompt sent as background work finishes runs in its own tab, with the child's turn taken in", () => {
    const s = drive('background-race.jsonl');
    expect(s.tabs.map((t) => [t.id, t.earlier.length, t.status, !!t.auto])).toEqual([
      [1, 0, 'done', false],
      [2, 0, 'done', false],
    ]);
    expect(tabText(s.tabs[1])).toBe('PONG');
    expect(s.running).toBeNull();
    expect(s.unstarted).toBeUndefined();
  });

  it('work that finishes during a turn is taken into that turn', () => {
    const s = drive('background-midturn.jsonl');
    expect(s.tabs.flatMap((t) => [t, ...t.earlier]).some((t) => t.auto)).toBe(false);
    expect(tabText(s.tabs[1])).toBe('FG_DONE');
    expect(s.notices).toEqual([]);
  });

  it("holds the queue until a sent prompt starts, and reopens its tab when the child's own turn closed it first", () => {
    const ev = (e: object) => ({ type: 'event' as const, event: e as ClaudeEvent });
    const init = ev({ type: 'system', subtype: 'init', cwd: '/', model: 'm', permissionMode: 'default', capabilities: ['interrupt_send_now_v1', 'msg_lifecycle_v1'] });
    const say = (text: string) => ev({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null });
    const result = (text: string) => ev({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, num_turns: 1, result: text });
    let s: State = { ...initialState('sid'), canSteer: true };
    s = reduce(s, { type: 'submit', prompt: 'A', tabId: 1 });
    s = reduce(s, { type: 'sent', tabId: 1, uuid: 'u1' });
    // The child runs a turn of its own before taking A, and its result closes tab 1.
    for (const a of [init, say('background report'), result('background report')]) s = reduce(s, a);
    expect(s.running).toBeNull();
    s = reduce(s, { type: 'submit', prompt: 'B', tabId: 2 });
    expect(nextToSend(s)).toBeUndefined(); // A has not started yet
    s = reduce(s, ev({ type: 'command_lifecycle', command_uuid: 'u1', state: 'started' }));
    expect([s.running, s.tabs[0].status]).toEqual([1, 'running']);
    for (const a of [init, say('A answered'), result('A answered')]) s = reduce(s, a);
    expect(tabText(s.tabs[0])).toBe('background report\nA answered');
    expect(s.tabs[0]).toMatchObject({ status: 'done', result: { text: 'A answered' } });
    expect(nextToSend(s)?.tabId).toBe(2);
  });
});
