import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, newSession, shot, SHOWCASE, type Launched } from './helpers';

// Settings (Binder > Settings…, ⌘,, /settings): binder's config.json.

let run: Launched | null = null;
test.afterEach(async () => {
  await run?.close();
  run = null;
});

test('changes config.json from the menu, ⌘, and /settings', async () => {
  const config = join(mkdtempSync('/tmp/bgc-'), 'config.json');
  writeFileSync(config, JSON.stringify({ permissionMode: 'plan', mine: true }));
  const saved = () => JSON.parse(readFileSync(config, 'utf8'));
  run = await launch(SHOWCASE, { BINDER_CONFIG: config });
  const { app, page, project, tmp } = run;
  const picker = page.locator('.picker');
  const row = (label: string) => picker.locator('.picker-item', { hasText: label });

  // The menu bar's Settings… opens it.
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('settings')!.click());
  await expect(picker.locator('.picker-title')).toHaveText('Settings');
  await expect(row('Permission mode').locator('.desc')).toHaveText('plan');
  await expect(row('Sticky prompt').locator('.desc')).toHaveText('On');
  await page.screenshot({ path: shot('settings') });

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(row('Sticky prompt').locator('.desc')).toHaveText('Off');
  expect(saved()).toEqual({ permissionMode: 'plan', mine: true, stickyPrompt: false });

  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(picker.locator('.picker-title')).toHaveText('Permission mode');
  await expect(picker.locator('.picker-item.picked .label')).toHaveText('plan');
  await row('acceptEdits').click();
  await expect(row('Permission mode').locator('.desc')).toHaveText('acceptEdits');
  expect(saved().permissionMode).toBe('acceptEdits');

  // Add a config dir: a folder that is there, then a config dir that is not yet.
  await row('Add a config dir').click();
  await page.keyboard.type(project);
  await expect(picker.locator('.picker-item.picked .label')).toHaveText(project);
  await page.keyboard.press('Enter');
  await expect(picker.locator('.picker-title')).toHaveText(`Config dir for ${project}`);
  const account = join(tmp, 'claude-work');
  await page.keyboard.type(account);
  await expect(picker.locator('.picker-item.picked .desc')).toHaveText('Does not exist yet');
  await page.screenshot({ path: shot('settings-config-dir') });
  await page.keyboard.press('Enter');
  await expect(row(`Config dir for ${project}`).locator('.desc')).toHaveText(account);
  expect(saved().configDirs).toEqual({ [project]: account });
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);

  // ⌘, opens it too; Enter on a config dir offers to remove it.
  await page.keyboard.press('Meta+Comma');
  await row(`Config dir for ${project}`).click();
  await row('Remove').click();
  await expect(row('Add a config dir')).toBeVisible();
  expect(saved()).toEqual({ permissionMode: 'acceptEdits', mine: true, stickyPrompt: false });
  await page.keyboard.press('Escape');

  // And /settings in a session.
  await newSession(page, project);
  await page.keyboard.type('/settings');
  await page.keyboard.press('Enter');
  await expect(picker.locator('.picker-title')).toHaveText('Settings');
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(page.locator('.composer textarea')).toBeFocused();
});

test('says why when config.json does not parse, and leaves it alone', async () => {
  const config = join(mkdtempSync('/tmp/bgc-'), 'config.json');
  writeFileSync(config, '{');
  run = await launch(SHOWCASE, { BINDER_CONFIG: config });
  const { page } = run;
  await page.keyboard.press('Meta+Comma');
  await expect(page.locator('.picker-sub')).toContainText(config);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('.picker-sub')).toContainText(config);
  expect(readFileSync(config, 'utf8')).toBe('{');
});
