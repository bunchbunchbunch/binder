import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { launch, ROOT, shot, SHOWCASE, type Launched } from './helpers';

// A pane runs a program from config.json beside the sessions, and the control
// socket lets that program open a session and something else close it again:
// the todo TUI's c and /done, in the app.

let run: Launched | null = null;
test.afterEach(async () => {
  await run?.close();
  run = null;
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
