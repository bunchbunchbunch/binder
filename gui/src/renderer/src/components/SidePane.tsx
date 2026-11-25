import { useEffect, useRef } from 'react';
import { setState, useApp } from '../store';

// The side pane: a claude.ai doc, sheet or artifact beside the session. The
// main process draws the page in a view of its own (main/sidePane.ts); this
// holds its place, with the page's title, a way out to the browser, and close.
// `covered`: an app-wide panel is over the window, which the view would hide.
export function SidePane({ covered }: { covered: boolean }) {
  const side = useApp((s) => s.sidePane);
  const box = useRef<HTMLDivElement>(null);
  const show = side !== null && side.error === null && !covered;

  useEffect(() => {
    const el = box.current;
    // Closed (× or ⌃\): the page hides with its frame (it stays loaded for ⌃\).
    if (!el) {
      window.binder.sidePaneLayout({ x: 0, y: 0, width: 0, height: 0 }, false);
      return;
    }
    const place = () => {
      const r = el.getBoundingClientRect();
      window.binder.sidePaneLayout({ x: r.x, y: r.y, width: r.width, height: r.height }, show);
    };
    place();
    const resized = new ResizeObserver(place);
    resized.observe(el);
    window.addEventListener('resize', place);
    return () => {
      resized.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [show, side !== null]);
  // Gone from the window: the page hides with it (it stays loaded for ⌃\).
  useEffect(() => () => window.binder.sidePaneLayout({ x: 0, y: 0, width: 0, height: 0 }, false), []);

  if (!side) return null;
  return (
    <aside className="side-pane">
      <div className="titlebar">
        <span className="side-title" title={side.url}>
          {side.title || side.url}
        </span>
        <button className="side-open" title="Open this page in the browser" onClick={() => void window.binder.openExternal(side.url)}>
          Open in browser
        </button>
        <button className="side-close" title="Close the side pane (⌃\\)" onClick={() => setState({ sidePane: null })}>
          ×
        </button>
      </div>
      <div className="side-web" ref={box}>
        {side.error && (
          <div className="banner">
            <span className="err">The page did not load.</span> {side.error}
          </div>
        )}
      </div>
    </aside>
  );
}
