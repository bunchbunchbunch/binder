import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useBoxMetrics, useInput, type DOMElement } from 'ink';
import type { Block, Tab } from '../store.js';
import { renderMarkdown } from './markdown.js';
import { stickyLines, tabLines, type PendingPrompt, type TextRenderer, type TurnHead } from './tabLines.js';
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
// `sticky`: once a turn's prompt scrolls out of view, its first rows stay at the top.
type TabViewProps = { tab: Tab; width: number; detail: boolean; scrollActive: boolean; questionPending: boolean; expandedOverride?: boolean; pending?: PendingPrompt[]; mdStyle?: MarkdownStyle; sticky?: boolean };

function TabViewImpl({ tab, width, detail, scrollActive, questionPending, expandedOverride, pending, sticky = false }: TabViewProps) {
  const viewportRef = useRef<DOMElement>(null);
  const { height: viewHeight } = useBoxMetrics(viewportRef);
  const [requested, setRequested] = useState(0);
  // Follow the bottom while the turn streams, until the user scrolls up.
  const [follow, setFollow] = useState(true);
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
  }, [tab.status]);

  // Work streams expanded while the turn runs; it collapses to a summary when
  // the response lands or a question is waiting. Ctrl+E overrides until the
  // next automatic switch, and also expands the tab's earlier turns.
  const autoExpanded = tab.status === 'running' && !questionPending;
  const [override, setOverride] = useState<boolean | null>(null);
  useEffect(() => setOverride(null), [autoExpanded]);
  const expanded = expandedOverride ?? override ?? autoExpanded;

  const textWidth = Math.max(20, width - 2);
  const { lines, workAt, heads } = tabLines(tab, { width: textWidth, detail, expanded, expandEarlier: override === true, renderText, pending });
  const maxTop = Math.max(0, lines.length - viewHeight);
  const top = follow ? maxTop : Math.min(requested, maxTop);

  // The sticky header, drawn over the top rows: the prompt of the turn that
  // row `at` belongs to, once that prompt is scrolled past.
  const headerRows = sticky ? Math.min(3, Math.floor(viewHeight / 4)) : 0;
  const headerAt = (at: number): string[] => {
    let cur: TurnHead | undefined;
    for (const h of heads) if (h.at <= at) cur = h;
    if (!cur || cur.at === at || headerRows < 1) return [];
    return stickyLines(cur, textWidth, headerRows, cur === heads[0]);
  };
  const header = headerAt(top);

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
    });
  }, [scrollActive]);

  useInput(
    (input, key) => {
      const page = Math.max(1, viewHeight - 2 - header.length);
      if (key.pageUp) {
        setFollow(false);
        setRequested(Math.max(0, top - page));
      } else if (key.pageDown) {
        const next = Math.min(maxTop, top + page);
        setRequested(next);
        if (next >= maxTop) setFollow(true);
      } else if (key.home && !key.ctrl) {
        setFollow(false);
        setRequested(0);
      } else if (key.end && !key.ctrl) {
        setFollow(true);
      } else if (key.ctrl && input === 'e') {
        setOverride(!expanded);
        if (!expanded && workAt >= 0) {
          // Expanding: bring the start of the work to the top of the view (under the header).
          setFollow(false);
          setRequested(Math.max(0, workAt - headerAt(workAt).length));
        } else {
          setFollow(true);
        }
      }
    },
    { isActive: scrollActive },
  );

  // Only the rows on screen reach Ink. Before the first measurement the
  // height is unknown, so nothing is drawn for that one frame.
  const visible = viewHeight > 0 ? lines.slice(top, top + viewHeight) : [];
  visible.splice(0, header.length, ...header);
  return (
    <Box ref={viewportRef} flexGrow={1} flexDirection="column" overflow="hidden" paddingX={1}>
      <Text wrap="truncate-end">{visible.join('\n')}</Text>
    </Box>
  );
}

// Spinner ticks and keystrokes re-render App; the tab only redraws when its
// own props change.
export const TabView = memo(TabViewImpl);
