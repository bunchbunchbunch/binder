import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, newSession, shot, SHOWCASE, type Launched } from './helpers';

// config.json stickyPrompt (on unless false): once sent, the tab's latest
// prompt stays under the tabs, and the transcript scrolls below it.

let run: Launched | null = null;
test.afterEach(async () => {
  await run?.close();
  run = null;
});

const LONG = 'Fix the table alignment so wide cells wrap instead of pushing the border out, and keep the header row in line with the body. '.repeat(4).trim();

function config(c: object): string {
  const path = join(mkdtempSync('/tmp/bgc-'), 'config.json');
  writeFileSync(path, JSON.stringify(c));
  return path;
}

async function start(env: Record<string, string> = {}): Promise<Launched> {
  const r = await launch(SHOWCASE, env);
  await r.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 640));
  await newSession(r.page, r.project);
  return r;
}

test('holds the prompt under the tabs from the moment it is sent; Home or a click shows a long one whole', async () => {
  run = await start();
  const { page } = run;
  await page.keyboard.type(LONG);
  await page.keyboard.press('Enter');
  const header = page.locator('.sticky-prompt');
  await expect(header.locator('.prompt')).toContainText('Fix the table alignment');
  await expect(page.locator('.transcript .prompt')).toHaveCount(0);
  const titlebar = await page.locator('.session:not([hidden]) .titlebar').boundingBox();
  const box = await header.boundingBox();
  expect(Math.abs(box!.y - (titlebar!.y + titlebar!.height))).toBeLessThan(2);

  await expect(page.locator('.turn-note')).toContainText('48.2s', { timeout: 20000 });
  await expect(header).toBeVisible();
  await expect(header.locator('.sticky-more')).toHaveText(/^\+\d+ lines?$/);
  const lines = () => header.locator('.clamp').evaluate((el) => Math.round(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight)));
  expect(await lines()).toBe(3);
  await page.screenshot({ path: shot('sticky-prompt') });

  const scroller = page.locator('.session:not([hidden]) .scroller');
  await page.keyboard.press('Home');
  await expect(header).toHaveClass(/full/);
  await expect(header.locator('.sticky-more')).toHaveCount(0);
  expect(await lines()).toBeGreaterThan(3);
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0);

  // The next scroll folds it back to three lines.
  await scroller.hover();
  await page.mouse.wheel(0, 200);
  await expect(header).not.toHaveClass(/full/);
  expect(await lines()).toBe(3);

  await header.click();
  await expect(header).toHaveClass(/full/);
  await header.click();
  await expect(header).not.toHaveClass(/full/);
});

test('in a tab with a follow-up, keeps the latest prompt while you read the first turn (in dark mode)', async () => {
  run = await start();
  const { app, page } = run;
  await app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = 'dark';
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.keyboard.type('Fix the table alignment');
  await page.keyboard.press('Enter');
  await expect(page.locator('.turn-note')).toContainText('48.2s', { timeout: 20000 });
  await page.keyboard.type('Summarize it. ' + 'Say what changed for emoji and CJK text, and what still lines up wrong. '.repeat(24));
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('.turn')).toHaveCount(2, { timeout: 20000 });
  await expect(page.locator('.turn').last().locator('.md strong')).toHaveText('display width', { timeout: 20000 });

  const header = page.locator('.sticky-prompt .prompt');
  await expect(header).toContainText('Summarize it.');
  // The first turn keeps its prompt in the transcript; the latest is only in the header.
  await expect(page.locator('.transcript .prompt')).toHaveText('Fix the table alignment');
  await page.screenshot({ path: shot('sticky-prompt-dark') });

  const scroller = page.locator('.session:not([hidden]) .scroller');
  await scroller.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(page.locator('.transcript .prompt')).toBeInViewport();
  await expect(header).toContainText('Summarize it.');
});

test('is off with "stickyPrompt": false in config.json', async () => {
  run = await start({ BINDER_CONFIG: config({ stickyPrompt: false }) });
  const { page } = run;
  await page.keyboard.type(LONG);
  await page.keyboard.press('Enter');
  await expect(page.locator('.turn-note')).toContainText('48.2s', { timeout: 20000 });
  expect(await page.locator('.session:not([hidden]) .scroller').evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(page.locator('.transcript .prompt')).toContainText('Fix the table alignment');
  await expect(page.locator('.sticky-prompt')).toHaveCount(0);
});
