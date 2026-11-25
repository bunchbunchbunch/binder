import { useEffect, useRef, useState } from 'react';
import { useApp, type Conn } from '../store';
import { closePreviewOf, showClaude } from '../lib/preview';

// The preview pane (/preview): the session's web app beside it. The main
// process draws the page in a view of its own (main/preview.ts); this holds
// its place, with its address, Reload, Show Claude (a capture and the console
// errors, sent to Claude), the console, and the dev server's log.
// `covered`: an app-wide panel is over the window, which the view would hide.
export function PreviewPane({ conn, covered }: { conn: Conn; covered: boolean }) {
  const p = useApp((s) => s.previews[conn.id]);
  const box = useRef<HTMLDivElement>(null);
  const [drawer, setDrawer] = useState<'console' | 'server' | null>(null);
  const [address, setAddress] = useState('');
  const show = Boolean(p?.url) && !p?.error && !covered;

  useEffect(() => setAddress(p?.url ?? ''), [p?.url]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      window.binder.previewLayout(conn.id, { x: r.x, y: r.y, width: r.width, height: r.height }, show);
    };
    place();
    const resized = new ResizeObserver(place);
    resized.observe(el);
    window.addEventListener('resize', place);
    return () => {
      resized.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [show, conn.id, drawer]);
  // Off screen (another session, or closed): the page hides with it.
  useEffect(() => () => window.binder.previewLayout(conn.id, { x: 0, y: 0, width: 0, height: 0 }, false), [conn.id]);

  if (!p) return null;
  const errors = p.console.filter((m) => m.level === 'error').length;
  const server = p.server;
  return (
    <aside className="side-pane preview-pane">
      <div className="titlebar">
        <input
          className="preview-address"
          value={address}
          spellCheck={false}
          placeholder={server?.status === 'running' ? `Waiting for ${server.command} to print its address…` : 'A web address'}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && /^https?:\/\//i.test(address.trim())) void window.binder.previewOpen(conn.id, address.trim());
          }}
          title={p.title ?? undefined}
        />
        <button title="Reload the page" disabled={!p.url} onClick={() => window.binder.previewReload(conn.id)}>
          ↻
        </button>
        <button className="show-claude" title="Send Claude a capture of the page and its console errors" disabled={!p.url} onClick={() => void showClaude(conn)}>
          Show Claude
        </button>
        <button title="Open this page in the browser" disabled={!p.url} onClick={() => p.url && void window.binder.openExternal(p.url)}>
          ↗
        </button>
        <button className="side-close" title="Close the preview (and stop its server)" onClick={() => closePreviewOf(conn.id)}>
          ×
        </button>
      </div>
      <div className="side-web" ref={box}>
        {p.error && (
          <div className="banner">
            <span className="err">The page did not load.</span> {p.error}
          </div>
        )}
        {!p.url && !p.error && <div className="preview-wait">{server ? (server.status === 'running' ? `Starting ${server.command}…` : `${server.command} exited${server.code !== undefined ? ` (code ${server.code})` : ''} before it printed an address.`) : 'Nothing to show yet.'}</div>}
      </div>
      {drawer && (
        <pre className="preview-drawer">
          {drawer === 'console'
            ? p.console.length
              ? p.console.map((m) => `${m.level === 'error' ? '✗' : '!'} ${m.message}${m.source ? `  (${m.source})` : ''}`).join('\n')
              : 'Nothing in the console.'
            : (server?.output ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(-20000) || 'No output yet.'}
        </pre>
      )}
      <div className="preview-foot">
        <button className={`${errors ? 'has-errors' : ''}${drawer === 'console' ? ' on' : ''}`} onClick={() => setDrawer(drawer === 'console' ? null : 'console')}>
          Console{errors ? ` · ${errors} error${errors === 1 ? '' : 's'}` : ''}
        </button>
        {server && (
          <button className={drawer === 'server' ? 'on' : ''} onClick={() => setDrawer(drawer === 'server' ? null : 'server')}>
            {server.command} · {server.status === 'running' ? 'running' : `exited${server.code !== undefined ? ` (${server.code})` : ''}`}
          </button>
        )}
        {p.loading && <span className="dim">Loading…</span>}
      </div>
    </aside>
  );
}
