import { shell, WebContentsView, type BrowserWindow } from 'electron';
import type { PreviewEvent, Rect } from '../shared/api';
import { appKey, type KeyDesc } from '../shared/keys';

// The preview pane (/preview): a session's web app beside it, in a view of its
// own over the window (the window says where, components/PreviewPane.tsx), as
// the side pane is. Its dev server runs in a pty (main/panes.ts, named
// preview:<conn>). The page's console errors go to the window, and a capture
// of it goes to Claude ("Show Claude"). It has no Node and no bridge to the app.

type Preview = { view: WebContentsView; win: BrowserWindow };
const previews = new Map<string, Preview>();
let shownConn: string | null = null;

const tell = (win: BrowserWindow, conn: string, e: PreviewEvent) => !win.isDestroyed() && win.webContents.send('preview', conn, e);

function make(win: BrowserWindow, conn: string): WebContentsView {
  const v = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, partition: `preview-${conn}` } });
  v.setVisible(false);
  win.contentView.addChildView(v);
  const wc = v.webContents;
  wc.session.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  // Pages open here; a new window (target=_blank) opens in the browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('page-title-updated', (_e, title) => tell(win, conn, { t: 'title', title }));
  wc.on('did-navigate', (_e, url) => tell(win, conn, { t: 'url', url }));
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => isMainFrame && tell(win, conn, { t: 'url', url }));
  wc.on('did-start-loading', () => tell(win, conn, { t: 'loading' }));
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => isMainFrame && code !== -3 && tell(win, conn, { t: 'failed', error: `${desc} (${url})` }));
  wc.on('console-message', (e) => {
    const level = (e as unknown as { level: string }).level;
    if (level !== 'error' && level !== 'warning') return;
    const { message, lineNumber, sourceId } = e as unknown as { message: string; lineNumber: number; sourceId: string };
    // Electron's own warnings (unpackaged builds) are not the page's.
    if (message.includes('Electron Security Warning')) return;
    tell(win, conn, { t: 'console', level, message: message.slice(0, 2000), source: sourceId ? `${sourceId.replace(/^https?:\/\/[^/]+/, '')}:${lineNumber}` : '' });
  });
  // The window's ⌘ keys still work while the page has the keyboard.
  wc.on('before-input-event', (e, input) => {
    const k: KeyDesc = { code: input.code, meta: input.meta, ctrl: input.control, alt: input.alt, shift: input.shift };
    if (input.type !== 'keyDown' || appKey(k) === null) return;
    e.preventDefault();
    if (!win.isDestroyed()) win.webContents.send('appKey', k);
  });
  return v;
}

/** Opens `url` in the session's preview. */
export function openPreview(win: BrowserWindow, conn: string, url: string): void {
  if (!/^https?:\/\//i.test(url)) throw new Error(`Not a web address: ${url}`);
  let p = previews.get(conn);
  if (!p || p.win !== win) {
    p = { view: make(win, conn), win };
    previews.set(conn, p);
  }
  void p.view.webContents.loadURL(url).catch(() => {});
  tell(win, conn, { t: 'url', url });
}

/** Places the session's preview over its box; it shows when `on`, and any other session's hides. */
export function layoutPreview(win: BrowserWindow, conn: string, box: Rect, on: boolean): void {
  for (const [id, p] of previews) if (id !== conn && p.win === win) p.view.setVisible(false);
  const p = previews.get(conn);
  if (!p) return;
  const z = win.webContents.getZoomFactor();
  p.view.setBounds({ x: Math.round(box.x * z), y: Math.round(box.y * z), width: Math.round(box.width * z), height: Math.round(box.height * z) });
  p.view.setVisible(on);
  if (on) shownConn = conn;
  else if (shownConn === conn) {
    shownConn = null;
    if (!win.isDestroyed()) win.webContents.focus();
  }
}

export function reloadPreview(conn: string): void {
  previews.get(conn)?.view.webContents.reloadIgnoringCache();
}

/** The page as it looks now, as a PNG (base64), with its size. */
export async function capturePreview(conn: string): Promise<{ data: string; width: number; height: number }> {
  const p = previews.get(conn);
  if (!p) throw new Error('No preview open');
  const img = await p.view.webContents.capturePage();
  const { width, height } = img.getSize();
  return { data: img.toPNG().toString('base64'), width, height };
}

export function closePreview(conn: string): void {
  const p = previews.get(conn);
  if (!p) return;
  previews.delete(conn);
  if (!p.win.isDestroyed()) p.win.contentView.removeChildView(p.view);
  p.view.webContents.close();
}

/** A window's previews go with it. */
export function closePreviews(win: BrowserWindow): void {
  for (const [id, p] of previews) if (p.win === win) previews.delete(id);
}
