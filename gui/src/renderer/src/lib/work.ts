import type { TabStatus, WireBlock, WireTab, WireTurn } from '@shared/wire';
import { firstLine } from './format';

// How a turn is laid out, as in bindertui's TUI: the "work" (thinking and tool
// calls up to the last tool call) folds into a summary once the response
// lands; text blocks never fold. A pending AskUserQuestion call is neither:
// the question card shows it.
export function lastToolIndex(blocks: WireBlock[]): number {
  let lastTool = -1;
  blocks.forEach((b, i) => {
    if (b.kind === 'tool_use' && !(b.name === 'AskUserQuestion' && !b.result)) lastTool = i;
  });
  return lastTool;
}

export function splitWork(blocks: WireBlock[]): { work: WireBlock[]; response: WireBlock[] } {
  const work = blocks.slice(0, lastToolIndex(blocks) + 1).filter((b) => b.kind !== 'text');
  const response = blocks.filter((b) => b.kind === 'text' && b.text.trim());
  return { work, response };
}

export function workSummary(work: WireBlock[]): string {
  const tools = work.filter((b) => b.kind === 'tool_use').length;
  const thoughts = work.filter((b) => b.kind === 'thinking' && b.text.trim()).length;
  const parts = [];
  if (tools) parts.push(`${tools} tool call${tools === 1 ? '' : 's'}`);
  if (thoughts) parts.push(`${thoughts} thought${thoughts === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/** What a running turn is doing right now, for the status row above the prompt. */
export function turnVerb(blocks: WireBlock[], activity: string, interrupting: boolean): string {
  if (interrupting) return 'Interrupting';
  if (activity === 'compacting') return 'Compacting';
  const last = blocks[blocks.length - 1];
  if (last?.kind === 'tool_use' && !last.result) return `Running ${last.name}`;
  if (last?.kind === 'text' && !last.final) return 'Writing';
  return 'Thinking';
}

export function statusGlyph(status: TabStatus): string {
  switch (status) {
    case 'queued':
      return '◌';
    case 'running':
    case 'superseded': // only until its Ctrl+Enter follow-up starts
      return '⠋';
    case 'done':
      return '●';
    case 'error':
      return '✗';
    case 'interrupted':
      return '◼';
  }
}

/** The prompt that opened a tab (its earliest turn). */
export function firstPrompt(tab: WireTab): string {
  return (tab.earlier[0] ?? tab).prompt;
}

export function tabTitle(tab: WireTab, max = 28): string {
  const line = firstLine(firstPrompt(tab)) || '(empty)';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

export function allTurns(tab: WireTab): WireTurn[] {
  return [...tab.earlier, tab];
}

// "ultrathink" anywhere in a prompt asks for deeper reasoning; it is drawn in rainbow letters.
export const RAINBOW = ['#EB5F57', '#F58B57', '#FAC35F', '#91C882', '#82AADC', '#9B82C8', '#C882B4'];

export function ultrathinkParts(text: string): { text: string; rainbow: boolean }[] {
  const out: { text: string; rainbow: boolean }[] = [];
  let at = 0;
  for (const m of text.matchAll(/\bultrathink\b/gi)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), rainbow: false });
    out.push({ text: m[0], rainbow: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), rainbow: false });
  return out;
}
