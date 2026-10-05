import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';

// The "?" popup under the prompt: binder's keys in Claude Code's short
// "key to action" form, in as many columns as fit (three at most). /help has
// the longer descriptions.
const SHORTCUTS = [
  '! for bash mode',
  '/ for commands',
  '@ for file paths',
  'tab to complete',
  '↑ ↓ for earlier prompts',
  'alt + enter for newline',
  'shift + arrows to select',
  'enter to send in a new tab',
  'ctrl + enter to send in this tab',
  'esc to interrupt',
  'double tap esc to rewind',
  'ctrl + e to expand the work',
  'ctrl + o for full detail',
  'wheel or pgup / pgdn to scroll',
  'ctrl + n / p to switch tabs',
  'alt + 1-9 to jump to a tab',
  'ctrl + v to paste text or an image',
  'option + drag to select text',
  'ctrl + c to copy a selection',
  'ctrl + ] for the latest artifact',
  'ctrl + c twice to quit',
  '/help for more',
];
const PAD = 2;
const GAP = 4;

function split(n: number): string[][] {
  const rows = Math.ceil(SHORTCUTS.length / n);
  return Array.from({ length: n }, (_, i) => SHORTCUTS.slice(i * rows, (i + 1) * rows));
}

export function shortcutColumns(width: number): string[][] {
  for (let n = 3; n > 1; n--) {
    const cols = split(n);
    const used = PAD + GAP * (n - 1) + cols.reduce((w, col) => w + Math.max(...col.map((s) => stringWidth(s))), 0);
    if (used <= width) return cols;
  }
  return split(1);
}

export function Shortcuts({ columns }: { columns: string[][] }) {
  return (
    <Box paddingLeft={PAD} gap={GAP}>
      {columns.map((col, i) => (
        <Box key={i} flexDirection="column">
          {col.map((s) => <Text key={s} dimColor>{s}</Text>)}
        </Box>
      ))}
    </Box>
  );
}
