import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WireTab } from '@shared/wire';
import { statusGlyph, tabTitle } from '../lib/work';

// Each prompt and its response is a tab, as in the TUI. The active one stays
// scrolled into view, and counts at the edges say how many tabs are out of
// view on each side (the TUI's ‹ ›); clicking one pages that way.
export function TabBar({ tabs, active, onSelect }: { tabs: WireTab[]; active: number | null; onSelect: (id: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState({ left: 0, right: 0 });
  // Whether the strip keeps the active tab in view. Scrolling it by hand lets
  // go until the active tab changes.
  const follow = useRef(true);

  const measure = () => {
    const el = box.current;
    if (!el) return;
    const from = el.scrollLeft;
    const to = from + el.clientWidth;
    let left = 0;
    let right = 0;
    for (const t of el.querySelectorAll<HTMLElement>('.tab')) {
      if (t.offsetLeft < from - 1) left++;
      else if (t.offsetLeft + t.offsetWidth > to + 1) right++;
    }
    setHidden((h) => (h.left === left && h.right === right ? h : { left, right }));
  };

  // The active tab in view, then the counts. Again on resize: a count
  // appearing narrows the strip and can cut the active tab off. Not once
  // scrolled by hand, or the count that scroll brings in snaps it back.
  const settle = () => {
    if (follow.current) box.current?.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    measure();
  };
  // Only a new active tab or a new tab moves the strip; patches (every
  // 120 ms while a turn runs) leave a strip scrolled by hand where it is.
  useLayoutEffect(() => {
    follow.current = true;
    settle();
  }, [active, tabs.length]);
  useLayoutEffect(measure, [tabs]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(settle);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs.length > 0]);

  if (!tabs.length) return <div className="no-tabs">No tabs yet: type a prompt below</div>;
  const page = (dir: number) => {
    follow.current = false;
    box.current?.scrollBy({ left: dir * box.current.clientWidth * 0.8, behavior: 'smooth' });
  };
  return (
    <div className="tabbar">
      {hidden.left > 0 && (
        <button className="tab-more" onClick={() => page(-1)} title={`${hidden.left} more tab${hidden.left === 1 ? '' : 's'} to the left (Ctrl+Left)`}>
          ‹ {hidden.left}
        </button>
      )}
      <div className="tabs" ref={box} onScroll={measure} onWheel={() => (follow.current = false)}>
        {tabs.map((t) => {
          const status = t.status === 'superseded' ? 'running' : t.status;
          return (
            <button key={t.id} className={`tab${t.id === active ? ' active' : ''}`} onClick={() => onSelect(t.id)} title={tabTitle(t, 200)}>
              <span className="num">{t.id}</span>
              <span className={`glyph ${status}`}>{status === 'running' ? <span className="spin">◐</span> : t.bash && status === 'done' ? '!' : statusGlyph(t.status)}</span>
              <span className="label">{tabTitle(t)}</span>
            </button>
          );
        })}
      </div>
      {hidden.right > 0 && (
        <button className="tab-more" onClick={() => page(1)} title={`${hidden.right} more tab${hidden.right === 1 ? '' : 's'} to the right (Ctrl+N)`}>
          {hidden.right} ›
        </button>
      )}
    </div>
  );
}
