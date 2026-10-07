import { describe, it, expect } from 'vitest';
import { applyPatch, type WireState, type WireTab } from '../src/shared/wire';

const meta = { sessionId: 's1', cwd: '/w', model: null, permissionMode: null, usage: null, contextTokens: null, running: null, activity: '', interrupting: false, canSteer: true, queue: [], steer: null, question: null, childExit: null, effort: null };
const tab = (id: number, text = ''): WireTab => ({ id, prompt: `p${id}`, status: 'running', blocks: [{ kind: 'text', text, final: false }], earlier: [] });
const fields = { prompt: 'p1', status: 'done' as const, result: null, uuid: 'u1', bash: false };

describe('applyPatch', () => {
  it('appends streamed text and copies the tab fields', () => {
    const s: WireState = { ...meta, tabs: [tab(1, 'Hel')] };
    const next = applyPatch(s, { t: 'patch', tabs: [{ op: 'append', id: 1, index: 0, text: 'lo', fields }] });
    expect(next.tabs[0].blocks[0]).toMatchObject({ text: 'Hello' });
    expect(next.tabs[0]).toMatchObject({ status: 'done', uuid: 'u1' });
    expect(next.tabs[0].bash).toBeUndefined();
  });

  it('replaces blocks from an index, sets and removes tabs in id order, and merges meta', () => {
    const s: WireState = { ...meta, tabs: [tab(1, 'a'), tab(3)] };
    const next = applyPatch(s, {
      t: 'patch',
      meta: { running: 2, activity: 'thinking' },
      tabs: [
        { op: 'blocks', id: 1, from: 0, blocks: [{ kind: 'thinking', text: 't', final: true }], fields },
        { op: 'set', tab: tab(2) },
        { op: 'remove', id: 3 },
      ],
    });
    expect(next.tabs.map((t) => t.id)).toEqual([1, 2]);
    expect(next.tabs[0].blocks).toEqual([{ kind: 'thinking', text: 't', final: true }]);
    expect(next).toMatchObject({ running: 2, activity: 'thinking' });
  });

  it('leaves untouched tabs as they were (memoized views skip them)', () => {
    const s: WireState = { ...meta, tabs: [tab(1, 'a'), tab(2, 'b')] };
    const next = applyPatch(s, { t: 'patch', tabs: [{ op: 'append', id: 2, index: 0, text: 'c', fields: { ...fields, prompt: 'p2' } }] });
    expect(next.tabs[0]).toBe(s.tabs[0]);
  });
});
