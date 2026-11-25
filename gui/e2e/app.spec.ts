import { test, expect, type ElectronApplication } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BINDERTUI, dragsAt, launch, newSession, shot, SHOWCASE, tuiFixture, type Launched } from './helpers';

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
  await expect.poll(() => existsSync(answers) && JSON.parse(readFileSync(answers, 'utf8')).response.response.updatedInput.answers).toEqual({ 'Which color do you prefer?': 'Blue' });
});

test("a question's text can be selected and copied; selecting an option does not answer", async () => {
  run = await launch(tuiFixture('ask-and-interrupt.jsonl'), { BINDER_FAKE_DELAY_MS: '2' });
  const { app, page, project } = run;
  await newSession(page, project);
  await page.keyboard.type('ask me a color');
  await page.keyboard.press('Enter');
  const card = page.locator('.question');
  await expect(card).toBeVisible({ timeout: 20000 });
  const selected = () => page.evaluate(() => window.getSelection()?.toString() ?? '');

  await card.locator('.q').click({ clickCount: 3 });
  expect(await selected()).toContain('Which color do you prefer?');
  await app.evaluate(({ clipboard }) => clipboard.writeText(''));
  await page.keyboard.press('Meta+c');
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('Which color do you prefer?');

  // A drag across an option selects its text and leaves the question open.
  const desc = await card.locator('.option .desc').first().boundingBox();
  await page.mouse.move(desc!.x + 1, desc!.y + desc!.height / 2);
  await page.mouse.down();
  await page.mouse.move(desc!.x + desc!.width - 1, desc!.y + desc!.height / 2, { steps: 5 });
  await page.mouse.up();
  expect(await selected()).toContain('warm');
  await page.waitForTimeout(300);
  await expect(card).toBeVisible();

  await card.locator('.option', { hasText: 'Blue' }).click();
  await expect(card).toHaveCount(0);
});

for (const how of ['Esc', 'a click on its hint'] as const) {
  test(`${how} declines an AskUserQuestion`, async () => {
    const answers = join(mkdtempSync('/tmp/bga-'), 'answers.json');
    run = await launch(tuiFixture('ask-and-interrupt.jsonl'), { BINDER_FAKE_DELAY_MS: '2', BINDER_FAKE_ANSWERS_OUT: answers });
    await newSession(run.page, run.project);
    await run.page.keyboard.type('ask me a color');
    await run.page.keyboard.press('Enter');
    const card = run.page.locator('.question');
    await expect(card.locator('.decline')).toHaveText('esc declines', { timeout: 20000 });
    if (how === 'Esc') await run.page.keyboard.press('Escape');
    else await card.locator('.decline').click();
    await expect(card).toHaveCount(0);
    await expect(run.page.locator('.composer textarea')).toBeFocused();
    await expect.poll(() => existsSync(answers) && JSON.parse(readFileSync(answers, 'utf8')).response.response.behavior).toBe('deny');
  });
}

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
  // "default" shows as the model it stands for.
  await expect(page.locator('.statusbar')).toContainText('Opus 5.5');
  // Presses in quick succession each take a step.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(toast).toHaveText('Effort: medium');
  await expect(page.locator('.statusbar')).toContainText('medium');
  await expect(page.locator('.composer textarea')).toBeFocused();

  // A click on the status bar's model or effort level opens its picker.
  await page.locator('.statusbar .pick.model').click();
  await expect(picker.locator('.picker-title')).toContainText('Model');
  await page.keyboard.press('Escape');
  await page.locator('.statusbar .pick.effort').click();
  await expect(picker.locator('.picker-title')).toContainText('Effort');
  await expect(picker.locator('.picker-item.picked')).toContainText('medium');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(toast).toHaveText('Effort: high');
  await expect(page.locator('.statusbar .pick.effort')).toHaveText('high');
  await expect(page.locator('.composer textarea')).toBeFocused();
});

test("a Codex file change (Patch) shows each file's diff", async () => {
  // A turn as binder's Codex translation reports it: one Patch call changing two files.
  const tmp = mkdtempSync('/tmp/bg-');
  mkdirSync(join(tmp, 'app'));
  // Where the session reports it runs: /tmp is /private/tmp on macOS.
  const dir = realpathSync(join(tmp, 'app'));
  const fixture = join(tmp, 'patch.jsonl');
  const changes = [
    { path: join(dir, 'src/table.ts'), kind: 'update', diff: '@@ -1,3 +1,3 @@\n const a = 1;\n-const width = s.length;\n+const width = stringWidth(s);\n return width;\n@@ -20,2 +20,3 @@\n }\n+export { width };\n' },
    { path: join(dir, 'src/wrap.ts'), kind: 'add', diff: 'export function wrap() {}\n' },
  ];
  const e = (o: object) => JSON.stringify({ session_id: 'patch', parent_tool_use_id: null, ...o });
  writeFileSync(
    fixture,
    [
      e({ type: 'system', subtype: 'init', cwd: dir, model: 'gpt-5-codex', permissionMode: 'acceptEdits' }),
      e({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'p1', name: 'Patch', input: { file_path: changes[0].path, changes } }] } }),
      e({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'p1', content: '' }] } }),
      e({ type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Patched both files.' }] } }),
      e({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, num_turns: 1, total_cost_usd: 0 }),
    ].join('\n') + '\n',
  );
  run = await launch(fixture, {}, { reuse: tmp });
  const { page, project } = run;
  await newSession(page, project);
  await page.keyboard.type('Use display width');
  await page.keyboard.press('Enter');
  await expect(page.locator('.md').last()).toHaveText('Patched both files.', { timeout: 20000 });
  await page.keyboard.press('Control+e');
  const tool = page.locator('.work .tool');
  await expect(tool.locator('.tool-name')).toHaveText('Patch');
  await expect(tool.locator('.tool-arg')).toHaveText('2 files');
  await expect(tool.locator('.diff-row.file')).toHaveText(['src/table.ts', 'src/wrap.ts · new file']);
  await expect(tool.locator('.diff-row.del')).toHaveText(['−const width = s.length;']);
  await expect(tool.locator('.diff-row.add')).toHaveText(['+const width = stringWidth(s);', '+export { width };', '+export function wrap() {}']);
  await expect(tool.locator('.diff-row.skip')).toHaveText(['⋯ 16 unchanged lines']);
  await page.screenshot({ path: shot('codex-patch') });
});

test('a one-file Codex patch is a link to its file, as an Edit is', async () => {
  const tmp = mkdtempSync('/tmp/bg-');
  mkdirSync(join(tmp, 'app'));
  const dir = realpathSync(join(tmp, 'app'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/table.ts'), 'const width = stringWidth(s);\n');
  const opened = join(tmp, 'opened');
  const config = join(tmp, 'config.json');
  writeFileSync(config, JSON.stringify({ editor: `printf '%s\\n' {file} >> ${opened}` }));
  const fixture = join(tmp, 'patch.jsonl');
  const changes = [{ path: join(dir, 'src/table.ts'), kind: 'update', diff: '@@ -1,1 +1,1 @@\n-const width = s.length;\n+const width = stringWidth(s);\n' }];
  const e = (o: object) => JSON.stringify({ session_id: 'patch', parent_tool_use_id: null, ...o });
  writeFileSync(
    fixture,
    [
      e({ type: 'system', subtype: 'init', cwd: dir, model: 'gpt-5-codex', permissionMode: 'acceptEdits' }),
      e({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'p1', name: 'Patch', input: { file_path: changes[0].path, changes } }] } }),
      e({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'p1', content: '' }] } }),
      e({ type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Patched it.' }] } }),
      e({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, num_turns: 1, total_cost_usd: 0 }),
    ].join('\n') + '\n',
  );
  run = await launch(fixture, { BINDER_CONFIG: config }, { reuse: tmp });
  const { page, project } = run;
  await newSession(page, project);
  await page.keyboard.type('Use display width');
  await page.keyboard.press('Enter');
  await expect(page.locator('.md').last()).toHaveText('Patched it.', { timeout: 20000 });
  await page.keyboard.press('Control+e');
  const link = page.locator('.work .tool .tool-arg.file-link');
  await expect(link).toHaveText('src/table.ts');
  await link.click();
  await expect.poll(() => (existsSync(opened) ? readFileSync(opened, 'utf8') : '')).toBe(`${join(dir, 'src/table.ts')}\n`);
});

test("the status bar shows the context and its share of the window, as config.json's statusText says; a click breaks it down", async () => {
  const tmp = mkdtempSync('/tmp/bg-');
  mkdirSync(join(tmp, 'app'));
  const config = join(tmp, 'config.json');
  writeFileSync(config, '{}');
  const fixture = join(tmp, 'cost.jsonl');
  const e = (o: object) => JSON.stringify({ session_id: 'cost', parent_tool_use_id: null, ...o });
  writeFileSync(
    fixture,
    [
      e({ type: 'system', subtype: 'init', cwd: realpathSync(join(tmp, 'app')), model: 'claude-opus-5-5', permissionMode: 'default' }),
      e({ type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 10, cache_read_input_tokens: 40000, cache_creation_input_tokens: 9990 } } }),
      e({ type: 'result', subtype: 'success', is_error: false, duration_ms: 900, num_turns: 1, total_cost_usd: 0.4213, modelUsage: { 'claude-opus-5-5': { contextWindow: 200000, costUSD: 0.4213 } } }),
    ].join('\n') + '\n',
  );
  run = await launch(fixture, { BINDER_CONFIG: config }, { reuse: tmp });
  const { page, project } = run;
  await newSession(page, project);
  await page.keyboard.type('Check the costs');
  await page.keyboard.press('Enter');
  const ctx = page.locator('.statusbar .ctx');
  await expect(ctx).toHaveText('50.0k/200k 25%', { timeout: 20000 });
  // The cost shows only when the template asks for it; an edit to config.json applies on focus.
  writeFileSync(config, JSON.stringify({ statusText: '{context} context( · {cost})' }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(ctx).toHaveText('50.0k context · $0.42');
  await ctx.click();
  const picker = page.locator('.picker');
  await expect(picker).toContainText('Context: 50.0k of 200k tokens (25%)');
  await expect(picker.locator('.picker-item')).toHaveCount(4);
  await expect(picker.locator('.picker-item', { hasText: 'Messages' })).toContainText('46.5k tokens · 23.3%');
  await expect(picker.locator('.picker-item', { hasText: 'MCP tools' })).toContainText('loaded when used');
  await page.screenshot({ path: shot('context-breakdown') });
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
});

test('/rename puts a title above the tabs and in the sidebar, and it drags the window', async () => {
  run = await launch(SHOWCASE);
  const { page, project } = run;
  await newSession(page, project);
  const title = page.locator('.session:not([hidden]) .session-title');
  await page.keyboard.type('Fix the table alignment');
  await page.keyboard.press('Enter');
  await expect(page.locator('.tab')).toHaveCount(1);
  await expect(title).toHaveCount(0);
  const row = page.locator('.session-row.active .title');
  await expect(row).toHaveText(/Fix the table alignment$/);

  await page.keyboard.type('/rename');
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast')).toHaveText('/rename: Give the session a title: /rename <title>');
  await page.keyboard.type('/rename Table   fixes');
  await page.keyboard.press('Enter');
  // As Claude Code tidied it; no tab for the command.
  await expect(title).toHaveText('Table fixes');
  await expect(page.locator('.tab')).toHaveCount(1);
  // The sidebar row's {title} is the name now, not the first prompt.
  await expect(row).toHaveText(/Table fixes$/);
  const t =(await title.boundingBox())!;
  const bar = (await page.locator('.session:not([hidden]) .titlebar').boundingBox())!;
  expect(t.y + t.height).toBeLessThanOrEqual(bar.y);
  expect(await dragsAt(page, t.x + t.width / 2, t.y + t.height / 2)).toBe(true);
  await page.screenshot({ path: shot('session-title') });
});

test('a click on the permission mode badge switches the mode', async () => {
  run = await launch(SHOWCASE);
  const { page, project } = run;
  await newSession(page, project);
  await page.keyboard.type('Fix the table alignment');
  await page.keyboard.press('Enter');
  const badge = page.locator('.statusbar .badge');
  await expect(badge).toHaveText('accept edits', { timeout: 20000 });
  await badge.click();
  const picker = page.locator('.picker');
  await expect(picker.locator('.picker-title')).toContainText('Permission mode');
  await expect(picker.locator('.picker-item.picked')).toContainText('accept edits');
  await picker.locator('.picker-item', { hasText: 'plan mode' }).click();
  await expect(page.locator('.toast')).toHaveText('Permission mode: plan mode');
  await expect(badge).toHaveText('plan mode');
  await expect(badge).toHaveClass(/\bplan\b/);
  await expect(picker).toHaveCount(0);
  await expect(page.locator('.composer textarea')).toBeFocused();
});

test('a permission prompt offers "always allow"; ⌥M steps the permission mode and ⌥O turns fast mode on and off', async () => {
  const answers = join(mkdtempSync('/tmp/bga-'), 'answers.json');
  run = await launch(tuiFixture('permission-suggestions.jsonl'), { BINDER_FAKE_ANSWERS_OUT: answers, BINDER_FAKE_REFUSE_MODES: 'auto,bypassPermissions' });
  const { page, project } = run;
  await newSession(page, project);
  await page.keyboard.type('make a folder');
  await page.keyboard.press('Enter');
  const card = page.locator('.question');
  await expect(card).toContainText('Allow Bash?', { timeout: 20000 });
  await expect(card.locator('.option .label')).toHaveText(['Allow', 'Always allow Bash(mkdir -p alpha && echo made)', 'Allow, and accept all edits from now on', 'Deny']);
  await expect(card.locator('.option .desc').first()).toHaveText('this project, in .claude/settings.local.json');
  await page.screenshot({ path: shot('always-allow') });
  await page.keyboard.press('2');
  await expect(card).toHaveCount(0);
  await expect.poll(() => existsSync(answers) && JSON.parse(readFileSync(answers, 'utf8')).response.response.updatedPermissions.map((u: { type: string }) => u.type)).toEqual(['addRules', 'addDirectories']);
  await expect(page.locator('.md').last()).toHaveText('Made the folder.');

  // ⌥M: manual, then accept edits, then plan; auto and bypass are refused here, so back to manual.
  const mode = page.locator('.statusbar .badge:not(.fast)');
  await expect(mode).toHaveText('manual');
  await page.keyboard.press('Alt+KeyM');
  await expect(mode).toHaveText('accept edits');
  await page.keyboard.press('Alt+KeyM');
  await expect(mode).toHaveText('plan mode');
  await page.keyboard.press('Alt+KeyM');
  await expect(page.locator('.toast')).toHaveText('Permission mode: manual');
  await expect(mode).toHaveText('manual');

  // ⌥O shows the badge; a click on it turns fast mode off.
  const fast = page.locator('.statusbar .badge.fast');
  await expect(fast).toHaveCount(0);
  await page.keyboard.press('Alt+KeyO');
  await expect(page.locator('.toast')).toHaveText('Fast mode on');
  await expect(fast).toHaveText('↯ fast');
  await expect(page.locator('.composer textarea')).toHaveValue('');
  await page.screenshot({ path: shot('fast-mode') });
  await fast.click();
  await expect(page.locator('.toast')).toHaveText('Fast mode off');
  await expect(fast).toHaveCount(0);
  // /fast says why when fast mode cannot serve; this fake account can.
  await page.keyboard.type('/fast on');
  await page.keyboard.press('Enter');
  await expect(fast).toHaveText('↯ fast');
});

test('a notification macOS fails to show is logged', async () => {
  run = await launch(tuiFixture('two-turns-stdin.jsonl'));
  const { app, page } = run;
  const logged: string[] = [];
  app.on('console', (m) => logged.push(m.text()));
  await page.evaluate(() => window.binder.notify({ title: 'Done', body: 'A', conn: 'none' }));
  const notes = () => app.evaluate(() => (globalThis as unknown as { __notes: unknown[] }).__notes.length);
  await expect.poll(notes).toBe(1);
  await app.evaluate(() => (globalThis as unknown as { __notes: { emit: (e: string, ...args: unknown[]) => void }[] }).__notes[0].emit('failed', {}, 'UNErrorDomain error 1'));
  await expect.poll(() => logged).toContain('Notification failed: UNErrorDomain error 1');
});

test('a notification says when a turn ends or a question arrives in a session you are not looking at; a click brings it forward', async () => {
  run = await launch(tuiFixture('ask-and-interrupt.jsonl'), { BINDER_FAKE_DELAY_MS: '300' });
  const { app, page, project, tmp } = run;
  const notes = () => app.evaluate(() => (globalThis as unknown as { __notes: { title: string; body: string }[] }).__notes.map((n) => ({ title: n.title, body: n.body })));
  await newSession(page, project);
  await page.keyboard.type('ask me a color');
  await page.keyboard.press('Enter');
  // Another session takes the window while the first one works.
  const other = join(tmp, 'other');
  mkdirSync(other);
  await newSession(page, other);
  await expect.poll(notes, { timeout: 20000 }).toEqual([{ title: 'ask me a color', body: 'Which color do you prefer?' }]);
  await app.evaluate(() => (globalThis as unknown as { __notes: { emit: (e: string) => void }[] }).__notes[0].emit('click'));
  await expect(page.locator('.session:not([hidden]) .question')).toContainText('Which color do you prefer?');
});

test('a notification says a turn finished in a session you are not looking at, with the first line of its answer', async () => {
  run = await launch(tuiFixture('two-turns-stdin.jsonl'), { BINDER_FAKE_DELAY_MS: '300' });
  const { app, page, project, tmp } = run;
  const notes = () => app.evaluate(() => (globalThis as unknown as { __notes: { title: string; body: string }[] }).__notes.map((n) => ({ title: n.title, body: n.body })));
  await newSession(page, project);
  await page.keyboard.type('first prompt');
  await page.keyboard.press('Enter');
  const other = join(tmp, 'other');
  mkdirSync(other);
  await newSession(page, other);
  await expect.poll(notes, { timeout: 20000 }).toEqual([{ title: 'first prompt', body: 'A' }]);
});

test('notifications stay off when config.json says so', async () => {
  const dir = mkdtempSync('/tmp/bgn-');
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ notifications: false }));
  run = await launch(tuiFixture('ask-and-interrupt.jsonl'), { BINDER_FAKE_DELAY_MS: '100', BINDER_CONFIG: config });
  const { app, page, project, tmp } = run;
  await newSession(page, project);
  await page.keyboard.type('ask me a color');
  await page.keyboard.press('Enter');
  const other = join(tmp, 'other');
  mkdirSync(other);
  await newSession(page, other);
  await expect(page.locator('.sidebar')).toContainText('waiting for you', { timeout: 20000 });
  expect(await app.evaluate(() => (globalThis as unknown as { __notes: unknown[] }).__notes.length)).toBe(0);
});

test('a session in the other half of split view is on screen: its question posts no notification', async () => {
  run = await launch(tuiFixture('ask-and-interrupt.jsonl'), { BINDER_FAKE_DELAY_MS: '300' });
  const { app, page, project, tmp } = run;
  // As if the window had the focus (tests show it without taking it).
  await page.evaluate(() => void (document.hasFocus = () => true));
  await newSession(page, project);
  await page.keyboard.type('ask me a color');
  await page.keyboard.press('Enter');
  const other = join(tmp, 'other');
  mkdirSync(other);
  await newSession(page, other);
  await page.keyboard.press('Meta+Backslash');
  await expect(page.locator('.session.split-right .question')).toContainText('Which color do you prefer?', { timeout: 30000 });
  await page.waitForTimeout(500);
  expect(await app.evaluate(() => (globalThis as unknown as { __notes: unknown[] }).__notes.length)).toBe(0);
});

test('a click on a notification for a session closed since leaves the window as it is', async () => {
  run = await launch(tuiFixture('ask-and-interrupt.jsonl'), { BINDER_FAKE_DELAY_MS: '300' });
  const { app, page, project, tmp } = run;
  await newSession(page, project);
  await page.keyboard.type('ask me a color');
  await page.keyboard.press('Enter');
  const other = join(tmp, 'other');
  mkdirSync(other);
  await newSession(page, other);
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __notes: unknown[] }).__notes.length), { timeout: 30000 }).toBe(1);
  // Close the first session; the other one shows.
  await page.keyboard.press('Meta+1');
  await page.keyboard.press('Meta+w');
  await expect(page.locator('.session')).toHaveCount(1);
  // The click, without the window coming forward on this screen.
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) Object.assign(w, { show: () => {}, focus: () => {} });
    (globalThis as unknown as { __notes: { emit: (e: string) => void }[] }).__notes[0].emit('click');
  });
  await expect(page.locator('.toast')).toHaveText('That session is closed now (⌘K opens it again)');
  await expect(page.locator('.session:not([hidden]) .composer textarea')).toBeVisible();
  await expect(page.locator('.empty-main')).toHaveCount(0);
});

// A stand-in for claude.ai, and a turn that links to a doc there and to a page elsewhere.
async function claudeStandIn(): Promise<{ origin: string; fixture: string; server: Server }> {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<title>Demo doc</title><h1>Doc at ${req.url}</h1>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fixture = join(mkdtempSync('/tmp/bgl-'), 'link.jsonl');
  const e = (o: object) => JSON.stringify({ session_id: 'link', parent_tool_use_id: null, ...o });
  writeFileSync(
    fixture,
    [
      e({ type: 'system', subtype: 'init', cwd: '/tmp', model: 'claude-opus-5-5', permissionMode: 'default' }),
      e({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: `Here is [the doc](${origin}/artifact/demo-1), and [another page](https://example.com/x).` }] } }),
      e({ type: 'result', subtype: 'success', is_error: false, duration_ms: 100, num_turns: 1, total_cost_usd: 0 }),
    ].join('\n') + '\n',
  );
  return { origin, fixture, server };
}

// shell.openExternal, recorded instead of opening the browser.
async function recordExternal(app: ElectronApplication): Promise<() => Promise<string[]>> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened: string[] };
    g.__opened = [];
    shell.openExternal = async (url: string) => void g.__opened.push(url);
  });
  return () => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);
}

// The URL of each page the main process draws over the window (web panes, the side pane).
const viewUrls = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.map((v) => (v as unknown as { webContents?: { getURL(): string } }).webContents?.getURL() ?? ''));

test('a claude.ai link opens beside the session; ⌃\\ closes the pane and opens it again; other links go to the browser', async () => {
  const { origin, fixture, server } = await claudeStandIn();
  try {
    run = await launch(fixture, { BINDER_CLAUDE_ORIGIN: origin });
    const { app, page, project } = run;
    const opened = await recordExternal(app);
    await newSession(page, project);
    await page.keyboard.type('link me a doc');
    await page.keyboard.press('Enter');
    await page.locator('.md a', { hasText: 'the doc' }).click();
    const side = page.locator('.side-pane');
    await expect(side.locator('.side-title')).toHaveText('Demo doc', { timeout: 20000 });
    expect(await viewUrls(app)).toContain(`${origin}/artifact/demo-1`);
    // The session narrows to make room; the pane fills the rest.
    const s = (await page.locator('.session:not([hidden])').boundingBox())!;
    const p = (await side.boundingBox())!;
    expect(s.x + s.width).toBeLessThanOrEqual(p.x + 1);
    await page.screenshot({ path: shot('side-pane') });

    await page.keyboard.press('Control+Backslash');
    await expect(side).toHaveCount(0);
    await page.keyboard.press('Control+Backslash');
    await expect(side.locator('.side-title')).toHaveText('Demo doc');
    await side.locator('.side-open').click();
    await expect.poll(opened).toEqual([`${origin}/artifact/demo-1`]);
    await side.locator('.side-close').click();
    await expect(side).toHaveCount(0);

    await page.locator('.md a', { hasText: 'another page' }).click();
    await expect.poll(opened).toEqual([`${origin}/artifact/demo-1`, 'https://example.com/x']);
    await expect(side).toHaveCount(0);
  } finally {
    server.close();
  }
});

// Whether each page the main process draws over the window (here, the side pane's) is shown.
const viewsShown = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.map((v) => v.getVisible()));

test('closing the side pane (× or ⌃\\) takes its page off the window, and ⌃\\ brings back the page it was on', async () => {
  const { origin, fixture, server } = await claudeStandIn();
  try {
    run = await launch(fixture, { BINDER_CLAUDE_ORIGIN: origin });
    const { app, page, project } = run;
    await newSession(page, project);
    await page.keyboard.type('link me a doc');
    await page.keyboard.press('Enter');
    await page.locator('.md a', { hasText: 'the doc' }).click();
    const side = page.locator('.side-pane');
    await expect(side.locator('.side-title')).toHaveText('Demo doc', { timeout: 20000 });
    await expect.poll(() => viewsShown(app)).toEqual([true]);
    await side.locator('.side-close').click();
    await expect(side).toHaveCount(0);
    await expect.poll(() => viewsShown(app)).toEqual([false]);
    await page.keyboard.press('Control+Backslash');
    await expect.poll(() => viewsShown(app)).toEqual([true]);
    // The page moves on inside the pane; ⌃\ closes it, and opens that page again, not the link's.
    await expect.poll(() => app.windows().some((p) => p.url().startsWith(origin))).toBe(true);
    const doc = app.windows().find((p) => p.url().startsWith(origin))!;
    await doc.evaluate(() => void (location.href = '/artifact/demo-2'));
    await expect(side.locator('.side-title')).toHaveAttribute('title', `${origin}/artifact/demo-2`, { timeout: 10000 });
    await page.keyboard.press('Control+Backslash');
    await expect(side).toHaveCount(0);
    await expect.poll(() => viewsShown(app)).toEqual([false]);
    await page.keyboard.press('Control+Backslash');
    await expect(side.locator('.side-title')).toHaveAttribute('title', `${origin}/artifact/demo-2`);
    await expect.poll(() => viewUrls(app)).toEqual([`${origin}/artifact/demo-2`]);
    await expect.poll(() => viewsShown(app)).toEqual([true]);
  } finally {
    server.close();
  }
});

test('split view beside the side pane fits a 1280 px window', async () => {
  const { origin, fixture, server } = await claudeStandIn();
  try {
    run = await launch(fixture, { BINDER_CLAUDE_ORIGIN: origin });
    const { app, page, project, tmp } = run;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860));
    await newSession(page, project);
    await page.keyboard.type('link me a doc');
    await page.keyboard.press('Enter');
    await page.locator('.md a', { hasText: 'the doc' }).click();
    await expect(page.locator('.side-pane .side-title')).toHaveText('Demo doc', { timeout: 20000 });
    const other = join(tmp, 'other');
    mkdirSync(other);
    await newSession(page, other);
    await page.keyboard.press('Meta+Backslash');
    await expect(page.locator('.main.split > .session:not([hidden])')).toHaveCount(2);
    expect(await page.evaluate(() => innerWidth)).toBe(1280);
    // Nothing scrolls sideways: not the window, not either half.
    const overflow = () => page.evaluate(() => [document.documentElement, ...document.querySelectorAll('.main.split > .session .scroller')].map((el) => el.scrollWidth - el.clientWidth));
    await expect.poll(overflow).toEqual([0, 0, 0]);
  } finally {
    server.close();
  }
});

test('claude.ai links open in the browser when config.json says so', async () => {
  const { origin, fixture, server } = await claudeStandIn();
  try {
    const config = join(mkdtempSync('/tmp/bgn-'), 'config.json');
    writeFileSync(config, JSON.stringify({ claudeLinks: 'browser' }));
    run = await launch(fixture, { BINDER_CLAUDE_ORIGIN: origin, BINDER_CONFIG: config });
    const { app, page, project } = run;
    const opened = await recordExternal(app);
    await newSession(page, project);
    await page.keyboard.type('link me a doc');
    await page.keyboard.press('Enter');
    await page.locator('.md a', { hasText: 'the doc' }).click();
    await expect.poll(opened).toEqual([`${origin}/artifact/demo-1`]);
    await expect(page.locator('.side-pane')).toHaveCount(0);
  } finally {
    server.close();
  }
});

// The side pane's view, as the main process has it.
const sideView = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const v = BrowserWindow.getAllWindows()[0].contentView.children.find((c) => c instanceof WebContentsView);
    return v instanceof WebContentsView ? { url: v.webContents.getURL(), shown: v.getVisible() } : null;
  });

test("the side pane's page keeps claude.ai new tabs and in-page moves, and gives the window ⌃] and ⌃\\", async () => {
  const { origin, fixture, server } = await claudeStandIn();
  try {
    run = await launch(fixture, { BINDER_CLAUDE_ORIGIN: origin });
    const { app, page, project } = run;
    const opened = await recordExternal(app);
    await newSession(page, project);
    await page.keyboard.type('link me a doc');
    await page.keyboard.press('Enter');
    await page.locator('.md a', { hasText: 'the doc' }).click();
    const side = page.locator('.side-pane');
    await expect(side.locator('.side-title')).toHaveText('Demo doc', { timeout: 20000 });
    await expect.poll(() => app.windows().some((p) => p.url().startsWith(origin))).toBe(true);
    const doc = app.windows().find((p) => p.url().startsWith(origin))!;
    // A new tab on claude.ai itself loads in the pane.
    await doc.evaluate(() => void window.open('/artifact/demo-2'));
    await expect.poll(async () => (await sideView(app))?.url).toBe(`${origin}/artifact/demo-2`);
    // claude.ai moves in the page; Open in browser opens where it is.
    await doc.evaluate(() => history.pushState({}, '', '/artifact/demo-3'));
    await expect(side.locator('.side-title')).toHaveAttribute('title', `${origin}/artifact/demo-3`);
    await side.locator('.side-open').click();
    await expect.poll(opened).toEqual([`${origin}/artifact/demo-3`]);
    // Keys typed in the page.
    const press = (keyCode: string) =>
      app.evaluate(({ BrowserWindow, WebContentsView }, keyCode) => {
        const v = BrowserWindow.getAllWindows()[0].contentView.children.find((c) => c instanceof WebContentsView) as InstanceType<typeof WebContentsView>;
        for (const type of ['keyDown', 'keyUp'] as const) v.webContents.sendInputEvent({ type, keyCode, modifiers: ['control'] });
      }, keyCode);
    await press(']');
    await expect(page.locator('.toast')).toHaveText('No artifact published in this session yet');
    await press('\\');
    await expect(side).toHaveCount(0);
  } finally {
    server.close();
  }
});

test("a reload or a crashed page hides the side pane's page", async () => {
  const { origin, fixture, server } = await claudeStandIn();
  try {
    // The host outlives the reloads.
    run = await launch(fixture, { BINDER_CLAUDE_ORIGIN: origin, BINDER_HOST_IDLE_MS: '60000' });
    const { app, page, project } = run;
    await newSession(page, project);
    await page.keyboard.type('link me a doc');
    await page.keyboard.press('Enter');
    const link = page.locator('.session:not([hidden]) .md a', { hasText: 'the doc' });
    await link.click();
    await expect.poll(async () => (await sideView(app))?.shown, { timeout: 20000 }).toBe(true);
    await page.reload();
    await expect.poll(async () => (await sideView(app))?.shown).toBe(false);
    await expect(page.locator('.side-pane')).toHaveCount(0);
    // The session comes back; its link opens the pane again.
    await link.click({ timeout: 30000 });
    await expect.poll(async () => (await sideView(app))?.shown, { timeout: 20000 }).toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
    await expect.poll(async () => (await sideView(app))?.shown).toBe(false);
  } finally {
    server.close();
  }
});

// The image fixture, its answer pointing at an image on a local server too.
async function imageTurn(): Promise<{ fixture: string; server: Server; remote: string }> {
  const png = readFileSync(join(BINDERTUI, 'fixtures/orange.png'));
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'image/png');
    res.end(png);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const remote = `http://127.0.0.1:${(server.address() as AddressInfo).port}/remote.png`;
  const fixture = join(mkdtempSync('/tmp/bgi-'), 'image.jsonl');
  const lines = readFileSync(tuiFixture('image-result.jsonl'), 'utf8').replace('Here it is again: ![orange](orange.png)', `Here it is again: ![orange](orange.png) and from the web: ![remote](${remote})`);
  writeFileSync(fixture, lines);
  return { fixture, server, remote };
}

test("images: a tool's, one pasted into the prompt, a markdown file here, and a web one when asked", async () => {
  const { fixture, server } = await imageTurn();
  try {
    run = await launch(fixture);
    const { page, project } = run;
    writeFileSync(join(project, 'orange.png'), readFileSync(join(BINDERTUI, 'fixtures/orange.png')));
    await newSession(page, project);
    // An image pasted into the prompt.
    const png64 = readFileSync(join(BINDERTUI, 'fixtures/orange.png')).toString('base64');
    await page.locator('.composer textarea').evaluate((el, b64) => {
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'orange.png', { type: 'image/png' }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, png64);
    await expect(page.locator('.composer textarea')).toHaveValue(/\[Image #1\]/);
    await page.keyboard.type(' what is this?');
    await page.keyboard.press('Enter');
    const md = page.locator('.md').last();
    await expect(md).toContainText('It is an orange square.', { timeout: 20000 });
    // The prompt's image, in its bubble.
    await expect(page.locator('.prompt-images img.inline-img')).toHaveAttribute('src', /^data:image\/png;base64,/);
    // The tool's image shows once the work is open.
    await page.keyboard.press('Control+e');
    await expect(page.locator('.tool-images img.inline-img')).toHaveAttribute('src', /^data:image\/png;base64,/);
    // A markdown image of a file in the session's folder.
    await expect(md.locator('img.inline-img')).toHaveCount(1);
    // One from the web waits to be asked for.
    const load = md.locator('button.md-image');
    await expect(load).toContainText('load from 127.0.0.1');
    await load.click();
    await expect(md.locator('img.inline-img')).toHaveCount(2);
    await page.screenshot({ path: shot('images') });
  } finally {
    server.close();
  }
});

test('a file:// image loads as its path does, and a web image you loaded stays when a follow-up moves its turn up', async () => {
  const { fixture, server } = await imageTurn();
  try {
    const dir = mkdtempSync('/tmp/bgi-');
    writeFileSync(join(dir, 'by-url.png'), readFileSync(join(BINDERTUI, 'fixtures/orange.png')));
    writeFileSync(fixture, readFileSync(fixture, 'utf8').replace('and from the web:', `and by URL: ![by url](file://${dir}/by-url.png) and from the web:`));
    run = await launch(fixture);
    const { page, project } = run;
    writeFileSync(join(project, 'orange.png'), readFileSync(join(BINDERTUI, 'fixtures/orange.png')));
    await newSession(page, project);
    await page.keyboard.type('what is this?');
    await page.keyboard.press('Enter');
    const first = page.locator('.turn').first().locator('.md');
    await expect(first).toContainText('It is an orange square.', { timeout: 20000 });
    // The relative path and the file:// URL show at once; the web one waits.
    await expect(first.locator('img.inline-img')).toHaveCount(2);
    await first.locator('button.md-image').click();
    await expect(first.locator('img.inline-img')).toHaveCount(3);
    // A follow-up into the tab: the first turn moves among the earlier ones.
    await page.keyboard.type('and again?');
    await page.keyboard.press('Control+Enter');
    await expect(page.locator('.turn')).toHaveCount(2, { timeout: 20000 });
    await expect(first.locator('img.inline-img')).toHaveCount(3);
    await expect(first.locator('button.md-image')).toHaveCount(0);
  } finally {
    server.close();
  }
});

test("a tool's file opens in config.json's editor on a click, Option-click shows it in Finder, and /files lists it", async () => {
  const { fixture, server } = await imageTurn();
  try {
    mkdirSync('/private/tmp/demo', { recursive: true });
    writeFileSync('/private/tmp/demo/orange.png', '');
    const dir = mkdtempSync('/tmp/bgn-');
    const opened = join(dir, 'opened');
    const config = join(dir, 'config.json');
    writeFileSync(config, JSON.stringify({ editor: `printf '%s:%s\\n' {file} {line} >> ${opened}` }));
    run = await launch(fixture, { BINDER_CONFIG: config });
    const { app, page, project } = run;
    await app.evaluate(({ shell }) => {
      const g = globalThis as unknown as { __revealed: string[] };
      g.__revealed = [];
      shell.showItemInFolder = (p: string) => void g.__revealed.push(p);
    });
    await newSession(page, project);
    await page.keyboard.type('what is this?');
    await page.keyboard.press('Enter');
    await expect(page.locator('.md').last()).toContainText('It is an orange square.', { timeout: 20000 });
    await page.keyboard.press('Control+e');
    const path = page.locator('.tool-arg.file-link');
    await path.click();
    await expect.poll(() => (existsSync(opened) ? readFileSync(opened, 'utf8') : '')).toBe('/private/tmp/demo/orange.png:1\n');
    await path.click({ modifiers: ['Alt'] });
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __revealed: string[] }).__revealed)).toEqual(['/private/tmp/demo/orange.png']);
    // The work stays as it was: the click opened the file, not the call.
    await expect(page.locator('.tool-images')).toBeVisible();

    await page.keyboard.type('/files');
    await page.keyboard.press('Enter');
    const picker = page.locator('.picker');
    await expect(picker.locator('.picker-item')).toHaveText([/\/private\/tmp\/demo\/orange\.png.*Read/]);
    await page.keyboard.press('Enter');
    await expect.poll(() => readFileSync(opened, 'utf8').split('\n').filter(Boolean).length).toBe(2);
  } finally {
    server.close();
  }
});

test('the latest todos and the plan stay pinned above the prompt; a click or ⌃T opens them', async () => {
  run = await launch(tuiFixture('todos.jsonl'));
  const { page, project } = run;
  await newSession(page, project);
  await page.keyboard.type('fix the parser');
  await page.keyboard.press('Enter');
  const todos = page.locator('.pinned-todos');
  await expect(todos.locator('.pinned-head')).toHaveText('▸ Todos 1/3 · ◐ Writing the tests', { timeout: 20000 });
  await page.keyboard.press('Control+t');
  await expect(todos.locator('li')).toHaveText(['☑ Read the parser', '◐ Write the tests', '☐ Fix the bug']);
  await expect(todos.locator('li.completed')).toHaveCount(1);
  await page.screenshot({ path: shot('pinned') });
  await todos.locator('.pinned-head').click();
  await expect(todos.locator('li')).toHaveCount(0);
});

test('the pinned todos are the latest Claude wrote in send order, also when a follow-up goes into an older tab', async () => {
  const tmp = mkdtempSync('/tmp/bg-');
  mkdirSync(join(tmp, 'app'));
  const fixture = join(tmp, 'todos.jsonl');
  const e = (o: object) => JSON.stringify({ session_id: 'todos', parent_tool_use_id: null, ...o });
  // Three turns, each writing its own list: two tabs, then a follow-up into the first.
  const turn = (n: number, todo: string) => [
    e({ type: 'system', subtype: 'init', cwd: '/tmp', model: 'claude-opus-5-5', permissionMode: 'default' }),
    e({ type: 'assistant', message: { id: `m${n}`, role: 'assistant', content: [{ type: 'tool_use', id: `t${n}`, name: 'TodoWrite', input: { todos: [{ content: todo, status: 'in_progress', activeForm: `Doing ${todo}` }, { content: 'Last', status: 'pending', activeForm: 'Doing last' }] } }] } }),
    e({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: 'Todos have been modified successfully.' }] } }),
    e({ type: 'assistant', message: { id: `r${n}`, role: 'assistant', content: [{ type: 'text', text: `X${n} done.` }] } }),
    e({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, num_turns: 1, total_cost_usd: 0 }),
  ];
  writeFileSync(fixture, [...turn(1, 'A'), ...turn(2, 'B'), ...turn(3, 'Z')].join('\n') + '\n');
  run = await launch(fixture, {}, { reuse: tmp });
  const { page, project } = run;
  await newSession(page, project);
  const head = page.locator('.pinned-todos .pinned-head');
  const say = async (text: string, key = 'Enter') => {
    await page.keyboard.type(text);
    await page.keyboard.press(key);
  };
  await say('first tab');
  await expect(page.locator('.md', { hasText: 'X1 done.' })).toBeVisible({ timeout: 20000 });
  await say('second tab');
  await expect(page.locator('.md', { hasText: 'X2 done.' })).toBeVisible({ timeout: 20000 });
  await expect(head).toHaveText('▸ Todos 0/2 · ◐ Doing B');
  await page.keyboard.press('Alt+1');
  await say('follow up', 'Control+Enter');
  await expect(page.locator('.md', { hasText: 'X3 done.' })).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.tab')).toHaveCount(2);
  await expect(head).toHaveText('▸ Todos 0/2 · ◐ Doing Z');
});

test('the current plan stays pinned, and opens to its markdown', async () => {
  const answers = join(mkdtempSync('/tmp/bga-'), 'answers.json');
  run = await launch(tuiFixture('plan-approval.jsonl'), { BINDER_FAKE_ANSWERS_OUT: answers });
  const { page, project } = run;
  await newSession(page, project);
  await page.keyboard.type('plan it');
  await page.keyboard.press('Enter');
  const plan = page.locator('.pinned-plan');
  await expect(plan.locator('.pinned-head')).toHaveText('▸ Plan: Add hello.txt · waiting for you', { timeout: 20000 });
  await page.keyboard.press('3');
  await expect(plan.locator('.pinned-head')).toHaveText('▸ Plan: Add hello.txt · approved');
  await plan.locator('.pinned-head').click();
  await expect(plan.locator('.pinned-plan-body h1')).toHaveText('Add hello.txt');
});

test('a PDF and a text file pasted into the prompt go to Claude as a document and as text', async () => {
  const input = join(mkdtempSync('/tmp/bgi-'), 'input.jsonl');
  run = await launch(tuiFixture('two-turns-stdin.jsonl'), { BINDER_FAKE_INPUT_OUT: input });
  const { page, project } = run;
  await newSession(page, project);
  const box = page.locator('.composer textarea');
  await box.evaluate((el) => {
    const data = new DataTransfer();
    data.items.add(new File(['%PDF-1.4 hello'], 'notes.pdf', { type: 'application/pdf' }));
    data.items.add(new File(['# Plan\n'], 'plan.md', { type: '' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(box).toHaveValue('[File #1: notes.pdf][File #2: plan.md]');
  await expect(page.locator('.attachment.file')).toHaveText(['PDFFile #1: notes.pdf', 'TXTFile #2: plan.md']);
  await page.keyboard.type(' read these');
  await page.keyboard.press('Enter');
  await expect.poll(() => (existsSync(input) ? readFileSync(input, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.type === 'user') : null), { timeout: 20000 }).toBeTruthy();
  const sent = readFileSync(input, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.type === 'user');
  expect(sent.message.content[1]).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from('%PDF-1.4 hello').toString('base64') }, title: 'notes.pdf' });
  expect(sent.message.content[2]).toEqual({ type: 'text', text: 'Attached file plan.md:\n\n```\n# Plan\n\n```' });
});

test('a text file with no extension (a Makefile) goes as text, as in the TUI', async () => {
  const input = join(mkdtempSync('/tmp/bgi-'), 'input.jsonl');
  run = await launch(tuiFixture('two-turns-stdin.jsonl'), { BINDER_FAKE_INPUT_OUT: input });
  const { page, project } = run;
  await newSession(page, project);
  const box = page.locator('.composer textarea');
  await box.evaluate((el) => {
    const data = new DataTransfer();
    data.items.add(new File(['all:\n\techo hi\n'], 'Makefile', { type: '' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(box).toHaveValue('[File #1: Makefile]');
  await expect(page.locator('.attachment.file')).toHaveText(['TXTFile #1: Makefile']);
  await page.keyboard.type(' read it');
  await page.keyboard.press('Enter');
  const user = () => (existsSync(input) ? readFileSync(input, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.type === 'user') : null);
  await expect.poll(user, { timeout: 20000 }).toBeTruthy();
  expect(user().message.content[1]).toEqual({ type: 'text', text: 'Attached file Makefile:\n\n```\nall:\n\techo hi\n\n```' });
});

test('a Codex session refuses /plugins and /tasks, and a refused PDF leaves the prompt and its attachments as they were', async () => {
  const dir = mkdtempSync('/tmp/bgx-');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ agent: 'codex' }));
  run = await launch(join(BINDERTUI, 'fixtures/codex/answer.jsonl'), { BINDER_CONFIG: join(dir, 'config.json'), BINDER_CODEX_BIN: join(BINDERTUI, 'test/fakeCodex.mjs'), CODEX_HOME: join(dir, 'codex') });
  const { page, project } = run;
  await newSession(page, project);
  const box = page.locator('.composer textarea');
  const toast = page.locator('.toast');
  for (const name of ['plugins', 'tasks']) {
    await page.keyboard.type(`/${name}`);
    await page.keyboard.press('Enter');
    await expect(toast).toHaveText(`/${name} is not available in a Codex session`);
    await expect(page.locator('.picker')).toHaveCount(0);
  }
  await box.evaluate((el) => {
    const data = new DataTransfer();
    data.items.add(new File(['%PDF-1.4 hello'], 'notes.pdf', { type: 'application/pdf' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.keyboard.type(' read');
  await page.keyboard.press('Enter');
  await expect(toast).toHaveText(/not PDFs/);
  await expect(box).toHaveValue('[File #1: notes.pdf] read');
  await expect(page.locator('.attachment.file')).toHaveText(['PDFFile #1: notes.pdf']);
});

test('attachments over 60 MB once encoded are refused before anything is sent, and stay in the prompt', async () => {
  const input = join(mkdtempSync('/tmp/bgi-'), 'input.jsonl');
  run = await launch(tuiFixture('two-turns-stdin.jsonl'), { BINDER_FAKE_INPUT_OUT: input });
  const { page, project } = run;
  await newSession(page, project);
  const box = page.locator('.composer textarea');
  // Two PDFs under the 32 MB limit each, about 83 MB together as base64.
  await box.evaluate((el) => {
    const data = new DataTransfer();
    for (const name of ['a.pdf', 'b.pdf']) data.items.add(new File([new Uint8Array(31 * 1024 * 1024)], name, { type: 'application/pdf' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(box).toHaveValue('[File #1: a.pdf][File #2: b.pdf]', { timeout: 20000 });
  await page.keyboard.type(' read both');
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast')).toHaveText('The attachments come to 83 MB encoded, over the 60 MB one prompt can carry');
  await expect(box).toHaveValue('[File #1: a.pdf][File #2: b.pdf] read both');
  await expect(page.locator('.attachment.file')).toHaveCount(2);
  await expect(page.locator('.banner')).toHaveCount(0);
  expect((existsSync(input) ? readFileSync(input, 'utf8') : '').includes('"type":"user"')).toBe(false);
});

test('⌘K finds a session by what Claude said, and ⌃X archives it out of the list until ⌃D', async () => {
  run = await launch(SHOWCASE);
  const { page, tmp } = run;
  const dir = join(tmp, 'claude', 'projects', '-private-tmp');
  mkdirSync(dir, { recursive: true });
  const line = (o: object) => JSON.stringify(o) + '\n';
  writeFileSync(join(dir, '44444444-4444-4444-8444-444444444444.jsonl'), line({ type: 'user', cwd: '/private/tmp', entrypoint: 'cli', message: { content: 'look at the logs' } }) + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'The pelican service restarted twice.' }] } }));
  await page.keyboard.press('Meta+k');
  const picker = page.locator('.picker');
  await page.keyboard.press('Control+a');
  await expect(picker.locator('.picker-item', { hasText: 'look at the logs' })).toBeVisible({ timeout: 20000 });
  await page.keyboard.type('pelican');
  await expect(picker.locator('.picker-item')).toHaveCount(1);
  await expect(picker.locator('.picker-item')).toContainText('The pelican service restarted twice.', { timeout: 20000 });
  await page.keyboard.press('Control+x');
  await expect(page.locator('.toast')).toHaveText('Archived look at the logs');
  await expect(picker.locator('.picker-item')).toHaveCount(0);
  await page.keyboard.press('Control+d');
  await expect(picker.locator('.picker-title')).toContainText('Archived sessions');
  await expect(picker.locator('.picker-item', { hasText: 'look at the logs' })).toBeVisible();
  await page.keyboard.press('Control+x');
  await expect(page.locator('.toast')).toHaveText('Unarchived look at the logs');
});

test('a workflow asks with its card, and its run shows its phases and agents in /tasks', async () => {
  const answers = join(mkdtempSync('/tmp/bga-'), 'answers.json');
  run = await launch(tuiFixture('workflow.jsonl'), { BINDER_FAKE_ANSWERS_OUT: answers });
  const { page, project } = run;
  await newSession(page, project);
  await page.keyboard.type('run a workflow');
  await page.keyboard.press('Enter');
  const card = page.locator('.question');
  await expect(card.locator('.q')).toHaveText('Run the workflow hello-probe?', { timeout: 20000 });
  await expect(card.locator('.wf-desc')).toHaveText('Single agent call that replies with one word');
  await expect(card.locator('.wf-phases li')).toHaveText(['Greet', 'Check']);
  await expect(card.locator('.tool-input')).toHaveCount(0);
  await expect(card.locator('.option .label')).toHaveText(['Run once', 'Always allow workflows', 'Deny']);
  await page.screenshot({ path: shot('workflow-card') });
  await page.keyboard.press('1');
  await expect.poll(() => existsSync(answers) && JSON.parse(readFileSync(answers, 'utf8')).response.response).toMatchObject({ behavior: 'allow' });
  expect(JSON.parse(readFileSync(answers, 'utf8')).response.response.updatedPermissions).toBeUndefined();
  await expect(page.locator('.md').last()).toHaveText('The workflow is running.');
  await page.keyboard.type('/tasks');
  await page.keyboard.press('Enter');
  await expect(page.locator('.wf-phase-title')).toHaveText('Greet');
  await expect(page.locator('.wf-agent')).toContainText('Reply with the single word ok');
  await expect(page.locator('.wf-agent.start')).toHaveCount(1);
});

test('⌥⏎ in a folder outside a git repo says so', async () => {
  run = await launch(tuiFixture('two-turns-stdin.jsonl'));
  const { page, project } = run;
  await page.keyboard.press('Meta+n');
  await page.locator('.picker-search').fill(project);
  await page.locator('.picker-item', { hasText: `Start in ${project}` }).first().waitFor();
  await page.keyboard.press('Alt+Enter');
  await expect(page.locator('.session:not([hidden])')).toContainText('Could not open the session. Not in a git repo:', { timeout: 30000 });
});

test('⌥⏎ starts a session in a new worktree, and archiving the session while it is open keeps it', async () => {
  run = await launch(tuiFixture('two-turns-stdin.jsonl'));
  const { page, project, tmp } = run;
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', project, ...args], { encoding: 'utf8' });
  writeFileSync(join(project, 'README.md'), '# app\n');
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'init');
  await page.keyboard.press('Meta+n');
  await page.locator('.picker-search').fill(project);
  await page.locator('.picker-item', { hasText: `Start in ${project}` }).first().waitFor();
  await page.keyboard.press('Alt+Enter');
  await page.locator('.session:not([hidden]) .composer textarea').waitFor({ state: 'visible', timeout: 30000 });
  await page.keyboard.type('first prompt');
  await page.keyboard.press('Enter');
  await expect(page.locator('.statusbar .cwd')).toContainText('app-worktrees', { timeout: 20000 });
  const worktrees = join(tmp, 'app-worktrees');
  expect(readdirSync(worktrees)).toHaveLength(1);
  const path = join(worktrees, readdirSync(worktrees)[0]);
  expect(git('worktree', 'list')).toContain(path);
  await expect(page.locator('.md').last()).toContainText('A', { timeout: 20000 });

  await page.keyboard.press('Meta+k');
  await page.keyboard.press('Control+a');
  const row = page.locator('.picker .picker-item', { hasText: 'first prompt' });
  await expect(row).toBeVisible({ timeout: 20000 });
  await row.hover();
  await page.keyboard.press('Control+x');
  await expect(page.locator('.toast')).toHaveText('Archived. Kept the worktree: the session is still open');
  expect(existsSync(path)).toBe(true);
  expect(git('worktree', 'list')).toContain(path);
});

test('the diff pane shows the changes; comments on lines go to Claude together', async () => {
  const input = join(mkdtempSync('/tmp/bgi-'), 'input.jsonl');
  run = await launch(tuiFixture('two-turns-stdin.jsonl'), { BINDER_FAKE_INPUT_OUT: input });
  const { page, project } = run;
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', project, ...args], { encoding: 'utf8' });
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'src', 'a.ts'), 'const one = 1;\nconst two = 2;\n');
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'init');
  writeFileSync(join(project, 'src', 'a.ts'), 'const one = 1;\nconst two = 22;\n');
  writeFileSync(join(project, 'notes.md'), 'todo\n');
  await newSession(page, project);
  await page.keyboard.type('/diff');
  await page.keyboard.press('Enter');
  const pane = page.locator('.diff-pane');
  await expect(pane.locator('.diff-file-head')).toHaveText(['notes.md untracked', 'src/a.ts modified'], { timeout: 20000 });
  await expect(pane.locator('select')).toHaveValue('HEAD');
  await pane.locator('.diff-row.add', { hasText: 'const two = 22;' }).click();
  await page.keyboard.type('Why 22?');
  await page.keyboard.press('Enter');
  await pane.locator('.diff-row.add', { hasText: 'todo' }).click();
  await page.keyboard.type('Drop this file.');
  await page.keyboard.press('Enter');
  await expect(pane.locator('.diff-comment')).toHaveText(['Drop this file.', 'Why 22?']);
  await page.screenshot({ path: shot('diff-pane') });
  await pane.locator('button.send').click();
  await expect(pane).toHaveCount(0);
  await expect.poll(() => (existsSync(input) ? readFileSync(input, 'utf8') : ''), { timeout: 20000 }).toContain('Why 22?');
  const sent = readFileSync(input, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.type === 'user');
  expect(sent.message.content).toBe('My comments on the changes (against HEAD). Please address each:\n\nsrc/a.ts:2\n> const two = 22;\nWhy 22?\n\nnotes.md:1\n> todo\nDrop this file.');
});

test('/diff <branch> shows the changes against that branch; ⌘⏎ in a comment saves it and sends', async () => {
  const input = join(mkdtempSync('/tmp/bgi-'), 'input.jsonl');
  run = await launch(tuiFixture('two-turns-stdin.jsonl'), { BINDER_FAKE_INPUT_OUT: input });
  const { page, project } = run;
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', project, ...args], { encoding: 'utf8' });
  writeFileSync(join(project, 'a.ts'), 'const one = 1;\nconst two = 2;\n');
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'init');
  // Committed on a branch: nothing against HEAD, one change against main.
  git('checkout', '-qb', 'feature');
  writeFileSync(join(project, 'a.ts'), 'const one = 11;\nconst two = 2;\n');
  git('commit', '-qam', 'eleven');
  await newSession(page, project);
  await page.keyboard.type('/diff main');
  await page.keyboard.press('Enter');
  const pane = page.locator('.diff-pane');
  await expect(pane.locator('.diff-file-head')).toHaveText(['a.ts modified'], { timeout: 20000 });
  await expect(pane.locator('select')).toHaveValue('main');
  // The change starts at line 1: nothing skipped above it.
  await expect(pane.locator('.diff-row.add')).toHaveText([/const one = 11;/]);
  await expect(pane.locator('.diff-row.skip')).toHaveCount(0);
  await pane.locator('.diff-row.add').click();
  await page.keyboard.type('Why 11?');
  await page.keyboard.press('Meta+Enter');
  await expect(pane).toHaveCount(0);
  await expect.poll(() => (existsSync(input) ? readFileSync(input, 'utf8') : ''), { timeout: 20000 }).toContain('Why 11?');
  const sent = readFileSync(input, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.type === 'user');
  expect(sent.message.content).toBe('My comments on the changes (against main). Please address each:\n\na.ts:1\n> const one = 11;\nWhy 11?');
});

test("a code review's findings are a card: Fix this one and Apply fixes ask Claude in the review's tab; the diff pane marks them", async () => {
  const input = join(mkdtempSync('/tmp/bgi-'), 'input.jsonl');
  run = await launch(tuiFixture('code-review.jsonl'), { BINDER_FAKE_INPUT_OUT: input });
  const { page, project } = run;
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', project, ...args], { encoding: 'utf8' });
  writeFileSync(join(project, 'calc.js'), 'function average(xs) {\n  let sum = 0;\n  for (const x of xs) sum += x;\n  return sum / xs.length;\n}\n');
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'init');
  writeFileSync(join(project, 'calc.js'), 'function average(xs) {\n  let sum = 0;\n  for (let i = 1; i <= xs.length; i++) sum += xs[i];\n  return sum / xs.length;\n}\nfunction max(xs) {\n  let m = 0;\n  for (const x of xs) if (x > m) m = x;\n  return m;\n}\n');
  const prompts = () => (existsSync(input) ? readFileSync(input, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.type === 'user').map((m) => String(m.message.content));
  await newSession(page, project);
  await page.keyboard.type('/code-review medium');
  await page.keyboard.press('Enter');
  const card = page.locator('.findings');
  await expect(card.locator('.findings-head .dim')).toHaveText('4 findings · 2 important, 1 pre-existing, 1 nit', { timeout: 20000 });
  await expect(card.locator('.finding .place')).toHaveText(['calc.js:3', 'calc.js:7', 'calc.js:4', 'calc.js:7']);
  await expect(card.locator('.finding .sev')).toHaveText(['important', 'important', 'pre-existing', 'nit']);
  await expect(card.locator('.finding').first()).toContainText('average() returns NaN for every non-empty array.');
  await expect(card.locator('.finding').first().locator('.scenario')).toHaveText(/^Failure scenario: average\(\[2, 4, 6\]\) → sum is 4 \+ 6/);
  // The card stands in for the review's text.
  await expect(page.locator('.md', { hasText: 'Pre-existing' })).toHaveCount(0);
  await page.screenshot({ path: shot('findings-card') });

  await card.locator('.finding').first().locator('button.fix').click();
  await expect(page.locator('.toast')).toHaveText('Asked Claude to fix calc.js:3');
  await expect.poll(prompts, { timeout: 20000 }).toHaveLength(2);
  expect(prompts()[1]).toMatch(/^Fix this finding from the code review:\n\ncalc\.js:3 \(important\): average\(\) returns NaN for every non-empty array\..*\nFailure scenario: average\(\[2, 4, 6\]\)/s);
  // Into the review's tab: still one tab, with both turns.
  await expect(page.locator('.md', { hasText: 'Fixed the loop' })).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.tabbar .tab')).toHaveCount(1);
  await expect(card.locator('.finding').first().locator('button.fix')).toHaveText('Asked');
  await expect(card.locator('button.apply')).toHaveText('Apply the other 3');

  // The diff pane: each finding under its line, with its own Fix this one (the one sent already says so).
  await page.locator('.session:not([hidden]) .composer textarea').focus();
  await page.keyboard.type('/diff');
  await page.keyboard.press('Enter');
  const pane = page.locator('.diff-pane');
  await expect(pane.locator('.diff-finding .sev')).toHaveText(['important', 'pre-existing', 'important', 'nit'], { timeout: 20000 });
  const after = (line: number) => pane.locator(`.diff-row:has(.num:text-is("${line}")):not(.del) + .diff-finding`);
  await expect(after(3)).toContainText('average() returns NaN for every non-empty array');
  await expect(after(3).locator('button')).toHaveText('Asked');
  await expect(after(4)).toContainText('returns NaN for an empty array');
  await page.screenshot({ path: shot('diff-findings') });
  await after(4).locator('button').click();
  await expect(page.locator('.toast')).toHaveText('Asked Claude to fix calc.js:4');
  await expect.poll(prompts, { timeout: 20000 }).toHaveLength(3);
  expect(prompts()[2]).toMatch(/^Fix this finding from the code review:\n\ncalc\.js:4 \(pre-existing\): /);
  await expect(after(4).locator('button')).toHaveText('Asked');
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);

  // Apply fixes: the two not sent yet, in one prompt.
  await expect(card.locator('button.apply')).toHaveText('Apply the other 2');
  await card.locator('button.apply').click();
  await expect(page.locator('.toast')).toHaveText('Asked Claude to fix 2 findings');
  await expect.poll(prompts, { timeout: 20000 }).toHaveLength(4);
  expect(prompts()[3]).toMatch(/^Fix these findings from the code review, most severe first:\n\n1\. calc\.js:7 \(important\): max\(\).*\n\n2\. calc\.js:7 \(nit\): /s);
  await expect(card.locator('button.apply')).toBeDisabled();
  await expect(page.locator('.md', { hasText: 'Fixed max()' })).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.tabbar .tab')).toHaveCount(1);
});

test('with config.json findingsCard false, a review stays its text', async () => {
  const config = join(mkdtempSync('/tmp/bgn-'), 'config.json');
  writeFileSync(config, JSON.stringify({ findingsCard: false }));
  run = await launch(tuiFixture('code-review.jsonl'), { BINDER_CONFIG: config });
  const { page, project } = run;
  await newSession(page, project);
  await page.keyboard.type('/code-review medium');
  await page.keyboard.press('Enter');
  await expect(page.locator('.md', { hasText: 'Pre-existing' })).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.findings')).toHaveCount(0);
});

test('⌘P finds a file; the file pane shows it highlighted, edits and saves it, and asks before saving over a change on disk', async () => {
  run = await launch(tuiFixture('two-turns-stdin.jsonl'));
  const { page, project } = run;
  mkdirSync(join(project, 'src'));
  const calc = join(project, 'src', 'calc.ts');
  writeFileSync(calc, 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
  writeFileSync(join(project, 'README.md'), '# app\n');
  await newSession(page, project);
  await page.keyboard.press('Meta+p');
  const picker = page.locator('.picker');
  await expect(picker.locator('.picker-title')).toHaveText('Open a file');
  await expect(picker.locator('.picker-head .picker-sub')).toHaveText('2 files in the session folder');
  await page.keyboard.type('calc');
  await expect(picker.locator('.picker-item')).toHaveCount(1);
  await expect(picker.locator('.picker-item')).toContainText('calc.ts');
  await page.keyboard.press('Enter');
  const pane = page.locator('.file-pane');
  await expect(pane.locator('.file-pane-head .path')).toHaveText('src/calc.ts');
  await expect(pane.locator('.file-code .gutter')).toHaveText('1\n2\n3');
  await expect(pane.locator('.file-code .code .hljs-keyword').first()).toHaveText('export');
  await expect(pane.locator('.tree-row.current')).toHaveText('calc.ts');
  await expect(pane.locator('.tree-row.dir')).toHaveText(['▾src']);
  await page.screenshot({ path: shot('file-pane') });

  // Edit, then ⌘S.
  await pane.locator('button.edit').click();
  const box = pane.locator('textarea.file-edit');
  await expect(box).toBeFocused();
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type('// more\n');
  await expect(pane.locator('.file-pane-head .note')).toHaveText('4 lines · edited');
  await page.keyboard.press('Meta+s');
  await expect(page.locator('.toast')).toHaveText('Saved src/calc.ts');
  expect(readFileSync(calc, 'utf8')).toBe('export function add(a: number, b: number) {\n  return a + b;\n}\n// more\n');
  await expect(pane.locator('.file-pane-head .note')).toHaveText('4 lines');

  // Changed on disk meanwhile (by Claude, say): the save asks first.
  writeFileSync(calc, 'changed by Claude\n');
  utimesSync(calc, new Date(), new Date(Date.now() + 5000));
  await page.keyboard.type('// mine\n');
  await page.keyboard.press('Meta+s');
  await expect(pane.locator('.file-conflict')).toContainText('src/calc.ts changed on disk since you opened it.');
  expect(readFileSync(calc, 'utf8')).toBe('changed by Claude\n');
  await pane.locator('.file-conflict button', { hasText: 'Reload it' }).click();
  await expect(pane.locator('.file-code .code')).toContainText('changed by Claude');
  await expect(box).toHaveCount(0);
  await expect(pane.locator('.file-conflict')).toHaveCount(0);

  // Esc with unsaved edits asks once more; then Esc closes the pane.
  await pane.locator('button.edit').click();
  await page.keyboard.type('x');
  await page.keyboard.press('Escape');
  await expect(page.locator('.toast')).toHaveText('Unsaved changes: ⌘S saves them; Esc (or Discard) again drops them');
  await expect(box).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(box).toHaveCount(0);
  expect(readFileSync(calc, 'utf8')).toBe('changed by Claude\n');
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
});

test('/open opens a file by its path and the tree opens folders; with config.json fileEditing false the pane only shows files', async () => {
  const config = join(mkdtempSync('/tmp/bgn-'), 'config.json');
  writeFileSync(config, JSON.stringify({ fileEditing: false }));
  run = await launch(tuiFixture('two-turns-stdin.jsonl'), { BINDER_CONFIG: config });
  const { page, project } = run;
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'src', 'a.ts'), 'const a = 1;\n');
  writeFileSync(join(project, 'README.md'), '# app\n');
  await newSession(page, project);
  await page.keyboard.type('/open README.md');
  await page.keyboard.press('Enter');
  const pane = page.locator('.file-pane');
  await expect(pane.locator('.file-pane-head .path')).toHaveText('README.md');
  await expect(pane.locator('.file-code .code')).toContainText('# app');
  await expect(pane.locator('button.edit')).toHaveCount(0);
  await pane.locator('.tree-row.dir', { hasText: 'src' }).click();
  await pane.locator('.tree-row.file', { hasText: 'a.ts' }).click();
  await expect(pane.locator('.file-pane-head .path')).toHaveText('src/a.ts');
  await expect(pane.locator('.file-code .code')).toContainText('const a = 1;');
  await pane.locator('.file-pane-head button', { hasText: '×' }).click();
  await expect(pane).toHaveCount(0);
});

test("the file pane's edit box: Tab indents the selected lines and Shift+Tab outdents them, a CRLF file stays CRLF, and with file editing turned off mid-edit ⌘S says why", async () => {
  const config = join(mkdtempSync('/tmp/bgn-'), 'config.json');
  writeFileSync(config, '{}');
  run = await launch(tuiFixture('two-turns-stdin.jsonl'), { BINDER_CONFIG: config });
  const { page, project } = run;
  const py = 'def f():\n    a = 1\n    b = 2\n    return a + b\n';
  writeFileSync(join(project, 'block.py'), py);
  writeFileSync(join(project, 'win.txt'), 'alpha\r\nbeta\r\n');
  await newSession(page, project);
  await page.keyboard.type('/open block.py');
  await page.keyboard.press('Enter');
  const pane = page.locator('.file-pane');
  const note = pane.locator('.file-pane-head .note');
  await expect(pane.locator('.file-pane-head .path')).toHaveText('block.py');
  await pane.locator('button.edit').click();
  const box = pane.locator('textarea.file-edit');
  const lines23 = () => box.evaluate((t: HTMLTextAreaElement) => t.setSelectionRange(t.value.indexOf('    a = 1'), t.value.indexOf('    return')));
  await lines23();
  await page.keyboard.press('Tab');
  await expect(box).toHaveValue('def f():\n      a = 1\n      b = 2\n    return a + b\n');
  await page.keyboard.press('Meta+z');
  await expect(box).toHaveValue(py);
  await expect(note).toHaveText('4 lines');
  await lines23();
  await page.keyboard.press('Shift+Tab');
  await expect(box).toHaveValue('def f():\n  a = 1\n  b = 2\n    return a + b\n');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(box).toHaveCount(0);
  expect(readFileSync(join(project, 'block.py'), 'utf8')).toBe(py);

  // CRLF: a character typed and deleted is no edit, and a save keeps \r\n.
  await pane.locator('.tree-row.file', { hasText: 'win.txt' }).click();
  await expect(pane.locator('.file-pane-head .path')).toHaveText('win.txt');
  await pane.locator('button.edit').click();
  await expect(box).toBeFocused();
  await page.keyboard.press('Meta+ArrowUp');
  await page.keyboard.type('#');
  await expect(note).toHaveText('2 lines · edited');
  await page.keyboard.press('Backspace');
  await expect(note).toHaveText('2 lines');
  await page.keyboard.type('#');
  await page.keyboard.press('Meta+s');
  await expect(page.locator('.toast')).toHaveText('Saved win.txt');
  expect(readFileSync(join(project, 'win.txt'), 'utf8')).toBe('#alpha\r\nbeta\r\n');

  // File editing off (⌘,) while editing: ⌘S says so and writes nothing.
  await page.keyboard.type('!');
  await page.keyboard.press('Meta+Comma');
  const row = page.locator('.picker .picker-item', { hasText: 'File editing' });
  await row.click();
  await expect(row.locator('.desc')).toHaveText('Off: the file pane only shows them');
  await page.keyboard.press('Escape');
  await expect(page.locator('.picker')).toHaveCount(0);
  await box.focus();
  await page.keyboard.press('Meta+s');
  await expect(page.locator('.toast')).toHaveText('File editing is off (Settings, ⌘,): this pane no longer saves files');
  expect(readFileSync(join(project, 'win.txt'), 'utf8')).toBe('#alpha\r\nbeta\r\n');
});

test("in split view, a file pane read again when its session's turn ends leaves the keyboard in the other half", async () => {
  // Slow enough that the turn is still running after the pane opens and the other half takes the keyboard.
  run = await launch(tuiFixture('two-turns-stdin.jsonl'), { BINDER_FAKE_DELAY_MS: '700' });
  const { page, project, tmp } = run;
  const other = join(tmp, 'other');
  mkdirSync(other);
  writeFileSync(join(other, 'notes.md'), 'notes\n');
  await newSession(page, project);
  await newSession(page, other);
  await page.keyboard.press('Meta+Backslash');
  const left = page.locator('.session.split-left');
  const right = page.locator('.session.split-right');
  await expect(left.locator('.composer textarea')).toBeFocused();
  await page.keyboard.type('Say A');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Meta+p');
  await page.keyboard.type('notes');
  await expect(page.locator('.picker .picker-item')).toHaveCount(1);
  await page.keyboard.press('Enter');
  const code = left.locator('.file-pane .file-code .code');
  await expect(code).toContainText('notes');
  writeFileSync(join(other, 'notes.md'), 'changed\n');
  await right.locator('.composer textarea').click();
  await expect(right.locator('.composer textarea')).toBeFocused();
  expect(await code.textContent()).toContain('notes');
  await expect(code).toContainText('changed', { timeout: 30000 });
  await expect(right.locator('.composer textarea')).toBeFocused();
});

test("/files c copies the tool call's path made absolute, as bindertui does", async () => {
  // A Read of a path relative to the session folder.
  const tmp = mkdtempSync('/tmp/bg-');
  mkdirSync(join(tmp, 'app'));
  const dir = realpathSync(join(tmp, 'app'));
  const fixture = join(tmp, 'read.jsonl');
  const e = (o: object) => JSON.stringify({ session_id: 'read', parent_tool_use_id: null, ...o });
  writeFileSync(
    fixture,
    [
      e({ type: 'system', subtype: 'init', cwd: dir, model: 'claude-opus-4-1', permissionMode: 'default' }),
      e({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'src/a.ts' } }] } }),
      e({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'const a = 1;' }] } }),
      e({ type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Read it.' }] } }),
      e({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, num_turns: 1, total_cost_usd: 0 }),
    ].join('\n') + '\n',
  );
  run = await launch(fixture, {}, { reuse: tmp });
  const { app, page, project } = run;
  await app.evaluate(({ clipboard }) => {
    const g = globalThis as unknown as { __copied: string[] };
    g.__copied = [];
    clipboard.writeText = async (t: string) => void g.__copied.push(t);
  });
  await newSession(page, project);
  await page.keyboard.type('Read src/a.ts');
  await page.keyboard.press('Enter');
  await expect(page.locator('.md').last()).toHaveText('Read it.', { timeout: 20000 });
  await page.keyboard.type('/files');
  await page.keyboard.press('Enter');
  await expect(page.locator('.picker .picker-item')).toHaveText([/src\/a\.ts.*Read/]);
  await page.keyboard.press('c');
  await expect(page.locator('.toast')).toHaveText(`Copied ${dir}/src/a.ts`);
  expect(await app.evaluate(() => (globalThis as unknown as { __copied: string[] }).__copied)).toEqual([`${dir}/src/a.ts`]);
});

test('⌘\\ shows two sessions side by side; a click or ⌘1-9 gives one the keyboard; ⌘\\ again shows one', async () => {
  run = await launch(tuiFixture('two-turns-stdin.jsonl'));
  const { page, project, tmp } = run;
  const other = join(tmp, 'other');
  mkdirSync(other);
  await newSession(page, project);
  await page.keyboard.type('Say A');
  await page.keyboard.press('Enter');
  await expect(page.locator('.session:not([hidden]) .md').last()).toHaveText('A', { timeout: 20000 });
  await newSession(page, other);
  await page.keyboard.press('Meta+Backslash');
  await expect(page.locator('.main.split > .session:not([hidden])')).toHaveCount(2);
  // The active session (the second) on the left with the keyboard, the next (wrapping to the first) on the right.
  const left = page.locator('.session.split-left');
  const right = page.locator('.session.split-right');
  await expect(left).toHaveClass(/focused/);
  await expect(left.locator('.composer textarea')).toBeFocused();
  await expect(right.locator('.md').last()).toHaveText('A');
  await page.screenshot({ path: shot('split-view') });
  // A click on the right half gives it the keyboard; typing goes there.
  await right.locator('.scroller').click();
  await expect(right).toHaveClass(/focused/);
  await expect(left).not.toHaveClass(/focused/);
  await page.keyboard.type('Say ok2');
  await expect(right.locator('.composer textarea')).toHaveValue('Say ok2');
  await expect(left.locator('.composer textarea')).toHaveValue('');
  await page.keyboard.press('Enter');
  await expect(right.locator('.md').last()).toHaveText('You asked me to reply with "ok", then "ok2", then "A".', { timeout: 20000 });
  // ⌘2 (the second session, on the left) moves the keyboard back; both stay on screen.
  await page.keyboard.press('Meta+2');
  await expect(left).toHaveClass(/focused/);
  await expect(page.locator('.main.split > .session:not([hidden])')).toHaveCount(2);
  await page.keyboard.press('Meta+Backslash');
  await expect(page.locator('.main.split')).toHaveCount(0);
  await expect(page.locator('.session:not([hidden])')).toHaveCount(1);
  await expect(page.locator('.session:not([hidden]) .composer textarea')).toBeFocused();
});

test('/window moves the session to a window of its own; it works there, and ⌘W closes that window only', async () => {
  run = await launch(tuiFixture('two-turns-stdin.jsonl'));
  const { app, page, project } = run;
  await newSession(page, project);
  await page.keyboard.type('Say A');
  await page.keyboard.press('Enter');
  await expect(page.locator('.session:not([hidden]) .md').last()).toHaveText('A', { timeout: 20000 });
  const opened = app.waitForEvent('window');
  await page.keyboard.type('/window');
  await page.keyboard.press('Enter');
  const w = await opened;
  await expect(w.locator('.session .md').last()).toHaveText('A', { timeout: 20000 });
  await expect(w.locator('.sidebar')).toHaveCount(0);
  // The main window let it go.
  await expect(page.locator('.session')).toHaveCount(0);
  await expect(page.locator('.welcome h1')).toHaveText('Binder');
  // It works in its window.
  await w.locator('.composer textarea').focus();
  await w.keyboard.type('Say ok2');
  await w.keyboard.press('Enter');
  await expect(w.locator('.session .md').last()).toHaveText('You asked me to reply with "ok", then "ok2", then "A".', { timeout: 20000 });
  await w.screenshot({ path: shot('session-window') });
  // The window closes under the key press.
  await w.keyboard.press('Meta+w').catch(() => {});
  await expect.poll(() => app.windows().length).toBe(1);
  await expect(page.locator('.welcome h1')).toHaveText('Binder');
});

// Whether a process is still there.
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("closing a /window window ends its session's terminal", async () => {
  const dir = mkdtempSync('/tmp/bgw-');
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ terminalCommand: 'exec /bin/sh' }));
  run = await launch(tuiFixture('two-turns-stdin.jsonl'), { BINDER_CONFIG: config });
  const { app, page, project } = run;
  await newSession(page, project);
  const opened = app.waitForEvent('window');
  await page.keyboard.type('/window');
  await page.keyboard.press('Enter');
  const w = await opened;
  await w.locator('.composer textarea').focus();
  await w.keyboard.press('Control+Backquote');
  await expect(w.locator('.session-term .xterm')).toBeVisible();
  await w.waitForTimeout(1000); // the shell starting
  const pidFile = join(dir, 'term.pid');
  await w.keyboard.type(`echo $$ > ${pidFile}`);
  await w.keyboard.press('Enter');
  await expect.poll(() => (existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : ''), { timeout: 20000 }).toMatch(/^\d+$/);
  const shell = Number(readFileSync(pidFile, 'utf8'));
  expect(alive(shell)).toBe(true);
  await w.keyboard.press('Meta+w').catch(() => {});
  await expect.poll(() => app.windows().length).toBe(1);
  await expect.poll(() => alive(shell), { timeout: 10000 }).toBe(false);
});

test("in a session's own window, ⌘N and /simulator say they belong to the main window", async () => {
  run = await launch(tuiFixture('two-turns-stdin.jsonl'));
  const { app, page, project } = run;
  await newSession(page, project);
  await page.keyboard.type('Say A');
  await page.keyboard.press('Enter');
  await expect(page.locator('.session:not([hidden]) .md').last()).toHaveText('A', { timeout: 20000 });
  const opened = app.waitForEvent('window');
  await page.keyboard.type('/window');
  await page.keyboard.press('Enter');
  const w = await opened;
  await expect(w.locator('.session .md').last()).toHaveText('A', { timeout: 20000 });
  await w.locator('.composer textarea').focus();
  await w.keyboard.press('Meta+n');
  await expect(w.locator('.toast')).toHaveText('New sessions open from the main window');
  await expect(w.locator('.picker')).toHaveCount(0);
  await w.keyboard.type('/simulator');
  await w.keyboard.press('Enter');
  await expect(w.locator('.toast')).toHaveText('The simulator shows in the main window: /simulator there opens it');
  await expect(w.locator('.sim-pane')).toHaveCount(0);
});

test('/btw asks side questions in the side chat, with the earlier ones as history, and keeps them out of the transcript', async () => {
  const input = join(mkdtempSync('/tmp/bgi-'), 'input.jsonl');
  run = await launch(tuiFixture('two-turns-stdin.jsonl'), { BINDER_FAKE_INPUT_OUT: input });
  const { page, project } = run;
  const sent = () => (existsSync(input) ? readFileSync(input, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  await newSession(page, project);
  await page.keyboard.type('Say A');
  await page.keyboard.press('Enter');
  await expect(page.locator('.session:not([hidden]) .md').last()).toHaveText('A', { timeout: 20000 });
  await page.keyboard.type('/btw what did I ask?');
  await page.keyboard.press('Enter');
  const chat = page.locator('.side-chat');
  await expect(chat.locator('.side-q')).toHaveText(['what did I ask?']);
  await expect(chat.locator('.side-item .md')).toHaveText(['Side answer to: what did I ask?'], { timeout: 20000 });
  await expect(chat.locator('.side-chat-input')).toBeFocused();
  await page.keyboard.type('and before that?');
  await page.keyboard.press('Enter');
  await expect(chat.locator('.side-item .md').last()).toHaveText('Side answer to: and before that? (after 1 earlier)', { timeout: 20000 });
  await page.screenshot({ path: shot('side-chat') });
  expect(sent().filter((m) => m.type === 'control_request' && m.request.subtype === 'side_question').map((m) => m.request)).toEqual([
    { subtype: 'side_question', question: 'what did I ask?' },
    { subtype: 'side_question', question: 'and before that?', history: [{ question: 'what did I ask?', response: '**Side answer** to: what did I ask?' }] },
  ]);
  // Nothing went to the conversation.
  expect(sent().filter((m) => m.type === 'user')).toHaveLength(1);
  await expect(page.locator('.session:not([hidden]) .turn')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(chat).toHaveCount(0);
  await expect(page.locator('.session:not([hidden]) .composer textarea')).toBeFocused();
});

test('/schedule adds a task in the session folder; its panel runs it now in a fresh session, opens the run, and deletes the task', async () => {
  run = await launch(tuiFixture('two-turns-stdin.jsonl'));
  const { page, project } = run;
  await newSession(page, project);
  await page.keyboard.type('/schedule weekdays 9:00 Say A');
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast')).toHaveText(/^Scheduled "Say A": weekdays at 09:00, next /, { timeout: 20000 });
  await page.keyboard.type('/schedule');
  await page.keyboard.press('Enter');
  const picker = page.locator('.picker');
  await expect(picker.locator('.picker-title')).toHaveText('Scheduled tasks');
  await expect(picker.locator('.picker-item')).toHaveCount(1);
  await expect(picker.locator('.picker-item')).toContainText(/Say A.*weekdays at 09:00 · next /);
  await page.screenshot({ path: shot('schedule-panel') });
  await picker.locator('.picker-item', { hasText: 'Say A' }).click();
  await expect(picker.locator('.picker-head .picker-sub')).toContainText('weekdays at 09:00 in ');
  await expect(picker.locator('.picker-head .picker-sub')).toContainText('/app: Say A');
  await picker.locator('.picker-item', { hasText: /^Run it now/ }).click();
  await expect(page.locator('.toast')).toHaveText('Say A is running (Runs opens it)', { timeout: 40000 });
  await picker.locator('.picker-item', { hasText: /^Runs/ }).click();
  await expect(picker.locator('.picker-title')).toHaveText('Runs: Say A');
  await expect(picker.locator('.picker-item')).toHaveCount(1);
  await picker.locator('.picker-item').first().click();
  // The run's own session: the task's prompt, and its answer.
  await expect(page.locator('.session:not([hidden]) .prompt')).toHaveText('Say A', { timeout: 20000 });
  await expect(page.locator('.session:not([hidden]) .md').last()).toHaveText('A', { timeout: 20000 });
  await expect(page.locator('.session')).toHaveCount(2);
  await page.locator('.session:not([hidden]) .composer textarea').focus();
  await page.keyboard.type('/schedule');
  await page.keyboard.press('Enter');
  await picker.locator('.picker-item', { hasText: 'Say A' }).click();
  await picker.locator('.picker-item', { hasText: /^Delete/ }).click();
  await expect(page.locator('.toast')).toHaveText('Deleted Say A');
  await expect(picker.locator('.picker-item')).toHaveText(/None yet/);
});

test('/plugins disables an installed plugin and installs one from the marketplaces, loading each into the session', async () => {
  const state = join(mkdtempSync('/tmp/bgp-'), 'plugins.json');
  writeFileSync(state, JSON.stringify({
    installed: [{ id: 'formatter@market', version: '1.0.0', scope: 'user', enabled: true }],
    available: [
      { pluginId: 'formatter@market', name: 'formatter', description: 'Formats code', marketplaceName: 'market' },
      { pluginId: 'linter@market', name: 'linter', description: 'Lints the code you change', marketplaceName: 'market' },
      { pluginId: 'notes@other', name: 'notes', description: 'Keeps notes', marketplaceName: 'other' },
    ],
  }));
  run = await launch(tuiFixture('two-turns-stdin.jsonl'), { BINDER_FAKE_PLUGINS: state });
  const { page, project } = run;
  const plugins = () => JSON.parse(readFileSync(state, 'utf8'));
  await newSession(page, project);
  await page.keyboard.type('/plugins');
  await page.keyboard.press('Enter');
  const picker = page.locator('.picker');
  await expect(picker.locator('.picker-head .picker-sub')).toHaveText('1 installed (1 enabled)', { timeout: 20000 });
  await expect(picker.locator('.picker-item')).toHaveCount(3);
  await picker.locator('.picker-item', { hasText: 'formatter@market' }).click();
  // The actions open with the first one highlighted, whatever was before.
  await expect(picker.locator('.picker-item.picked')).toContainText('Disable');
  await picker.locator('.picker-item', { hasText: /^Disable/ }).click();
  await expect(page.locator('.toast')).toHaveText(/^Successfully disabled plugin: formatter \(scope: user\)\. Loaded 0 plugins with \d+ commands$/, { timeout: 20000 });
  expect(plugins().installed[0].enabled).toBe(false);
  await picker.locator('.picker-item', { hasText: 'Install a plugin…' }).click();
  await expect(picker.locator('.picker-head .picker-sub')).toHaveText('3 in your marketplaces · Enter installs it (user scope)', { timeout: 20000 });
  await expect(picker.locator('.picker-item')).toHaveCount(2);
  await page.keyboard.type('lint');
  await expect(picker.locator('.picker-item')).toHaveCount(1);
  await page.screenshot({ path: shot('plugins') });
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast')).toHaveText(/^Successfully installed plugin: linter \(scope: user\)\. Loaded 1 plugin with \d+ commands$/, { timeout: 20000 });
  expect(plugins().installed.map((p: { id: string }) => p.id)).toEqual(['formatter@market', 'linter@market']);
  // Its command is in the menu now.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.locator('.session:not([hidden]) .composer textarea').focus();
  await page.keyboard.type('/lint');
  await expect(page.locator('.session:not([hidden]) .menu')).toContainText('From the linter@market plugin');
});

test('/preview <url> shows the page beside the session with its console errors; Show Claude sends a capture of it', async () => {
  const input = join(mkdtempSync('/tmp/bgi-'), 'input.jsonl');
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Preview test</title><h1>Hello from the app</h1><script>console.error("boom from the page")</script>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  try {
    run = await launch(tuiFixture('two-turns-stdin.jsonl'), { BINDER_FAKE_INPUT_OUT: input });
    const { page, project } = run;
    const sent = () => (existsSync(input) ? readFileSync(input, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.type === 'user');
    await newSession(page, project);
    await page.keyboard.type(`/preview ${url}`);
    await page.keyboard.press('Enter');
    const pane = page.locator('.preview-pane');
    await expect(pane.locator('.preview-address')).toHaveValue(url);
    await expect(pane.locator('.preview-address')).toHaveAttribute('title', 'Preview test', { timeout: 20000 });
    await expect(pane.locator('.preview-foot button').first()).toHaveText('Console · 1 error', { timeout: 20000 });
    await pane.locator('.preview-foot button', { hasText: 'Console' }).click();
    await expect(pane.locator('.preview-drawer')).toContainText('✗ boom from the page');
    await pane.locator('button.show-claude').click();
    await expect(page.locator('.toast')).toHaveText('Sent the preview to Claude', { timeout: 20000 });
    await expect.poll(() => sent().length, { timeout: 20000 }).toBe(1);
    const content = sent()[0].message.content as Array<{ type: string; text?: string; source?: { media_type: string; data: string } }>;
    expect(content.find((b) => b.type === 'text')?.text).toMatch(new RegExp(`^Here is the preview of ${url.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} as it looks now \\(\\d+×\\d+\\)\\. Its console logged 1 error:\\n- boom from the page`));
    const img = content.find((b) => b.type === 'image');
    expect(img?.source?.media_type).toBe('image/png');
    expect(Buffer.from(img!.source!.data, 'base64').subarray(1, 4).toString()).toBe('PNG');
    await pane.locator('.side-close').click();
    await expect(pane).toHaveCount(0);
  } finally {
    server.close();
  }
});

test("/preview <command> starts the dev server, opens the address it prints, reloads after a turn, and stops it on close", async () => {
  run = await launch(tuiFixture('two-turns-stdin.jsonl'));
  const { page, project } = run;
  const hits = join(project, 'hits.txt');
  // A dev server: counts its page loads, and prints where it listens.
  writeFileSync(
    join(project, 'serve.mjs'),
    `import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const s = createServer((req, res) => { if (req.url === '/') appendFileSync(${JSON.stringify(hits)}, 'x'); res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Served app</title><p>served</p>'); });
s.listen(0, '127.0.0.1', () => console.log('  ➜  Local:   http://localhost:' + s.address().port + '/'));
`,
  );
  await newSession(page, project);
  await page.keyboard.type('/preview node serve.mjs');
  await page.keyboard.press('Enter');
  const pane = page.locator('.preview-pane');
  await expect(pane.locator('.preview-address')).toHaveValue(/^http:\/\/localhost:\d+\/$/, { timeout: 20000 });
  await expect(pane.locator('.preview-address')).toHaveAttribute('title', 'Served app', { timeout: 20000 });
  const address = await pane.locator('.preview-address').inputValue();
  await expect(pane.locator('.preview-foot button', { hasText: 'node serve.mjs' })).toHaveText('node serve.mjs · running');
  await expect.poll(() => (existsSync(hits) ? readFileSync(hits, 'utf8').length : 0)).toBe(1);
  // A turn ends: the page loads again.
  await page.locator('.session:not([hidden]) .composer textarea').focus();
  await page.keyboard.type('Say A');
  await page.keyboard.press('Enter');
  await expect(page.locator('.session:not([hidden]) .md').last()).toHaveText('A', { timeout: 20000 });
  await expect.poll(() => readFileSync(hits, 'utf8').length, { timeout: 20000 }).toBe(2);
  // Closed: the server stops with it.
  await pane.locator('.side-close').click();
  await expect(pane).toHaveCount(0);
  await expect.poll(async () => fetch(address).then(() => 'up', () => 'down'), { timeout: 20000 }).toBe('down');
});

test('/preview <command> again replaces the server; × and quitting end one that ignores SIGHUP and SIGTERM', async () => {
  run = await launch(tuiFixture('two-turns-stdin.jsonl'));
  const { app, page, project, tmp } = run;
  // Each server's name is its first argument; ps finds them by the launch's folder name.
  const mark = `--mark=${tmp.split('/').pop()}`;
  const servers = () =>
    execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.includes(mark) && !l.includes(' -c '))
      .map((l) => /serve\.mjs (\S+)/.exec(l)?.[1]);
  const pids = () => execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(mark)).map((l) => Number(l.trim().split(' ')[0]));
  writeFileSync(
    join(project, 'serve.mjs'),
    `import { createServer } from 'node:http';
const [name, ...flags] = process.argv.slice(2);
if (flags.includes('--stubborn')) for (const sig of ['SIGHUP', 'SIGTERM']) process.on(sig, () => console.log('ignoring ' + sig));
const s = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Served ' + name + '</title>'); });
s.listen(0, '127.0.0.1', () => console.log('  ➜  Local:   http://localhost:' + s.address().port + '/'));
`,
  );
  const pane = page.locator('.preview-pane');
  const preview = async (name: string, flags = '') => {
    await page.locator('.session:not([hidden]) .composer textarea').focus();
    await page.keyboard.type(`/preview node serve.mjs ${name} ${flags}${mark}`);
    await page.keyboard.press('Enter');
    await expect(pane.locator('.preview-address')).toHaveAttribute('title', `Served ${name}`, { timeout: 20000 });
  };
  try {
    await newSession(page, project);
    await preview('first');
    await preview('second');
    // The first server's exit is not the second's.
    await page.waitForTimeout(2000);
    await expect(pane.locator('.preview-foot button', { hasText: 'node serve.mjs second' })).toHaveText(/· running$/);
    expect(servers()).toEqual(['second']);
    await pane.locator('.side-close').click();
    await expect.poll(servers, { timeout: 10000 }).toEqual([]);
    // SIGHUP, then SIGTERM, then SIGKILL.
    await preview('stubborn', '--stubborn ');
    await pane.locator('.side-close').click();
    await expect.poll(servers, { timeout: 10000 }).toEqual([]);
    // Quitting waits for the same.
    await preview('quitting', '--stubborn ');
    const pid = app.process().pid!;
    await app.evaluate(({ app }) => void setTimeout(() => app.quit(), 10));
    await expect.poll(() => alive(pid), { timeout: 15000 }).toBe(false);
    expect(servers()).toEqual([]);
  } finally {
    // Any left after a failure.
    for (const p of pids()) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {
        // gone already
      }
    }
  }
});

test('/simulator shows a device beside the sessions: Boot starts it, its screen refreshes, Show Claude sends a capture', async () => {
  const dir = mkdtempSync('/tmp/bgs-');
  const state = join(dir, 'sim.json');
  const log = join(dir, 'xcrun.log');
  const input = join(dir, 'input.jsonl');
  writeFileSync(state, JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-2': [{ udid: 'AAAA-1', name: 'iPhone 17', state: 'Shutdown' }],
      'com.apple.CoreSimulator.SimRuntime.iOS-27-2': [{ udid: 'BBBB-2', name: 'iPhone Duo', state: 'Shutdown', displays: 2 }],
    },
  }));
  run = await launch(tuiFixture('two-turns-stdin.jsonl'), { BINDER_XCRUN: join(BINDERTUI, '..', 'gui', 'e2e', 'fakeXcrun.mjs'), BINDER_FAKE_SIM: state, BINDER_FAKE_SIM_LOG: log, BINDER_FAKE_SIM_IMAGE: tuiFixture('orange.png'), BINDER_FAKE_INPUT_OUT: input });
  const { page, project } = run;
  const shots = () => (existsSync(log) ? readFileSync(log, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]).filter((a) => a.includes('screenshot'));
  const sent = () => (existsSync(input) ? readFileSync(input, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.type === 'user');
  await newSession(page, project);
  await page.keyboard.type('/simulator');
  await page.keyboard.press('Enter');
  const pane = page.locator('.sim-pane');
  // The newest runtime's first; none running yet.
  await expect(pane.locator('select option')).toHaveText(['iPhone Duo · iOS 27.2', 'iPhone 17 · iOS 26.2'], { timeout: 20000 });
  await expect(pane.locator('.sim-screen .note')).toHaveText('iPhone Duo is not running. Boot starts it.');
  await pane.locator('button.boot').click();
  await expect(pane.locator('select option').first()).toHaveText('iPhone Duo · iOS 27.2 · running', { timeout: 20000 });
  await expect(pane.locator('.sim-screen img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/, { timeout: 20000 });
  // Two screens: asked again with --display=primary, and from then on.
  expect(shots()[0]).not.toContain('--display=primary');
  expect(shots()[1]).toContain('--display=primary');
  await expect.poll(() => shots().length, { timeout: 10000 }).toBeGreaterThanOrEqual(4);
  await page.screenshot({ path: shot('simulator') });
  await pane.locator('button.show-claude').click();
  await expect(page.locator('.toast')).toHaveText('Sent the simulator to Claude', { timeout: 20000 });
  await expect.poll(() => sent().length, { timeout: 20000 }).toBe(1);
  const content = sent()[0].message.content as Array<{ type: string; text?: string; source?: { media_type: string } }>;
  expect(content.find((c) => c.type === 'text')?.text).toBe('Here is the iOS Simulator (iPhone Duo, iOS 27.2) as it looks now.\n\nCheck that it shows what you changed, and fix anything that is wrong.');
  expect(content.find((c) => c.type === 'image')?.source?.media_type).toBe('image/png');
  // /simulator again closes it, and the captures stop.
  await page.locator('.session:not([hidden]) .composer textarea').focus();
  await page.keyboard.type('/simulator');
  await page.keyboard.press('Enter');
  await expect(pane).toHaveCount(0);
  const n = shots().length;
  await new Promise((r) => setTimeout(r, 2500));
  expect(shots().length).toBeLessThanOrEqual(n + 1);
});

test('the simulator pane keeps one capture going however often a panel covers it, and none while the window is hidden', async () => {
  const dir = mkdtempSync('/tmp/bgs-');
  const state = join(dir, 'sim.json');
  const log = join(dir, 'xcrun.log');
  writeFileSync(state, JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-2': [{ udid: 'B1', name: 'iPhone 17', state: 'Booted' }] } }));
  // Each capture takes most of its second, so a panel nearly always opens over one in flight.
  run = await launch(tuiFixture('two-turns-stdin.jsonl'), { BINDER_XCRUN: join(BINDERTUI, '..', 'gui', 'e2e', 'fakeXcrun.mjs'), BINDER_FAKE_SIM: state, BINDER_FAKE_SIM_LOG: log, BINDER_FAKE_SIM_IMAGE: tuiFixture('orange.png'), BINDER_FAKE_SIM_DELAY_MS: '700' });
  const { page, project } = run;
  const shots = () => (existsSync(log) ? readFileSync(log, 'utf8') : '').split('\n').filter((l) => l.includes('screenshot')).length;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // The page told the window is hidden (or minimized) or shown, as macOS tells it on an
  // unlocked screen: on a locked one (a test machine's, often) hide() changes nothing.
  const visibility = (state: 'hidden' | 'visible') =>
    page.evaluate((state) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
    }, state);
  // Captures started in `ms`.
  const started = async (ms: number) => {
    const n = shots();
    await sleep(ms);
    return shots() - n;
  };
  await newSession(page, project);
  await page.keyboard.type('/simulator');
  await page.keyboard.press('Enter');
  await expect(page.locator('.sim-pane .sim-screen img')).toBeVisible({ timeout: 20000 });
  const picker = page.locator('.picker');
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Meta+Comma');
    await expect(picker).toBeVisible();
    await sleep(1000);
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await sleep(1000);
  }
  // Covered: none; shown: one loop, about once a second (a leaked loop per cover would make several).
  await page.keyboard.press('Meta+Comma');
  await expect(picker).toBeVisible();
  await sleep(1000);
  expect(await started(3000)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await sleep(500);
  expect(await started(4000)).toBeLessThanOrEqual(5);
  // A hidden window: none, until it shows again.
  await visibility('hidden');
  await sleep(1000);
  expect(await started(3000)).toBe(0);
  await visibility('visible');
  await expect.poll(() => started(1500), { timeout: 10000 }).toBeGreaterThan(0);
});

test("⌃` opens the session's own terminal in its folder; its keys stay in the terminal; ⌃` hides it and it keeps running", async () => {
  run = await launch(tuiFixture('two-turns-stdin.jsonl'));
  const { page, project } = run;
  await newSession(page, project);
  await page.keyboard.press('Control+Backquote');
  const term = page.locator('.session:not([hidden]) .session-term');
  await expect(term.locator('.xterm')).toBeVisible();
  await expect(term.locator('.session-term-head')).toContainText('Terminal');
  await page.waitForTimeout(1500); // the login shell starting
  await page.keyboard.type('echo binder-term-$((40+2)); pwd');
  await page.keyboard.press('Enter');
  await expect(term.locator('.xterm-rows')).toContainText('binder-term-42', { timeout: 20000 });
  await expect(term.locator('.xterm-rows')).toContainText(project);
  // Esc is the shell's: no rewind, no interrupt.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.locator('.picker')).toHaveCount(0);
  await page.screenshot({ path: shot('session-terminal') });
  await page.keyboard.press('Control+Backquote');
  await expect(term).toBeHidden();
  await expect(page.locator('.session:not([hidden]) .composer textarea')).toBeFocused();
  await page.keyboard.press('Control+Backquote');
  await expect(term.locator('.xterm-rows')).toContainText('binder-term-42');
});

test("the branch's PR shows in the status bar; its panel merges when ready", async () => {
  const log = join(mkdtempSync('/tmp/bgh-'), 'gh.log');
  run = await launch(tuiFixture('two-turns-stdin.jsonl'), { BINDER_GH: join(BINDERTUI, 'test/fakeGh.mjs'), BINDER_FAKE_GH_STATE: tuiFixture('gh-pr.json'), BINDER_FAKE_GH_LOG: log });
  const { page, project } = run;
  await newSession(page, project);
  const badge = page.locator('.statusbar .badge.pr');
  await expect(badge).toHaveText('PR #12 ✗ 2', { timeout: 20000 });
  await expect(badge).toHaveClass(/failing/);
  await badge.click();
  const picker = page.locator('.picker');
  await expect(picker.locator('.picker-title')).toHaveText('PR #12: Fix the parser');
  await expect(picker.locator('.picker-head .picker-sub')).toContainText('✗ 2 failing (lint, test)');
  await page.screenshot({ path: shot('pr-panel') });
  await picker.locator('.picker-item', { hasText: 'Merge when ready' }).click();
  await expect(page.locator('.toast')).toHaveText('PR #12 merges (squash) once its checks pass and it is approved');
  expect(readFileSync(log, 'utf8')).toContain(JSON.stringify(['pr', 'merge', '12', '--auto', '--squash']));
});

test('images stay captions when config.json showImages is false', async () => {
  const { fixture, server } = await imageTurn();
  try {
    const config = join(mkdtempSync('/tmp/bgn-'), 'config.json');
    writeFileSync(config, JSON.stringify({ showImages: false }));
    run = await launch(fixture, { BINDER_CONFIG: config });
    const { page, project } = run;
    writeFileSync(join(project, 'orange.png'), readFileSync(join(BINDERTUI, 'fixtures/orange.png')));
    await newSession(page, project);
    await page.keyboard.type('what is this?');
    await page.keyboard.press('Enter');
    const md = page.locator('.md').last();
    await expect(md).toContainText('It is an orange square.', { timeout: 20000 });
    await page.keyboard.press('Control+e');
    await expect(page.locator('.tool-images .img-caption')).toHaveText('▣ PNG image, 1 KB');
    await expect(page.locator('img.inline-img')).toHaveCount(0);
    await expect(md.locator('a.md-image')).toContainText('Image: remote (127.0.0.1');
  } finally {
    server.close();
  }
});

test('a plan shows as markdown in the question card, and a choice approves it with the mode', async () => {
  const answers = join(mkdtempSync('/tmp/bga-'), 'answers.json');
  run = await launch(tuiFixture('plan-approval.jsonl'), { BINDER_FAKE_ANSWERS_OUT: answers });
  const { page, project } = run;
  await newSession(page, project);
  await page.keyboard.type('plan a hello file');
  await page.keyboard.press('Enter');
  const card = page.locator('.question');
  await expect(card.locator('.q')).toHaveText('Ready to code?', { timeout: 20000 });
  await expect(card.locator('.plan h1')).toHaveText('Add hello.txt');
  await expect(card.locator('.plan li strong').first()).toHaveText('Create the file:');
  await expect(card.locator('.tool-input')).toHaveCount(0);
  await expect(card.locator('.option .label')).toHaveText(['Yes, and use auto mode', 'Yes, and auto-accept edits', 'Yes, and manually approve edits', 'No, keep planning', 'No, and tell Claude what to change']);
  await expect(card.locator('.hint')).toContainText('esc keeps planning');
  await page.screenshot({ path: shot('plan-approval') });
  await page.keyboard.press('3');
  await expect(card).toHaveCount(0);
  await expect.poll(() => existsSync(answers) && JSON.parse(readFileSync(answers, 'utf8')).response.response.updatedPermissions).toEqual([{ type: 'setMode', mode: 'default', destination: 'session' }]);
  // Approved, the plan stays in the transcript, not folded into the work.
  await expect(page.locator('.plan-block .plan-head')).toHaveText('Plan · approved', { timeout: 20000 });
  await expect(page.locator('.plan-block h1')).toHaveText('Add hello.txt');
  await expect(page.locator('.md').last()).toHaveText('Starting on the plan.');
});

test('after binder is rebuilt, an idle session restarts its host on the new build and keeps its modes', async () => {
  run = await launch(tuiFixture('two-turns-stdin.jsonl'));
  const { page, project, tmp } = run;
  await newSession(page, project);
  await page.keyboard.type('first prompt');
  await page.keyboard.press('Enter');
  await expect(page.locator('.tab')).toHaveCount(1);
  await expect(page.locator('.turn-note').first()).toBeVisible({ timeout: 20000 });
  await page.keyboard.press('Alt+KeyM');
  const mode = page.locator('.statusbar .badge:not(.fast)');
  await expect(mode).toHaveText('accept edits');
  await page.keyboard.press('Alt+KeyO');
  await expect(page.locator('.statusbar .badge.fast')).toHaveText('↯ fast');
  const sock = join(tmp, 's', 'sock');
  const pids = () => readdirSync(sock).filter((f) => f.endsWith('.pid')).map((f) => readFileSync(join(sock, f), 'utf8').trim());
  const [before] = pids();

  // A build rewrites every file of binder; the host notices within a few seconds here (BINDER_HOST_IDLE_MS).
  const code = join(BINDERTUI, 'dist/remote/cli.js');
  const later = new Date(Date.now() + 60000);
  utimesSync(code, later, later);
  await expect(page.locator('.toast')).toHaveText('Restarted this session on the new build of binder', { timeout: 20000 });
  await expect.poll(() => pids().filter((p) => p !== before).length).toBe(1);
  await expect(page.locator('.tab')).toHaveCount(1);
  await expect(mode).toHaveText('accept edits');
  await expect(page.locator('.statusbar .badge.fast')).toHaveText('↯ fast');
  // And it works on the new host.
  await page.keyboard.type('second prompt');
  await page.keyboard.press('Enter');
  await expect(page.locator('.tab')).toHaveCount(2, { timeout: 20000 });
  await expect(page.locator('.banner')).toHaveCount(0);
});

test('a prompt typed and then cleared does not hold off the restart on a new build', async () => {
  run = await launch(tuiFixture('two-turns-stdin.jsonl'));
  const { page, project, tmp } = run;
  await newSession(page, project);
  await page.keyboard.type('first prompt');
  await page.keyboard.press('Enter');
  await expect(page.locator('.turn-note').first()).toBeVisible({ timeout: 20000 });
  const sock = join(tmp, 's', 'sock');
  const pids = () => readdirSync(sock).filter((f) => f.endsWith('.pid')).map((f) => readFileSync(join(sock, f), 'utf8').trim());
  const [before] = pids();
  // Text in the prompt: the host waits (it notices the build within 3 s here).
  await page.keyboard.type('half a thought');
  const code = join(BINDERTUI, 'dist/remote/cli.js');
  const later = new Date(Date.now() + 60000);
  utimesSync(code, later, later);
  await page.waitForTimeout(5000);
  expect(pids()).toEqual([before]);
  // Cleared: it restarts.
  await page.keyboard.press('Control+u');
  await expect(page.locator('.composer textarea')).toHaveValue('');
  await expect(page.locator('.toast')).toHaveText('Restarted this session on the new build of binder', { timeout: 20000 });
  await expect.poll(() => pids().filter((p) => p !== before).length).toBe(1);
});

test('a click on the folder moves the session to another one', async () => {
  run = await launch(SHOWCASE);
  const { page, project, tmp } = run;
  const other = join(tmp, 'other');
  mkdirSync(other);
  await newSession(page, project);
  await page.locator('.statusbar .cwd').click();
  const picker = page.locator('.picker');
  await expect(picker.locator('.picker-title')).toContainText('Move to a folder');
  await page.keyboard.type(other);
  await expect(picker.locator('.picker-item .label').first()).toHaveText(`Move to ${other}`);
  await page.keyboard.press('Enter');
  // A folder Claude Code has not been trusted with asks first, as /cd does.
  await expect(picker.locator('.picker-title')).toContainText('Trust this folder?');
  await page.keyboard.press('Enter');
  await expect(page.locator('.statusbar .cwd')).toHaveText(other);
  await expect(picker).toHaveCount(0);
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

  // A click shows its output in /tasks; x stops it.
  await task.click();
  const picker = page.locator('.picker');
  await expect(picker.locator('.picker-title')).toHaveText('Background tasks');
  await expect(picker.locator('.task-output')).toContainText('output of bifp3kil2');
  await expect(picker.locator('.task-detail-head')).toContainText('Output · last 8 KB of 20 KB');
  await page.screenshot({ path: shot('tasks-panel') });
  await page.keyboard.press('x');
  await expect(page.locator('.toast')).toHaveText('Stopped sleep 8; echo BG_DONE');
  await expect(picker.locator('.picker-empty')).toHaveText('No background tasks running');
  await page.keyboard.press('Escape');
  await expect(page.locator('.bg-task')).toHaveCount(0);
});

test("Ctrl+B moves the running command to the background; the tab that launched finished work carries on with it", async () => {
  run = await launch(tuiFixture('background-midturn.jsonl'), { BINDER_FAKE_DELAY_MS: '120' });
  const { page, project } = run;
  await newSession(page, project);
  await page.keyboard.type('Start the background job');
  await page.keyboard.press('Enter');
  await expect(page.locator('.bg-task')).toHaveCount(1, { timeout: 20000 });
  await expect(page.locator('.activity .now')).toHaveText('', { timeout: 20000 });
  await page.keyboard.type('Run the foreground job');
  await page.keyboard.press('Enter');
  await expect(page.locator('.activity .now')).toContainText('⌃B to run in background', { timeout: 20000 });
  await page.keyboard.press('Control+b');
  await expect(page.locator('.toast')).toHaveText('Running in the background');
  // Tab 1's shell finished during tab 2's turn: tab 1 gets a turn of its own about it.
  await page.keyboard.press('Control+ArrowLeft');
  await expect(page.locator('.tab.active .num')).toHaveText('1');
  await expect(page.locator('.transcript .auto-head.pending')).toHaveText('⏺ Background task finished: sleep 8; echo BG_DONE', { timeout: 20000 });
  await expect(page.locator('.transcript')).toContainText('Claude carries on with it here once the current turn ends');
  await page.screenshot({ path: shot('background-followup') });
  // Once tab 2's turn ends it is sent, and runs in tab 1 (this fake has no reply left for it).
  await expect(page.locator('.transcript .auto-head:not(.pending)')).toHaveText('⏺ Background task finished: sleep 8; echo BG_DONE', { timeout: 20000 });
  await expect(page.locator('.transcript .auto-head.pending')).toHaveCount(0);
  // The sticky header keeps the prompt the user sent.
  await expect(page.locator('.sticky-prompt')).toContainText('Start the background job');
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
  await expect(page.locator('.session-row')).toHaveCount(0);
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
  // A full strip still leaves the window to drag: by the bar's right end, and
  // by the sidebar's top, which the tabs scrolled past it must not cover.
  const bar = (await page.locator('.session:not([hidden]) .titlebar').boundingBox())!;
  const mid = bar.y + bar.height / 2;
  expect(await dragsAt(page, bar.x + bar.width - 30, mid)).toBe(true);
  expect(await dragsAt(page, bar.x / 2, mid)).toBe(true);
  const tab = (await page.locator('.tab.active').boundingBox())!;
  expect(await dragsAt(page, tab.x + tab.width / 2, mid)).toBe(false);
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

test("⌘T opens the new-session panel, which picks the folder named by the search; Finder is ⌘O, not a row", async () => {
  run = await launch(SHOWCASE);
  const { page, tmp } = run;
  // Sessions in projects and two folders inside it, projects the least recent.
  const top = join(tmp, 'projects');
  [join(top, 'foobar'), join(top, 'barbaz'), top].forEach((cwd, i) => {
    mkdirSync(cwd, { recursive: true });
    const dir = join(tmp, 'claude', 'projects', cwd.replace(/\//g, '-'));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `00000000-0000-4000-8000-00000000000${i}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: 'user', cwd, entrypoint: 'cli', message: { content: `Work in ${cwd}` } }) + '\n');
    const t = new Date(Date.now() - (i + 1) * 3600_000);
    utimesSync(file, t, t);
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));

  // ⌘T opens it, as ⌘N does.
  await page.keyboard.press('Meta+t');
  const labels = page.locator('.picker-item .label');
  await expect(labels).toHaveText(['foobar', 'barbaz', 'projects'], { timeout: 15000 });
  await expect(page.locator('.picker-hint')).toContainText('⌘O choose in Finder');

  // A search also finds the folders beside those, read as the panel opens: here
  // one no session has run in yet, made after the app started.
  await page.keyboard.press('Escape');
  mkdirSync(join(top, 'fresh'));
  mkdirSync(join(top, '.hidden'));
  await page.keyboard.press('Meta+t');
  await expect(labels).toHaveText(['foobar', 'barbaz', 'projects']);
  await page.keyboard.type('fres');
  await expect(labels).toHaveText(['fresh']);
  await page.keyboard.press('Escape');

  // Typing keeps the cursor on the top row, the folder whose own name matches.
  await page.keyboard.press('Meta+t');
  await page.keyboard.type('projects');
  await expect(labels).toHaveText(['projects', 'foobar', 'barbaz', 'fresh']);
  await expect(page.locator('.picker-item.picked .label')).toHaveText('projects');
  await page.keyboard.press('Enter');
  await page.locator('.session:not([hidden]) .composer textarea').waitFor({ state: 'visible', timeout: 30000 });
  await expect(page.locator('.session-row.active .sub')).toHaveText('projects');
});
