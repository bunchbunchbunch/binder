import { describe, it, expect } from 'vitest';
import * as ed from '../src/ui/editor.js';

const at = (value: string, cursor: number, anchor: number | null = null): ed.Editor => ({ value, cursor, anchor });

describe('editor selection', () => {
  it('Shift+arrow grows a selection from the cursor; plain arrow collapses it to an edge', () => {
    let e = at('hello world', 5);
    e = ed.moveChar(e, 1, true);
    e = ed.moveChar(e, 1, true);
    expect(ed.selectedText(e)).toBe(' w');
    expect(ed.selection(e)).toEqual({ start: 5, end: 7 });
    const left = ed.moveChar(e, -1, false);
    expect(left.cursor).toBe(5);
    expect(ed.selection(left)).toBeNull();
    const right = ed.moveChar(e, 1, false);
    expect(right.cursor).toBe(7);
  });

  it('Shift+Option+arrow selects by word and Shift+Home/End to the line edges', () => {
    let e = at('fix the login bug', 17);
    e = ed.moveTo(e, ed.prevWord(e.value, e.cursor), true);
    expect(ed.selectedText(e)).toBe('bug');
    e = ed.moveTo(e, ed.prevWord(e.value, e.cursor), true);
    expect(ed.selectedText(e)).toBe('login bug');
    e = ed.moveTo(e, ed.lineStart(e.value, e.cursor), true);
    expect(ed.selectedText(e)).toBe('fix the login bug');
    const two = at('one\ntwo three', 6);
    expect(ed.moveTo(two, ed.lineEnd(two.value, two.cursor), true).cursor).toBe(13);
    expect(ed.moveTo(two, ed.lineStart(two.value, two.cursor), true).cursor).toBe(4);
  });

  it('typing, paste, Backspace and Delete all replace the selection', () => {
    const sel = at('hello big world', 6, 9); // "big" selected (anchor after cursor)
    expect(ed.insert(sel, 'small')).toEqual({ value: 'hello small world', cursor: 11, anchor: null });
    expect(ed.deleteBackward(sel)).toEqual({ value: 'hello  world', cursor: 6, anchor: null });
    expect(ed.deleteForward(sel)).toEqual({ value: 'hello  world', cursor: 6, anchor: null });
  });

  it('Backspace and Delete without a selection remove one char or one word', () => {
    expect(ed.deleteBackward(at('abc def', 7))).toEqual({ value: 'abc de', cursor: 6, anchor: null });
    expect(ed.deleteBackward(at('abc def', 7), true)).toEqual({ value: 'abc ', cursor: 4, anchor: null });
    expect(ed.deleteForward(at('abc def', 0)).value).toBe('bc def');
    expect(ed.deleteForward(at('abc def', 0), true).value).toBe(' def');
    expect(ed.deleteBackward(at('', 0)).value).toBe('');
  });

  it('select all and reverse selections', () => {
    const all = ed.selectAll(at('abc', 1));
    expect(ed.selectedText(all)).toBe('abc');
    expect(ed.selectedText(at('abcdef', 1, 4))).toBe('bcd');
  });
});
