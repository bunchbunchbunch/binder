import type { Block } from '../store.js';

// Splits a tab's blocks into the "work" (thinking and tool calls up to the
// last tool call) and the "response" (every text block). Text never folds:
// a turn can answer and then keep calling tools (a closing skill, a log
// write), and the answer must stay visible. A pending AskUserQuestion call is
// neither: the picker at the bottom shows it.
export function splitWork(blocks: Block[]): { work: Block[]; response: Block[] } {
  let lastTool = -1;
  blocks.forEach((b, i) => {
    if (b.kind === 'tool_use' && !(b.name === 'AskUserQuestion' && !b.result)) lastTool = i;
  });
  const work = blocks.slice(0, lastTool + 1).filter((b) => b.kind !== 'text');
  const response = blocks.filter((b) => b.kind === 'text' && b.text.trim());
  return { work, response };
}

export function workSummary(work: Block[]): string {
  const tools = work.filter((b) => b.kind === 'tool_use').length;
  const thoughts = work.filter((b) => b.kind === 'thinking' && b.text.trim()).length;
  const parts = [];
  if (tools) parts.push(`${tools} tool call${tools === 1 ? '' : 's'}`);
  if (thoughts) parts.push(`${thoughts} thought${thoughts === 1 ? '' : 's'}`);
  return parts.join(', ');
}
