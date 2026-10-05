import type { DOMElement } from 'ink';

// Double-height rows for big headings. iTerm2 and Terminal.app draw a row at
// twice the size when it carries the DEC line attribute ESC#3 (top half) or
// ESC#4 (bottom half); ESC#5 makes it a normal row again. The renderer starts
// both rows of a big heading with its escape. Ink drops these escapes from its
// output, so binder stamps the rows itself. A stamped row only addresses half
// the columns (a full-width write there wraps into the next row) and erasing
// does not clear the attribute, so each synchronized frame first turns the
// stamped rows back to normal, lets Ink write, then stamps the new heading rows.

export const BIG_TOP = '\x1b#3';
export const BIG_BOTTOM = '\x1b#4';
const NORMAL = '\x1b#5';
const BEGIN_SYNC = '\x1b[?2026h';
const END_SYNC = '\x1b[?2026l';

// Terminals known to draw double-height lines; elsewhere headings stay one row.
export let bigText = ['iTerm.app', 'Apple_Terminal'].includes(process.env.TERM_PROGRAM ?? '');

export function setBigText(on: boolean): void {
  bigText = on;
}

// One normal row per big heading, for callers that prefix lines (a stamped
// row would double the prefix too).
export function flattenBig(lines: string[]): string[] {
  return lines.filter((l) => !l.startsWith(BIG_BOTTOM)).map((l) => l.slice(bigAttr(l)?.length ?? 0));
}

const bigAttr = (l: string) => [BIG_TOP, BIG_BOTTOM].find((a) => l.startsWith(a));

// The Box whose text rows may hold big headings: the transcript viewport.
let viewport: DOMElement | null = null;
let stamped: number[] = [];

export function setBigViewport(node: DOMElement | null): void {
  viewport = node;
}

function textOf(node: DOMElement): string {
  return node.childNodes.map((c) => (c.nodeName === '#text' ? c.nodeValue : textOf(c))).join('');
}

function screenTop(node: DOMElement): number {
  let y = 0;
  for (let n: DOMElement | undefined = node; n; n = n.parentNode) y += n.yogaNode?.getComputedTop() ?? 0;
  return y;
}

// Cursor-saved sequences that set row attributes, '' when there are none.
const atRows = (rows: Array<[number, string]>) =>
  rows.length ? '\x1b7' + rows.map(([r, a]) => `\x1b[${r + 1};1H${a}`).join('') + '\x1b8' : '';

// Frame start: every stamped row back to normal width.
export function unstampRows(): string {
  const out = atRows(stamped.map((r) => [r, NORMAL]));
  stamped = [];
  return out;
}

// Frame end: stamp the big-heading rows now in the viewport.
export function stampRows(): string {
  const rows: Array<[number, string]> = [];
  if (viewport?.yogaNode) {
    const top = screenTop(viewport);
    textOf(viewport)
      .split('\n')
      .forEach((l, i) => {
        const a = bigAttr(l);
        if (a) rows.push([top + i, a]);
      });
  }
  stamped = rows.map(([r]) => r);
  return atRows(rows);
}

// Ink wraps every frame in a synchronized update, so the terminal never shows
// the rows between the unstamp and the stamp.
export function stampFrames(stream: NodeJS.WriteStream): void {
  const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    const before = chunk === END_SYNC ? stampRows() : '';
    if (before) write(before);
    const ok = write(chunk, ...rest);
    const after = chunk === BEGIN_SYNC ? unstampRows() : '';
    if (after) write(after);
    return ok;
  }) as typeof stream.write;
}
