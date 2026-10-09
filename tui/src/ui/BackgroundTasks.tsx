import React from 'react';
import { Box, Text } from 'ink';
import type { BackgroundTask } from '../store.js';
import { elapsed } from './tabLayout.js';

// Background shells and agents still running, one row each under the status
// row: what each is doing, and its kind, tab and running time, so one that
// hangs is plain to see.
const MAX_ROWS = 3;

export const taskKind = (type: string) => (type === 'local_bash' ? 'shell' : type.replace(/^local_/, '').replace(/_/g, ' '));

// "agent · tab 1 · 12h 3m"
export function taskMeta(t: BackgroundTask, now: number): string {
  return [taskKind(t.type), t.tabId !== undefined && `tab ${t.tabId}`, t.startedAt !== undefined && elapsed(Math.max(0, now - t.startedAt))].filter(Boolean).join(' · ');
}

export function BackgroundTasks({ tasks }: { tasks: BackgroundTask[] }) {
  const shown = tasks.length > MAX_ROWS ? tasks.slice(0, MAX_ROWS - 1) : tasks;
  const now = Date.now();
  return (
    <>
      {shown.map((t) => (
        <Box key={t.id} justifyContent="space-between" height={1} paddingLeft={1}>
          <Text wrap="truncate-end">
            <Text color="#7CC4FF">{`◷ ${t.description}`}</Text>
            {t.progress && <Text dimColor>{` · ${t.progress}`}</Text>}
          </Text>
          <Box flexShrink={0} marginLeft={2}>
            <Text dimColor>{taskMeta(t, now)}</Text>
          </Box>
        </Box>
      ))}
      {shown.length < tasks.length && <Text dimColor>{`   +${tasks.length - shown.length} more background tasks · /tasks`}</Text>}
    </>
  );
}
