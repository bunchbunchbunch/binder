import React, { useState } from 'react';
import { Box, Text, useInput, useWindowSize, type Key } from 'ink';

export type PickerItem = {
  key: string;
  label: string;
  description?: string;
  // Shown before the label, e.g. a status mark or "✓" for the current choice.
  mark?: string;
  markColor?: string;
};

type Props = {
  title: string;
  items: PickerItem[];
  onSelect: (item: PickerItem) => void;
  onCancel: () => void;
  // Typing edits the query; the caller filters `items` by it.
  search?: { query: string; onChange: (query: string) => void };
  // Key hints under the list.
  hint?: string;
  // A line above the list (scope, status, an error).
  subtitle?: string;
  // Extra keys for this picker; return true when handled.
  onKey?: (input: string, key: Key, item: PickerItem | undefined) => boolean;
  initial?: number;
  empty?: string;
  rows?: number;
};

// A bordered list for binder's own panels (/resume, /mcp, /model, ...):
// Up/Down (PgUp/PgDn) move, Enter picks, Esc closes.
export function Picker({ title, items, onSelect, onCancel, search, hint, subtitle, onKey, initial = 0, empty = 'nothing here', rows: maxRows = 10 }: Props) {
  const [cursor, setCursor] = useState(initial);
  // Fit the transcript area: the rest of the screen and the picker's own
  // frame take about 16 rows.
  const { rows: termRows } = useWindowSize();
  const rows = Math.max(3, Math.min(maxRows, (termRows || 24) - 16 - (subtitle ? 1 : 0) - (search ? 1 : 0)));
  const at = Math.max(0, Math.min(cursor, items.length - 1));
  const item = items[at];

  useInput((input, key) => {
    if (onKey?.(input, key, item)) return;
    if (key.escape) return onCancel();
    if (key.upArrow) return setCursor(Math.max(0, at - 1));
    if (key.downArrow) return setCursor(Math.min(items.length - 1, at + 1));
    if (key.pageUp) return setCursor(Math.max(0, at - rows));
    if (key.pageDown) return setCursor(Math.min(items.length - 1, at + rows));
    if (key.return) {
      if (item) onSelect(item);
      return;
    }
    if (!search) return;
    if (key.backspace || key.delete) {
      search.onChange(search.query.slice(0, -1));
      setCursor(0);
    } else if (input && !key.ctrl && !key.meta && !key.tab) {
      search.onChange(search.query + input);
      setCursor(0);
    }
  });

  const first = Math.max(0, Math.min(at - Math.floor(rows / 2), items.length - rows));
  const shown = items.slice(first, first + rows);
  const labelWidth = Math.min(48, Math.max(0, ...shown.map((i) => i.label.length)));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#C9A0FF" paddingX={1}>
      <Text>
        <Text bold color="#FFD580">{title}</Text>
        {items.length > rows ? <Text dimColor>{`  ${at + 1}/${items.length}`}</Text> : null}
      </Text>
      {subtitle ? <Text dimColor wrap="truncate-end">{subtitle}</Text> : null}
      {search ? (
        <Text>
          <Text color="#7CC4FF" bold>{'⌕ '}</Text>
          {search.query}
          <Text inverse> </Text>
          {!search.query ? <Text dimColor> type to search</Text> : null}
        </Text>
      ) : null}
      {shown.length ? (
        shown.map((it, i) => {
          const selected = first + i === at;
          return (
            <Text key={it.key} wrap="truncate-end">
              <Text color="#7CC4FF">{selected ? '❯ ' : '  '}</Text>
              {it.mark !== undefined ? <Text color={it.markColor}>{it.mark + ' '}</Text> : null}
              <Text bold={selected} color={selected ? '#7CC4FF' : undefined}>{it.label.padEnd(labelWidth)}</Text>
              {it.description ? <Text dimColor>{'  ' + it.description}</Text> : null}
            </Text>
          );
        })
      ) : (
        <Text dimColor>{'  ' + empty}</Text>
      )}
      <Text dimColor wrap="truncate-end">{hint ?? '↑↓ move · enter selects · esc closes'}</Text>
    </Box>
  );
}
