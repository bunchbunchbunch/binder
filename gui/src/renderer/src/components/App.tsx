import { useEffect, useRef, useState } from 'react';
import { appKey, type KeyDesc } from '@shared/keys';
import { closeConn, getState, handleControl, handleMessage, paneId, paneName, refreshSessions, restoreLayout, setState, toast, useApp } from '../store';
import { NewSessionPanel, SessionSwitcher, SettingsPanel } from '../panels/AppPanels';
import { PaneView } from './PaneView';
import { SessionView } from './SessionView';
import { Guide } from './Shortcuts';
import { Sidebar } from './Sidebar';
import { WebPaneView } from './WebPaneView';
import { Logo } from './Welcome';

// The window: the session sidebar, the panes and open sessions (one on
// screen), and the window-wide keys: ⌘N, ⌘K, ⌘W, ⌘1-9, ⌘⇧[ ], ⌘,, ⌘/, ⌃⌘S
// (also when a web pane's page has the keyboard), and Ctrl+C (copy, or twice
// to quit).

type AppPanel = { kind: 'switcher'; scope: 'folder' | 'all' } | { kind: 'new' } | { kind: 'settings' } | { kind: 'guide' };

const QUIT_ARM_MS = 1500;

function selectedText(): string {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const text = el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
    if (text) return text;
  }
  return window.getSelection()?.toString() ?? '';
}

export function App() {
  const conns = useApp((s) => s.conns);
  const panes = useApp((s) => s.panes);
  const webPanes = useApp((s) => s.webPanes);
  const active = useApp((s) => s.active);
  const toastNow = useApp((s) => s.toast);
  const [appPanel, setAppPanel] = useState<AppPanel | null>(null);
  // ⌃⌘S hides the sidebar for more room (remembered).
  const [sidebar, setSidebar] = useState(() => localStorage.getItem('sidebar') !== 'hidden');
  useEffect(() => localStorage.setItem('sidebar', sidebar ? 'shown' : 'hidden'), [sidebar]);
  const quitArmed = useRef(0);

  useEffect(() => {
    const off = window.binder.onMessage(handleMessage);
    const offSettings = window.binder.onOpenSettings(() => setAppPanel({ kind: 'settings' }));
    const offGuide = window.binder.onOpenGuide(() => setAppPanel({ kind: 'guide' }));
    const offControl = window.binder.onControl(handleControl);
    void window.binder.loadSettings().then((s) => setState({ stickyPrompt: s.stickyPrompt, sidebar: s.sidebar }));
    void restoreLayout();
    const t = setInterval(() => void refreshSessions(), 30000);
    const onFocus = () => void refreshSessions();
    window.addEventListener('focus', onFocus);
    return () => {
      off();
      offSettings();
      offGuide();
      offControl();
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  useEffect(() => {
    // A window-wide key, pressed here or in a web pane's page; false when `k` is none.
    const runKey = (k: KeyDesc): boolean => {
      const a = appKey(k);
      if (a === null) return false;
      const { conns, panes, active } = getState();
      // What ⌘1-9 and ⌘⇧[ ] go through: the panes, then the open sessions.
      const views = [...panes.map(paneId), ...conns.map((c) => c.id)];
      if (a === 'sidebar') setSidebar((v) => !v);
      else if (a === 'new') setAppPanel({ kind: 'new' });
      else if (a === 'switcher') setAppPanel({ kind: 'switcher', scope: 'all' });
      else if (a === 'settings') setAppPanel({ kind: 'settings' });
      else if (a === 'guide') setAppPanel({ kind: 'guide' });
      else if (a === 'close') {
        if (active && paneName(active) === null) closeConn(active);
      } else if (typeof a === 'number') {
        const v = views[a - 1];
        if (v) setState({ active: v });
      } else {
        if (!views.length) return false;
        const i = views.indexOf(active ?? '');
        const d = a === 'prev' ? -1 : 1;
        setState({ active: views[(((i + d) % views.length) + views.length) % views.length] });
      }
      return true;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const take = () => e.preventDefault();
      if (runKey({ code: e.code, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey })) return take();
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'c') {
        take();
        const text = selectedText();
        if (text) {
          void window.binder.copyText(text);
          return toast('Copied');
        }
        if (Date.now() - quitArmed.current < QUIT_ARM_MS) return window.binder.quit();
        quitArmed.current = Date.now();
        toast('Press Ctrl+C again to quit');
      }
    };
    window.addEventListener('keydown', onKey);
    const offAppKey = window.binder.onAppKey(runKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      offAppKey();
    };
  }, []);

  const activeConn = conns.find((c) => c.id === active);
  const activePane = paneName(active);
  const cwd = activeConn?.state?.cwd ?? activeConn?.cwd ?? null;
  const close = () => setAppPanel(null);
  return (
    <div className={`app${sidebar ? '' : ' no-sidebar'}`}>
      {sidebar && <Sidebar onNew={() => setAppPanel({ kind: 'new' })} onSwitcher={() => setAppPanel({ kind: 'switcher', scope: 'all' })} onSettings={() => setAppPanel({ kind: 'settings' })} />}
      <main className="main">
        {conns.map((c) => (
          <SessionView key={c.id} conn={c} visible={c.id === active} appPanelOpen={appPanel !== null} onSwitcher={(scope) => setAppPanel({ kind: 'switcher', scope })} onSettings={() => setAppPanel({ kind: 'settings' })} />
        ))}
        {panes.map((name) =>
          webPanes.includes(name) ? (
            <WebPaneView key={name} name={name} visible={name === activePane} focus={name === activePane && appPanel === null} />
          ) : (
            <PaneView key={name} name={name} visible={name === activePane} focus={name === activePane && appPanel === null} />
          ),
        )}
        {!activeConn && activePane === null && (
          <div className="empty-main">
            <div className="titlebar" />
            <div className="welcome">
              <div className="welcome-inner">
                <Logo size={11} />
                <div>
                  <h1>Binder</h1>
                  <div className="muted">Claude Code sessions, in tabs.</div>
                  <div className="hint">
                    <kbd>⌘N</kbd> starts a session in a folder · <kbd>⌘K</kbd> opens one you had · <kbd>⌘/</kbd> shows the keys
                  </div>
                </div>
              </div>
            </div>
            {toastNow && <div className={`toast${toastNow.error ? ' error' : ''}`} style={{ bottom: 24 }}>{toastNow.text}</div>}
          </div>
        )}
        {appPanel?.kind === 'switcher' && <SessionSwitcher cwd={cwd} initialScope={appPanel.scope} close={close} />}
        {appPanel?.kind === 'new' && <NewSessionPanel cwd={cwd} close={close} />}
        {appPanel?.kind === 'settings' && <SettingsPanel close={close} />}
        {appPanel?.kind === 'guide' && <Guide close={close} />}
      </main>
    </div>
  );
}
