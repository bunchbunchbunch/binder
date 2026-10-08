import { firstPrompt, type Block, type Tab, type TabStatus } from '../store.js';

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function statusGlyph(status: TabStatus, frame: number): string {
  switch (status) {
    case 'queued':
      return '◌';
    case 'running':
    case 'superseded': // only until its Ctrl+Enter follow-up starts
      return SPINNER[frame % SPINNER.length];
    case 'done':
      return '●';
    case 'error':
      return '✗';
    case 'interrupted':
      return '◼';
  }
}

export function tabLabel(tab: Tab, frame: number, max = 24): string {
  const firstLine = firstPrompt(tab).split('\n')[0].trim();
  const title = firstLine.length > max ? firstLine.slice(0, max - 1) + '…' : firstLine;
  return `${tab.id} ${statusGlyph(tab.status, frame)} ${title}`;
}

// What a running turn is doing right now, for the status row above the prompt.
export function turnVerb(blocks: Block[], activity: string, interrupting: boolean): string {
  if (interrupting) return 'Interrupting';
  if (activity === 'compacting') return 'Compacting';
  const last = blocks[blocks.length - 1];
  if (last?.kind === 'tool_use' && !last.result) return `Running ${last.name}`;
  if (last?.kind === 'text' && !last.final) return 'Writing';
  return 'Thinking';
}

export function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
}

// Which tabs fit in `width` columns, keeping the active one visible.
// Returns indices into `labels`, plus whether there are hidden tabs on each side.
export function visibleTabs(labels: string[], active: number, width: number, sep = 3): { indices: number[]; left: boolean; right: boolean } {
  if (!labels.length) return { indices: [], left: false, right: false };
  const widths = labels.map((l) => l.length + sep);
  let start = active;
  let end = active;
  let used = widths[active] + 4; // room for ‹ › markers
  // Expand to the right first, then the left, until nothing more fits.
  let grew = true;
  while (grew) {
    grew = false;
    if (end + 1 < labels.length && used + widths[end + 1] <= width) {
      end++;
      used += widths[end];
      grew = true;
    }
    if (start > 0 && used + widths[start - 1] <= width) {
      start--;
      used += widths[start];
      grew = true;
    }
  }
  const indices = [];
  for (let i = start; i <= end; i++) indices.push(i);
  return { indices, left: start > 0, right: end < labels.length - 1 };
}
