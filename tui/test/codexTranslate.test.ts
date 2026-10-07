import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initialState, nextToSend, reduce, tabText, type Block, type State } from '../src/store.js';
import { Translator, errorText, shellCommand, usageWindows } from '../src/codex/translate.js';
import { FIXTURES } from './helpers.js';

type Line = { dir: 'in' | 'out'; msg: { id?: number; method?: string; params?: Record<string, unknown> } };

function lines(name: string): Line[] {
  return readFileSync(join(FIXTURES, 'codex', name), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((l) => l.dir);
}

const promptOf = (params: Record<string, unknown> | undefined) => ((params?.input as Array<{ text?: string }>) ?? []).map((i) => i.text ?? '').join('');

// Replays a recorded session through the translator and the reducer, doing
// what binder does for each of the recorded client's prompts and steers.
function replayCodex(name: string, opts: { interruptOnRequest?: boolean } = {}): State {
  const t = new Translator(() => ({ sessionId: 'sid', model: 'gpt-6-luna', cwd: '/private/tmp/x' }));
  let s = initialState('sid');
  for (const { dir, msg } of lines(name)) {
    if (dir === 'out' && msg.method === 'turn/start') {
      const uuid = String(msg.params?.clientUserMessageId ?? `u${msg.id}`);
      s = reduce(s, { type: 'submit', prompt: promptOf(msg.params) });
      s = reduce(s, { type: 'sent', tabId: nextToSend(s)!.tabId, uuid });
      t.expectStart(uuid);
    } else if (dir === 'out' && msg.method === 'turn/steer') {
      const uuid = String(msg.params?.clientUserMessageId);
      s = reduce(s, { type: 'steer', tabId: s.running!, prompt: promptOf(msg.params), uuid });
      t.expectSteer(uuid);
    } else if (dir === 'out' && msg.method === 'turn/interrupt' && opts.interruptOnRequest) {
      s = reduce(s, { type: 'interrupt_requested' });
    } else if (dir === 'in' && msg.method && msg.id === undefined) {
      s = reduce(s, { type: 'events', events: t.translate(msg.method, msg.params ?? {}) });
    }
  }
  return s;
}

const tools = (blocks: Block[]) => blocks.filter((b): b is Extract<Block, { kind: 'tool_use' }> => b.kind === 'tool_use');

describe('Codex translation', () => {
  it('streams an answer into one done tab, with the model and context size', () => {
    const s = replayCodex('answer.jsonl');
    expect(s.tabs).toHaveLength(1);
    const tab = s.tabs[0];
    expect(tab.status).toBe('done');
    expect(tab.blocks.map((b) => [b.kind, b.final])).toEqual([['text', true]]);
    expect(tabText(tab)).toMatch(/^A binder clip is a small metal clamp/);
    expect(s.model).toBe('gpt-6-luna');
    expect(s.contextTokens).toBeGreaterThan(0);
    expect(s.canSteer).toBe(true);
    expect(s.usage?.thirty_day).toEqual({ utilization: 0, resetsAt: expect.any(Number) });
  });

  it('shows an approved command as Bash with its shell wrapper removed', () => {
    const tab = replayCodex('approve.jsonl').tabs[0];
    const [bash] = tools(tab.blocks);
    expect(bash.name).toBe('Bash');
    expect(bash.input).toEqual({ command: 'mkdir -p out && echo hello > out/note.txt' });
    expect(bash.result).toEqual({ content: '', isError: false });
    expect(tabText(tab)).toBe('done');
    expect(tab.status).toBe('done');
  });

  it('marks a declined command as an error', () => {
    const tab = replayCodex('decline.jsonl').tabs[0];
    const [bash] = tools(tab.blocks);
    expect(bash.result).toEqual({ content: 'Declined', isError: true });
    expect(tab.blocks.map((b) => b.kind)).toEqual(['text', 'tool_use', 'text']);
    expect(tabText(tab)).toMatch(/skipped$/);
  });

  it('shows a file edit as Patch with its diff', () => {
    const tab = replayCodex('edit.jsonl').tabs[0];
    const [patch] = tools(tab.blocks);
    expect(patch.name).toBe('Patch');
    expect(patch.input).toEqual({
      file_path: '/private/tmp/binder-codex-rec/edit/greeting.txt',
      changes: [{ path: '/private/tmp/binder-codex-rec/edit/greeting.txt', kind: 'update', diff: '@@ -1 +1 @@\n-hello\n+goodbye\n' }],
    });
    expect(patch.result?.isError).toBe(false);
  });

  it('ends an interrupted turn as interrupted, its command without a result', () => {
    const s = replayCodex('interrupt.jsonl', { interruptOnRequest: true });
    const tab = s.tabs[0];
    expect(tab.status).toBe('interrupted');
    expect(tools(tab.blocks)[0].input).toEqual({ command: 'sleep 30' });
    expect(tools(tab.blocks)[0].result).toBeUndefined();
    expect(s.running).toBeNull();
  });

  it('starts the steered follow-up as the tab’s next turn when Codex takes it in', () => {
    const s = replayCodex('steer.jsonl');
    expect(s.tabs).toHaveLength(1);
    const tab = s.tabs[0];
    expect(tab.earlier).toHaveLength(1);
    expect(tab.earlier[0].status).toBe('superseded');
    expect(tools(tab.earlier[0].blocks)[0].input).toEqual({ command: 'sleep 6' });
    expect(tab.prompt).toBe('Name a vegetable instead of a fruit.');
    expect(tab.status).toBe('done');
    expect(tabText(tab)).toBe('Carrot');
    expect(s.steer).toBeUndefined();
  });

  it('shows a failed turn’s API error as the tab’s text', () => {
    const tab = replayCodex('failed.jsonl').tabs[0];
    expect(tab.status).toBe('error');
    expect(tabText(tab)).toBe("The 'no-such-model' model is not supported when using Codex with a ChatGPT account.");
  });

  it('answers a prompt with an image', () => {
    expect(tabText(replayCodex('image.jsonl').tabs[0])).toBe('Orange');
  });

  it('shows a reasoning summary as thinking, without its markdown heading markers', () => {
    const t = new Translator(() => ({ sessionId: 'sid', cwd: '/x' }));
    const [e] = t.translate('item/completed', { item: { type: 'reasoning', id: 'r1', summary: ['**Preparing exact command**\n\nRunning it as **given**.'], content: [] } });
    expect((e as { message: { content: unknown } }).message.content).toEqual([{ type: 'thinking', thinking: 'Preparing exact command\n\nRunning it as **given**.' }]);
  });

  it('turns Codex details into what binder shows', () => {
    expect(shellCommand("/bin/zsh -lc 'sleep 6'")).toBe('sleep 6');
    expect(shellCommand("/bin/bash -c 'echo '\\''hi'\\'''")).toBe("echo 'hi'");
    expect(shellCommand('ls -la')).toBe('ls -la');
    expect(errorText('{"type":"error","error":{"message":"nope"}}')).toBe('nope');
    expect(errorText('plain')).toBe('plain');
    expect(usageWindows({ primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 9 }, secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 10 } })).toEqual({
      five_hour: { utilization: 0.4, resetsAt: 9 },
      seven_day: { utilization: 0.05, resetsAt: 10 },
    });
  });
});
