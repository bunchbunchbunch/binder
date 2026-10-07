import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, newSession, shot, SHOWCASE, type Launched } from './helpers';

// config.json's sidebar: templates for an open session's row, and a script
// for their {script} field.

let run: Launched | null = null;
test.afterEach(async () => {
  await run?.close();
  run = null;
});

test("an open session's row follows config.json's sidebar templates and script", async () => {
  const config = join(mkdtempSync('/tmp/bgc-'), 'config.json');
  const sidebar = { title: '{status} {elapsed} ([{modelLetter}]) {script|folder}', subtitle: '{folder}( · {branch})', script: 'cat summary.txt 2>/dev/null' };
  writeFileSync(config, JSON.stringify({ sidebar }));
  // Slow enough to switch sessions while the turn runs.
  run = await launch(SHOWCASE, { BINDER_CONFIG: config, BINDER_FAKE_DELAY_MS: '150' });
  const { page, project, tmp } = run;
  execFileSync('git', ['init', '-q', '-b', 'sidebar-test'], { cwd: project });
  const row = page.locator('.session-row.active');

  // Before the first prompt: no status, time or summary yet.
  await newSession(page, project);
  await expect(row.locator('.title')).toHaveText('[O] app');
  await expect(row.locator('.sub')).toHaveText('app · sidebar-test');

  // The script's output arrives with the next change of state.
  writeFileSync(join(project, 'summary.txt'), 'Table alignment/app\n');
  await page.keyboard.type('Fix the table alignment');
  await page.keyboard.press('Enter');
  await expect(row.locator('.title')).toHaveText('⏳ 0m [O] Table alignment/app');

  // A turn that ends while you look at another session is ✅ until you look.
  const other = join(tmp, 'other');
  mkdirSync(other);
  await newSession(page, other);
  await expect(row.locator('.title')).toHaveText('[O] other');
  await expect(row.locator('.sub')).toHaveText('other');
  const first = page.locator('.session-row', { hasText: 'Table alignment/app' });
  await expect(first.locator('.title')).toHaveText('✅ 0m [O] Table alignment/app', { timeout: 30000 });
  await expect(first).toHaveAttribute('title', '✅ 0m [O] Table alignment/app\napp · sidebar-test');
  await page.locator('.sidebar').screenshot({ path: shot('sidebar-custom') });
  await first.click();
  await expect(first.locator('.title')).toHaveText('0m [O] Table alignment/app');
});

test('Settings edits the sidebar templates with a preview', async () => {
  const config = join(mkdtempSync('/tmp/bgc-'), 'config.json');
  writeFileSync(config, JSON.stringify({ mine: true }));
  const saved = () => JSON.parse(readFileSync(config, 'utf8'));
  run = await launch(SHOWCASE, { BINDER_CONFIG: config });
  const { page, project } = run;
  const picker = page.locator('.picker');
  const item = (label: string) => picker.locator('.picker-item', { hasText: label });
  await newSession(page, project);
  await page.keyboard.type('Fix the table alignment');
  await page.keyboard.press('Enter');
  await expect(page.locator('.turn-note')).toContainText('48.2s', { timeout: 20000 });
  // By default: the status icon (none once seen), how long the turn ran, and the first prompt.
  const row = page.locator('.session-row.active');
  await expect(row.locator('.title')).toHaveText('0m Fix the table alignment');

  await page.keyboard.press('Meta+Comma');
  await expect(item('Sidebar title').locator('.desc')).toHaveText('{status} {elapsed} {title}');
  await expect(item('Sidebar subtitle').locator('.desc')).toHaveText('{folder}( · {waiting})');
  await item('Sidebar title').click();
  await expect(picker.locator('.picker-title')).toContainText('Sidebar title');
  await expect(picker.locator('.picker-search')).toHaveValue('{status} {elapsed} {title}');
  await expect(picker.locator('.sidebar-preview')).toHaveText('Preview: 0m Fix the table alignment');
  // Fields show what they hold now; Enter on one adds it.
  await expect(item('{modelLetter}').locator('.desc')).toHaveText('Its first letter: O, S, H, F · now O');
  await picker.locator('.picker-search').fill('{folder}');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(picker.locator('.picker-item.picked .label')).toHaveText('{status}');
  await item('{modelLetter}').click();
  await expect(picker.locator('.picker-search')).toHaveValue('{folder} {modelLetter}');
  await expect(picker.locator('.sidebar-preview')).toHaveText('Preview: app O');
  await page.screenshot({ path: shot('settings-sidebar') });
  await item('Save').click();
  await expect(item('Sidebar title').locator('.desc')).toHaveText('{folder} {modelLetter}');
  expect(saved()).toEqual({ mine: true, sidebar: { title: '{folder} {modelLetter}' } });
  await expect(row.locator('.title')).toHaveText('app O');

  // An empty subtitle hides the second line; the default removes the key.
  await item('Sidebar subtitle').click();
  await picker.locator('.picker-search').fill('');
  await page.keyboard.press('Enter');
  await expect.poll(() => saved().sidebar).toEqual({ title: '{folder} {modelLetter}', subtitle: '' });
  await expect(row.locator('.sub')).toHaveCount(0);
  await item('Sidebar title').click();
  await item('Use the default').click();
  await item('Sidebar subtitle').click();
  await item('Use the default').click();
  await expect.poll(saved).toEqual({ mine: true });
  await page.keyboard.press('Escape');
  await expect(row.locator('.title')).toHaveText('0m Fix the table alignment');
  await expect(row.locator('.sub')).toHaveText('app');
});
