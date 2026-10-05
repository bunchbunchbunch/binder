import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/ui/App.js';
import { PromptInput } from '../src/ui/PromptInput.js';
import { Welcome } from '../src/ui/Welcome.js';
import { takeMouse } from '../src/mouse.js';
import { Session } from '../src/session.js';
import { SessionHost } from '../src/host.js';
import { initialState, reduce, type State } from '../src/store.js';
import type { ClaudeEvent } from '../src/events.js';
import { replay, logPath } from '../src/eventLog.js';
import { FAKE_BIN, FIXTURES } from './helpers.js';

const ENTER = '\r';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Frames carry ANSI styling; assertions are about the text.
const plainFrame = (ui: { lastFrame: () => string | undefined }) =>
  (ui.lastFrame() ?? '').replace(/\x1b\[[0-9;:]*[A-Za-z]/g, '').replace(/\x1b\]8;;[^\x1b\x07]*(?:\x1b\\|\x07)/g, '');

async function type(ui: { stdin: { write: (s: string) => void } }, text: string) {
  ui.stdin.write(text);
  await sleep(30);
  ui.stdin.write(ENTER);
}

async function until(check: () => boolean, ms = 8000, lastFrame?: () => string | undefined): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting; last frame:\n' + (lastFrame?.() ?? ''));
    await sleep(25);
  }
}

function setup(fixture: string, extraEnv: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'binder-state-'));
  process.env.BINDER_STATE_DIR = stateDir;
  process.env.BINDER_CLAUDE_BIN = FAKE_BIN;
  process.env.BINDER_FAKE_FIXTURE = join(FIXTURES, fixture);
  // Per-test knobs for the fake binary must not leak into the next test.
  for (const k of ['BINDER_FAKE_DELAY_MS', 'BINDER_FAKE_ANSWERS_OUT', 'BINDER_FAKE_INPUT_OUT', 'BINDER_FAKE_CAPS']) delete process.env[k];
  for (const [k, v] of Object.entries(extraEnv)) process.env[k] = v;
  return stateDir;
}

function mount(session: Session, sessionId: string, cwd: string, state = initialState(sessionId), draft?: string) {
  let quit = false;
  const ui = render(
    <App host={new SessionHost(session, state, cwd, join(cwd, 'nonexistent'))} configDir={join(cwd, 'nonexistent')} draft={draft} onQuit={() => (quit = true)} />,
  );
  return { ui, didQuit: () => quit };
}

describe('App', () => {
  beforeEach(() => {
    delete process.env.BINDER_FAKE_ANSWERS_OUT;
    delete process.env.BINDER_FAKE_DELAY_MS;
  });

  it('opens one tab per prompt, streams into the right tab, and logs for replay', async () => {
    const cwd = process.cwd();
    const stateDir = setup('two-turns-stdin.jsonl');
    const sessionId = '00000000-0000-4000-8000-000000000001';
    const session = new Session({ sessionId, resume: false, cwd, passthrough: [] });
    session.start();
    const { ui } = mount(session, sessionId, cwd);

    await type(ui, 'first prompt');
    await until(() => plainFrame(ui).includes('1 ● first prompt'), 8000, () => ui.lastFrame());
    expect(plainFrame(ui)).toContain('A'); // the fixture's first answer

    await type(ui, 'second prompt');
    await until(() => plainFrame(ui).includes('2 ● second prompt'), 8000, () => ui.lastFrame());
    const frame = plainFrame(ui);
    expect(frame).toContain('1 ● first prompt');
    expect(frame).toContain('ok2'); // second answer, in the active (second) tab
    expect(frame).not.toMatch(/^ │ first prompt/m);

    // Ctrl+P goes back to the first tab.
    ui.stdin.write('\x10');
    await until(() => plainFrame(ui).includes('│ first prompt'), 8000, () => ui.lastFrame());

    await session.close();
    ui.unmount();

    // The log replays to the same two finished tabs.
    expect(existsSync(logPath(sessionId))).toBe(true);
    const replayed = replay(sessionId);
    expect(replayed.tabs.map((t) => [t.prompt, t.status])).toEqual([['first prompt', 'done'], ['second prompt', 'done']]);
    expect(replayed.running).toBeNull();
    expect(readFileSync(logPath(sessionId), 'utf8')).not.toContain('"stream_event"');
    expect(stateDir).toBeTruthy();
  });

  it('shows a header with the version, model, effort, plan and folder until the first prompt', async () => {
    const cwd = process.cwd();
    setup('two-turns-stdin.jsonl');
    const sessionId = '00000000-0000-4000-8000-0000000000f1';
    const session = new Session({ sessionId, resume: false, cwd, passthrough: [] });
    session.start();
    const { ui } = mount(session, sessionId, cwd);

    await until(() => plainFrame(ui).includes('Opus 5.5 with xhigh effort · Claude Max'), 8000, () => ui.lastFrame());
    const { version } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    // The name in block letters, the version after its shadow.
    expect(plainFrame(ui)).toContain('██████╗ ██╗███╗   ██╗██████╗ ███████╗██████╗');
    expect(plainFrame(ui)).toContain(`╚═╝  ╚═╝  v${version}`);
    expect(plainFrame(ui)).not.toContain('Binder v');
    expect(plainFrame(ui)).toContain(cwd);

    await type(ui, 'first prompt');
    await until(() => plainFrame(ui).includes('1 ● first prompt'), 8000, () => ui.lastFrame());
    expect(plainFrame(ui)).not.toContain(`v${version}`);

    await session.close();
    ui.unmount();
  });

  it('names binder in plain text when the block letters do not fit', () => {
    const { version } = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const ui = render(<Welcome cwd="/tmp" width={40} />);
    expect(plainFrame(ui)).toContain(`Binder v${version}`);
    ui.unmount();
  });

  it('answers AskUserQuestion through the control protocol and marks an interrupted turn', async () => {
    const cwd = process.cwd();
    const stateDir = setup('ask-and-interrupt.jsonl');
    const answersOut = join(stateDir, 'answers.json');
    process.env.BINDER_FAKE_ANSWERS_OUT = answersOut;
    process.env.BINDER_FAKE_DELAY_MS = '5';
    const sessionId = '00000000-0000-4000-8000-000000000002';
    const session = new Session({ sessionId, resume: false, cwd, passthrough: [] });
    session.start();
    const { ui } = mount(session, sessionId, cwd);

    await type(ui, 'ask me a color');
    await until(() => plainFrame(ui).match(/1\.\s+Red/), 8000, () => ui.lastFrame());
    expect(plainFrame(ui)).toContain('Which color do you prefer?');
    expect(plainFrame(ui)).toMatch(/2\.\s+Blue/);
    await sleep(50); // let the picker's input hook attach after its first paint
    ui.stdin.write('2');
    await until(() => plainFrame(ui).includes('1 ● ask me a color'), 8000, () => ui.lastFrame());
    const sent = JSON.parse(readFileSync(answersOut, 'utf8'));
    expect(sent.response.response.behavior).toBe('allow');
    expect(sent.response.response.updatedInput.answers).toEqual({ 'Which color do you prefer?': 'Blue' });
    const strip = (f: string) => f.replace(/\x1b\[[0-9;:]*[A-Za-z]/g, '');
    await until(() => /picked blue/i.test(strip(plainFrame(ui))), 8000, () => ui.lastFrame());

    // Second turn in the fixture ends with the aborted result; Esc marks it interrupted.
    await type(ui, 'count');
    await until(() => plainFrame(ui).includes('2 ⠋ count') || plainFrame(ui).includes('2 ◼ count') || /2 [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] count/.test(plainFrame(ui)), 8000, () => ui.lastFrame());
    await sleep(50);
    ui.stdin.write('\x1b');
    await until(() => plainFrame(ui).includes('2 ◼ count'), 8000, () => ui.lastFrame());
    expect(plainFrame(ui)).toContain('interrupted');

    await session.close();
    ui.unmount();
  });

  // Bypass mode still asks when Claude Code's own safety checks fire; the
  // prompt says why, or it looks like bypass mode is broken.
  it('shows why a permission prompt was raised, and Allow lets the tool run', async () => {
    const cwd = process.cwd();
    const stateDir = setup('permission-safety-check.jsonl');
    const answersOut = join(stateDir, 'answers.json');
    process.env.BINDER_FAKE_ANSWERS_OUT = answersOut;
    const sessionId = '00000000-0000-4000-8000-00000000000d';
    const session = new Session({ sessionId, resume: false, cwd, passthrough: [] });
    session.start();
    const { ui } = mount(session, sessionId, cwd);

    await type(ui, 'clean up');
    await until(() => plainFrame(ui).includes('Allow Bash?'), 8000, () => ui.lastFrame());
    expect(plainFrame(ui).replace(/[│\s]+/g, ' ')).toContain('Dangerous rm operation on possibly-empty variable path');
    await sleep(50); // let the picker's input hook attach after its first paint
    ui.stdin.write('1');
    await until(() => plainFrame(ui).includes('Removed the log.'), 8000, () => ui.lastFrame());
    expect(JSON.parse(readFileSync(answersOut, 'utf8')).response.response.behavior).toBe('allow');

    await session.close();
    ui.unmount();
  });
});

describe('App with background work', () => {
  // The state after playing a recorded event log (see fixtures/background-*.jsonl) up to its nth result.
  function played(name: string, results: number): State {
    let s = initialState('sid');
    let seen = 0;
    for (const line of readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter(Boolean)) {
      const e = JSON.parse(line);
      if (e.type === 'hc_prompt') {
        s = reduce(s, { type: 'submit', prompt: e.prompt, tabId: e.tabId });
        s = reduce(s, { type: 'sent', tabId: e.tabId, uuid: e.uuid });
      } else {
        s = reduce(s, { type: 'event', event: e as ClaudeEvent });
      }
      if (e.type === 'result' && ++seen === results) break;
    }
    return s;
  }

  it('names running background tasks in the status row, then shows the turn the child starts when they finish', async () => {
    const cwd = process.cwd();
    const session = new Session({ sessionId: 'sid', resume: false, cwd, passthrough: [] });
    const idle = mount(session, 'sid', cwd, played('background-bash.jsonl', 1)).ui;
    expect(plainFrame(idle)).toContain('◷ 1 background task: sleep 8; echo BG_DONE');
    idle.unmount();

    const after = mount(session, 'sid', cwd, played('background-bash.jsonl', 2)).ui;
    await until(() => plainFrame(after).includes('Background task finished'), 8000, () => after.lastFrame());
    const frame = plainFrame(after);
    expect(frame).toContain('⏺ Background task finished: sleep 8; echo BG_DONE');
    expect(frame).toMatch(/Background task finished[\s\S]*BG_DONE/);
    expect(frame).not.toContain('background task:');
    after.unmount();
  });
});

describe('App after the child dies', () => {
  it('shows the exit, and Ctrl+R restarts and resumes', async () => {
    const cwd = process.cwd();
    setup('single-turn-partial.jsonl');
    process.env.BINDER_FAKE_FIXTURE = ''; // makes the fake binary exit 2 immediately
    const sessionId = '00000000-0000-4000-8000-000000000003';
    const session = new Session({ sessionId, resume: false, cwd, passthrough: [] });
    session.start();
    const { ui } = mount(session, sessionId, cwd);
    await until(() => plainFrame(ui).includes('claude exited (code 2)'), 8000, () => ui.lastFrame());
    expect(plainFrame(ui)).toContain('BINDER_FAKE_FIXTURE');

    process.env.BINDER_FAKE_FIXTURE = join(FIXTURES, 'single-turn-partial.jsonl');
    ui.stdin.write('\x12'); // Ctrl+R
    await until(() => !plainFrame(ui).includes('claude exited'), 8000, () => ui.lastFrame());
    await type(ui, 'after restart');
    await until(() => plainFrame(ui).includes('1 ● after restart'), 8000, () => ui.lastFrame());
    await session.close();
    ui.unmount();
  });
});

describe('tab switching keys', () => {
  it('Ctrl+Left/Right switch tabs and Option+Left moves the cursor by a word', async () => {
    const cwd = process.cwd();
    setup('two-turns-stdin.jsonl');
    const sessionId = '00000000-0000-4000-8000-000000000004';
    const session = new Session({ sessionId, resume: false, cwd, passthrough: [] });
    session.start();
    const { ui } = mount(session, sessionId, cwd);
    await type(ui, 'first prompt');
    await until(() => plainFrame(ui).includes('1 ● first prompt'), 8000, () => ui.lastFrame());
    await type(ui, 'second prompt');
    await until(() => plainFrame(ui).includes('2 ● second prompt'), 8000, () => ui.lastFrame());
    expect(plainFrame(ui)).toContain('│ second prompt');
    ui.stdin.write('\x1b[1;5D'); // Ctrl+Left
    await until(() => plainFrame(ui).includes('│ first prompt'), 8000, () => ui.lastFrame());
    ui.stdin.write('\x1b[1;5C'); // Ctrl+Right
    await until(() => plainFrame(ui).includes('│ second prompt'), 8000, () => ui.lastFrame());

    // Option+Left does not switch tabs; it moves the cursor back a word so typing lands there.
    ui.stdin.write('one two');
    await sleep(30);
    ui.stdin.write('\x1b[1;3D');
    await sleep(30);
    ui.stdin.write('X');
    await until(() => plainFrame(ui).includes('one Xtwo'), 8000, () => ui.lastFrame());
    expect(plainFrame(ui)).toContain('│ second prompt');
    await session.close();
    ui.unmount();
  });
});

describe('selection and images in the prompt', () => {
  it.skipIf(process.platform !== 'darwin')('Shift+Left selects, typing replaces the selection, and Ctrl+V attaches a clipboard image', async () => {
    const cwd = process.cwd();
    const stateDir = setup('single-turn-partial.jsonl');
    const inputOut = join(stateDir, 'input.jsonl');
    process.env.BINDER_FAKE_INPUT_OUT = inputOut;
    const sessionId = '00000000-0000-4000-8000-000000000005';
    const session = new Session({ sessionId, resume: false, cwd, passthrough: [] });
    session.start();
    const { ui } = mount(session, sessionId, cwd);

    ui.stdin.write('hello world');
    await sleep(30);
    for (let i = 0; i < 5; i++) { ui.stdin.write('\x1b[1;2D'); await sleep(15); } // Shift+Left x5 selects "world"
    ui.stdin.write('there');
    await until(() => plainFrame(ui).includes('hello there'), 8000, () => ui.lastFrame());

    // Put a PNG on the clipboard, then Ctrl+V.
    const { execFileSync } = await import('node:child_process');
    const saved = execFileSync('pbpaste').toString();
    const png = join(FIXTURES, 'orange.png');
    execFileSync('osascript', ['-e', `set the clipboard to (read (POSIX file "${png}") as «class PNGf»)`]);
    try {
      ui.stdin.write('\x16');
      await until(() => plainFrame(ui).includes('[Image #1]'), 8000, () => ui.lastFrame());
    } finally {
      execFileSync('pbcopy', { input: saved });
    }
    ui.stdin.write('\r');
    await until(() => plainFrame(ui).includes('1 ● hello there'), 8000, () => ui.lastFrame());

    const sent = readFileSync(inputOut, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((m) => m.type === 'user');
    expect(sent.message.content[0]).toEqual({ type: 'text', text: 'hello there[Image #1]' });
    expect(sent.message.content[1].type).toBe('image');
    expect(sent.message.content[1].source.media_type).toBe('image/png');
    expect(sent.message.content[1].source.data.length).toBeGreaterThan(100);
    await session.close();
    ui.unmount();
  });
});

describe('copying the prompt selection', () => {
  it.skipIf(process.platform !== 'darwin')('Ctrl+C copies the selected text instead of arming quit', async () => {
    const cwd = process.cwd();
    setup('single-turn-partial.jsonl');
    const sessionId = '00000000-0000-4000-8000-000000000020';
    const session = new Session({ sessionId, resume: false, cwd, passthrough: [] });
    session.start();
    const { ui } = mount(session, sessionId, cwd);
    const { execFileSync } = await import('node:child_process');
    const saved = execFileSync('pbpaste').toString();
    try {
      ui.stdin.write('hello world');
      await sleep(30);
      for (let i = 0; i < 5; i++) { ui.stdin.write('\x1b[1;2D'); await sleep(15); } // Shift+Left x5 selects "world"
      ui.stdin.write('\x03'); // Ctrl+C
      await until(() => execFileSync('pbpaste').toString() === 'world', 8000, () => ui.lastFrame());
      await until(() => plainFrame(ui).includes('copied to clipboard'), 8000, () => ui.lastFrame());
      expect(plainFrame(ui)).not.toContain('Press Ctrl+C again to quit');
    } finally {
      execFileSync('pbcopy', { input: saved });
    }
    await session.close();
    ui.unmount();
  });
});

describe('shortcuts popup', () => {
  it('opens with "?" under the prompt, and Esc closes it without counting toward a rewind', async () => {
    const cwd = process.cwd();
    setup('single-turn-partial.jsonl');
    const sessionId = '00000000-0000-4000-8000-000000000021';
    const session = new Session({ sessionId, resume: false, cwd, passthrough: [] });
    session.start();
    const { ui } = mount(session, sessionId, cwd);
    await until(() => plainFrame(ui).includes('? for shortcuts'), 8000, () => ui.lastFrame());
    ui.stdin.write('?');
    await until(() => plainFrame(ui).includes('ctrl + n / p to switch tabs'), 8000, () => ui.lastFrame());
    ui.stdin.write('\x1b');
    await sleep(60);
    ui.stdin.write('\x1b');
    await until(() => !plainFrame(ui).includes('ctrl + n / p to switch tabs'), 8000, () => ui.lastFrame());
    await sleep(200);
    expect(plainFrame(ui)).not.toContain('No prompts to rewind to yet');
    await session.close();
    ui.unmount();
  });
});

describe('Ctrl+V', () => {
  it.skipIf(process.platform !== 'darwin')('pastes the clipboard text when it holds no image, collapsing long text as a paste does', async () => {
    const { execFileSync } = await import('node:child_process');
    const saved = execFileSync('pbpaste').toString();
    const sent: string[] = [];
    const ui = render(<PromptInput onSubmit={(text) => sent.push(text)} isActive width={80} />);
    try {
      execFileSync('pbcopy', { input: 'from the clipboard ' });
      ui.stdin.write('\x16');
      await until(() => plainFrame(ui).includes('❯ from the clipboard'), 8000, () => ui.lastFrame());
      execFileSync('pbcopy', { input: 'one\ntwo\nthree\nfour' });
      ui.stdin.write('\x16');
      await until(() => plainFrame(ui).includes('❯ from the clipboard [Pasted text #1 +3 lines]'), 8000, () => ui.lastFrame());
      ui.stdin.write(ENTER);
      await until(() => sent.length === 1, 8000, () => ui.lastFrame());
      expect(sent[0]).toBe('from the clipboard one\ntwo\nthree\nfour');
    } finally {
      execFileSync('pbcopy', { input: saved });
      ui.unmount();
    }
  });
});

describe('draft prompt', () => {
  it('starts with the draft in the composer, unsent, and Enter sends it', async () => {
    const cwd = process.cwd();
    const stateDir = setup('single-turn-partial.jsonl');
    const inputOut = join(stateDir, 'input.jsonl');
    process.env.BINDER_FAKE_INPUT_OUT = inputOut;
    const sessionId = '00000000-0000-4000-8000-000000000009';
    const session = new Session({ sessionId, resume: false, cwd, passthrough: [] });
    session.start();
    const { ui } = mount(session, sessionId, cwd, initialState(sessionId), 'Pay rent');

    await until(() => plainFrame(ui).includes('Pay rent'), 8000, () => ui.lastFrame());
    await sleep(100);
    expect(existsSync(inputOut) ? readFileSync(inputOut, 'utf8') : '').not.toContain('Pay rent');

    ui.stdin.write(' today');
    await sleep(30);
    ui.stdin.write(ENTER);
    await until(() => plainFrame(ui).includes('1 ● Pay rent today'), 8000, () => ui.lastFrame());
    const sent = readFileSync(inputOut, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((m) => m.type === 'user');
    expect(sent.message.content).toBe('Pay rent today');
    await session.close();
    ui.unmount();
  });

  // A permission prompt used to replace the composer, and putting it back
  // brought the draft back with it, dropping whatever was typed since.
  it('does not come back after a permission prompt, and text typed meanwhile stays', async () => {
    const cwd = process.cwd();
    setup('permission-safety-check.jsonl', { BINDER_FAKE_DELAY_MS: '300' });
    const sessionId = '00000000-0000-4000-8000-00000000000e';
    const session = new Session({ sessionId, resume: false, cwd, passthrough: [] });
    session.start();
    const { ui } = mount(session, sessionId, cwd, initialState(sessionId), 'Pay rent');

    await until(() => plainFrame(ui).includes('❯ Pay rent'), 8000, () => ui.lastFrame());
    await sleep(50);
    ui.stdin.write(ENTER);
    await until(() => plainFrame(ui).includes('Enter queues a new tab'), 8000, () => ui.lastFrame());
    ui.stdin.write('next idea');
    await until(() => plainFrame(ui).includes('❯ next idea'), 8000, () => ui.lastFrame());
    await until(() => plainFrame(ui).includes('Allow Bash?'), 8000, () => ui.lastFrame());
    await sleep(50); // let the picker's input hook attach after its first paint
    ui.stdin.write('1');
    await until(() => plainFrame(ui).includes('Removed the log.'), 8000, () => ui.lastFrame());
    expect(plainFrame(ui)).toContain('❯ next idea');
    expect(plainFrame(ui)).not.toContain('❯ Pay rent');
    await session.close();
    ui.unmount();
  });
});

describe('layout with a long response', () => {
  it('keeps the tab bar, prompt and status line on screen', async () => {
    const cwd = process.cwd();
    setup('long-turn.jsonl');
    const sessionId = '00000000-0000-4000-8000-000000000006';
    const session = new Session({ sessionId, resume: false, cwd, passthrough: [] });
    session.start();
    const { ui } = mount(session, sessionId, cwd);
    await type(ui, 'run the long task');
    await until(() => plainFrame(ui).includes('Plain text after a rule. Done.'), 15000, () => ui.lastFrame());
    const frame = plainFrame(ui);
    expect(frame).toContain('1 ● run the long task'); // tab bar
    expect(frame).toContain('❯'); // prompt
    expect(frame).toContain('Opus 5.5 │ 5h 12% 7d 20%'); // status line (fallback bar)
    await session.close();
    ui.unmount();
  });

  it('shows what the running turn is doing above the prompt until it finishes', async () => {
    const cwd = process.cwd();
    setup('long-turn.jsonl', { BINDER_FAKE_DELAY_MS: '1' });
    const sessionId = '00000000-0000-4000-8000-00000000000c';
    const session = new Session({ sessionId, resume: false, cwd, passthrough: [] });
    session.start();
    const { ui } = mount(session, sessionId, cwd);
    await type(ui, 'run the long task');
    await until(() => plainFrame(ui).includes('esc to interrupt'), 8000, () => ui.lastFrame());
    expect(plainFrame(ui)).toMatch(/(Thinking|Running \w+|Writing)… \(\d+s · esc to interrupt\)/);
    await until(() => plainFrame(ui).includes('Plain text after a rule. Done.'), 15000, () => ui.lastFrame());
    await until(() => !plainFrame(ui).includes('esc to interrupt'), 8000, () => ui.lastFrame());
    await session.close();
    ui.unmount();
  });

  it('scrolls with the mouse wheel, and follows the bottom again once back there', async () => {
    const cwd = process.cwd();
    setup('long-turn.jsonl');
    const sessionId = '00000000-0000-4000-8000-000000000022';
    const session = new Session({ sessionId, resume: false, cwd, passthrough: [] });
    session.start();
    const { ui } = mount(session, sessionId, cwd);
    await type(ui, 'run the long task');
    const last = 'Plain text after a rule. Done.';
    await until(() => plainFrame(ui).includes(last), 15000, () => ui.lastFrame());
    for (let i = 0; i < 5; i++) takeMouse('\x1b[<64;10;10M'); // wheel up
    await until(() => !plainFrame(ui).includes(last), 8000, () => ui.lastFrame());
    for (let i = 0; i < 20; i++) takeMouse('\x1b[<65;10;10M'); // wheel down, past the end
    await until(() => plainFrame(ui).includes(last), 8000, () => ui.lastFrame());
    await session.close();
    ui.unmount();
  });
});

describe('Ctrl+Enter', () => {
  const CTRL_ENTER = '\x1b[13;5u'; // how iTerm2 and kitty report it with the kitty keyboard protocol on

  it('on a finished tab sends the prompt into that tab instead of opening a new one', async () => {
    const cwd = process.cwd();
    setup('two-turns-stdin.jsonl');
    const sessionId = '00000000-0000-4000-8000-00000000000a';
    const session = new Session({ sessionId, resume: false, cwd, passthrough: [] });
    session.start();
    const { ui } = mount(session, sessionId, cwd);
    await type(ui, 'first prompt');
    await until(() => plainFrame(ui).includes('1 ● first prompt'), 8000, () => ui.lastFrame());

    ui.stdin.write('more please');
    await sleep(30);
    ui.stdin.write(CTRL_ENTER);
    await until(() => plainFrame(ui).includes('ok2'), 8000, () => ui.lastFrame());
    const frame = plainFrame(ui);
    expect(frame).toContain('│ first prompt');
    expect(frame).toContain('│ more please');
    expect(frame).toContain('1 ● first prompt'); // the tab keeps its first prompt as its title
    expect(frame).not.toMatch(/\b2 [●◌⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /); // no second tab
    await session.close();
    ui.unmount();

    const replayed = replay(sessionId);
    expect(replayed.tabs).toHaveLength(1);
    expect(replayed.tabs[0].earlier.map((t) => t.prompt)).toEqual(['first prompt']);
    expect([replayed.tabs[0].prompt, replayed.tabs[0].status]).toEqual(['more please', 'done']);
  });

  it('on a running tab sends now: the turn is stopped and the follow-up runs in the same tab', async () => {
    const cwd = process.cwd();
    const stateDir = setup('two-turns-stdin.jsonl', {
      BINDER_FAKE_CAPS: 'interrupt_send_now_v1,msg_lifecycle_v1',
      BINDER_FAKE_DELAY_MS: '100',
    });
    const inputOut = join(stateDir, 'input.jsonl');
    process.env.BINDER_FAKE_INPUT_OUT = inputOut;
    const sessionId = '00000000-0000-4000-8000-00000000000b';
    const session = new Session({ sessionId, resume: false, cwd, passthrough: [] });
    session.start();
    const { ui } = mount(session, sessionId, cwd);
    try {
      await type(ui, 'first prompt');
      // The model name shows once the init line (which advertises send_now) has
      // arrived; the turn's answer is still a few lines away.
      await until(() => /1 [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] first prompt/.test(plainFrame(ui)) && plainFrame(ui).includes('Haiku'), 8000, () => ui.lastFrame());
      ui.stdin.write('steer me');
      await sleep(30);
      ui.stdin.write(CTRL_ENTER);
      await until(() => plainFrame(ui).includes('1 ● first prompt') && plainFrame(ui).includes('ok2'), 8000, () => ui.lastFrame());
      const frame = plainFrame(ui);
      expect(frame).toContain('│ first prompt');
      expect(frame).toContain('│ steer me');
      expect(frame).not.toMatch(/\b2 [●◌⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /);

      const sent = readFileSync(inputOut, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const steer = sent.find((m) => m.type === 'user' && m.message.content === 'steer me');
      expect(steer.uuid).toMatch(/^[0-9a-f-]{36}$/);
      const sendNow = sent.find((m) => m.type === 'control_request' && m.request.subtype === 'interrupt');
      expect(sendNow.request).toEqual({ subtype: 'interrupt', send_now: true, message_uuid: steer.uuid });
    } finally {
      delete process.env.BINDER_FAKE_CAPS;
      await session.close();
      ui.unmount();
    }

    const replayed = replay(sessionId);
    expect(replayed.tabs).toHaveLength(1);
    expect(replayed.tabs[0].earlier.map((t) => [t.prompt, t.status])).toEqual([['first prompt', 'superseded']]);
    expect([replayed.tabs[0].prompt, replayed.tabs[0].status]).toEqual(['steer me', 'done']);
  });
});

describe('slash commands', () => {
  const ESC = '\x1b';
  const DOWN = '\x1b[B';

  it('opens a menu of commands as you type, completes with Tab, and closes with Esc', async () => {
    const cwd = process.cwd();
    setup('two-turns-stdin.jsonl');
    const sessionId = '00000000-0000-4000-8000-00000000000d';
    const session = new Session({ sessionId, resume: false, cwd, passthrough: [] });
    session.start();
    const { ui } = mount(session, sessionId, cwd);
    // The fake answers `initialize` with its command list.
    ui.stdin.write('/');
    await until(() => plainFrame(ui).includes('Show current context usage'), 8000, () => ui.lastFrame());
    expect(plainFrame(ui)).toContain('/cd <path>');
    expect(plainFrame(ui)).toContain('/bump-version');

    ui.stdin.write('co');
    await until(() => !plainFrame(ui).includes('/cd <path>'), 8000, () => ui.lastFrame());
    expect(plainFrame(ui)).toMatch(/\/compact <optional[^\n]*\n\s*\/context /);

    ui.stdin.write(DOWN);
    await sleep(30);
    ui.stdin.write('\t');
    await until(() => plainFrame(ui).includes('❯ /context'), 8000, () => ui.lastFrame());
    expect(plainFrame(ui)).not.toContain('Show current context usage'); // a space ends the menu

    ui.stdin.write('\x15'); // Ctrl+U clears the prompt
    await sleep(30);
    ui.stdin.write('/he');
    await until(() => plainFrame(ui).includes('Show keys and commands'), 8000, () => ui.lastFrame());
    ui.stdin.write(ESC);
    await until(() => !plainFrame(ui).includes('Show keys and commands'), 8000, () => ui.lastFrame());
    expect(plainFrame(ui)).toContain('❯ /he');
    await session.close();
    ui.unmount();
  });

  it('/help shows keys in place of the transcript until Esc', async () => {
    const cwd = process.cwd();
    setup('two-turns-stdin.jsonl');
    const sessionId = '00000000-0000-4000-8000-00000000000e';
    const session = new Session({ sessionId, resume: false, cwd, passthrough: [] });
    session.start();
    const { ui } = mount(session, sessionId, cwd);
    await type(ui, '/help');
    await until(() => plainFrame(ui).includes('Type / to browse all'), 8000, () => ui.lastFrame());
    expect(plainFrame(ui)).toContain('Ctrl+Enter');
    expect(plainFrame(ui)).not.toMatch(/1 [●◌⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \/help/); // no tab, nothing sent
    ui.stdin.write(ESC);
    await until(() => !plainFrame(ui).includes('Type / to browse all'), 8000, () => ui.lastFrame());
    await session.close();
    ui.unmount();
  });

  it('/clear starts a fresh session and /resume brings the previous one back', async () => {
    const cwd = process.cwd();
    const stateDir = setup('two-turns-stdin.jsonl');
    const sessionId = '00000000-0000-4000-8000-00000000000f';
    // /resume lists Claude Code's transcripts; the fake binary writes none, so stand one in.
    const configDir = join(stateDir, 'claude');
    mkdirSync(join(configDir, 'projects', 'p'), { recursive: true });
    writeFileSync(join(configDir, 'projects', 'p', `${sessionId}.jsonl`), JSON.stringify({ type: 'user', cwd, gitBranch: 'main', message: { role: 'user', content: 'first prompt' } }) + '\n');
    const session = new Session({ sessionId, resume: false, cwd, passthrough: [] });
    session.start();
    const ui = render(<App host={new SessionHost(session, initialState(sessionId), cwd, configDir)} configDir={configDir} onQuit={() => {}} />);
    await type(ui, 'first prompt');
    await until(() => plainFrame(ui).includes('1 ● first prompt'), 8000, () => ui.lastFrame());

    await type(ui, '/clear');
    await until(() => plainFrame(ui).includes('no tabs yet'), 8000, () => ui.lastFrame());
    expect(session.sessionId).not.toBe(sessionId);
    expect(plainFrame(ui)).toContain('/resume 00000000 brings the previous one back');

    await type(ui, '/resume');
    await until(() => plainFrame(ui).includes('Resume a session: this folder'), 8000, () => ui.lastFrame());
    expect(plainFrame(ui)).toMatch(/❯ first prompt\s+\d+m ago · main/);
    ui.stdin.write(ENTER);
    await until(() => plainFrame(ui).includes('1 ● first prompt'), 8000, () => ui.lastFrame());
    expect(session.sessionId).toBe(sessionId);
    expect(plainFrame(ui)).toContain('│ first prompt');
    await session.close();
    ui.unmount();
  });
});
