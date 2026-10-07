import { test, expect } from '@playwright/test';
import { chmodSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, newSession, shot, SHOWCASE, tuiFixture, type Launched } from './helpers';

// Screenshots of states the other tests do not picture, for design reviews:
// REVIEW_SHOTS=1 npx playwright test gallery (files land in e2e/screenshots/gallery-*.png).
test.skip(!process.env.REVIEW_SHOTS, 'set REVIEW_SHOTS=1 to capture the gallery');

let run: Launched | null = null;
test.afterEach(async () => {
  await run?.close();
  run = null;
});

const g = (name: string) => shot(`gallery-${name}`);

// Claude Code transcripts for the sidebar's recent list, newest first.
function transcripts(tmp: string, project: string) {
  const rows: [string, string, string][] = [
    [project, 'Fix the flaky upload test on CI', 'main'],
    [project, 'Why does the settings page re-render on every keystroke? It feels slow on older laptops', 'perf/settings'],
    ['/Users/me/code/site', 'Write release notes for 2.4', 'main'],
    ['/Users/me/code/site', 'Add dark mode to the marketing pages', 'dark-mode'],
    ['/Users/me/notes', 'Summarize this week’s meeting notes', ''],
    ['/Users/me/code/api', 'Migrate the users table to UUID keys', 'uuid-keys'],
  ];
  rows.forEach(([cwd, prompt, branch], i) => {
    const dir = join(tmp, 'claude', 'projects', cwd.replace(/\//g, '-'));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `00000000-0000-4000-8000-00000000000${i}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: 'user', cwd, gitBranch: branch || undefined, entrypoint: 'cli', message: { content: prompt } }) + '\n');
    const t = new Date(Date.now() - (i * 7 + 2) * 3600_000);
    utimesSync(file, t, t);
  });
}

test('sidebar with recent sessions, and the switcher and new-session panels', async () => {
  run = await launch(SHOWCASE);
  transcripts(run.tmp, run.project);
  const { page } = run;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.session-row')).toHaveCount(6, { timeout: 15000 });
  await page.screenshot({ path: g('empty-with-recent') });
  await page.keyboard.press('Meta+k');
  await expect(page.locator('.picker-item')).toHaveCount(6);
  await page.screenshot({ path: g('switcher') });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+n');
  await expect(page.locator('.picker-item').first()).toBeVisible();
  await page.screenshot({ path: g('new-session') });
  await page.keyboard.press('Escape');
  // A session whose folder is gone fails to open.
  await page.locator('.session-row', { hasText: 'Migrate the users table' }).click();
  await expect(page.locator('.banner')).toContainText('Could not open', { timeout: 15000 });
  await page.screenshot({ path: g('failed-open') });
});

test('narrow window, streaming, and many tabs', async () => {
  run = await launch(SHOWCASE, { BINDER_FAKE_DELAY_MS: '30' });
  const { app, page, project } = run;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 680));
  await newSession(page, project);
  await page.keyboard.type('Fix the table alignment');
  await page.keyboard.press('Enter');
  await expect(page.locator('.work .tool').first()).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: g('narrow-streaming') });
  await expect(page.locator('.turn-note')).toContainText('48.2s', { timeout: 30000 });
  await page.screenshot({ path: g('narrow-done') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860));
  for (let i = 2; i <= 12; i++) {
    await page.keyboard.type(`!echo tab ${i}: checking the deploy script for region ${i}`);
    await page.keyboard.press('Enter');
  }
  await expect(page.locator('.tab')).toHaveCount(12, { timeout: 15000 });
  await page.keyboard.press('Control+p');
  await page.screenshot({ path: g('many-tabs') });
  await page.keyboard.type('/');
  await page.screenshot({ path: g('slash-menu') });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+u');
  await page.keyboard.type('/help');
  await page.keyboard.press('Enter');
  await expect(page.locator('.help')).toBeVisible();
  await page.screenshot({ path: g('help') });
  await page.keyboard.press('Escape');
  await page.keyboard.press('?');
  await page.screenshot({ path: g('shortcuts') });
});

test('a permission prompt', async () => {
  run = await launch(tuiFixture('permission-safety-check.jsonl'), { BINDER_FAKE_DELAY_MS: '2' });
  const { page, project } = run;
  await newSession(page, project);
  await page.keyboard.type('clean up the test log');
  await page.keyboard.press('Enter');
  await expect(page.locator('.question')).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: g('permission') });
});

test('claude exiting at start', async () => {
  run = await launch(SHOWCASE);
  const { page, project, tmp } = run;
  // A claude that fails at once, as with a broken install or bad flags.
  const bad = join(tmp, 'bad-claude.sh');
  writeFileSync(bad, '#!/bin/sh\necho "error: unknown option --bogus" >&2\nexit 2\n');
  chmodSync(bad, 0o755);
  await run.close();
  run = await launch(SHOWCASE, { BINDER_CLAUDE_BIN: bad }, { reuse: tmp });
  await newSession(run.page, project);
  await expect(run.page.locator('.banner')).toContainText('claude exited', { timeout: 15000 });
  await run.page.screenshot({ path: g('child-exit') });
  void page;
});
