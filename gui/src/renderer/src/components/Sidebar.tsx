import { useEffect, useRef, useState } from 'react';
import { sidebarTemplates, sidebarText, usesField } from '../lib/sidebarText';
import { paneId, sessionFacts, setState, useApp } from '../store';

// The panes, then the open sessions (⌘1-9 in that order). A session's row says
// what config.json's sidebar templates make of it (by default its status icon,
// how long its turn ran, and its first prompt), and pulses while it opens. A
// session on another computer (config.json's computers) carries that
// computer's name. Drag the sidebar's edge to resize it (remembered);
// double-click the edge for the default.

const MIN_WIDTH = 180;

export function Sidebar({ onNew, onGuide }: { onNew: () => void; onGuide: () => void }) {
  const conns = useApp((s) => s.conns);
  const panes = useApp((s) => s.panes);
  const active = useApp((s) => s.active);
  const templates = sidebarTemplates(useApp((s) => s.sidebar));
  // {elapsed} counts up while a turn runs.
  const ticking = (usesField(templates.title, 'elapsed') || usesField(templates.subtitle, 'elapsed')) && conns.some((c) => c.state?.running != null);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  // null: the stylesheet's width.
  const [width, setWidth] = useState(() => Number(localStorage.getItem('sidebarWidth')) || null);
  useEffect(() => {
    if (width) localStorage.setItem('sidebarWidth', String(width));
    else localStorage.removeItem('sidebarWidth');
  }, [width]);
  // While dragging: the sidebar's width less the pointer's x when the drag began.
  const dragFrom = useRef<number | null>(null);
  return (
    <aside className="sidebar" style={width ? { width } : undefined}>
      <div className="sidebar-top" />
      <div className="sidebar-scroll">
        {panes.map((name, i) => (
          <button key={name} className={`session-row${active === paneId(name) ? ' active' : ''}`} onClick={() => setState({ active: paneId(name) })}>
            <span className="dot square" />
            <span className="body">
              <div className="title">{name}</div>
            </span>
            {i < 9 && <span className="num">⌘{i + 1}</span>}
          </button>
        ))}
        {conns.length > 0 && <div className="sidebar-section">Open</div>}
        {conns.map((c, i) => {
          const text = sidebarText(templates, sessionFacts(c), Date.now());
          return (
            <button key={c.id} className={`session-row${c.id === active ? ' active' : ''}${c.status === 'opening' ? ' opening' : ''}`} onClick={() => setState({ active: c.id })} title={[text.title, text.subtitle].filter(Boolean).join('\n')}>
              <span className="body">
                <div className="title">{text.title}</div>
                {text.subtitle && <div className="sub">{text.subtitle}</div>}
              </span>
              {c.computer && <span className="computer">{c.computer}</span>}
              {panes.length + i < 9 && <span className="num">⌘{panes.length + i + 1}</span>}
            </button>
          );
        })}
      </div>
      <div className="sidebar-foot">
        <button onClick={onNew}>
          New session <kbd>⌘N</kbd>
        </button>
        <button onClick={onGuide}>
          Help <kbd>⌘/</kbd>
        </button>
      </div>
      <div
        className="sidebar-edge"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          dragFrom.current = e.currentTarget.parentElement!.offsetWidth - e.clientX;
        }}
        onPointerMove={(e) => {
          if (dragFrom.current !== null) setWidth(Math.round(Math.max(MIN_WIDTH, Math.min(window.innerWidth / 2, dragFrom.current + e.clientX))));
        }}
        onLostPointerCapture={() => (dragFrom.current = null)}
        onDoubleClick={() => setWidth(null)}
      />
    </aside>
  );
}
