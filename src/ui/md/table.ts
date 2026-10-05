import { padCenter, padEnd, padStart, width, wrap } from './text.js';
import { BG_OFF, styled, theme, on, off, type Style } from './theme.js';

export type Cell = { text: string; align: 'left' | 'right' | 'center' | null };

const B = (s: string) => on(theme.tableBorder) + s + off(theme.tableBorder);

// Fit natural column widths into `avail` columns by trimming the widest first.
export function fitColumns(natural: number[], avail: number, min = 3): number[] {
  const widths = natural.map((w) => Math.max(min, w));
  let total = widths.reduce((a, b) => a + b, 0);
  while (total > avail) {
    let i = 0;
    for (let j = 1; j < widths.length; j++) if (widths[j] > widths[i]) i = j;
    if (widths[i] <= min) break;
    widths[i]--;
    total--;
  }
  return widths;
}

function pad(s: string, w: number, align: Cell['align']): string {
  if (align === 'right') return padStart(s, w);
  if (align === 'center') return padCenter(s, w);
  return padEnd(s, w);
}

// Render a table with box-drawing borders. Cells are pre-rendered ANSI strings;
// they wrap inside their column when the table is wider than the terminal.
export function renderTable(header: Cell[], rows: Cell[][], totalWidth: number, headerStyle: Style = theme.tableHeader): string[] {
  const cols = header.length;
  const all = [header, ...rows];
  const natural = header.map((_, c) => Math.max(...all.map((r) => width(r[c]?.text ?? ''))));
  const overhead = cols * 3 + 1; // "│ " + " " per column, plus the closing "│"
  const widths = fitColumns(natural, Math.max(cols * 3, totalWidth - overhead));

  const line = (l: string, m: string, r: string) => B(l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r);
  const out: string[] = [line('╭', '┬', '╮')];

  const renderRow = (cells: Cell[], style?: Style) => {
    const wrapped = widths.map((w, c) => wrap(cells[c]?.text ?? '', w));
    const height = Math.max(...wrapped.map((x) => x.length));
    for (let i = 0; i < height; i++) {
      const parts = widths.map((w, c) => {
        const raw = wrapped[c][i] ?? '';
        const text = style ? styled(raw, style) : raw;
        return pad(text, w, cells[c]?.align ?? header[c]?.align ?? null);
      });
      out.push(B('│') + ' ' + parts.join(' ' + B('│') + ' ') + ' ' + B('│'));
    }
  };

  renderRow(header, headerStyle);
  out.push(line('├', '┼', '┤'));
  rows.forEach((r, i) => {
    if (i) out.push(line('├', '┼', '┤'));
    renderRow(r);
  });
  out.push(line('╰', '┴', '╯'));
  return out;
}

// Page-style table: a shaded header and striped rows instead of box borders.
export function renderStripedTable(header: Cell[], rows: Cell[][], totalWidth: number): string[] {
  const cols = header.length;
  const all = [header, ...rows];
  const natural = header.map((_, c) => Math.max(...all.map((r) => width(r[c]?.text ?? ''))));
  const overhead = cols * 3 - 1; // a space either side of each cell, and one between cells
  const widths = fitColumns(natural, Math.max(cols * 3, totalWidth - overhead));

  const out: string[] = [];
  const renderRow = (cells: Cell[], bg: string | null, style?: Style) => {
    const wrapped = widths.map((w, c) => wrap(cells[c]?.text ?? '', w));
    const height = Math.max(...wrapped.map((x) => x.length));
    const bgOn = bg ? on({ bg }) : '';
    for (let i = 0; i < height; i++) {
      const parts = widths.map((w, c) => {
        const raw = wrapped[c][i] ?? '';
        const text = style ? styled(raw, style) : raw;
        return pad(text, w, cells[c]?.align ?? header[c]?.align ?? null);
      });
      const row = ' ' + parts.join('   ') + ' ';
      // A cell's own background (inline code) ends with BG_OFF; put the row's back.
      out.push(bg ? bgOn + row.replaceAll(BG_OFF, bgOn) + BG_OFF : row);
    }
  };

  renderRow(header, theme.tableHeaderBg, theme.tableHeader);
  rows.forEach((r, i) => renderRow(r, i % 2 ? theme.tableStripeBg : null));
  return out;
}
