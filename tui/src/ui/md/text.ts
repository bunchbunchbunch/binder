import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import sliceAnsi from 'slice-ansi';

export const width = (s: string) => stringWidth(s);

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
