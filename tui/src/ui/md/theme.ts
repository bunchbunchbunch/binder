// ANSI styling helpers for the markdown renderer. Everything is 24-bit color
// with explicit "off" codes (never a full reset) so nested spans can restore
// the style around them. Palette leans on blue, gold, and purple so it reads
// the same for red-green color blindness.

export type Style = {
  fg?: string; // hex
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
};

const hex = (h: string) => {
  const n = parseInt(h.replace('#', ''), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
};

export const FG_OFF = '\x1b[39m';
export const BG_OFF = '\x1b[49m';

export function on(s: Style): string {
  let out = '';
  if (s.bold) out += '\x1b[1m';
  if (s.dim) out += '\x1b[2m';
  if (s.italic) out += '\x1b[3m';
  if (s.underline) out += '\x1b[4m';
  if (s.strike) out += '\x1b[9m';
  if (s.fg) out += `\x1b[38;2;${hex(s.fg)}m`;
  if (s.bg) out += `\x1b[48;2;${hex(s.bg)}m`;
  return out;
}

export function off(s: Style): string {
  let out = '';
  if (s.bold || s.dim) out += '\x1b[22m';
  if (s.italic) out += '\x1b[23m';
  if (s.underline) out += '\x1b[24m';
  if (s.strike) out += '\x1b[29m';
  if (s.fg) out += FG_OFF;
  if (s.bg) out += BG_OFF;
  return out;
}

// Style `text`, then restore `outer` (the enclosing style) so an inner span's
// off codes do not strip the span around it.
export function styled(text: string, s: Style, outer: Style = {}): string {
  return on(s) + text + off(s) + on({ ...outer });
}

const classic = {
  h1: { bold: true, fg: '#FFD580' } as Style,
  h1Rule: { fg: '#FFD580' } as Style,
  h2: { bold: true, fg: '#7CC4FF' } as Style,
  h2Rule: { fg: '#4A6A8A' } as Style,
  h3: { bold: true, fg: '#C9A0FF' } as Style,
  h4: { bold: true } as Style,
  h5: { bold: true } as Style,
  h6: { bold: true } as Style,
  strong: { bold: true, fg: '#FFFFFF' } as Style,
  em: { italic: true } as Style,
  del: { strike: true, dim: true } as Style,
  codespan: { fg: '#E8C07D', bg: '#2C313A' } as Style,
  link: { fg: '#7CC4FF', underline: true } as Style,
  linkUrl: { fg: '#5C6370' } as Style,
  bullet: { fg: '#7CC4FF' } as Style,
  number: { fg: '#7CC4FF' } as Style,
  checkbox: { fg: '#7CC4FF' } as Style,
  checked: { fg: '#98C379' } as Style,
  quoteBar: { fg: '#C9A0FF' } as Style,
  quoteText: { italic: true, fg: '#B8BCC8' } as Style,
  codeBg: '#1F2329',
  codeLang: { dim: true, italic: true } as Style,
  codePlain: { fg: '#D7DAE0' } as Style,
  tableBorder: { fg: '#6B7280' } as Style,
  tableHeader: { bold: true, fg: '#7CC4FF' } as Style,
  tableHeaderBg: '#2D333B',
  tableStripeBg: '#1A1F26',
  hr: { fg: '#5C6370' } as Style,
  muted: { fg: '#7F848E' } as Style,
  html: { dim: true } as Style,
};

// "vivid" lays responses out like a rendered markdown page (big H1 and H2,
// padded code boxes, striped tables, links without their URLs) in the classic
// colors. Its H2 is regular weight so it sits under the bold H1 at the same size.
const vivid: typeof classic = {
  ...classic,
  h1Rule: { fg: '#8A7444' },
  h2: { fg: '#7CC4FF' },
  h5: { bold: true, fg: '#9198A1' },
  h6: { fg: '#9198A1' },
};

const THEMES = { classic, vivid };
export type MarkdownStyle = keyof typeof THEMES;
export const MARKDOWN_STYLES = Object.keys(THEMES) as MarkdownStyle[];
export let markdownStyle: MarkdownStyle = 'classic';

// The renderer reads `theme`; switching styles swaps its contents.
export const theme = { ...classic };

export function setMarkdownStyle(s: MarkdownStyle): void {
  markdownStyle = s;
  Object.assign(theme, THEMES[s]);
}
