import React from 'react';
import { Box, Text, useWindowSize } from 'ink';
import { renderMarkdown } from './md/render.js';
import { styled } from './md/theme.js';
import { clean, wrap } from './md/text.js';
import { flattenBig } from './lineAttrs.js';

// /btw: a side chat about the session, in place of the transcript. Claude
// answers from the conversation so far, without tools, and nothing here goes
// into the transcript. While it is open the prompt asks it; Esc closes it.

// `synthetic`: the answer is a stand-in (no answer came), not Claude's.
export type SideItem = { id: number; question: string; response: string | null; error?: string; synthetic?: boolean };

const ASK = { fg: '#C9A0FF', bold: true };
const DIM = { fg: '#7F848E' };

export function sideLines(items: SideItem[], width: number): string[] {
  const out: string[] = [styled('Side chat: answered from the session so far, kept out of its transcript · Enter asks · Esc closes', DIM), ''];
  if (!items.length) out.push(styled('Type a side question below.', DIM));
  for (const it of items) {
    out.push(...wrap(styled(`❯ ${clean(it.question)}`, ASK), width));
    if (it.error) out.push(...wrap(styled(it.error, { fg: '#E06C75' }), width));
    else if (it.response === null) out.push(styled('thinking…', DIM));
    else out.push(...flattenBig(renderMarkdown(it.response, width).split('\n')));
    out.push('');
  }
  return out;
}

export function SideChat({ items }: { items: SideItem[] }) {
  const { columns, rows } = useWindowSize();
  // What is left of the screen once the tab bar, prompt and status rows have theirs.
  const height = Math.max(5, rows - 10);
  const lines = sideLines(items, Math.max(20, columns - 2));
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>{lines.slice(-height).join('\n')}</Text>
    </Box>
  );
}
