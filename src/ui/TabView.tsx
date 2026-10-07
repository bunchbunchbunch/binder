import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useBoxMetrics, useInput, type DOMElement } from 'ink';
import type { Block, Tab } from '../store.js';
import { renderMarkdown } from './markdown.js';
import { pinnedTurn, stickyLines, tabLines, type PendingPrompt, type TextRenderer } from './tabLines.js';
import { onWheel } from '../mouse.js';
import { setBigViewport } from './lineAttrs.js';
import { markdownStyle, type MarkdownStyle } from './md/theme.js';

// Markdown for a streaming block is re-rendered at most this often; the
// interval stretches to 5x the last render's cost so a very long response
// never spends more than ~20% of the time re-rendering.
const STREAM_RENDER_MS = 150;

type TextBlock = Extract<Block, { kind: 'text' }>;

// Final text blocks are rendered once per width; the streaming one is
// throttled, showing its last rendering until the next tick.
function useTextRenderer(): TextRenderer {
  const finals = useRef(new WeakMap<TextBlock, { width: number; style: MarkdownStyle; lines: string[] }>());
  const stream = useRef<{ text: string; width: number; style: MarkdownStyle; lines: string[]; at: number; cost: number } | null>(null);
  const timer = useRef<NodeJS.Timeout | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return useCallback((block: TextBlock, width: number) => {
    const render = () => renderMarkdown(block.text, width).split('\n');
    if (block.final) {
      const hit = finals.current.get(block);
      if (hit && hit.width === width && hit.style === markdownStyle) return hit.lines;
      const lines = render();
      finals.current.set(block, { width, style: markdownStyle, lines });
      return lines;
    }
    const s = stream.current;
    if (s && s.text === block.text && s.width === width && s.style === markdownStyle) return s.lines;
    const interval = Math.max(STREAM_RENDER_MS, (s?.cost ?? 0) * 5);
    if (s && s.width === width && s.style === markdownStyle && Date.now() - s.at < interval) {
      // Too soon: keep the last rendering and come back for the rest.
      if (!timer.current) {
        timer.current = setTimeout(() => {
          timer.current = null;
          setTick((t) => t + 1);
        }, interval - (Date.now() - s.at));
      }
      return s.lines;
    }
    const t0 = Date.now();
    const lines = render();
    stream.current = { text: block.text, width, style: markdownStyle, lines, at: Date.now(), cost: Date.now() - t0 };
    return lines;
  }, []);
}

// `mdStyle` is only read to redraw the tab when the markdown style changes.
// `sticky`: the tab's latest prompt stays at the top, above the rows that scroll.
type TabViewProps = { tab: Tab; width: number; detail: boolean; scrollActive: boolean; questionPending: boolean; expandedOverride?: boolean; pending?: PendingPrompt[]; mdStyle?: MarkdownStyle; sticky?: boolean };

function TabViewImpl({ tab, width, detail, scrollActive, questionPending, expandedOverride, pending, sticky = false }: TabViewProps) {
  const viewportRef = useRef<DOMElement>(null);
  const { height: viewHeight } = useBoxMetrics(viewportRef);
  const [requested, setRequested] = useState(0);
  // Follow the bottom while the turn streams, until the user scrolls up.
  const [follow, setFollow] = useState(true);
  // Home shows the whole sticky prompt, until the next scroll.
  const [full, setFull] = useState(false);
  const renderText = useTextRenderer();
  // Big headings in this viewport get their double-height rows (lineAttrs.ts).
  useEffect(() => {
    setBigViewport(viewportRef.current);
    return () => setBigViewport(null);
  }, []);

  useEffect(() => {
    if (tab.status !== 'running') return;
    // A new turn in this tab (after a respawn) starts following again.
    setFollow(true);
    setFull(false);
  }, [tab.status]);

  // Work streams expanded while the turn runs; it collapses to a summary when
  // the response lands or a question is waiting. Ctrl+E overrides until the
  // next automatic switch, and also expands the tab's earlier turns.
  const autoExpanded = tab.status === 'running' && !questionPending;
  const [override, setOverride] = useState<boolean | null>(null);
  useEffect(() => setOverride(null), [autoExpanded]);
  const expanded = expandedOverride ?? override ?? autoExpanded;

  const textWidth = Math.max(20, width - 2);
  // The sticky header holds the tab's latest prompt in place of the
  // transcript: its first 3 rows, or with Home as much as fits.
  const headerRows = full ? viewHeight - 2 : Math.min(3, Math.floor(viewHeight / 4));
  const pinned = sticky && headerRows >= 1 ? pinnedTurn(tab) : undefined;
  const header = pinned ? stickyLines(pinned.prompt, textWidth, headerRows, !full) : [];
  const { lines, workAt } = tabLines(tab, { width: textWidth, detail, expanded, expandEarlier: override === true, renderText, pending, pinned });
  const rows = Math.max(0, viewHeight - header.length);
  const maxTop = Math.max(0, lines.length - rows);
  const top = follow ? maxTop : Math.min(requested, maxTop);

  // The wheel scrolls by lines. Steps that land before the next render add up.
  const pos = useRef({ top, maxTop });
  pos.current = { top, maxTop };
  useEffect(() => {
    if (!scrollActive) return;
    return onWheel((lines) => {
      const next = Math.max(0, Math.min(pos.current.maxTop, pos.current.top + lines));
      pos.current = { ...pos.current, top: next };
      setRequested(next);
      setFollow(next >= pos.current.maxTop);
      setFull(false);
    });
  }, [scrollActive]);

  useInput(
    (input, key) => {
      const page = Math.max(1, rows - 2);
      if (key.pageUp) {
        setFull(false);
        setFollow(false);
        setRequested(Math.max(0, top - page));
      } else if (key.pageDown) {
        setFull(false);
        const next = Math.min(maxTop, top + page);
        setRequested(next);
        if (next >= maxTop) setFollow(true);
      } else if (key.home && !key.ctrl) {
        setFull(true);
        setFollow(false);
        setRequested(0);
      } else if (key.end && !key.ctrl) {
        setFull(false);
        setFollow(true);
      } else if (key.ctrl && input === 'e') {
        setFull(false);
        setOverride(!expanded);
        if (!expanded && workAt >= 0) {
          // Expanding: bring the start of the work to the top of the view.
          setFollow(false);
          setRequested(workAt);
        } else {
          setFollow(true);
        }
      }
    },
    { isActive: scrollActive },
  );

  // Only the rows on screen reach Ink. Before the first measurement the
  // height is unknown, so nothing is drawn for that one frame.
  const visible = viewHeight > 0 ? [...header, ...lines.slice(top, top + rows)] : [];
  return (
    <Box ref={viewportRef} flexGrow={1} flexDirection="column" overflow="hidden" paddingX={1}>
      <Text wrap="truncate-end">{visible.join('\n')}</Text>
    </Box>
  );
}

// Spinner ticks and keystrokes re-render App; the tab only redraws when its
// own props change.
export const TabView = memo(TabViewImpl);
