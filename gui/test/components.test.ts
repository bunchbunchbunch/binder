import { describe, it, expect, vi } from 'vitest';
import { askSide, type SideItem } from '../src/renderer/src/components/SideChat';
import { askToFix, wasAsked } from '../src/renderer/src/components/FindingsCard';

// The renderer's store talks to the main process; here each request waits until the test answers it.
const pending = vi.hoisted(() => [] as Array<{ answer: (r: Record<string, unknown>) => void }>);
vi.mock('../src/renderer/src/store', () => ({
  request: () => new Promise((answer) => pending.push({ answer })),
  errText: (e: unknown) => String(e),
  toast: () => {},
}));

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the side chat', () => {
  it('puts a late answer on its own question, never on a reopened chat', async () => {
    let chat: SideItem[] | null = null;
    const set = (fn: (now: SideItem[] | null) => SideItem[] | null) => void (chat = fn(chat));
    chat = askSide('c', [], 'SLOW one', set);
    const slow = pending.at(-1)!;
    // Esc closes the chat; /btw two opens it again.
    chat = askSide('c', [], 'two', set);
    pending.at(-1)!.answer({ response: 'Answer to two' });
    await settle();
    slow.answer({ response: 'Answer to one' });
    await settle();
    expect(chat!.map((it) => [it.question, it.response])).toEqual([['two', 'Answer to two']]);
    // One that lands after the chat closed for good goes nowhere.
    chat = askSide('c', chat!, 'three', set);
    const late = pending.at(-1)!;
    chat = null;
    late.answer({ response: 'Answer to three' });
    await settle();
    expect(chat).toBeNull();
  });
});

describe('the findings card', () => {
  it("keys what was sent by the review's turn, so a second review with the same text starts fresh", async () => {
    const f = { file: 'calc.js', line: 3, summary: 'Off by one' };
    const sent = askToFix({ conn: 'c', tabId: 1, turn: 0 }, [f]);
    pending.at(-1)!.answer({});
    expect(await sent).toBe(true);
    expect(wasAsked({ conn: 'c', tabId: 1, turn: 0 }, f)).toBe(true);
    expect(wasAsked({ conn: 'c', tabId: 1, turn: 2 }, f)).toBe(false);
  });
});
