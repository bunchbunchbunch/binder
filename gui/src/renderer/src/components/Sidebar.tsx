import { useEffect, useState } from 'react';
import { baseName, ago } from '../lib/format';
import { sidebarTemplates, sidebarText, usesField } from '../lib/sidebarText';
import { openSession, paneId, sessionFacts, setState, useApp } from '../store';

// The panes and open sessions (⌘1-9, panes first), then recent sessions from
// `binder sessions`: live ones first, then what /resume would offer. An open
// session's row says what config.json's sidebar templates make of it (by
// default its status icon, how long its turn ran, and its first prompt), and
// pulses while it opens.

export function Sidebar({ onNew, onSwitcher, onSettings }: { onNew: () => void; onSwitcher: () => void; onSettings: () => void }) {
  const conns = useApp((s) => s.conns);
  const panes = useApp((s) => s.panes);
  const active = useApp((s) => s.active);
  const sessions = useApp((s) => s.sessions);
  const error = useApp((s) => s.sessionsError);
  const templates = sidebarTemplates(useApp((s) => s.sidebar));
  // {elapsed} counts up while a turn runs.
  const ticking = (usesField(templates.title, 'elapsed') || usesField(templates.subtitle, 'elapsed')) && conns.some((c) => c.state?.running != null);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  const open = new Set(conns.map((c) => c.sessionId));
  const recent = sessions.filter((r) => !open.has(r.id)).slice(0, 40);
  return (
    <aside className="sidebar">
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
              {panes.length + i < 9 && <span className="num">⌘{panes.length + i + 1}</span>}
            </button>
          );
        })}
        <div className="sidebar-section">
          <span>Recent</span>
        </div>
        {error && <div className="session-row sub">{error}</div>}
        {recent.map((r) => (
          <button key={r.id} className="session-row" onClick={() => openSession({ cwd: r.cwd, sessionId: r.id, resume: true, title: r.title })} title={`${r.cwd}\n${r.id}`}>
            <span className="body">
              <div className="title">
                {r.running ? '⏳ ' : ''}
                {r.title || '(no prompt yet)'}
              </div>
              <div className="sub">
                {baseName(r.cwd)}
                {r.branch ? ` · ${r.branch}` : ''} · {r.live ? 'live' : ago(r.lastUsedAt)}
              </div>
            </span>
          </button>
        ))}
      </div>
      <div className="sidebar-foot">
        <button onClick={onNew}>
          New session <kbd>⌘N</kbd>
        </button>
        <button onClick={onSwitcher}>
          Open a session <kbd>⌘K</kbd>
        </button>
        <button onClick={onSettings}>
          Settings <kbd>⌘,</kbd>
        </button>
      </div>
    </aside>
  );
}
