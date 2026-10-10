import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { BinderPane } from '../src/shared/api';
import { launch, ROOT, shot, SHOWCASE, type Launched } from './helpers';

// A pane runs a program from config.json beside the sessions, and the control
// socket lets that program open a session and something else close it again:
// the todo TUI's c and /done, in the app.

let run: Launched | null = null;
let server: Server | null = null;
test.afterEach(async () => {
  await run?.close();
  run = null;
  server?.closeAllConnections();
  server?.close();
  server = null;
});

/** One request on the app's control socket, sent and then half-closed as `nc -U` does; resolves with the reply. */
function control(path: string, req: unknown): Promise<Record<string, unknown>> {
  return new Promise((done, fail) => {
    const s = connect(path);
    s.on('error', fail);
    createInterface({ input: s }).once('line', (line) => done(JSON.parse(line)));
    s.end((typeof req === 'string' ? req : JSON.stringify(req)) + '\n');
  });
}

test('a pane opens a session through the control socket, and closing it shows the pane again', async () => {
  const dir = mkdtempSync('/tmp/bgp-');
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ panes: [{ name: 'Todos', command: `node ${join(ROOT, 'e2e/fixtures/pane.mjs')}`, cwd: dir }] }));
  const argsOut = join(dir, 'claude-args.json');
  // Hosts outlive a quick relaunch below.
  const env = { BINDER_CONFIG: config, BINDER_FAKE_ARGS_OUT: argsOut, BINDER_HOST_IDLE_MS: '60000' };
  run = await launch(SHOWCASE, env);
  const { page, tmp } = run;
  const socket = join(tmp, 'gui', 'control.sock');

  // With no session open, the pane is on screen, and its program runs in a
  // terminal of the pane's size, in the pane's folder, with the socket.
  const row = page.locator('.session-row', { hasText: 'Todos' });
  await expect(row).toHaveClass(/active/);
  await expect(row.locator('.num')).toHaveText('⌘1');
  const screen = page.locator('.pane:not(.off) .xterm-rows');
  await expect(screen).toContainText('in Binder with socket set');
  await expect(screen).not.toContainText('80x24');
  await page.screenshot({ path: shot('pane') });

  // c in the program opens a session with its draft in the prompt, and the claude flags it sent.
  await page.keyboard.press('c');
  await expect(screen).toHaveCount(0);
  const box = page.locator('.session:not([hidden]) .composer textarea');
  await expect(box).toHaveValue('Write the report', { timeout: 30000 });
  await expect(box).toBeFocused();
  await expect(page.locator('.session-row.active .num')).toHaveText('⌘2');
  expect(JSON.parse(readFileSync(argsOut, 'utf8'))).toEqual(expect.arrayContaining(['-n', 'Write the report']));

  // ⌘1 and ⌘2 move between the pane and the session, and keys reach whichever is on screen.
  await page.keyboard.press('Meta+1');
  await expect(page.locator('.pane:not(.off)')).toHaveCount(1);
  await page.keyboard.press('x');
  await expect(page.locator('.pane .xterm-rows')).toContainText('key "x"');
  await page.keyboard.press('Meta+2');
  await expect(box).toBeFocused();
  const line = ((await page.locator('.pane .xterm-rows').textContent()) ?? '').replace(/\u00a0/g, ' ');
  const sessionId = /opened (\S+) \{"ok":true\}/.exec(line)?.[1];
  expect(sessionId).toBeTruthy();

  // The session's host, and so its claude, can find the socket.
  const pid = readFileSync(join(tmp, 's', 'sock', `${sessionId}.pid`), 'utf8').trim();
  expect(execFileSync('ps', ['-E', '-ww', '-o', 'command=', '-p', pid], { encoding: 'utf8' })).toContain(`BINDER_GUI_SOCKET=${socket}`);

  // Closing the session on screen shows the pane named in the request.
  expect(await control(socket, { t: 'close', sessionId, show: 'Todos' })).toEqual({ ok: true, closed: true });
  await expect(page.locator('.pane:not(.off)')).toHaveCount(1);
  await expect(page.locator('.sidebar-section', { hasText: 'Open' })).toHaveCount(0);
  expect(await control(socket, { t: 'close', sessionId })).toEqual({ ok: true, closed: false });
  expect(await control(socket, 'nonsense')).toEqual({ ok: false, error: 'Not JSON' });
  expect(await control(socket, { t: 'open' })).toEqual({ ok: false, error: 'open needs cwd' });

  // A program that exits starts again on Enter.
  await page.keyboard.press('q');
  await expect(screen).toContainText('[Todos exited with code 3 · Enter starts it again]');
  await page.keyboard.press('Enter');
  await expect(screen).toContainText('pane ready');
  await expect(screen).not.toContainText('exited');

  // The pane on screen at quit is on screen at the next launch, with the open session behind it.
  expect(await control(socket, { t: 'open', cwd: dir, sessionId: '00000000-0000-4000-8000-0000000000b2' })).toEqual({ ok: true });
  await expect(page.locator('.session:not([hidden]) .composer textarea')).toBeVisible({ timeout: 30000 });
  await page.keyboard.press('Meta+1');
  await expect(page.locator('.pane:not(.off)')).toHaveCount(1);
  await run.quitApp();
  run = await launch(SHOWCASE, env, { reuse: tmp });
  await expect(run.page.locator('.session-row', { hasText: 'Todos' })).toHaveClass(/active/);
  await expect(run.page.locator('.sidebar-section', { hasText: 'Open' })).toHaveCount(1);
  await expect(run.page.locator('.pane:not(.off) .xterm-rows')).toContainText('pane ready');
});

// A web pane's server, standing in for a todo app's web GUI. Each page shows
// its path and logs the keys it gets. /gated drops the connection, as a server
// does before you sign in, until a /login/<token> link has been opened.
const hits = new Map<string, number>();
function serve(): Promise<string> {
  let signedIn = false;
  hits.clear();
  server = createServer((req, res) => {
    hits.set(req.url!, (hits.get(req.url!) ?? 0) + 1);
    if (req.url?.startsWith('/login/')) {
      signedIn = true;
      return res.writeHead(302, { location: '/' }).end();
    }
    if (req.url === '/gated' && !signedIn) return req.socket.destroy();
    res.writeHead(200, { 'content-type': 'text/html' }).end(
      `<!doctype html><meta charset="utf-8"><h1>${req.url}</h1><input id="field"><pre id="keys"></pre>
<script>
  addEventListener('keydown', (e) => e.key !== 'Meta' && (keys.textContent += (e.metaKey ? 'Meta+' : '') + e.key + ' '));
  field.focus();
</script>`,
    );
  });
  return new Promise((done) => server!.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`)));
}

/** The page a web pane shows, once it has loaded `url`. */
async function paneAt(app: ElectronApplication, url: string): Promise<Page> {
  await expect.poll(() => app.windows().some((p) => p.url() === url)).toBe(true);
  return app.windows().find((p) => p.url() === url)!;
}

/**
 * Notes what is given the keyboard from now on. The tests run the window in
 * the background, where nothing reports focus (isFocused() is false
 * throughout), so this watches the app's WebContents.focus() calls instead.
 */
function watchKeyboard(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) => {
    const proto = Object.getPrototypeOf(BrowserWindow.getAllWindows()[0].webContents);
    const focus = proto.focus;
    proto.focus = function (this: unknown) {
      (globalThis as { keyboard?: unknown }).keyboard = this;
      return focus.call(this);
    };
  });
}

/** The view showing a page from `origin`, as the main process has it, and what was given the keyboard last: that page, or the window. */
function views(app: ElectronApplication, origin: string) {
  return app.evaluate(({ BrowserWindow, WebContentsView }, origin) => {
    const win = BrowserWindow.getAllWindows()[0];
    const view = win.contentView.children.find((v) => v instanceof WebContentsView && v.webContents.getURL().startsWith(origin)) as InstanceType<typeof WebContentsView> | undefined;
    const last = (globalThis as { keyboard?: unknown }).keyboard;
    return { visible: view?.getVisible(), bounds: view?.getBounds(), keyboard: last === win.webContents ? 'window' : view && last === view.webContents ? 'page' : null };
  }, origin);
}

/** A key pressed in the page from `origin` as a keyboard sends it (Playwright's key events skip before-input-event). */
function pressIn(app: ElectronApplication, origin: string, keyCode: string, modifiers: ('meta' | 'control' | 'shift')[] = []) {
  return app.evaluate(({ BrowserWindow, WebContentsView }, { origin, keyCode, modifiers }) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children.find((v) => v instanceof WebContentsView && v.webContents.getURL().startsWith(origin)) as InstanceType<typeof WebContentsView>;
    for (const type of ['keyDown', 'keyUp'] as const) view.webContents.sendInputEvent({ type, keyCode, modifiers });
  }, { origin, keyCode, modifiers });
}

const rounded = (b: { x: number; y: number; width: number; height: number } | null) => b && { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };

type PaneWindow = { binderPane: BinderPane };

test('a web pane shows its page with the keyboard, passes the window its ⌘ keys, and gives the page a narrow bridge', async () => {
  const origin = await serve();
  const dir = mkdtempSync('/tmp/bgw-');
  // The bridge only reaches folders in home, so the app gets one of its own.
  const home = join(dir, 'home');
  for (const sub of ['code/app', 'code/api', 'notes']) mkdirSync(join(home, sub), { recursive: true });
  const config = join(dir, 'config.json');
  const panes = [
    { name: 'Desk', url: `${origin}/desk` },
    { name: 'Todos', command: `node ${join(ROOT, 'e2e/fixtures/pane.mjs')}`, cwd: dir },
    { name: 'Hosts', url: 'file:///etc/hosts' },
  ];
  writeFileSync(config, JSON.stringify({ panes }));
  const argsOut = join(dir, 'claude-args.json');
  run = await launch(SHOWCASE, { BINDER_CONFIG: config, BINDER_FAKE_ARGS_OUT: argsOut, HOME: home });
  const { app, page, tmp } = run;
  await watchKeyboard(app);
  const desk = () => views(app, origin);

  // Web panes and terminal panes sit in the sidebar alike; a url that is not http(s) makes no pane.
  const row = page.locator('.session-row', { hasText: 'Desk' });
  await expect(row).toHaveClass(/active/);
  await expect(row.locator('.num')).toHaveText('⌘1');
  await expect(page.locator('.session-row', { hasText: 'Todos' }).locator('.num')).toHaveText('⌘2');
  await expect(page.locator('.session-row', { hasText: 'Hosts' })).toHaveCount(0);

  // The page loads in a view over the pane, under its title bar, and has the keyboard.
  const pane = await paneAt(app, `${origin}/desk`);
  await expect(pane.locator('h1')).toHaveText('/desk');
  const box = rounded(await page.locator('.pane:not(.off) .pane-web').boundingBox());
  expect(box!.y).toBeGreaterThan(0);
  await expect.poll(desk).toMatchObject({ visible: true, bounds: box });

  // Keys go to the page, ⌘ editing keys included; the window's ⌘ keys never reach it.
  await pane.keyboard.type('hi');
  for (const k of ['a', 'c', 'x', 'v', 'z']) await pressIn(app, origin, k, ['meta']);
  await expect(pane.locator('#keys')).toHaveText('h i Meta+a Meta+c Meta+x Meta+v Meta+z ');
  await pressIn(app, origin, '2', ['meta']);
  await expect(page.locator('.session-row', { hasText: 'Todos' })).toHaveClass(/active/);
  await expect.poll(desk).toMatchObject({ visible: false, keyboard: 'window' });
  await page.keyboard.press('Meta+1');
  await expect.poll(desk).toMatchObject({ visible: true, keyboard: 'page' });
  await expect(pane.locator('#field')).toBeFocused();

  // A panel over the pane hides the page and takes the keyboard; closing it gives both back.
  await pressIn(app, origin, 'k', ['meta']);
  await expect(page.locator('.picker-search')).toBeFocused();
  await expect.poll(desk).toMatchObject({ visible: false, keyboard: 'window' });
  await page.keyboard.press('Escape');
  await expect(page.locator('.picker')).toHaveCount(0);
  await expect.poll(desk).toMatchObject({ visible: true, keyboard: 'page' });
  await pressIn(app, origin, '/', ['meta']);
  await expect(page.locator('.overlay')).toHaveCount(1);
  await expect.poll(desk).toMatchObject({ visible: false });
  await page.keyboard.press('Escape');
  await expect.poll(desk).toMatchObject({ visible: true, keyboard: 'page' });
  expect(await pane.locator('#keys').textContent()).toBe('h i Meta+a Meta+c Meta+x Meta+v Meta+z ');

  // The page follows the pane's box when the sidebar hides (⌃⌘S) and comes back.
  await pressIn(app, origin, 's', ['control', 'meta']);
  await expect(page.locator('.sidebar')).toHaveCount(0);
  const wide = rounded(await page.locator('.pane:not(.off) .pane-web').boundingBox());
  expect(wide!.x).toBe(0);
  await expect.poll(desk).toMatchObject({ bounds: wide });
  await pressIn(app, origin, 's', ['control', 'meta']);
  await expect.poll(desk).toMatchObject({ bounds: box });

  // The page stays on its origin: a link elsewhere, or a new window, opens in the browser instead.
  await app.evaluate(({ shell }) => {
    const opened: string[] = ((globalThis as { opened?: string[] }).opened = []);
    shell.openExternal = async (url) => void opened.push(url);
  });
  const elsewhere = origin.replace('127.0.0.1', 'localhost');
  await pane.evaluate((url) => void (location.href = `${url}/away`), elsewhere);
  await pane.evaluate((url) => void window.open(`${url}/popup`), elsewhere);
  await expect.poll(() => app.evaluate(() => (globalThis as { opened?: string[] }).opened)).toEqual([`${elsewhere}/away`, `${elsewhere}/popup`]);
  expect(pane.url()).toBe(`${origin}/desk`);

  // The bridge: window.binderPane and nothing else, reaching only into home.
  expect(await pane.evaluate(() => [Object.keys((window as unknown as PaneWindow).binderPane), 'binder' in window])).toEqual([['home', 'open', 'completeFolder', 'missingFolder', 'makeFolder', 'onShow'], false]);
  expect(await pane.evaluate(() => (window as unknown as PaneWindow).binderPane.home())).toBe(home);
  expect(await pane.evaluate(() => (window as unknown as PaneWindow).binderPane.completeFolder('~/co'))).toEqual({ value: '~/code/', options: [] });
  expect(await pane.evaluate(() => (window as unknown as PaneWindow).binderPane.completeFolder('~/code/a'))).toEqual({ value: '~/code/ap', options: ['api', 'app'] });
  expect(await pane.evaluate((dir) => (window as unknown as PaneWindow).binderPane.completeFolder(`${dir}/`), dir)).toEqual({ value: `${dir}/`, options: [] });
  const fresh = await pane.evaluate(() => (window as unknown as PaneWindow).binderPane.missingFolder('~/code/new/'));
  expect(fresh).toBe(join(home, 'code/new'));
  await pane.evaluate((path) => (window as unknown as PaneWindow).binderPane.makeFolder(path), fresh!);
  expect(existsSync(join(home, 'code/new'))).toBe(true);
  await expect(pane.evaluate((dir) => (window as unknown as PaneWindow).binderPane.makeFolder(`${dir}/outside`), dir)).rejects.toThrow('outside your home folder');
  expect(existsSync(join(dir, 'outside'))).toBe(false);

  // open goes the control socket's way: a new session with its draft unsent and its name as -n.
  const sessionId = randomUUID();
  const open = (req: Parameters<BinderPane['open']>[0]) => pane.evaluate((req) => (window as unknown as PaneWindow).binderPane.open(req), req);
  await expect(open({ cwd: dir, sessionId })).rejects.toThrow('cwd must be inside your home folder');
  await expect(open({ cwd: join(home, 'code/app'), sessionId: 'not-a-uuid' })).rejects.toThrow('sessionId must be a UUID');
  await open({ cwd: `${home}/code/app/`, sessionId, draft: 'Write the report', name: 'Write the report' });
  const composer = page.locator('.session:not([hidden]) .composer textarea');
  await expect(composer).toHaveValue('Write the report', { timeout: 30000 });
  await expect(page.locator('.session-row.active .num')).toHaveText('⌘3');
  expect(JSON.parse(readFileSync(argsOut, 'utf8'))).toEqual(expect.arrayContaining(['-n', 'Write the report']));
  await expect.poll(desk).toMatchObject({ visible: false, keyboard: 'window' });

  // A hidden page hears nothing of it, so onShow tells it when it is back on screen.
  type Counted = PaneWindow & { shown: number };
  await pane.evaluate(() => {
    const w = window as unknown as Counted;
    w.shown = 0;
    w.binderPane.onShow(() => w.shown++);
  });

  // Asked again (resume), it switches to the session the app has open.
  await page.keyboard.press('Meta+1');
  await expect.poll(desk).toMatchObject({ visible: true, keyboard: 'page' });
  await expect.poll(() => pane.evaluate(() => (window as unknown as Counted).shown)).toBe(1);
  await open({ cwd: join(home, 'code/app'), sessionId, resume: true });
  await expect(page.locator('.session-row.active .num')).toHaveText('⌘3');
  await expect(page.locator('.session-row .num', { hasText: '⌘4' })).toHaveCount(0);

  // Closing it through the control socket shows the web pane named in `show`, with the keyboard.
  expect(await control(join(tmp, 'gui', 'control.sock'), { t: 'close', sessionId, show: 'Desk' })).toEqual({ ok: true, closed: true });
  await expect(row).toHaveClass(/active/);
  await expect.poll(desk).toMatchObject({ visible: true, keyboard: 'page' });
});

test('a web pane whose page does not load says why, and a sign-in link on its origin brings the page', async () => {
  const origin = await serve();
  const dir = mkdtempSync('/tmp/bgw-');
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ panes: [{ name: 'Gated', url: `${origin}/gated` }] }));
  run = await launch(SHOWCASE, { BINDER_CONFIG: config });
  const { app, page } = run;
  await watchKeyboard(app);

  // The server drops the connection: the view hides and the pane says why, with the link field focused.
  const banner = page.locator('.pane:not(.off) .banner');
  await expect(banner).toContainText(`The page did not load. ERR_EMPTY_RESPONSE (${origin}/gated)`);
  await expect.poll(() => views(app, origin)).toMatchObject({ visible: false });
  const field = page.locator('.pane:not(.off) .pane-link');
  await expect(field).toBeFocused();

  // Enter tries again; it still fails.
  const tries = hits.get('/gated')!;
  await page.keyboard.press('Enter');
  await expect.poll(() => hits.get('/gated')).toBe(tries + 1);
  await expect(banner.locator('.turn-note')).toContainText('tries again');
  await expect(banner).toContainText('ERR_EMPTY_RESPONSE');

  // Only a link on the page's origin opens in the pane.
  const elsewhere = origin.replace('127.0.0.1', 'localhost');
  await field.fill(`${elsewhere}/login/secret`);
  await page.keyboard.press('Enter');
  await expect(banner.locator('.turn-note')).toHaveText(`Only links on ${origin} open in this pane`);
  await expect(field).toHaveValue('');

  // A sign-in link opens there, and then the page loads.
  await field.fill(`${origin}/login/secret`);
  await page.keyboard.press('Enter');
  await expect(banner).toHaveCount(0);
  const pane = await paneAt(app, `${origin}/gated`);
  await expect(pane.locator('h1')).toHaveText('/gated');
  await expect.poll(() => views(app, origin)).toMatchObject({ visible: true, keyboard: 'page' });
});
