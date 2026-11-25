import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, shell, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ControlReply, ControlRequest, OpenRequest, PaneInfo, Rect, SavedLayout, SessionList, SessionRef, Settings, SettingsPatch, SidebarScriptInput } from '../shared/api';
import type { HostMessage } from '../shared/wire';
import { archiveSession, binder, scheduleCommand, ensureHost, listSessions, searchSessions, readComputers, readDefaultComputer, readPanes, readSettings, repoInfo, runSidebarScript, stateDir, writeSettings, type PaneConfig, type WebPaneConfig } from './binder';
import { listenControl } from './control';
import { subfolders } from './paneBridge';
import { HostConnection, processStream, socketStream, type HostStream } from './hostConnection';
import { Remote, shellQuote } from './remote';
import { paneInput, resizePane, startPane, stopPane, stopPaneGroup, stopPanes } from './panes';
import { capturePreview, closePreview, closePreviews, layoutPreview, openPreview, reloadPreview } from './preview';
import { previewCommand } from './devServer';
import { simBoot, simDevices, simOpenApp, simShot } from './simulator';
import { layoutWebPane, loadWebPane, startWebPane } from './webPanes';
import { hideSidePane, isClaudeLink, layoutSidePane, openSidePane } from './sidePane';
import { fetchImage, localImage } from './images';
import { openPath } from './openPath';

// The app's main process: one window, one host connection per session the
// window shows (a socket here, or ssh to another computer), the panes'
// programs and pages, and the control socket. Everything about a session
// lives in its binder host.

let win: BrowserWindow | null = null;
// The windows' connections; null while one is still opening (its host starting).
const conns = new Map<string, HostConnection | null>();
// The page each connection belongs to: the main window's, or a session window's.
const owners = new Map<string, WebContents>();
// Sessions with a turn running or queued, and waiting on you, as each window last reported.
const statuses = new Map<number, { waiting: number; working: number }>();
let working = 0;
let quitting = false;

const userFile = (name: string) => join(app.getPath('userData'), name);

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(userFile(name), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function post(conn: string, msg: HostMessage): void {
  const wc = owners.get(conn) ?? win?.webContents;
  if (wc && !wc.isDestroyed()) wc.send('host', conn, msg);
}

// The window a page belongs to.
const windowOf = (wc: WebContents) => BrowserWindow.fromWebContents(wc);

// One per name in config.json's computers, made on first use; each shares one ssh connection.
const remotes = new Map<string, Remote>();

async function remote(name: string): Promise<Remote> {
  const env = await loginEnv();
  if (!readComputers(env).includes(name)) throw new Error(`config.json's computers has no ${name}`);
  let r = remotes.get(name);
  if (!r) remotes.set(name, (r = new Remote(name, env.BINDER_SSH || 'ssh', join(stateDir(env), 'ssh'))));
  return r;
}

/** Makes sure a host serves the session, here or on req.computer, and opens the line to it. */
async function hostStream(req: OpenRequest, sessionId: string, dropped: () => boolean): Promise<HostStream | null> {
  const resume = Boolean(req.sessionId && req.resume);
  if (!req.computer) return socketStream(await ensureHost(await binder(), req.cwd, sessionId, resume, req.args, req.worktree));
  const r = await remote(req.computer);
  await r.start(req.cwd, sessionId, resume, req.args, req.worktree);
  return dropped() ? null : processStream(await r.attach(sessionId));
}

async function open(conn: string, req: OpenRequest): Promise<void> {
  conns.set(conn, null);
  // The window let it go (⌘W) while its host was starting.
  const dropped = () => !conns.has(conn);
  try {
    const sessionId = req.sessionId ?? randomUUID();
    const stream = await hostStream(req, sessionId, dropped);
    if (!stream || dropped()) return stream?.end();
    const hc = new HostConnection(
      stream,
      (msg) => post(conn, msg),
      (reason) => {
        conns.delete(conn);
        post(conn, { t: 'detached', reason });
      },
    );
    conns.set(conn, hc);
    await hc.attach();
    if (conns.get(conn) !== hc) hc.close();
  } catch (e) {
    if (conns.get(conn) === null) conns.delete(conn);
    throw e;
  }
}

/** Lets go of `wc`'s connections (all of them, without one). */
function dropAll(wc?: WebContents): void {
  for (const [id, hc] of conns) {
    if (wc && owners.get(id) !== wc) continue;
    hc?.close();
    conns.delete(id);
    owners.delete(id);
  }
}

// The Dock badge and the quit check count every window's sessions.
function tally(): void {
  let waiting = 0;
  working = 0;
  for (const s of statuses.values()) {
    waiting += s.waiting;
    working += s.working;
  }
  app.dock?.setBadge(waiting ? String(waiting) : '');
}

// Control requests waiting for the window's answer.
const controls = new Map<number, (r: ControlReply) => void>();
let controlSeq = 0;

function askWindow(req: ControlRequest): Promise<ControlReply> {
  const w = win;
  if (!w || w.isDestroyed()) return Promise.resolve({ ok: false, error: 'The window is closed' });
  const id = ++controlSeq;
  return new Promise((done) => {
    controls.set(id, done);
    w.webContents.send('control', id, req);
    setTimeout(() => {
      if (controls.delete(id)) done({ ok: false, error: 'The window did not answer' });
    }, 5000);
  });
}

const loginEnv = () => binder().then((b) => b.env, () => process.env);

// config.json's appearance. The window's colors, its panes' terminals and its
// vibrancy all follow nativeTheme.
function applyAppearance(s: Settings): void {
  nativeTheme.themeSource = s.appearance === 'auto' ? 'system' : s.appearance;
}

function openExternal(url: string): void {
  if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
}

function registerIpc(): void {
  // Every computer's at once; one that does not answer adds nothing.
  ipcMain.handle('searchSessions', async (_e, query: string) => {
    const env = await loginEnv();
    const here = binder().then((b) => searchSessions(b, query));
    const there = readComputers(env).map((name) => remote(name).then((r) => r.search(query)));
    return (await Promise.allSettled([here, ...there])).flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  });
  ipcMain.handle('archiveSession', async (_e, id: string, on: boolean, computer?: string) => (computer ? (await remote(computer)).archive(id, on) : archiveSession(await binder(), id, on)));
  ipcMain.handle('schedule', async (_e, args: string[]) => scheduleCommand(await binder(), Array.isArray(args) ? args : []));
  ipcMain.handle('listSessions', async (_e, computer?: string): Promise<SessionList> => (computer ? (await remote(computer)).sessions() : { sessions: await listSessions(await binder()), home: homedir() }));
  ipcMain.handle('computers', async () => {
    const env = await loginEnv();
    return { computers: readComputers(env), defaultComputer: readDefaultComputer(env) };
  });
  ipcMain.handle('open', (e, conn: string, req: OpenRequest) => {
    owners.set(conn, e.sender);
    return open(conn, req);
  });
  ipcMain.handle('newWindow', (_e, ref: SessionRef) => void createWindow(ref));
  ipcMain.handle('request', (_e, conn: string, t: string, fields?: Record<string, unknown>) => {
    const hc = conns.get(conn);
    if (!hc) throw new Error('That session is not open');
    return hc.request(t, fields);
  });
  ipcMain.handle('close', (_e, conn: string) => {
    conns.get(conn)?.close();
    conns.delete(conn);
    owners.delete(conn);
  });
  ipcMain.handle('repoInfo', async (_e, cwd: string, computer?: string) => (computer ? (await remote(computer)).repoInfo(cwd) : repoInfo(cwd)));
  ipcMain.handle('sidebarScript', async (_e, input: SidebarScriptInput, computer?: string) => {
    const env = await loginEnv();
    if (!computer) return runSidebarScript(env, input);
    const command = readSettings(env).sidebar.script;
    return command ? (await remote(computer)).sidebarScript(command, input) : '';
  });
  ipcMain.handle('isDirectory', async (_e, path: string, computer?: string) => {
    if (computer) return (await remote(computer)).isDirectory(path);
    const p = resolve(path.replace(/^~(?=$|\/)/, homedir()));
    return existsSync(p) && statSync(p).isDirectory();
  });
  ipcMain.handle('subfolders', async (_e, dirs: string[], computer?: string) => {
    if (computer) return (await remote(computer)).subfolders(dirs);
    return dirs.flatMap((d) => subfolders(d).filter((n) => !n.startsWith('.')).map((n) => join(d, n)));
  });
  ipcMain.handle('chooseFolder', async (e, opts?: { buttonLabel?: string; hidden?: boolean }) => {
    const r = await dialog.showOpenDialog((windowOf(e.sender) ?? win)!, {
      properties: ['openDirectory', 'createDirectory', ...(opts?.hidden ? (['showHiddenFiles'] as const) : [])],
      buttonLabel: opts?.buttonLabel ?? 'Start session here',
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('clipboardImage', async () => {
    for (const item of await clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const data = Buffer.from(await ((await item.getType(type)) as Blob).arrayBuffer());
      // The host takes PNG, JPEG, GIF and WebP; anything else (a TIFF from some apps) becomes PNG.
      if (/^image\/(png|jpeg|gif|webp)$/.test(type)) return { mediaType: type, data: data.toString('base64') };
      return { mediaType: 'image/png', data: nativeImage.createFromBuffer(data).toPNG().toString('base64') };
    }
    return null;
  });
  ipcMain.handle('clipboardText', () => clipboard.readText());
  ipcMain.handle('copyText', (_e, text: string) => clipboard.writeText(text));
  ipcMain.handle('openExternal', (_e, url: string) => openExternal(url));
  ipcMain.handle('openLink', async (e, url: string) => {
    // The side pane is the main window's: a session window's links open in the browser.
    if (win && e.sender === win.webContents && isClaudeLink(url) && readSettings(await loginEnv()).claudeLinks === 'pane') {
      openSidePane(win, url);
      return 'pane';
    }
    openExternal(url);
    return 'browser';
  });
  ipcMain.handle('openPath', async (_e, path: string, cwd: string, how: 'edit' | 'reveal', line?: number) => {
    const env = await loginEnv();
    return openPath(path, cwd, how, readSettings(env).editor, env, line);
  });
  ipcMain.handle('localImage', (_e, path: string, cwd: string) => localImage(path, cwd));
  ipcMain.handle('fetchImage', (_e, url: string) => fetchImage(url));
  ipcMain.on('sidePaneLayout', (_e, box: Rect, show: boolean) => win && layoutSidePane(win, box, show));
  ipcMain.handle('loadLayout', () => readJson<SavedLayout>('layout.json', { open: [], active: null }));
  ipcMain.handle('saveLayout', (_e, layout: SavedLayout) => writeFileSync(userFile('layout.json'), JSON.stringify(layout)));
  ipcMain.handle('loadSettings', async () => readSettings(await binder().then((b) => b.env, () => process.env)));
  ipcMain.handle('saveSettings', async (_e, patch: SettingsPatch) => {
    const s = writeSettings(await binder().then((b) => b.env, () => process.env), patch);
    applyAppearance(s);
    return s;
  });
  ipcMain.handle('panes', async () => readPanes(await loginEnv()).map((p): PaneInfo => ({ name: p.name, web: 'url' in p })));
  // A session's terminal: its shell in the session's folder, here or on its computer over ssh.
  ipcMain.handle('termStart', async (e, id: string, cwd: string, computer: string | undefined, cols: number, rows: number) => {
    const wc = e.sender;
    const env = await loginEnv();
    const shell = readSettings(env).terminalCommand ?? 'exec "$SHELL" -l';
    const command = computer ? `exec ${env.BINDER_SSH || 'ssh'} -t ${shellQuote(computer)} ${shellQuote(`cd ${shellQuote(cwd)} && ${shell}`)}` : shell;
    return startPane({ name: `term:${id}`, command, ...(computer ? {} : { cwd }) }, env, cols, rows, (ev) => !wc.isDestroyed() && wc.send('pane', `term:${id}`, ev));
  });
  ipcMain.on('termStop', (_e, id: string) => stopPane(`term:${id}`));
  // The preview pane: its dev server in a pty, in the session's folder on this Mac.
  ipcMain.handle('previewCommand', async (_e, cwd: string) => previewCommand(cwd, readSettings(await loginEnv()).previewCommand));
  ipcMain.handle('previewServerStart', async (e, conn: string, cwd: string, command: string, cols: number, rows: number) => {
    const wc = e.sender;
    return startPane({ name: `preview:${conn}`, command, cwd }, await loginEnv(), cols, rows, (ev) => !wc.isDestroyed() && wc.send('pane', `preview:${conn}`, ev));
  });
  ipcMain.on('previewServerStop', (_e, conn: string) => stopPaneGroup(`preview:${conn}`));
  ipcMain.handle('previewOpen', (e, conn: string, url: string) => {
    const w = windowOf(e.sender);
    if (w) openPreview(w, conn, url);
  });
  ipcMain.on('previewLayout', (e, conn: string, box: Rect, show: boolean) => {
    const w = windowOf(e.sender);
    if (w) layoutPreview(w, conn, box, show);
  });
  ipcMain.on('previewReload', (_e, conn: string) => reloadPreview(conn));
  ipcMain.handle('previewCapture', (_e, conn: string) => capturePreview(conn));
  ipcMain.on('previewClose', (_e, conn: string) => closePreview(conn));
  ipcMain.handle('simDevices', () => simDevices());
  ipcMain.handle('simBoot', (_e, udid: string) => simBoot(udid));
  ipcMain.handle('simShot', (_e, udid: string, type: 'jpeg' | 'png') => simShot(udid, type === 'png' ? 'png' : 'jpeg'));
  ipcMain.on('simOpenApp', (_e, udid: string) => simOpenApp(udid));
  ipcMain.handle('paneStart', async (_e, name: string, cols: number, rows: number) => {
    const env = await loginEnv();
    const pane = readPanes(env).find((p): p is PaneConfig => p.name === name && 'command' in p);
    if (!pane) throw new Error(`config.json has no pane named ${name}`);
    return startPane(pane, env, cols, rows, (e) => win && !win.isDestroyed() && win.webContents.send('pane', name, e));
  });
  ipcMain.on('paneInput', (_e, name: string, data: string) => paneInput(name, data));
  ipcMain.on('paneResize', (_e, name: string, cols: number, rows: number) => resizePane(name, cols, rows));
  ipcMain.handle('webPaneStart', async (_e, name: string) => {
    const pane = readPanes(await loginEnv()).find((p): p is WebPaneConfig => p.name === name && 'url' in p);
    if (!pane) throw new Error(`config.json has no web pane named ${name}`);
    return startWebPane(win!, pane, askWindow, async () => readDefaultComputer(await loginEnv()));
  });
  ipcMain.on('webPaneLayout', (_e, name: string, box: Rect, show: boolean) => win && layoutWebPane(win, name, box, show));
  ipcMain.handle('webPaneLoad', (_e, name: string, url?: string) => loadWebPane(name, url));
  ipcMain.on('controlReply', (_e, id: number, reply: ControlReply) => {
    controls.get(id)?.(reply);
    controls.delete(id);
  });
  ipcMain.on('quit', () => app.quit());
  ipcMain.on('status', (e, s: { waiting: number; working: number }) => {
    statuses.set(e.sender.id, s);
    tally();
  });
  ipcMain.on('attention', () => {
    if (!BrowserWindow.getFocusedWindow()) app.dock?.bounce('informational');
  });
  // Held until clicked or closed: a notification nobody references may be
  // collected, and its click would then go nowhere.
  const notes = new Set<Notification>();
  ipcMain.on('notify', (_e, n: { title: string; body: string; conn: string }) => {
    if (!Notification.isSupported()) return;
    const note = new Notification({ title: n.title, body: n.body });
    notes.add(note);
    note.on('click', () => {
      notes.delete(note);
      // The window the session is in.
      const wc = owners.get(n.conn) ?? win?.webContents;
      const w = wc && !wc.isDestroyed() ? windowOf(wc) : null;
      if (!w || w.isDestroyed()) return;
      w.show();
      w.focus();
      w.webContents.send('notificationClick', n.conn);
    });
    note.on('close', () => notes.delete(note));
    note.on('failed', (_e, error) => {
      notes.delete(note);
      console.error(`Notification failed: ${error}`);
    });
    note.show();
  });
}

// The standard Mac menus plus Settings… and the guide, minus the shortcuts
// the window uses itself (Cmd+N, Cmd+T, Cmd+W, Cmd+K, Cmd+1-9 act on sessions).
function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        role: 'appMenu',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { id: 'settings', label: 'Settings…', accelerator: 'Cmd+,', click: () => win?.webContents.send('openSettings') },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
          { type: 'separator' },
          { role: 'reload' },
          { role: 'toggleDevTools' },
        ],
      },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
      { role: 'help', submenu: [{ id: 'guide', label: 'Binder Guide', accelerator: 'Cmd+/', click: () => win?.webContents.send('openGuide') }] },
    ]),
  );
}

type Bounds = { x?: number; y?: number; width: number; height: number };

/**
 * The main window, or (with `ref`) a window of its own for one session: the
 * same page, told which session by its URL's hash. Closing the main window
 * quits; closing a session's window lets its session go (its host keeps
 * running until idle).
 */
function createWindow(ref?: SessionRef): void {
  const main = !ref;
  const at = win && !win.isDestroyed() ? win.getBounds() : null;
  const bounds = main ? readJson<Bounds>('window.json', { width: 1280, height: 860 }) : { width: 980, height: 820, ...(at && { x: at.x + 60, y: at.y + 40 }) };
  const w = new BrowserWindow({
    ...bounds,
    minWidth: main ? 720 : 480,
    minHeight: 480,
    title: ref?.title ?? 'Binder',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 22 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  if (main) win = w;
  const wc = w.webContents;
  // Tests show the window without taking focus from whatever the user is doing.
  w.once('ready-to-show', () => (process.env.BINDER_GUI_BACKGROUND ? w.showInactive() : w.show()));
  if (main) {
    const saveBounds = () => {
      if (!w.isDestroyed() && !w.isFullScreen()) writeFileSync(userFile('window.json'), JSON.stringify(w.getBounds()));
    };
    w.on('resized', saveBounds);
    w.on('moved', saveBounds);
  }
  // Links open in the browser, never in the app's window.
  wc.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (url !== wc.getURL()) {
      e.preventDefault();
      openExternal(url);
    }
  });
  // Closing or quitting while turns run asks first: the turns keep going in
  // their hosts, which is easy to miss once the window is gone.
  if (main) {
    w.on('close', (e) => {
      if (quitting || !working) return;
      e.preventDefault();
      const n = working;
      void dialog
        .showMessageBox(w, {
          type: 'question',
          buttons: ['Quit', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          message: `${n} session${n === 1 ? ' is' : 's are'} still working`,
          detail: 'Claude keeps working in the background and finishes the turn. Open Binder again to see the result.',
        })
        .then(({ response }) => {
          if (response !== 0) return;
          quitting = true;
          app.quit();
        });
    });
  }
  const id = wc.id;
  w.on('closed', () => {
    closePreviews(w);
    statuses.delete(id);
    tally();
    // Its sessions' terminals end, as when a session closes in the window.
    for (const [conn, owner] of owners) if (owner === wc) stopPane(`term:${conn}`);
    dropAll(wc);
    if (!main) return;
    win = null;
    app.quit();
  });
  // A reload (View > Reload) or a crashed page starts the window over, and
  // it reattaches (from its saved layout, or its session): the old connections
  // must go, and the side pane's page, which the new page has not placed.
  const startOver = () => {
    dropAll(wc);
    if (main) hideSidePane();
  };
  wc.on('did-navigate', startOver);
  wc.on('render-process-gone', (_e, details) => {
    startOver();
    if (details.reason !== 'clean-exit' && !w.isDestroyed()) wc.reload();
  });
  const hash = ref ? `window=${encodeURIComponent(JSON.stringify(ref))}` : '';
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL + (hash ? `#${hash}` : ''));
  else void w.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : {});
}

// Tests run each app with its own settings folder.
if (process.env.BINDER_GUI_USER_DATA) app.setPath('userData', process.env.BINDER_GUI_USER_DATA);
// Set before binder() reads the environment, so the panes and session hosts
// the app starts inherit it.
const controlSocket = (process.env.BINDER_GUI_SOCKET = userFile('control.sock'));

app.whenReady().then(() => {
  listenControl(controlSocket, askWindow);
  registerIpc();
  buildMenu();
  // Read with the app's own environment, so the window opens in these colors
  // without waiting for the login shell.
  applyAppearance(readSettings(process.env));
  createWindow();
  // Find binder while the window loads.
  binder().catch(() => {});
  // Scheduled tasks run while the app is open: each minute, the ones due start (config.json schedules).
  const tickSchedules = () => void binder().then((b) => (readSettings(b.env).schedules ? scheduleCommand(b, ['tick']) : null)).catch(() => {});
  setTimeout(tickSchedules, 10_000);
  setInterval(tickSchedules, 60_000);
});

// Closing the main window quits (createWindow), and so does closing the last
// one. Session hosts keep running on their own and exit after 15 idle
// minutes, like ones a phone started.
app.on('window-all-closed', () => app.quit());
// Quitting waits for the panes' programs to end (one that ignores the hangup gets SIGTERM, then SIGKILL).
app.on('will-quit', (e) => {
  const ended = stopPanes();
  if (!ended) return;
  e.preventDefault();
  void ended.then(() => app.quit());
});
