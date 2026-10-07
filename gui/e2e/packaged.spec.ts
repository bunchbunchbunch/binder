import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { launch, newSession, PACKAGED, SHOWCASE, type Launched } from './helpers';

// The built Binder.app (npm run dist), started with launchd's bare
// environment as the Dock does: it must find node and binder through the
// login shell.
test.skip(!existsSync(PACKAGED), 'run npm run dist first');

let run: Launched | null = null;
test.afterEach(async () => {
  await run?.close();
  run = null;
});

test('the packaged app finds binder from a Dock-like launch and runs a turn', async () => {
  run = await launch(SHOWCASE, {}, { packaged: true });
  const { page, project } = run;
  await newSession(page, project);
  await page.keyboard.type('Fix the table alignment');
  await page.keyboard.press('Enter');
  await expect(page.locator('.md h1')).toHaveText('Table rendering', { timeout: 20000 });
});
