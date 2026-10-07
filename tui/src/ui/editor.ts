// Pure editing operations for the prompt input: a text buffer with a cursor
// and an optional selection anchor, following macOS text-field conventions.

export type Editor = {
  value: string;
  cursor: number;
  // Selection spans anchor..cursor when anchor is set (either order).
  anchor: number | null;
};

export const empty: Editor = { value: '', cursor: 0, anchor: null };

const SEP = /[\s\p{P}]/u;

// Word boundaries for Option+arrow: skip separators, then the word itself.
export function prevWord(text: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && SEP.test(text[i - 1])) i--;
  while (i > 0 && !SEP.test(text[i - 1])) i--;
  return i;
}

export function nextWord(text: string, cursor: number): number {
  let i = cursor;
  while (i < text.length && SEP.test(text[i])) i++;
  while (i < text.length && !SEP.test(text[i])) i++;
  return i;
}

export function lineStart(text: string, cursor: number): number {
  return text.lastIndexOf('\n', cursor - 1) + 1;
}

export function lineEnd(text: string, cursor: number): number {
  const nl = text.indexOf('\n', cursor);
  return nl === -1 ? text.length : nl;
}

export function selection(e: Editor): { start: number; end: number } | null {
  if (e.anchor === null || e.anchor === e.cursor) return null;
  return { start: Math.min(e.anchor, e.cursor), end: Math.max(e.anchor, e.cursor) };
}

// Move the cursor; with `extend` (Shift held) the anchor stays put so the
// selection grows, otherwise any selection is dropped.
export function moveTo(e: Editor, pos: number, extend: boolean): Editor {
  const cursor = Math.max(0, Math.min(e.value.length, pos));
  if (extend) return { ...e, cursor, anchor: e.anchor ?? e.cursor };
  return { ...e, cursor, anchor: null };
}

// Plain Left/Right on a selection collapse to its edge, like macOS.
export function moveChar(e: Editor, delta: -1 | 1, extend: boolean): Editor {
  const sel = selection(e);
  if (sel && !extend) return { ...e, cursor: delta < 0 ? sel.start : sel.end, anchor: null };
  return moveTo(e, e.cursor + delta, extend);
}

export function insert(e: Editor, text: string): Editor {
  const sel = selection(e);
  const start = sel ? sel.start : e.cursor;
  const end = sel ? sel.end : e.cursor;
  const value = e.value.slice(0, start) + text + e.value.slice(end);
  return { value, cursor: start + text.length, anchor: null };
}

// Backspace: delete the selection, else one char (or a word with Option) before the cursor.
export function deleteBackward(e: Editor, word = false): Editor {
  const sel = selection(e);
  if (sel) return insert(e, '');
  const start = word ? prevWord(e.value, e.cursor) : Math.max(0, e.cursor - 1);
  return { value: e.value.slice(0, start) + e.value.slice(e.cursor), cursor: start, anchor: null };
}

// Forward delete (fn+Delete): the selection, else the char after the cursor.
export function deleteForward(e: Editor, word = false): Editor {
  const sel = selection(e);
  if (sel) return insert(e, '');
  const end = word ? nextWord(e.value, e.cursor) : Math.min(e.value.length, e.cursor + 1);
  return { ...e, value: e.value.slice(0, e.cursor) + e.value.slice(end), anchor: null };
}

export function selectAll(e: Editor): Editor {
  return { ...e, anchor: 0, cursor: e.value.length };
}

export function selectedText(e: Editor): string {
  const sel = selection(e);
  return sel ? e.value.slice(sel.start, sel.end) : '';
}

// Up/Down within a multi-line prompt, keeping the column where it fits.
// Null on the first (Up) or last (Down) line, where history takes over.
export function moveLine(e: Editor, delta: -1 | 1, extend: boolean): Editor | null {
  const start = lineStart(e.value, e.cursor);
  const col = e.cursor - start;
  if (delta < 0) {
    if (start === 0) return null;
    const prevStart = lineStart(e.value, start - 1);
    return moveTo(e, Math.min(prevStart + col, start - 1), extend);
  }
  const end = lineEnd(e.value, e.cursor);
  if (end === e.value.length) return null;
  const nextStart = end + 1;
  return moveTo(e, Math.min(nextStart + col, lineEnd(e.value, nextStart)), extend);
}

export function replaceRange(e: Editor, start: number, end: number, text: string): Editor {
  return { value: e.value.slice(0, start) + text + e.value.slice(end), cursor: start + text.length, anchor: null };
}
