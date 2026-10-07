import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { launch, newSession, shot, SHOWCASE, type Launched } from './helpers';

// A capture of the real window (vibrancy and all), which page screenshots
// cannot show. Run on demand: WINDOW_SHOTS=1 npx playwright test window
test.skip(!process.env.WINDOW_SHOTS, 'set WINDOW_SHOTS=1 to capture the real window');

let run: Launched | null = null;
test.afterEach(async () => {
  await run?.close();
  run = null;
});

for (const theme of ['light', 'dark'] as const) {
  test(`captures the window in ${theme} mode`, async () => {
    run = await launch(SHOWCASE, { BINDER_GUI_BACKGROUND: '' });
    const { app, page, project } = run;
    await app.evaluate(({ nativeTheme }, t) => {
      nativeTheme.themeSource = t;
    }, theme);
    await page.emulateMedia({ colorScheme: theme });
    await newSession(page, project);
    await page.keyboard.type('Fix the table alignment');
    await page.keyboard.press('Enter');
    await expect(page.locator('.turn-note')).toContainText('48.2s', { timeout: 20000 });
    await page.locator('.prompt').first().scrollIntoViewIfNeeded();
    // "window:<CGWindowID>:0" on macOS.
    const id = (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getMediaSourceId())).split(':')[1];
    await page.waitForTimeout(400);
    execFileSync('screencapture', ['-x', '-o', '-l', id, shot(`window-${theme}`)]);
  });
}
