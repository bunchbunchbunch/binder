import { Lexer, type Token, type Tokens } from 'marked';
import { highlightCode } from './highlight.js';
import { renderStripedTable, renderTable, type Cell } from './table.js';
import { indent, padEnd, width, wrap } from './text.js';
import { FG_OFF, markdownStyle, off, on, styled, theme, type Style } from './theme.js';
import { BIG_BOTTOM, BIG_TOP, bigText } from '../lineAttrs.js';

// Markdown -> ANSI lines for a terminal `w` columns wide. Built on marked's
// lexer so the output is ours: prominent headings, box-drawing tables, code
// bands, and consistent 24-bit colors. Pure string work, no React.

// The vivid style keeps lines to a readable measure, as a markdown page does.
const MEASURE = 100;

const vivid = () => markdownStyle === 'vivid';

export function renderMarkdown(text: string, w: number): string {
  // A Lexer instance accumulates tokens across calls, so make a fresh one.
  const tokens = new Lexer({ gfm: true, breaks: false }).lex(text.replace(/\t/g, '  '));
  const width = Math.max(16, w);
  return renderBlocks(tokens, vivid() ? Math.min(width, MEASURE) : width).join('\n');
}

// ---------- inline ----------

function inline(tokens: Token[] | undefined, outer: Style = {}): string {
  if (!tokens) return '';
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'text': {
        const tt = t as Tokens.Text;
        // Soft line breaks inside a paragraph are spaces; `br` tokens carry hard breaks.
        out += tt.tokens ? inline(tt.tokens, outer) : unescape(tt.text).replace(/\n/g, ' ');
        break;
      }
      case 'escape':
        out += (t as Tokens.Escape).text;
        break;
      case 'strong':
        out += styled(inline((t as Tokens.Strong).tokens, { ...outer, ...theme.strong }), theme.strong, outer);
        break;
      case 'em':
        out += styled(inline((t as Tokens.Em).tokens, { ...outer, ...theme.em }), theme.em, outer);
        break;
      case 'del':
        out += styled(inline((t as Tokens.Del).tokens, { ...outer, ...theme.del }), theme.del, outer);
        break;
      case 'codespan':
        // Non-breaking spaces pad the span so wrapping never trims the padding.
        out += styled('\u00a0' + unescape((t as Tokens.Codespan).text) + '\u00a0', theme.codespan, outer);
        break;
      case 'br':
        out += '\n';
        break;
      case 'link': {
        const l = t as Tokens.Link;
        const label = inline(l.tokens, { ...outer, ...theme.link }) || l.href;
        out += hyperlink(l.href, styled(label, theme.link, outer));
        if (!vivid() && label !== l.href && !/^#/.test(l.href)) out += styled(` (${shortUrl(l.href)})`, theme.linkUrl, outer);
        break;
      }
      case 'image': {
        const img = t as Tokens.Image;
        out += styled(`[image: ${img.text || img.href}]`, theme.muted, outer);
        break;
      }
      case 'html':
        out += styled((t as Tokens.HTML).text, theme.html, outer);
        break;
      default:
        out += (t as { raw?: string }).raw ?? '';
    }
  }
  return out;
}

function hyperlink(href: string, label: string): string {
  return `\x1b]8;;${href}\x1b\\${label}\x1b]8;;\x1b\\`;
}

function shortUrl(href: string): string {
  const s = href.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return s.length > 48 ? s.slice(0, 47) + '…' : s;
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
function unescape(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);
}

// ---------- blocks ----------

// `nested` blocks sit under a prefix (quote bar, list marker), so their
// headings stay one row high.
function renderBlocks(tokens: Token[], w: number, nested = false): string[] {
  const out: string[] = [];
  let prevType = '';
  for (const t of tokens) {
    if (t.type === 'space') continue;
    const lines = renderBlock(t, w, nested);
    if (!lines.length) continue;
    // Blank line between blocks, but keep a heading tight against its rule.
    if (out.length) out.push('');
    out.push(...lines);
    prevType = t.type;
  }
  void prevType;
  return out;
}

function renderBlock(t: Token, w: number, nested = false): string[] {
  switch (t.type) {
    case 'heading':
      return vivid() ? vividHeading(t as Tokens.Heading, w, nested) : heading(t as Tokens.Heading, w);
    case 'paragraph':
      return wrap(inline((t as Tokens.Paragraph).tokens), w).flatMap((l) => l.split('\n'));
    case 'text':
      return wrap(inline((t as Tokens.Text).tokens ?? [t]), w);
    case 'code':
      return codeBlock(t as Tokens.Code, w);
    case 'blockquote':
      return blockquote(t as Tokens.Blockquote, w);
    case 'list':
      return list(t as Tokens.List, w);
    case 'table':
      return table(t as Tokens.Table, w);
    case 'hr':
      return [styled('─'.repeat(w), theme.hr)];
    case 'html':
      return (t as Tokens.HTML).text.trimEnd().split('\n').map((l) => styled(l, theme.html));
    case 'def':
      return [];
    default:
      return wrap((t as { raw?: string }).raw ?? '', w);
  }
}

function heading(h: Tokens.Heading, w: number): string[] {
  const text = inline(h.tokens, h.depth === 1 ? theme.h1 : h.depth === 2 ? theme.h2 : h.depth === 3 ? theme.h3 : theme.h4);
  switch (h.depth) {
    case 1: {
      const lines = wrap(styled(text, theme.h1), w);
      return [...lines, styled('━'.repeat(w), theme.h1Rule)];
    }
    case 2: {
      const lines = wrap(styled(text, theme.h2), w);
      const ruleWidth = Math.min(w, Math.max(...lines.map(width)));
      return [...lines, styled('─'.repeat(ruleWidth), theme.h2Rule)];
    }
    case 3:
      return wrap(styled('▍ ' + text, theme.h3), w);
    default:
      return wrap(styled(text, theme.h4), w);
  }
}

// H1 and H2 on double-height rows where the terminal has them, then H3 to H6
// at normal size.
function vividHeading(h: Tokens.Heading, w: number, nested: boolean): string[] {
  const big = bigText && !nested && h.depth <= 2;
  const base = [theme.h1, theme.h2, theme.h3, theme.h4, theme.h5, theme.h6][h.depth - 1];
  // At normal size the regular-weight H2 needs bold to read as a heading.
  const st = h.depth === 2 && !big ? { ...base, bold: true } : base;
  const text = styled(inline(h.tokens, st), st);
  if (h.depth > 2) return wrap(text, w);
  // A double-height row shows half as many columns.
  const lines = big ? wrap(text, Math.floor(w / 2)).flatMap((l) => [BIG_TOP + l, BIG_BOTTOM + l]) : wrap(text, w);
  // An H1 is ruled across the page; a one-row H2 is ruled under its text.
  if (h.depth === 1) return [...lines, styled('─'.repeat(w), theme.h1Rule)];
  return big ? lines : [...lines, styled('─'.repeat(Math.min(w, Math.max(...lines.map(width)))), theme.h2Rule)];
}

function codeBlock(c: Tokens.Code, w: number): string[] {
  // The vivid style pads the band on every side, like a code box on a page.
  const pad = vivid() ? 2 : 1;
  const sp = ' '.repeat(pad);
  const inner = Math.max(8, w - 2 * pad);
  const code = c.text.replace(/\s+$/, '');
  const highlighted = highlightCode(code, c.lang?.split(/\s+/)[0]);
  const bgOn = on({ bg: theme.codeBg });
  const bgOff = off({ bg: theme.codeBg });
  const lines = highlighted.split('\n').flatMap((l) => wrap(l, inner, true));
  const band = lines.map((l) => bgOn + sp + padEnd(l, inner) + sp + bgOff);
  if (c.lang) {
    const label = styled(c.lang.split(/\s+/)[0], theme.codeLang);
    band.unshift(bgOn + padEnd('', inner + 2 * pad - width(label) - pad) + label + sp + bgOff);
  } else if (vivid()) {
    band.unshift(bgOn + ' '.repeat(inner + 2 * pad) + bgOff);
  }
  if (vivid()) band.push(bgOn + ' '.repeat(inner + 2 * pad) + bgOff);
  return band;
}

function blockquote(q: Tokens.Blockquote, w: number): string[] {
  const inner = renderBlocks(q.tokens, Math.max(8, w - 2), true);
  const bar = styled('▎', theme.quoteBar) + ' ';
  // An inline span (bold, code) ends with FG_OFF; bring the quote color back after it.
  return inner.map((l) => bar + styled(l.replaceAll(FG_OFF, FG_OFF + on(theme.quoteText)), theme.quoteText));
}

const BULLETS = ['•', '◦', '▪'];

function list(l: Tokens.List, w: number, depth = 0): string[] {
  const out: string[] = [];
  const start = typeof l.start === 'number' ? l.start : 1;
  const numberWidth = l.ordered ? String(start + l.items.length - 1).length + 1 : 0;
  l.items.forEach((item, i) => {
    let marker: string;
    if (item.task) {
      marker = item.checked ? styled('☑', theme.checked) : styled('☐', theme.checkbox);
    } else if (l.ordered) {
      marker = styled(padEnd(`${start + i}.`, numberWidth), theme.number);
    } else {
      marker = styled(BULLETS[depth % BULLETS.length], theme.bullet);
    }
    const prefix = marker + ' ';
    const rest = ' '.repeat(width(prefix));
    const body = listItemBody(item, Math.max(8, w - width(prefix)), depth);
    out.push(...indent(body, prefix, rest));
    if (l.loose && i < l.items.length - 1) out.push('');
  });
  return out;
}

function listItemBody(item: Tokens.ListItem, w: number, depth: number): string[] {
  const out: string[] = [];
  for (const t of item.tokens) {
    if (t.type === 'space') continue;
    if (t.type === 'list') {
      out.push(...list(t as Tokens.List, w, depth + 1));
    } else {
      const lines = renderBlock(t, w, true);
      if (out.length && (item.loose || (t.type !== 'text' && t.type !== 'paragraph'))) out.push('');
      out.push(...lines);
    }
  }
  return out;
}

function table(t: Tokens.Table, w: number): string[] {
  const cell = (c: Tokens.TableCell): Cell => ({ text: inline(c.tokens), align: c.align });
  return (vivid() ? renderStripedTable : renderTable)(t.header.map(cell), t.rows.map((r) => r.map(cell)), w);
}
