import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';

// The "?" popout over the bottom of the transcript: binder's keys in Claude
// Code's short "key to action" form, in as many columns as fit (three at most),
// the key in blue and the action dim. /help has the longer descriptions.
type Shortcut = [key: string, action: string];
const SHORTCUTS: Shortcut[] = [
  ['!', 'for bash mode'],
  ['/', 'for commands'],
  ['@', 'for file paths'],
  ['tab', 'to complete'],
  ['↑ ↓', 'for earlier prompts'],
  ['shift + enter', 'for newline'],
  ['shift + arrows', 'to select'],
  ['enter', 'to send in a new tab'],
  ['ctrl + enter', 'to send in this tab'],
  ['esc', 'to interrupt'],
  ['double tap esc', 'to rewind'],
  ['ctrl + e', 'to expand the work'],
  ['ctrl + o', 'for full detail'],
  ['ctrl + b', 'to run in background'],
  ['ctrl + l', 'to pick a model'],
  ['ctrl + p', 'to cycle models'],
  ['shift + tab', 'to cycle effort'],
  ['wheel or pgup / pgdn', 'to scroll'],
  ['ctrl + ← / →', 'to switch tabs'],
  ['alt + 1-9', 'to jump to a tab'],
  ['ctrl + v', 'to paste text or an image'],
  ['option + drag', 'to select text'],
  ['ctrl + c', 'to copy a selection'],
  ['ctrl + ]', 'for the latest artifact'],
  ['ctrl + c twice', 'to quit'],
  ['/help', 'for more'],
];
const PAD = 1;
const GAP = 4;
// The border and the padding inside it.
const FRAME = 2 + 2 * PAD;

const label = ([key, action]: Shortcut) => `${key} ${action}`;
const columnWidth = (col: Shortcut[]) => Math.max(...col.map((s) => stringWidth(label(s))));

function split(n: number): Shortcut[][] {
  const rows = Math.ceil(SHORTCUTS.length / n);
  return Array.from({ length: n }, (_, i) => SHORTCUTS.slice(i * rows, (i + 1) * rows));
}

export function shortcutColumns(width: number): Shortcut[][] {
  for (let n = 3; n > 1; n--) {
    const cols = split(n);
    const used = FRAME + GAP * (n - 1) + cols.reduce((w, col) => w + columnWidth(col), 0);
    if (used <= width) return cols;
  }
  return split(1);
}

// Each row is spaces to the border, so nothing of the transcript shows through.
export function Shortcuts({ width }: { width: number }) {
  const cols = shortcutColumns(width);
  const widths = cols.map(columnWidth);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray">
      {cols[0].map((_, r) => (
        <Text key={r}>
          {' '.repeat(PAD)}
          {cols.map((col, c) => {
            const s = col[r];
            const fill = ' '.repeat(widths[c] - (s ? stringWidth(label(s)) : 0) + (c < cols.length - 1 ? GAP : PAD));
            return (
              <React.Fragment key={c}>
                {s ? <Text color="#7CC4FF">{s[0]}</Text> : null}
                {s ? <Text dimColor>{' ' + s[1]}</Text> : null}
                {fill}
              </React.Fragment>
            );
          })}
        </Text>
      ))}
    </Box>
  );
}
