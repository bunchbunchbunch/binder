import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { launch, newSession, ROOT, shot, SHOWCASE, type Launched } from './helpers';

// Sessions on another computer (config.json's computers) beside this Mac's,
// over e2e/fixtures/fake-ssh: it runs that computer's `binder start`,
// `binder attach` and `binder sessions` here, with that computer's own state.

let run: Launched | null = null;
let remote: string | null = null;
test.afterEach(async () => {
  await run?.close();
  run = null;
  // The other computer's hosts.
  const sock = remote && join(remote, 'mini/s/sock');
  if (sock && existsSync(sock)) {
    for (const f of readdirSync(sock).filter((n) => n.endsWith('.pid'))) {
      try {
        process.kill(Number(readFileSync(join(sock, f), 'utf8')), 'SIGTERM');
      } catch {
        // gone already
      }
    }
  }
  remote = null;
});

function computers(dir: string, names: string[], defaultComputer?: string) {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ computers: names, ...(defaultComputer && { defaultComputer }) }));
  remote = join(dir, 'remote');
  // Hosts outlive the relaunch below: the other computer is a login shell away.
  return { BINDER_CONFIG: join(dir, 'config.json'), BINDER_SSH: join(ROOT, 'e2e/fixtures/fake-ssh'), FAKE_SSH_ROOT: remote, BINDER_HOST_IDLE_MS: '60000' };
}

const sockets = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sock')) : []);

test("runs a session on another computer beside this Mac's, labeled, and brings both back after a relaunch", async () => {
  const dir = mkdtempSync('/tmp/bgr-');
  const env = computers(dir, ['mini']);
  run = await launch(SHOWCASE, env);
  const { page, project } = run;

  // ⌘N offers the typed folder on each computer that has it.
  await page.keyboard.press('Meta+n');
  await page.locator('.picker-search').fill(project);
  await expect(page.locator('.picker-item .label', { hasText: 'Start in' })).toHaveText([`Start in ${project}`, `Start in ${project} on mini`], { timeout: 20000 });
  await page.locator('.picker-item', { hasText: `Start in ${project} on mini` }).click();
  await page.locator('.session:not([hidden]) .composer textarea').waitFor({ state: 'visible', timeout: 30000 });
  await page.keyboard.type('Fix the table alignment');
  await page.keyboard.press('Enter');
  await expect(page.locator('.md h1')).toHaveText('Table rendering', { timeout: 20000 });
  await expect(page.locator('.session-row.active .computer')).toHaveText('mini');
  // Its host runs there, not here.
  expect(sockets(join(remote!, 'mini/s/sock'))).toHaveLength(1);
  expect(sockets(join(run.tmp, 's/sock'))).toHaveLength(0);

  // One here too: unlabeled.
  await newSession(page, project);
  await page.keyboard.type('Summarize it');
  await page.keyboard.press('Enter');
  await expect(page.locator('.session:not([hidden]) .md h1')).toHaveText('Table rendering', { timeout: 20000 });
  await expect(page.locator('.session-row.active .computer')).toHaveCount(0);
  expect(sockets(join(run.tmp, 's/sock'))).toHaveLength(1);
  await page.screenshot({ path: shot('computers') });

  await run.quitApp();
  const tmp = run.tmp;
  run = await launch(SHOWCASE, env, { reuse: tmp });
  const back = run.page;
  const miniRow = back.locator('.session-row', { hasText: 'Fix the table alignment' });
  await expect(miniRow.locator('.computer')).toHaveText('mini', { timeout: 20000 });
  await expect(back.locator('.session-row.active .title')).toHaveText(/Summarize it$/, { timeout: 20000 });

  // ⌘W lets the mini's session go, and ⌘K finds it by the computer's name.
  await miniRow.click();
  await expect(back.locator('.session:not([hidden]) .md h1')).toHaveText('Table rendering');
  await back.keyboard.press('Meta+w');
  await expect(miniRow).toHaveCount(0);
  await back.keyboard.press('Meta+k');
  await back.locator('.picker-search').fill('mini');
  await expect(back.locator('.picker-item.picked .label')).toHaveText('Fix the table alignment');
  await expect(back.locator('.picker-item.picked .desc')).toContainText('mini · live');
  await back.keyboard.press('Enter');
  await expect(back.locator('.session:not([hidden]) .md h1')).toHaveText('Table rendering', { timeout: 20000 });
  await expect(back.locator('.session-row.active .computer')).toHaveText('mini');
});

/** One request on the app's control socket (BINDER_GUI_SOCKET); resolves with its reply. */
function control(tmp: string, req: object): Promise<Record<string, unknown>> {
  return new Promise((done, fail) => {
    const s = connect(join(tmp, 'gui', 'control.sock'));
    let out = '';
    s.on('data', (d) => (out += d));
    s.on('end', () => done(JSON.parse(out)));
    s.on('error', fail);
    s.write(JSON.stringify(req) + '\n');
  });
}

test('with defaultComputer, ⌘N and the control socket start new sessions there', async () => {
  const dir = mkdtempSync('/tmp/bgr-');
  run = await launch(SHOWCASE, computers(dir, ['mini'], 'mini'));
  const { page, project } = run;

  // The default computer's row comes first, so Enter starts there.
  await page.keyboard.press('Meta+n');
  await page.locator('.picker-search').fill(project);
  await expect(page.locator('.picker-item .label', { hasText: 'Start in' })).toHaveText([`Start in ${project} on mini`, `Start in ${project}`], { timeout: 20000 });
  await page.keyboard.press('Enter');
  await page.locator('.session:not([hidden]) .composer textarea').waitFor({ state: 'visible', timeout: 30000 });
  await expect(page.locator('.session-row.active .computer')).toHaveText('mini');
  expect(sockets(join(remote!, 'mini/s/sock'))).toHaveLength(1);

  // A session the control socket names that the window does not know (a todo's) starts there too.
  expect(await control(run.tmp, { t: 'open', cwd: project, sessionId: randomUUID(), draft: 'From a todo' })).toEqual({ ok: true });
  await expect(page.locator('.session-row.active .computer')).toHaveText('mini', { timeout: 30000 });
  await expect(page.locator('.session:not([hidden]) .composer textarea')).toHaveValue('From a todo', { timeout: 30000 });
  await expect.poll(() => sockets(join(remote!, 'mini/s/sock')).length, { timeout: 20000 }).toBe(2);
  expect(sockets(join(run.tmp, 's/sock'))).toHaveLength(0);
});

test("a computer that cannot be reached says why, and this Mac's sessions still list", async () => {
  const dir = mkdtempSync('/tmp/bgr-');
  run = await launch(SHOWCASE, computers(dir, ['offline']));
  const { page, project } = run;
  await newSession(page, project);
  await page.keyboard.type('Fix the table alignment');
  await page.keyboard.press('Enter');
  await expect(page.locator('.md h1')).toHaveText('Table rendering', { timeout: 20000 });
  await page.keyboard.press('Meta+w');
  await page.keyboard.press('Meta+k');
  await expect(page.locator('.picker-item', { hasText: 'Fix the table alignment' })).toBeVisible();
  await expect(page.locator('.picker')).toContainText('offline: ssh: connect to host offline port 22: Operation timed out');
});
