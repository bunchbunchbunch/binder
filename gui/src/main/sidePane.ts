import { shell, WebContentsView, type BrowserWindow } from 'electron';
import type { Rect, SidePaneEvent } from '../shared/api';
import { appKey, type KeyDesc } from '../shared/keys';

// The side pane: claude.ai docs, sheets and artifacts opened beside the
// session instead of in the browser (config.json claudeLinks). One page in a
// view of its own over the window, as a web pane is; the window says where
// (components/SidePane.tsx). Its cookies are kept between launches, so a
// claude.ai sign-in there lasts. It has no Node and no bridge to the app.

// BINDER_CLAUDE_ORIGIN stands in for claude.ai in tests.
export const claudeOrigin = (): string => process.env.BINDER_CLAUDE_ORIGIN || 'https://claude.ai';

/** Whether `url` is a claude.ai page (a doc, sheet or artifact), which the side pane shows. */
export function isClaudeLink(url: string): boolean {
  const u = URL.parse(url);
  return u !== null && u.origin === claudeOrigin();
}

// Where the page may go itself: claude.ai and its sign-in (Google, Apple,
// Anthropic). A link anywhere else opens in the browser.
const SIGN_IN = [/(^|\.)claude\.ai$/, /(^|\.)anthropic\.com$/, /^accounts\.google\.com$/, /^appleid\.apple\.com$/];
function staysHere(url: string): boolean {
  const u = URL.parse(url);
  if (!u) return false;
  if (u.origin === claudeOrigin()) return true;
  return u.protocol === 'https:' && SIGN_IN.some((r) => r.test(u.hostname));
}

let view: WebContentsView | null = null;
let shown = false;

function tell(win: BrowserWindow, e: SidePaneEvent): void {
  if (!win.isDestroyed()) win.webContents.send('sidePane', e);
}

function make(win: BrowserWindow): WebContentsView {
  const v = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, partition: 'persist:claude-ai' } });
  v.setVisible(false);
  win.contentView.addChildView(v);
  const wc = v.webContents;
  wc.session.setPermissionRequestHandler((_wc, permission, done) => done(permission === 'clipboard-sanitized-write'));
  const away = (e: Electron.Event, url: string) => {
    if (staysHere(url)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  };
  wc.on('will-navigate', (e) => away(e, e.url));
  wc.on('will-redirect', (e) => e.isMainFrame && away(e, e.url));
  wc.setWindowOpenHandler(({ url }) => {
    // A new tab on claude.ai itself loads here, as its links do.
    if (isClaudeLink(url)) void wc.loadURL(url).catch(() => {});
    else if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('page-title-updated', (_e, title) => tell(win, { t: 'title', title }));
  wc.on('did-navigate', (_e, url) => tell(win, { t: 'url', url }));
  // claude.ai moves between its pages in the page (history.pushState).
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => isMainFrame && tell(win, { t: 'url', url }));
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => isMainFrame && code !== -3 && tell(win, { t: 'failed', error: `${desc} (${url})` }));
  // The window's ⌘ keys still work while the page has the keyboard, and so do
  // ⌃\ (closes the pane) and ⌃] (the newest artifact): pressed again in the
  // window, where its own key handlers take them.
  wc.on('before-input-event', (e, input) => {
    const k: KeyDesc = { code: input.code, meta: input.meta, ctrl: input.control, alt: input.alt, shift: input.shift };
    const windowKey = input.control && !input.meta && !input.alt && (input.code === 'Backslash' || input.key === ']');
    if (input.type !== 'keyDown' || (appKey(k) === null && !windowKey)) return;
    e.preventDefault();
    if (win.isDestroyed()) return;
    if (!windowKey) return win.webContents.send('appKey', k);
    const init = { key: input.key, code: input.code, ctrlKey: true, shiftKey: input.shift, bubbles: true, cancelable: true };
    void win.webContents.executeJavaScript(`dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify(init)}))`).catch(() => {});
  });
  return v;
}

/** Opens `url` (a claude.ai page) in the side pane; the window then shows it. */
export function openSidePane(win: BrowserWindow, url: string): void {
  if (!isClaudeLink(url)) throw new Error(`Only ${claudeOrigin()} pages open in the side pane`);
  view ??= make(win);
  void view.webContents.loadURL(url).catch(() => {});
  tell(win, { t: 'url', url });
}

/** Places the side pane's page over its box; it shows when `on`. */
export function layoutSidePane(win: BrowserWindow, box: Rect, on: boolean): void {
  if (!view) return;
  const z = win.webContents.getZoomFactor();
  view.setBounds({ x: Math.round(box.x * z), y: Math.round(box.y * z), width: Math.round(box.width * z), height: Math.round(box.height * z) });
  if (on === shown) return;
  shown = on;
  view.setVisible(on);
  if (!on && !win.isDestroyed()) win.webContents.focus();
}

/** Hides the side pane's page: the window started over (a reload or a crash) and shows no pane yet. */
export function hideSidePane(): void {
  if (!view || !shown) return;
  shown = false;
  view.setVisible(false);
}

/** The page on screen in the side pane, for "Open in browser". */
export function sidePaneUrl(): string | null {
  return view ? view.webContents.getURL() || null : null;
}
