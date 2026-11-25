import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { Tab } from '../store.js';
import { checklistSummary, currentPlan, sessionChecklist, type CheckItem } from '../checklist.js';
import { renderMarkdown } from './markdown.js';
import { flattenBig } from './lineAttrs.js';
import { clean, truncate } from './md/text.js';

// The pinned panel above the prompt (config.json todoPanel): the session's
// latest todo list and its current plan, so neither scrolls away with the
// transcript. One line until Ctrl+T opens it: every item, then the plan
// (at most `maxRows` rows in all).

const MARK: Record<CheckItem['status'], [string, string]> = { completed: ['☑', '#98C379'], in_progress: ['◐', '#E8C07D'], pending: ['☐', '#7F848E'] };

// The plan's title: its first heading, else its first line.
function planTitle(plan: string): string {
  const lines = plan.split('\n').map((l) => l.trim()).filter(Boolean);
  const heading = lines.find((l) => l.startsWith('#'));
  return clean((heading ?? lines[0] ?? 'Plan').replace(/^#+\s*/, ''));
}

export function PinnedPanel({ tabs, open, width, maxRows }: { tabs: Tab[]; open: boolean; width: number; maxRows: number }) {
  const list = useMemo(() => sessionChecklist(tabs), [tabs]);
  const plan = useMemo(() => currentPlan(tabs), [tabs]);
  const planLines = useMemo(() => (open && plan ? flattenBig(renderMarkdown(plan.plan, Math.max(20, width - 4)).split('\n')) : []), [open, plan, width]);
  // A finished list stays out of the way unless asked for.
  const listShown = list && (open || list.items.some((i) => i.status !== 'completed'));
  if (!listShown && !plan) return null;

  if (!open) {
    const s = list ? checklistSummary(list) : null;
    const parts: string[] = [];
    if (s && listShown) parts.push(`☑ ${s.done}/${s.total}${s.now ? ` · ◐ ${clean(s.now.active ?? s.now.text)}` : ''}`);
    if (plan) parts.push(`▤ Plan: ${planTitle(plan.plan)}${plan.approved ? '' : plan.answered ? ' (kept planning)' : ' (waiting for you)'}`);
    return (
      <Box height={1} paddingLeft={1}>
        <Text wrap="truncate-end">
          <Text color="#C9A0FF">{parts.join('  ·  ')}</Text>
          <Text dimColor>{'  ctrl+t'}</Text>
        </Text>
      </Box>
    );
  }

  const rows: React.ReactNode[] = [];
  if (list) {
    rows.push(<Text key="lh" dimColor>{`Todos ${checklistSummary(list).done}/${list.items.length}`}</Text>);
    list.items.forEach((item, i) => {
      const [mark, color] = MARK[item.status];
      rows.push(
        <Text key={`i${i}`} wrap="truncate-end">
          <Text color={color}>{` ${mark} `}</Text>
          <Text dimColor={item.status === 'completed'} strikethrough={item.status === 'completed'} bold={item.status === 'in_progress'}>{clean(item.text)}</Text>
        </Text>,
      );
    });
  }
  if (plan) {
    rows.push(<Text key="ph" dimColor>{`Plan${plan.approved ? ' · approved' : plan.answered ? ' · kept planning' : ' · waiting for you'}`}</Text>);
    planLines.forEach((l, i) => rows.push(<Text key={`p${i}`} wrap="truncate-end">{' ' + truncate(l, width - 4)}</Text>));
  }
  const cut = rows.length > maxRows ? rows.length - (maxRows - 1) : 0;
  return (
    <Box flexDirection="column" paddingLeft={1} borderStyle="single" borderColor="gray" borderLeft={false} borderRight={false} borderBottom={false}>
      {cut ? rows.slice(0, maxRows - 1) : rows}
      {cut ? <Text dimColor>{`⋯ ${cut} more lines · ctrl+t closes`}</Text> : <Text dimColor>ctrl+t closes</Text>}
    </Box>
  );
}
