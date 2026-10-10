import { shell, WebContentsView, type BrowserWindow } from 'electron';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ControlReply, ControlRequest, Rect, WebPaneEvent } from '../shared/api';
import { appKey, type KeyDesc } from '../shared/keys';
import type { WebPaneConfig } from './binder';
import { completeFolder, makeFolder, missingFolder, paneOpen, sameOrigin } from './paneBridge';

// Web panes: pages from config.json's `panes` with a `url`, each in a view of
// its own drawn over the window (a WebContentsView), where the window lays
// out the pane (components/WebPaneView.tsx says where, and when it shows). A
// page loads when the window first shows its pane and stays while the app
// runs, as a terminal pane's program does. It comes from a server, so it
// stays on its origin, has no Node, and reaches the app only through
// window.binderPane (preload/pane.ts), whose calls paneBridge.ts checks.

type WebPane = {
  config: WebPaneConfig;
  view: WebContentsView;
  // Why the page did not load; the window says so in its place.
  failed: string | null;
  shown: boolean;
  // A link from the window (a sign-in link) is loading; the page comes after it.
  link: boolean;
};

const panes = new Map<string, WebPane>();
// The pane whose page was given the keyboard last, while it shows. Tracked
// rather than asked (isFocused): one pane may hide after the next one shows.
let keyboard: WebPane | null = null;

const openLink = (url: string) => /^https?:/i.test(url) && void shell.openExternal(url);

function show(win: BrowserWindow, p: WebPane, on: boolean): void {
  if (on === p.shown) return;
  p.shown = on;
  p.view.setVisible(on);
  if (on) {
    keyboard = p;
    p.view.webContents.focus();
    // Hiding the view tells the page nothing (no visibilitychange, no blur), so it is told here.
    p.view.webContents.send('pane:shown');
  } else if (keyboard === p) {
    // Hidden (another view, a panel over it, a failed load): the window takes the keyboard back.
    keyboard = null;
    win.webContents.focus();
  }
}

/** Loads web pane `pane`'s page in a view over `win`, unless it has one; returns why the page did not load, or null. */
export function startWebPane(win: BrowserWindow, pane: WebPaneConfig, open: (req: ControlRequest) => Promise<ControlReply>): string | null {
  const had = panes.get(pane.name);
  if (had) return had.failed;
  const view = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/pane.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Its own cookies, kept between launches, so a sign-in lasts.
      partition: `persist:pane-${encodeURIComponent(pane.name)}`,
    },
  });
  const p: WebPane = { config: pane, view, failed: null, shown: false, link: false };
  panes.set(pane.name, p);
  view.setVisible(false);
  win.contentView.addChildView(view);
  const wc = view.webContents;
  const tell = (e: WebPaneEvent) => !win.isDestroyed() && win.webContents.send('webPane', pane.name, e);

  // No camera, notifications and the like for a page from a server; writing to the clipboard is fine.
  wc.session.setPermissionRequestHandler((_wc, permission, done) => done(permission === 'clipboard-sanitized-write'));
  // The page stays on its origin; links elsewhere open in the browser.
  const away = (e: Electron.Event, url: string) => {
    if (sameOrigin(url, pane.url)) return;
    e.preventDefault();
    openLink(url);
  };
  wc.on('will-navigate', (e) => away(e, e.url));
  wc.on('will-redirect', (e) => e.isMainFrame && away(e, e.url));
  wc.setWindowOpenHandler(({ url }) => {
    openLink(url);
    return { action: 'deny' };
  });

  const fail = (why: string) => {
    p.failed = why;
    p.link = false;
    show(win, p, false);
    tell({ t: 'failed', error: why });
  };
  // A server that drops the connection (as one does before you sign in) fails here.
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => isMainFrame && code !== -3 && fail(`${desc} (${url})`));
  wc.on('render-process-gone', (_e, d) => fail(`The page stopped (${d.reason})`));
  wc.on('did-navigate', () => {
    if (p.failed === null) return;
    p.failed = null;
    tell({ t: 'loaded' });
  });
  wc.on('did-finish-load', () => {
    if (!p.link || p.failed !== null) return;
    p.link = false;
    void wc.loadURL(pane.url).catch(() => {});
  });

  // The window's own ⌘ keys work while the page has the keyboard: they are
  // taken from it and passed on. Every other key is the page's.
  wc.on('before-input-event', (e, input) => {
    const k: KeyDesc = { code: input.code, meta: input.meta, ctrl: input.control, alt: input.alt, shift: input.shift };
    if (input.type !== 'keyDown' || appKey(k) === null) return;
    e.preventDefault();
    if (!win.isDestroyed()) win.webContents.send('appKey', k);
  });

  // window.binderPane, for the page on the pane's origin only.
  const home = resolve(homedir());
  const bridge = (channel: string, fn: (arg: unknown) => unknown) =>
    wc.ipc.handle(`pane:${channel}`, (e, arg: unknown) => {
      if (!e.senderFrame || !sameOrigin(e.senderFrame.url, pane.url)) throw new Error(`binderPane is for ${new URL(pane.url).origin} only`);
      return fn(arg);
    });
  bridge('home', () => home);
  bridge('open', async (req) => {
    const r = paneOpen(req, home);
    if (typeof r === 'string') throw new Error(r);
    const reply = await open(r);
    if (!reply.ok) throw new Error(reply.error);
  });
  bridge('completeFolder', (input) => completeFolder(input, home));
  bridge('missingFolder', (input) => missingFolder(input, home));
  bridge('makeFolder', (path) => makeFolder(path, home));

  void wc.loadURL(pane.url).catch(() => {});
  return null;
}

/** Places web pane `name`'s page over its box in the window; it shows, with the keyboard, when `on` and it has loaded. */
export function layoutWebPane(win: BrowserWindow, name: string, box: Rect, on: boolean): void {
  const p = panes.get(name);
  if (!p) return;
  // The view is placed in window points; the window's zoom (View > Zoom In) scales its CSS pixels.
  const z = win.webContents.getZoomFactor();
  p.view.setBounds({ x: Math.round(box.x * z), y: Math.round(box.y * z), width: Math.round(box.width * z), height: Math.round(box.height * z) });
  show(win, p, on && p.failed === null);
}

/** Loads web pane `name`'s page again; with `url`, a link on its origin (a sign-in link that sets a cookie), that first. */
export function loadWebPane(name: string, url?: string): void {
  const p = panes.get(name);
  if (!p) throw new Error(`No web pane named ${name}`);
  if (url !== undefined && !sameOrigin(url, p.config.url)) throw new Error(`Only links on ${new URL(p.config.url).origin} open in this pane`);
  p.link = url !== undefined;
  void p.view.webContents.loadURL(url ?? p.config.url).catch(() => {});
}
