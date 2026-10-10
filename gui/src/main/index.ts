import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ControlReply, ControlRequest, OpenRequest, PaneInfo, Rect, SavedLayout, Settings, SettingsPatch, SidebarScriptInput } from '../shared/api';
import type { HostMessage } from '../shared/wire';
import { binder, ensureHost, listSessions, readPanes, readSettings, repoInfo, runSidebarScript, writeSettings, type PaneConfig, type WebPaneConfig } from './binder';
import { listenControl } from './control';
import { HostConnection } from './hostConnection';
import { paneInput, resizePane, startPane, stopPanes } from './panes';
import { layoutWebPane, loadWebPane, startWebPane } from './webPanes';

// The app's main process: one window, one socket connection per session the
// window shows, the panes' programs and pages, and the control socket.
// Everything about a session lives in its binder host.

let win: BrowserWindow | null = null;
// The window's connections; null while one is still opening (its host starting).
const conns = new Map<string, HostConnection | null>();
// Sessions with a turn running or queued, as the window last reported.
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
  if (win && !win.isDestroyed()) win.webContents.send('host', conn, msg);
}

async function open(conn: string, req: OpenRequest): Promise<void> {
  conns.set(conn, null);
  // The window let it go (⌘W) while its host was starting.
  const dropped = () => !conns.has(conn);
  try {
    const b = await binder();
    const sessionId = req.sessionId ?? randomUUID();
    const path = await ensureHost(b, req.cwd, sessionId, Boolean(req.sessionId && req.resume), req.args);
    if (dropped()) return;
    const hc = new HostConnection(
      path,
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

function dropAll(): void {
  for (const hc of conns.values()) hc?.close();
  conns.clear();
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
  ipcMain.handle('listSessions', async () => listSessions(await binder()));
  ipcMain.handle('open', (_e, conn: string, req: OpenRequest) => open(conn, req));
  ipcMain.handle('request', (_e, conn: string, t: string, fields?: Record<string, unknown>) => {
    const hc = conns.get(conn);
    if (!hc) throw new Error('That session is not open');
    return hc.request(t, fields);
  });
  ipcMain.handle('close', (_e, conn: string) => {
    conns.get(conn)?.close();
    conns.delete(conn);
  });
  ipcMain.handle('repoInfo', (_e, cwd: string) => repoInfo(cwd));
  ipcMain.handle('sidebarScript', async (_e, input: SidebarScriptInput) => runSidebarScript(await loginEnv(), input));
  ipcMain.handle('isDirectory', (_e, path: string) => {
    const p = resolve(path.replace(/^~(?=$|\/)/, homedir()));
    return existsSync(p) && statSync(p).isDirectory();
  });
  ipcMain.handle('chooseFolder', async (_e, opts?: { buttonLabel?: string; hidden?: boolean }) => {
    const r = await dialog.showOpenDialog(win!, {
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
  ipcMain.handle('loadLayout', () => readJson<SavedLayout>('layout.json', { open: [], active: null }));
  ipcMain.handle('saveLayout', (_e, layout: SavedLayout) => writeFileSync(userFile('layout.json'), JSON.stringify(layout)));
  ipcMain.handle('loadSettings', async () => readSettings(await binder().then((b) => b.env, () => process.env)));
  ipcMain.handle('saveSettings', async (_e, patch: SettingsPatch) => {
    const s = writeSettings(await binder().then((b) => b.env, () => process.env), patch);
    applyAppearance(s);
    return s;
  });
  ipcMain.handle('panes', async () => readPanes(await loginEnv()).map((p): PaneInfo => ({ name: p.name, web: 'url' in p })));
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
    return startWebPane(win!, pane, askWindow);
  });
  ipcMain.on('webPaneLayout', (_e, name: string, box: Rect, show: boolean) => win && layoutWebPane(win, name, box, show));
  ipcMain.handle('webPaneLoad', (_e, name: string, url?: string) => loadWebPane(name, url));
  ipcMain.on('controlReply', (_e, id: number, reply: ControlReply) => {
    controls.get(id)?.(reply);
    controls.delete(id);
  });
  ipcMain.on('quit', () => app.quit());
  ipcMain.on('status', (_e, s: { waiting: number; working: number }) => {
    working = s.working;
    app.dock?.setBadge(s.waiting ? String(s.waiting) : '');
  });
  ipcMain.on('attention', () => {
    if (win && !win.isFocused()) app.dock?.bounce('informational');
  });
}

// The standard Mac menus plus Settings… and the guide, minus the shortcuts
// the window uses itself (Cmd+N, Cmd+W, Cmd+K, Cmd+1-9 act on sessions).
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

function createWindow(): void {
  const bounds = readJson<Bounds>('window.json', { width: 1280, height: 860 });
  win = new BrowserWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 480,
    title: 'Binder',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
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
  // Tests show the window without taking focus from whatever the user is doing.
  win.once('ready-to-show', () => (process.env.BINDER_GUI_BACKGROUND ? win?.showInactive() : win?.show()));
  const saveBounds = () => {
    if (win && !win.isDestroyed() && !win.isFullScreen()) writeFileSync(userFile('window.json'), JSON.stringify(win.getBounds()));
  };
  win.on('resized', saveBounds);
  win.on('moved', saveBounds);
  // Links open in the browser, never in the app's window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault();
      openExternal(url);
    }
  });
  // Closing or quitting while turns run asks first: the turns keep going in
  // their hosts, which is easy to miss once the window is gone.
  win.on('close', (e) => {
    if (quitting || !working) return;
    e.preventDefault();
    const n = working;
    void dialog
      .showMessageBox(win!, {
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
  win.on('closed', () => {
    win = null;
    dropAll();
  });
  // A reload (View > Reload) or a crashed page starts the window over, and
  // it reattaches from its saved layout: the old connections must go.
  win.webContents.on('did-navigate', dropAll);
  win.webContents.on('render-process-gone', (_e, details) => {
    dropAll();
    if (details.reason !== 'clean-exit') win?.webContents.reload();
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
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
});

// One window: closing it quits. Session hosts keep running on their own and
// exit after 15 idle minutes, like ones a phone started.
app.on('window-all-closed', () => app.quit());
app.on('will-quit', stopPanes);
