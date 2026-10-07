import type { Block, Tab, Turn } from '../store.js';
import { renderTool, toolWidth } from './toolView.js';
import { splitWork, workSummary } from './workSplit.js';
import { truncate, width as strWidth, wrap } from './md/text.js';
import { styled, type Style } from './md/theme.js';
import { keywordColors, ultrathinkRanges } from './ultrathink.js';
import { flattenBig } from './lineAttrs.js';

// A tab is drawn as a flat list of pre-rendered ANSI lines, each at most
// `width` columns. TabView hands Ink only the slice that is on screen, so
// layout and output cost depend on the terminal size, not on how long the
// conversation is. This is the "row model" that native TUIs such as
// claude-code-rust use instead of a full component tree.

const DIM: Style = { fg: '#7F848E' };
const THINK: Style = { fg: '#7F848E', italic: true };
const PROMPT: Style = { fg: '#7CC4FF', bold: true };
const PROMPT_BAR: Style = { fg: '#4A6A8A' };
const SUBAGENT_BAR: Style = { fg: '#5C6370' };
// Heads a turn the child started on its own (background work finished).
const AUTO: Style = { fg: '#E8C07D' };

// Per-block line cache. Blocks are immutable in the store (an update makes a
// new object), so the object itself is the cache key; stale entries go away
// with the blocks they belong to.
const cache = new WeakMap<Block, Map<string, string[]>>();

function cached(block: Block, key: string, make: () => string[]): string[] {
  let byKey = cache.get(block);
  if (!byKey) cache.set(block, (byKey = new Map()));
  let lines = byKey.get(key);
  if (!lines) byKey.set(key, (lines = make()));
  return lines;
}

// Clamp every line to the width once, when a block is rendered, so Ink never
// re-wraps a line and the line count stays exact.
function fit(lines: string[], w: number): string[] {
  return lines.map((l) => (strWidth(l) > w ? truncate(l, w) : l));
}

export type TextRenderer = (block: Extract<Block, { kind: 'text' }>, width: number) => string[];

function thinkingLines(text: string, w: number, detail: boolean): string[] {
  const body = detail ? text : text.split('\n').slice(0, 3).join('\n');
  return ('✻ ' + body).split('\n').flatMap((l) => wrap(styled(l, THINK), w));
}

function toolLines(block: Extract<Block, { kind: 'tool_use' }>, w: number, detail: boolean, renderText: TextRenderer): string[] {
  const r = renderTool(block, toolWidth(w));
  const result = block.result;
  const marker = styled('⏺ ', { fg: result ? (result.isError ? '#E06C75' : '#61AFEF') : '#E8C07D' });
  const out = [truncate(marker + r.title + (!block.final && !result ? styled(' …', DIM) : ''), w)];
  const shown = detail ? r.body : r.body.slice(0, r.preview);
  const hidden = r.body.length - shown.length;
  for (const l of shown) out.push('  ' + l);
  if (hidden > 0) out.push('  ' + styled(`⋯ ${hidden} more line${hidden === 1 ? '' : 's'} (Ctrl+O)`, DIM));
  if (block.children.length) {
    if (detail) {
      const bar = '  ' + styled('│', SUBAGENT_BAR) + ' ';
      const inner = flattenBig(blocksLines(block.children, Math.max(20, w - 4), detail, renderText));
      for (const l of inner) out.push(l ? bar + l : bar.trimEnd());
    } else {
      const n = block.children.length;
      out.push('  ' + styled(`${n} subagent block${n === 1 ? '' : 's'} (Ctrl+O)`, DIM));
    }
  }
  return fit(out, w);
}

export function blockLines(block: Block, w: number, detail: boolean, renderText: TextRenderer): string[] {
  switch (block.kind) {
    case 'thinking':
      if (!block.text.trim()) return [];
      return cached(block, `${w}:${detail}`, () => fit(thinkingLines(block.text, w, detail), w));
    case 'text':
      if (!block.text) return [];
      return renderText(block, w);
    case 'tool_use':
      // Subagent children render through renderText, so only cache final tools.
      if (!block.final || (block.children.length && detail)) return toolLines(block, w, detail, renderText);
      return cached(block, `${w}:${detail}`, () => toolLines(block, w, detail, renderText));
  }
}

// Each block followed by a blank line, matching the old marginBottom={1}.
function blocksLines(blocks: Block[], w: number, detail: boolean, renderText: TextRenderer): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    const lines = blockLines(b, w, detail, renderText);
    if (!lines.length) continue;
    for (const l of lines) out.push(l);
    out.push('');
  }
  return out;
}

function fmtDuration(ms: number): string {
  return ms >= 60000 ? `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
}

const promptCache = new Map<string, string[]>();

// A prompt line, with "ultrathink" in rainbow letters.
function promptText(line: string): string {
  const colors = keywordColors(line.length, ultrathinkRanges(line));
  let out = '';
  for (let i = 0; i < line.length; ) {
    let j = i + 1;
    while (j < line.length && colors[j] === colors[i]) j++;
    out += styled(line.slice(i, j), colors[i] ? { ...PROMPT, fg: colors[i] } : PROMPT);
    i = j;
  }
  return out;
}

function promptLines(prompt: string, w: number): string[] {
  const key = `${w}\u0000${prompt}`;
  let lines = promptCache.get(key);
  if (!lines) {
    const bar = styled('│', PROMPT_BAR) + ' ';
    lines = prompt.split('\n').flatMap((l) => wrap(promptText(l), Math.max(8, w - 2))).map((l) => bar + l);
    if (promptCache.size > 200) promptCache.clear();
    promptCache.set(key, lines);
  }
  return lines;
}

export type PendingPrompt = { prompt: string; sending: boolean };

export type TabLinesOptions = {
  width: number;
  detail: boolean;
  // The latest turn's work is expanded; earlier turns' work only with expandEarlier.
  expanded: boolean;
  expandEarlier?: boolean;
  renderText: TextRenderer;
  // Follow-ups for this tab that have not started yet.
  pending?: PendingPrompt[];
};

// A turn's prompt rows and the row they start at, for the sticky header.
export type TurnHead = { at: number; lines: string[] };

// `workAt` is the row of the work summary line (-1 when there is no work), so
// expanding can scroll the work into view.
function turnLines(turn: Turn, width: number, detail: boolean, expanded: boolean, renderText: TextRenderer, out: string[], heads: TurnHead[]): number {
  const head = turn.auto ? wrap(styled(`⏺ ${turn.prompt}`, AUTO), width) : promptLines(turn.prompt, width);
  heads.push({ at: out.length, lines: head });
  for (const l of head) out.push(l);
  out.push('');
  const { work, response } = splitWork(turn.blocks);
  const workAt = work.length ? out.length : -1;
  if (work.length) {
    out.push(styled(`${expanded ? '▾ ' : '▸ '}${workSummary(work)}${expanded ? ' (Ctrl+E to collapse)' : ' (Ctrl+E to expand)'}`, DIM), '');
  }
  const shown = expanded ? turn.blocks : response;
  for (const l of blocksLines(shown, width, detail, renderText)) out.push(l);
  if (turn.status === 'queued') out.push(styled('queued, waiting for the current turn to finish', DIM));
  if (turn.status === 'interrupted') out.push(styled('interrupted', { fg: '#E8C07D' }));
  if (turn.result && turn.status !== 'interrupted' && turn.status !== 'superseded') {
    out.push(styled(`${turn.status === 'error' ? 'error · ' : ''}${fmtDuration(turn.result.durationMs)}`, DIM));
  }
  return workAt;
}

// The tab's turns in order, then its pending follow-ups. `workAt` points at
// the latest turn's work; `heads` has one entry per turn.
export function tabLines(tab: Tab, { width, detail, expanded, expandEarlier = false, renderText, pending = [] }: TabLinesOptions): { lines: string[]; workAt: number; heads: TurnHead[] } {
  const out: string[] = [];
  const heads: TurnHead[] = [];
  for (const turn of tab.earlier) {
    turnLines(turn, width, detail, expandEarlier, renderText, out, heads);
    if (out[out.length - 1] !== '') out.push('');
  }
  const workAt = turnLines(tab, width, detail, expanded, renderText, out, heads);
  for (const p of pending) {
    if (out[out.length - 1] !== '') out.push('');
    for (const l of promptLines(p.prompt, width)) out.push(l);
    out.push(styled(p.sending ? 'sending now…' : 'queued, sends when the current turn finishes (in this tab)', DIM));
  }
  return { lines: out, workAt, heads };
}

// The sticky header: the first `rows` rows of a prompt, then a rule that says
// how much of it is cut. The first turn's prompt is read in full with Home.
export function stickyLines(head: TurnHead, width: number, rows: number, first: boolean): string[] {
  const cut = head.lines.length - rows;
  const shown = head.lines.slice(0, rows);
  if (cut > 0) shown[rows - 1] = truncate(shown[rows - 1] + ' …', width);
  const note = cut > 0 ? ` +${cut} line${cut === 1 ? '' : 's'}${first ? ' · Home' : ''} ╌` : '';
  return [...shown, styled('╌'.repeat(Math.max(0, width - strWidth(note))) + note, DIM)];
}
