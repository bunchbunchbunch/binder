import { test, expect } from '@playwright/test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { launch, newSession, SHOWCASE, tuiFixture, type Launched } from './helpers';

// Regressions from the design review: connections the app lets go, keys under
// panels and questions, scrolling, attachments, images, and starting hosts.

let run: Launched | null = null;
test.afterEach(async () => {
  await run?.close();
  run = null;
});

// The session hosts serving sockets right now. A host with no viewer exits
// after BINDER_HOST_IDLE_MS (3 s in these tests), so a connection the app
// leaked shows up as a host that never goes away.
const sockets = (tmp: string) => {
  const dir = join(tmp, 's', 'sock');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sock')) : [];
};

test('⌘W while a session starts lets its host go idle', async () => {
  run = await launch(SHOWCASE);
  const { page, project, tmp } = run;
  await page.keyboard.press('Meta+n');
  await page.locator('.picker-search').fill(project);
  await page.locator('.picker-item', { hasText: `Start in ${project}` }).waitFor();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Meta+w');
  await expect.poll(() => sockets(tmp).length, { message: 'the host starts' }).toBe(1);
  await expect.poll(() => sockets(tmp).length, { message: 'and exits once idle', timeout: 15000 }).toBe(0);
});

test('a reload lets go of the connections from before it', async () => {
  run = await launch(SHOWCASE);
  const { page, project, tmp } = run;
  await newSession(page, project);
  await page.reload();
  await expect(page.locator('.session:not([hidden]) .composer textarea')).toBeVisible({ timeout: 20000 });
  await page.keyboard.press('Meta+w');
  await expect(page.locator('.empty-main')).toBeVisible();
  await expect.poll(() => sockets(tmp).length, { message: 'no viewer is left to keep the host', timeout: 15000 }).toBe(0);
});

test('a question that arrives under an open picker leaves it the keyboard', async () => {
  run = await launch(tuiFixture('ask-and-interrupt.jsonl'), { BINDER_FAKE_DELAY_MS: '40' });
  const { page, project } = run;
  await newSession(page, project);
  await page.keyboard.type('ask me a color');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Meta+k');
  await expect(page.locator('.session-row .sub', { hasText: 'waiting for you' })).toBeVisible({ timeout: 20000 });
  await page.keyboard.type('xyz');
  await expect(page.locator('.picker-search')).toHaveValue('xyz');
  await page.keyboard.press('Escape');
  await expect(page.locator('.picker')).toHaveCount(0);
  await page.keyboard.press('2');
  await expect(page.locator('.question')).toHaveCount(0);
});

test('scrolling up a little while a turn streams stops following it', async () => {
  run = await launch(tuiFixture('long-turn.jsonl'), { BINDER_FAKE_DELAY_MS: '3' });
  const { page, project } = run;
  await newSession(page, project);
  await page.keyboard.type('go');
  await page.keyboard.press('Enter');
  const scroller = page.locator('.session:not([hidden]) .scroller');
  await expect(page.locator('.work .tool').nth(8)).toBeVisible({ timeout: 20000 });
  await scroller.hover();
  await page.mouse.wheel(0, -60);
  await page.waitForTimeout(800);
  const gap = await scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  expect(gap).toBeGreaterThan(30);
  // Back at the bottom (End), it follows again.
  await page.keyboard.press('End');
  await page.waitForTimeout(500);
  expect(await scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(4);
});

test('two images pasted at once each get their own label', async () => {
  run = await launch(SHOWCASE);
  const { page, project } = run;
  await newSession(page, project);
  const box = page.locator('.composer textarea');
  await box.evaluate((el) => {
    // A 1x1 PNG.
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([png], 'a.png', { type: 'image/png' }));
    data.items.add(new File([png], 'b.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(box).toHaveValue('[Image #1][Image #2]');
  await expect(page.locator('.attachment')).toHaveCount(2);
});

test('an image in a response is a link and is never fetched', async () => {
  run = await launch(SHOWCASE);
  const { page, project } = run;
  const fetched: string[] = [];
  page.on('request', (r) => fetched.push(r.url()));
  await newSession(page, project);
  await page.keyboard.type('Fix the table alignment');
  await page.keyboard.press('Enter');
  await expect(page.locator('.turn-note')).toContainText('48.2s', { timeout: 20000 });
  await expect(page.locator('.md img')).toHaveCount(0);
  await expect(page.locator('.md .md-image')).toHaveText('Image: Alignment before and after (example.com)');
  expect(fetched.filter((u) => u.includes('example.com'))).toEqual([]);
});

test('a session that never got a prompt starts again under its id instead of resuming', async () => {
  const out = join(mkdtempSync('/tmp/bga-'), 'args.json');
  run = await launch(SHOWCASE, { BINDER_FAKE_ARGS_OUT: out });
  const { page, project, tmp } = run;
  await newSession(page, project);
  await expect.poll(() => existsSync(out)).toBe(true);
  // Quit, and stop its host too: the next launch must start one.
  await run.close();
  rmSync(out);
  run = await launch(SHOWCASE, { BINDER_FAKE_ARGS_OUT: out }, { reuse: tmp });
  await expect(run.page.locator('.session:not([hidden]) .composer textarea')).toBeVisible({ timeout: 20000 });
  await expect.poll(() => existsSync(out)).toBe(true);
  const args = JSON.parse(readFileSync(out, 'utf8')) as string[];
  expect(args).toContain('--session-id');
  expect(args).not.toContain('--resume');
});

test('a host that cannot start says so at once', async () => {
  run = await launch(SHOWCASE, { BINDER_BIN: '/nonexistent/binder.mjs' });
  const { page, project } = run;
  await page.keyboard.press('Meta+n');
  await page.locator('.picker-search').fill(project);
  await page.locator('.picker-item', { hasText: `Start in ${project}` }).waitFor();
  await page.keyboard.press('Enter');
  await expect(page.locator('.banner')).toContainText('binder host exited', { timeout: 8000 });
});
