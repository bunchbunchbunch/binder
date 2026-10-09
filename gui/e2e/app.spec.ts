import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, newSession, shot, SHOWCASE, tuiFixture, type Launched } from './helpers';

let run: Launched | null = null;
test.afterEach(async () => {
  await run?.close();
  run = null;
});

test('starts a session, streams a turn, and renders its Markdown and work', async () => {
  run = await launch(SHOWCASE);
  const { page, project } = run;
  await newSession(page, project);
  const box = page.locator('.composer textarea');
  await expect(box).toBeFocused();
  await expect(page.locator('.welcome h1')).toHaveText('Binder');

  await page.keyboard.type('Fix the table alignment');
  await page.keyboard.press('Enter');
  await expect(page.locator('.md h1')).toHaveText('Table rendering', { timeout: 20000 });
  await expect(page.locator('.turn-note')).toContainText('48.2s');
  await expect(page.locator('.tab')).toHaveCount(1);
  await expect(page.locator('.work-toggle')).toContainText('5 tool calls, 1 thought');
  await expect(page.locator('.md table tbody tr')).toHaveCount(4);
  await expect(page.locator('.md li.task-list-item')).toHaveCount(3);
  await expect(page.locator('.codeblock .hljs-keyword').first()).toBeVisible();
  await expect(page.locator('.statusbar')).toContainText('Opus 5.5');
  await expect(page.locator('.statusbar')).toContainText('accept edits');
  await page.screenshot({ path: shot('transcript') });

  // Ctrl+E shows the work behind the answer, in order.
  await page.keyboard.press('Control+e');
  await expect(page.locator('.work .tool')).toHaveCount(5);
  await expect(page.locator('.diff-row.add')).toHaveCount(2);
  await expect(page.locator('.diff-row.del')).toHaveCount(1);
  await expect(page.locator('.work .md')).toHaveText("I'll start with the table renderer.");
  await page.screenshot({ path: shot('work') });
  await page.keyboard.press('Control+e');
  await expect(page.locator('.work')).toHaveCount(0);

  // A second prompt opens a second tab; Ctrl+Left and Option+2 move between them.
  await page.keyboard.type('Summarize it');
  await page.keyboard.press('Enter');
  await expect(page.locator('.tab')).toHaveCount(2);
  await expect(page.locator('.tab.active .num')).toHaveText('2');
  await expect(page.locator('.md strong').last()).toHaveText('display width', { timeout: 20000 });
  await page.keyboard.press('Control+ArrowLeft');
  await expect(page.locator('.tab.active .num')).toHaveText('1');
  await page.keyboard.press('Alt+Digit2');
  await expect(page.locator('.tab.active .num')).toHaveText('2');
  // Up brings back the last prompt.
  await page.keyboard.press('ArrowUp');
  await expect(box).toHaveValue('Summarize it');
});

test('answers an AskUserQuestion from the keyboard', async () => {
  // The fake claude writes the answer it got here.
  const answers = join(mkdtempSync('/tmp/bga-'), 'answers.json');
  run = await launch(tuiFixture('ask-and-interrupt.jsonl'), { BINDER_FAKE_DELAY_MS: '2', BINDER_FAKE_ANSWERS_OUT: answers });
  await newSession(run.page, run.project);
  await run.page.keyboard.type('ask me a color');
  await run.page.keyboard.press('Enter');
  const card = run.page.locator('.question');
  await expect(card).toContainText('Which color do you prefer?', { timeout: 20000 });
  await expect(card).toBeFocused();
  await expect(run.page.locator('.composer')).toBeHidden();
  await run.page.screenshot({ path: shot('question') });
  await run.page.keyboard.press('2');
  await expect(card).toHaveCount(0);
  await expect(run.page.locator('.composer textarea')).toBeFocused();
  await expect.poll(() => JSON.parse(readFileSync(answers, 'utf8')).response.response.updatedInput.answers).toEqual({ 'Which color do you prefer?': 'Blue' });
});

test('opens the command menu and the model panel', async () => {
  run = await launch(SHOWCASE);
  const { page, project } = run;
  await newSession(page, project);
  await page.keyboard.type('/mod');
  const menu = page.locator('.menu');
  await expect(menu.locator('.menu-item.picked .label')).toHaveText('/model [model]');
  await page.keyboard.press('Enter');
  const picker = page.locator('.picker');
  await expect(picker.locator('.picker-title')).toContainText('Model');
  await expect(picker.locator('.picker-item')).toHaveCount(2);
  await page.screenshot({ path: shot('model-panel') });
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(page.locator('.composer textarea')).toBeFocused();

  // "?" on an empty prompt shows the shortcuts; the next key closes them.
  await page.keyboard.press('?');
  await expect(page.locator('.shortcuts')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.shortcuts')).toHaveCount(0);

  // pi's keys: Ctrl+L opens the same panel, Ctrl+P / Shift+Ctrl+P cycle models, Shift+Tab the effort level.
  await page.keyboard.press('Control+l');
  await expect(picker.locator('.picker-title')).toContainText('Model');
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  const toast = page.locator('.toast');
  await page.keyboard.press('Control+p');
  await expect(toast).toHaveText('Model: Haiku 4.5');
  await page.keyboard.press('Control+Shift+P');
  await expect(toast).toHaveText('Model: Opus 5.5');
  await page.keyboard.press('Shift+Tab');
  await expect(toast).toHaveText('Effort: low');
  await page.keyboard.press('Shift+Tab');
  await expect(toast).toHaveText('Effort: medium');
  await expect(page.locator('.composer textarea')).toBeFocused();
});

test('⌘/ and Help > Binder Guide open the guide; Esc closes it', async () => {
  run = await launch(SHOWCASE);
  const { app, page, project } = run;
  await newSession(page, project);
  const guide = page.locator('.guide');
  await page.keyboard.press('Meta+Slash');
  await expect(guide.locator('.picker-title')).toHaveText('Binder is a GTUI');
  await expect(guide.locator('h2')).toHaveText(['In a session', 'In the window']);
  await expect(guide.locator('td kbd', { hasText: 'Cmd+/' })).toBeVisible();
  await expect(guide.locator('.guide-body')).toBeFocused();
  await page.screenshot({ path: shot('guide') });
  await page.keyboard.press('Escape');
  await expect(guide).toHaveCount(0);
  await expect(page.locator('.composer textarea')).toBeFocused();

  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('guide')!.click());
  await expect(guide).toBeVisible();
  await guide.locator('..').click({ position: { x: 5, y: 5 } });
  await expect(guide).toHaveCount(0);
});

test('lists running background tasks under the status row', async () => {
  run = await launch(tuiFixture('background-bash.jsonl'));
  const { page, project } = run;
  await newSession(page, project);
  await page.keyboard.type('Start the background job');
  await page.keyboard.press('Enter');
  const task = page.locator('.bg-task');
  await expect(task).toHaveCount(1, { timeout: 20000 });
  await expect(task.locator('.what')).toHaveText('◷ sleep 8; echo BG_DONE');
  // Its kind, the tab that started it, and how long it has run (since the fixture was recorded).
  await expect(task.locator('.meta')).toHaveText(/^shell · tab 1 · \d+h \d+m$/);
  await page.screenshot({ path: shot('background') });
});

test('runs a bash command in its own tab', async () => {
  run = await launch(SHOWCASE);
  const { page, project } = run;
  await newSession(page, project);
  await page.keyboard.type('!echo hello from bash');
  await expect(page.locator('.composer')).toHaveClass(/bash/);
  await page.keyboard.press('Enter');
  await expect(page.locator('.prompt.bash')).toHaveText('!echo hello from bash');
  await page.screenshot({ path: shot('bash') });
  await expect(page.locator('.tab')).toHaveCount(1);
  await expect(page.locator('.transcript')).toContainText('hello from bash', { timeout: 10000 });
});

test('brings open sessions back after a relaunch; ⌘W closes one and ⌘K reopens it', async () => {
  run = await launch(SHOWCASE);
  await newSession(run.page, run.project);
  await run.page.keyboard.type('Fix the table alignment');
  await run.page.keyboard.press('Enter');
  await expect(run.page.locator('.md h1')).toHaveText('Table rendering', { timeout: 20000 });
  // Quit the app only: the host keeps the session.
  await run.quitApp();
  await new Promise((r) => setTimeout(r, 500));
  const tmp = run.tmp;
  run = await launch(SHOWCASE, {}, { reuse: tmp });
  const { page } = run;
  await expect(page.locator('.session-row.active .title')).toHaveText(/Fix the table alignment$/, { timeout: 20000 });
  await expect(page.locator('.md h1')).toHaveText('Table rendering');

  await page.keyboard.press('Meta+w');
  await expect(page.locator('.empty-main')).toBeVisible();
  await expect(page.locator('.session-row .title', { hasText: 'Fix the table alignment' })).toBeVisible();
  await page.keyboard.press('Meta+k');
  await page.locator('.picker-search').fill('table');
  await expect(page.locator('.picker-item.picked .label')).toHaveText('Fix the table alignment');
  await page.screenshot({ path: shot('switcher') });
  await page.keyboard.press('Enter');
  await expect(page.locator('.md h1')).toHaveText('Table rendering', { timeout: 20000 });
  await expect(page.locator('.composer textarea')).toBeFocused();
});

test("a running turn's clock keeps counting across a relaunch", async () => {
  // Slow enough that the turn outlasts the relaunch.
  run = await launch(SHOWCASE, { BINDER_FAKE_DELAY_MS: '300' });
  await newSession(run.page, run.project);
  await run.page.keyboard.type('Fix the table alignment');
  await run.page.keyboard.press('Enter');
  await expect(run.page.locator('.activity .now')).toContainText('(3s', { timeout: 20000 });
  await run.quitApp();
  run = await launch(SHOWCASE, {}, { reuse: run.tmp });
  const now = run.page.locator('.activity .now');
  await expect(now).toContainText('esc to interrupt', { timeout: 20000 });
  // Its first reading counts from when the turn started, not from the relaunch.
  const seconds = Number((await now.textContent())!.match(/\((\d+)s/)![1]);
  expect(seconds).toBeGreaterThanOrEqual(3);
});

test('Ctrl+Enter adds a follow-up to the tab; Esc twice rewinds it', async () => {
  run = await launch(SHOWCASE);
  const { page, project } = run;
  await newSession(page, project);
  await page.keyboard.type('Fix the table alignment');
  await page.keyboard.press('Enter');
  await expect(page.locator('.turn-note')).toContainText('48.2s', { timeout: 20000 });
  await page.keyboard.type('Summarize it');
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('.turn')).toHaveCount(2, { timeout: 20000 });
  await expect(page.locator('.tab')).toHaveCount(1);
  await expect(page.locator('.turn').last().locator('.md strong')).toHaveText('display width', { timeout: 20000 });

  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const picker = page.locator('.picker');
  await expect(picker.locator('.picker-title')).toHaveText('Rewind to before a prompt');
  await expect(picker.locator('.picker-item.picked .label')).toHaveText('Summarize it');
  await page.keyboard.press('Enter');
  await expect(picker.locator('.picker-item').first()).toContainText('Restore code and conversation');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('.turn')).toHaveCount(1);
  await expect(page.locator('.composer textarea')).toHaveValue('Summarize it');
});

test('edits a queued prompt in place from Up or its Edit button, and removes one', async () => {
  // The first prompt runs for about 4s (13 lines, 300ms apart) while the others wait.
  run = await launch(tuiFixture('two-turns-stdin.jsonl'), { BINDER_FAKE_DELAY_MS: '300' });
  const { page, project } = run;
  await newSession(page, project);
  const box = page.locator('.composer textarea');
  const labels = page.locator('.tab .label');
  for (const p of ['first prompt', 'second prompt', 'third prompt']) {
    await page.keyboard.type(p);
    await page.keyboard.press('Enter');
  }
  await expect(labels).toHaveText(['first prompt', 'second prompt', 'third prompt']);

  // Up on the empty prompt opens tab 3's prompt; Esc leaves it queued as it was.
  await page.keyboard.press('ArrowUp');
  await expect(box).toHaveValue('third prompt');
  await expect(page.locator('.composer.editing')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(box).toHaveValue('');
  await expect(page.locator('.composer.editing')).toHaveCount(0);
  await expect(page.locator('.tab.active .glyph')).toHaveClass(/queued/);

  await page.locator('.queued-actions button', { hasText: 'Remove' }).click();
  await expect(labels).toHaveText(['first prompt', 'second prompt']);

  await page.locator('.tab', { hasText: 'second prompt' }).click();
  await page.locator('.queued-actions button', { hasText: 'Edit' }).click();
  await expect(box).toHaveValue('second prompt');
  await expect(box).toBeFocused();
  await page.keyboard.type(', edited');
  await page.keyboard.press('Enter');
  await expect(labels).toHaveText(['first prompt', 'second prompt, edited']);
  await expect(box).toHaveValue('');
  // It runs as edited once the first turn ends.
  await expect(page.locator('.tab.active .glyph')).toHaveClass(/done/, { timeout: 20000 });
  await expect(page.locator('.prompt')).toHaveText('second prompt, edited');
});

test('reads well in dark mode', async () => {
  run = await launch(SHOWCASE);
  const { app, page, project } = run;
  await app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = 'dark';
  });
  // Playwright pins the page to light unless told otherwise.
  await page.emulateMedia({ colorScheme: 'dark' });
  await newSession(page, project);
  await page.keyboard.type('Fix the table alignment');
  await page.keyboard.press('Enter');
  await expect(page.locator('.md h1')).toHaveText('Table rendering', { timeout: 20000 });
  expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
  await expect(page.locator('.turn-note')).toContainText('48.2s', { timeout: 20000 });
  await page.locator('.md h2').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: shot('dark') });
});

test('fast typing right after Enter keeps each prompt whole', async () => {
  run = await launch(SHOWCASE);
  const { page, project } = run;
  await newSession(page, project);
  const prompts = Array.from({ length: 6 }, (_, i) => `!echo prompt ${i + 1} with enough words to take a while to type`);
  for (const p of prompts) {
    await page.keyboard.type(p, { delay: 0 });
    await page.keyboard.press('Enter');
  }
  await expect(page.locator('.tab')).toHaveCount(6, { timeout: 15000 });
  for (let i = 0; i < prompts.length; i++) {
    await page.keyboard.press(`Alt+Digit${i + 1}`);
    await expect(page.locator('.prompt.bash')).toHaveText(prompts[i]);
  }
});

test('a question keeps the keyboard after a click elsewhere, and badges the Dock', async () => {
  run = await launch(tuiFixture('ask-and-interrupt.jsonl'), { BINDER_FAKE_DELAY_MS: '2' });
  const { app, page, project } = run;
  await newSession(page, project);
  await page.keyboard.type('ask me a color');
  await page.keyboard.press('Enter');
  await expect(page.locator('.question')).toBeVisible({ timeout: 20000 });
  await expect.poll(() => app.evaluate(({ app }) => app.dock?.getBadge())).toBe('1');
  await page.locator('.prompt').first().click();
  await page.keyboard.press('2');
  await expect(page.locator('.question')).toHaveCount(0);
  await expect.poll(() => app.evaluate(({ app }) => app.dock?.getBadge())).toBe('');
});

test('fits a narrow window, counts tabs out of view, and hides the sidebar', async () => {
  run = await launch(SHOWCASE);
  const { app, page, project } = run;
  await newSession(page, project);
  await page.keyboard.type('Fix the table alignment');
  await page.keyboard.press('Enter');
  await expect(page.locator('.turn-note')).toContainText('48.2s', { timeout: 20000 });
  const fits = () => page.locator('.session:not([hidden]) .statusbar').evaluate((el) => el.scrollWidth <= el.clientWidth);
  for (const width of [720, 900, 1280]) {
    await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setSize(w, 700), width);
    await expect.poll(fits, { message: `status bar fits at ${width}px` }).toBe(true);
  }
  await page.screenshot({ path: shot('narrow-fixed') });

  for (let i = 2; i <= 14; i++) {
    await page.keyboard.type(`!echo tab ${i}: a longer title so the tabs overflow`);
    await page.keyboard.press('Enter');
  }
  await expect(page.locator('.tab')).toHaveCount(14, { timeout: 15000 });
  // On the last tab only earlier tabs are out of view, and on the first only later ones.
  await expect(page.locator('.tab-more')).toHaveCount(1);
  await expect(page.locator('.tab-more')).toHaveText(/‹ \d+/);
  await page.keyboard.press('Alt+Digit1');
  await expect(page.locator('.tab-more')).toHaveCount(1);
  await expect(page.locator('.tab-more')).toHaveText(/\d+ ›/);
  await page.screenshot({ path: shot('tab-overflow') });

  // Paging or scrolling the strip by hand leaves it there: the count that
  // appears on the other side narrows the strip, which must not snap it back.
  const strip = page.locator('.session:not([hidden]) .tabs');
  const scrolled = () => strip.evaluate((el) => el.scrollLeft);
  await page.locator('.tab-more').click();
  await page.waitForTimeout(800);
  expect(await scrolled()).toBeGreaterThan(0);
  await expect(page.locator('.tab-more')).toHaveCount(2);
  const paged = await scrolled();
  await strip.hover();
  await page.mouse.wheel(-60, 0);
  await page.waitForTimeout(300);
  expect(await scrolled()).toBeLessThan(paged);
  expect(await scrolled()).toBeGreaterThan(0);
  await expect(page.locator('.tab-more')).toHaveCount(2);

  await page.keyboard.press('Control+Meta+s');
  await expect(page.locator('.sidebar')).toHaveCount(0);
  await page.keyboard.press('Control+Meta+s');
  await expect(page.locator('.sidebar')).toHaveCount(1);
});

test('the @ menu, Tab completion, and a long paste', async () => {
  run = await launch(SHOWCASE);
  const { page, project } = run;
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'src', 'table.ts'), '');
  writeFileSync(join(project, 'src', 'wrap.ts'), '');
  writeFileSync(join(project, 'README.md'), '');
  await newSession(page, project);
  const box = page.locator('.composer textarea');

  await page.keyboard.type('look at @sr');
  await expect(page.locator('.menu-item.picked .label')).toHaveText('@src/');
  await page.keyboard.press('Tab');
  await expect(box).toHaveValue('look at @src/');
  await page.keyboard.type('ta');
  await expect(page.locator('.menu-item.picked .label')).toHaveText('@src/table.ts');
  await page.keyboard.press('Enter');
  await expect(box).toHaveValue('look at @src/table.ts');

  await page.keyboard.press('Control+u');
  await page.keyboard.type('open READ');
  await page.keyboard.press('Tab');
  await expect(box).toHaveValue('open README.md ');

  // A paste over three lines collapses to a label; the full text is what gets sent.
  await page.keyboard.press('Control+u');
  const long = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join('\n');
  await box.evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, long);
  await expect(box).toHaveValue('[Pasted text #1 +4 lines]');
  await page.keyboard.press('Enter');
  await expect(page.locator('.prompt')).toHaveText(long);
});
