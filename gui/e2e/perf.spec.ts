import { test, expect } from '@playwright/test';
import { launch, newSession, tuiFixture, type Launched } from './helpers';

// bindertui's long synthetic turn (40 tool calls, a 10k-character answer,
// about 3,000 events) streams through the app while the renderer's long
// tasks are recorded: the window must stay responsive.

let run: Launched | null = null;
test.afterEach(async () => {
  await run?.close();
  run = null;
});

test('stays responsive while a long turn streams', async () => {
  run = await launch(tuiFixture('long-turn.jsonl'), { BINDER_FAKE_DELAY_MS: '1' });
  const { page, project } = run;
  await newSession(page, project);
  await page.evaluate(() => {
    const w = window as unknown as { longTasks: number[] };
    w.longTasks = [];
    new PerformanceObserver((list) => list.getEntries().forEach((e) => w.longTasks.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: false });
  });
  const started = Date.now();
  await page.keyboard.type('go');
  await page.keyboard.press('Enter');
  // Typing while it streams lands in the prompt.
  await page.waitForTimeout(800);
  const t0 = Date.now();
  await page.keyboard.type('still typing');
  await expect(page.locator('.composer textarea')).toHaveValue('still typing');
  const typed = Date.now() - t0;
  await expect(page.locator('.turn-note')).toContainText('1m 30s', { timeout: 60000 });
  const total = Date.now() - started;
  const longTasks = await page.evaluate(() => (window as unknown as { longTasks: number[] }).longTasks);
  const worst = Math.max(0, ...longTasks);
  console.log(`streamed in ${total}ms; typing 12 keys took ${typed}ms; ${longTasks.length} long tasks, worst ${worst}ms`);
  expect(worst).toBeLessThan(250);
  await page.keyboard.press('Control+e');
  await expect(page.locator('.work .tool')).toHaveCount(40);
});
