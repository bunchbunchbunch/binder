// Convert an ANSI text file into a dark-themed HTML page for screenshotting.
//   npx tsx test/manual/ansiToHtml.ts in.ans out.html
// Handles SGR bold/dim/italic/underline/strike, 24-bit and 256/16 colors, and OSC 8 links.
import { readFileSync, writeFileSync } from 'node:fs';

const [, , inFile, outFile] = process.argv;
const src = readFileSync(inFile, 'utf8');

const BASIC = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];

function color256(n: number): string {
  if (n < 16) return BASIC[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  n -= 16;
  const r = Math.floor(n / 36), g = Math.floor((n % 36) / 6), b = n % 6;
  const c = (x: number) => (x ? 55 + x * 40 : 0);
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

type St = { fg?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; strike?: boolean };
let st: St = {};
let link: string | null = null;
let html = '';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function open(): string {
  const css: string[] = [];
  if (st.fg) css.push(`color:${st.fg}`);
  if (st.bg) css.push(`background:${st.bg}`);
  if (st.bold) css.push('font-weight:bold');
  if (st.dim) css.push('opacity:.6');
  if (st.italic) css.push('font-style:italic');
  const deco = [st.underline && 'underline', st.strike && 'line-through'].filter(Boolean).join(' ');
  if (deco) css.push(`text-decoration:${deco}`);
  return `<span style="${css.join(';')}">`;
}

function applySgr(params: string) {
  const p = params.split(/[;:]/).map((x) => (x === '' ? 0 : Number(x)));
  for (let i = 0; i < p.length; i++) {
    const n = p[i];
    if (n === 0) st = {};
    else if (n === 1) st.bold = true;
    else if (n === 2) st.dim = true;
    else if (n === 3) st.italic = true;
    else if (n === 4) st.underline = true;
    else if (n === 9) st.strike = true;
    else if (n === 22) { st.bold = false; st.dim = false; }
    else if (n === 23) st.italic = false;
    else if (n === 24) st.underline = false;
    else if (n === 29) st.strike = false;
    else if (n === 39) st.fg = undefined;
    else if (n === 49) st.bg = undefined;
    else if (n >= 30 && n <= 37) st.fg = BASIC[n - 30];
    else if (n >= 90 && n <= 97) st.fg = BASIC[n - 90 + 8];
    else if (n >= 40 && n <= 47) st.bg = BASIC[n - 40];
    else if (n >= 100 && n <= 107) st.bg = BASIC[n - 100 + 8];
    else if ((n === 38 || n === 48) && p[i + 1] === 2) {
      const c = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`;
      if (n === 38) st.fg = c; else st.bg = c;
      i += 4;
    } else if ((n === 38 || n === 48) && p[i + 1] === 5) {
      const c = color256(p[i + 2]);
      if (n === 38) st.fg = c; else st.bg = c;
      i += 2;
    }
  }
}

const re = /\x1b\[([0-9;:]*)m|\x1b\]8;;([^\x1b\x07]*)(?:\x1b\\|\x07)|\x1b\[[0-9;?]*[A-Za-z]/g;
let last = 0;
let m: RegExpExecArray | null;
const emit = (text: string) => {
  if (!text) return;
  const body = esc(text);
  html += open() + (link ? `<a href="${esc(link)}" style="color:inherit">${body}</a>` : body) + '</span>';
};
while ((m = re.exec(src))) {
  emit(src.slice(last, m.index));
  last = re.lastIndex;
  if (m[1] !== undefined) applySgr(m[1]);
  else if (m[2] !== undefined) link = m[2] || null;
}
emit(src.slice(last));

writeFileSync(outFile, `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#1a1b26;color:#c0caf5;padding:16px">
<pre style="margin:0;font:15px/1.35 'Hack Nerd Font','JetBrains Mono',Menlo,monospace;white-space:pre">${html}</pre></body>`);
