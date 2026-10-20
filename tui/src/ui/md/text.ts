import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import sliceAnsi from 'slice-ansi';

export const width = (s: string) => stringWidth(s);

// Strip the bytes that start or steer terminal escape sequences from untrusted
// text (model output, tool output, file contents, other sessions' prompts)
// before it reaches the screen. Removing the introducer bytes themselves (ESC,
// BEL, the C1 range 0x80-0x9f including CSI 0x9b and OSC 0x9d, the other C0
// controls and DEL) makes it impossible to form a sequence, and because it
// works byte by byte it is not fooled by a payload split across stream deltas.
// Tab and newline are kept; binder adds its own color and hyperlinks after.
// Ink's own sanitizer drops most sequences but passes OSC (hyperlink) tokens
// through verbatim, so an OSC 8 link can smuggle an OSC 52 clipboard write or a
// cursor/erase sequence past it; this closes that gap at the source.
export const clean = (s: string): string => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');

// Wrap an ANSI string to `w` columns; long words are broken rather than
// overflowing. Prose drops the whitespace at wrap points; code keeps it.
export function wrap(s: string, w: number, keepSpace = false): string[] {
  if (w < 1) return [s];
  return wrapAnsi(s, w, { hard: true, trim: !keepSpace }).split('\n');
}

export function truncate(s: string, w: number): string {
  if (width(s) <= w) return s;
  return sliceAnsi(s, 0, Math.max(0, w - 1)) + '…';
}

export function padEnd(s: string, w: number): string {
  const n = w - width(s);
  return n > 0 ? s + ' '.repeat(n) : s;
}

export function padStart(s: string, w: number): string {
  const n = w - width(s);
  return n > 0 ? ' '.repeat(n) + s : s;
}

export function padCenter(s: string, w: number): string {
  const n = w - width(s);
  if (n <= 0) return s;
  const left = Math.floor(n / 2);
  return ' '.repeat(left) + s + ' '.repeat(n - left);
}

// Prefix every line; the first line gets `first`, the rest `rest`.
export function indent(lines: string[], first: string, rest = ' '.repeat(width(first))): string[] {
  return lines.map((l, i) => (i === 0 ? first + l : l ? rest + l : ''));
}
