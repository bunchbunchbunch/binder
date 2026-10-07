import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/ui/App.js';
import { SessionHost } from '../src/host.js';
import { initialStateFor, parseArgs, sessionFor, type Launch } from '../src/args.js';
import { CodexSession } from '../src/codex/session.js';
import { initialState } from '../src/store.js';
import { FAKE_CODEX, FIXTURES } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const plainFrame = (ui: { lastFrame: () => string | undefined }) =>
  (ui.lastFrame() ?? '').replace(/\x1b\[[0-9;:]*[A-Za-z]/g, '').replace(/\x1b\]8;;[^\x1b\x07]*(?:\x1b\\|\x07)/g, '');

async function until(check: () => boolean, ms = 8000, lastFrame?: () => string | undefined): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting; last frame:\n' + (lastFrame?.() ?? ''));
    await sleep(25);
  }
}

function setup(fixture: string) {
  const stateDir = mkdtempSync(join(tmpdir(), 'binder-state-'));
  process.env.BINDER_STATE_DIR = stateDir;
  process.env.BINDER_CODEX_BIN = FAKE_CODEX;
  process.env.BINDER_FAKE_FIXTURE = join(FIXTURES, 'codex', fixture);
  process.env.BINDER_FAKE_INPUT_OUT = join(stateDir, 'input.jsonl');
  return stateDir;
}

describe('App on a Codex session', () => {
  it('runs a prompt with an approval, shows Codex in the bar, and resumes as Codex from the session index', async () => {
    const cwd = process.cwd();
    const stateDir = setup('approve.jsonl');
    const launch = parseArgs(['--codex'], cwd) as Launch;
    expect(launch.agent).toBe('codex');
    const session = sessionFor(launch, cwd);
    expect(session).toBeInstanceOf(CodexSession);
    const cfg = join(cwd, 'nonexistent-codex-home');
    session.start();
    const host = new SessionHost(session, initialState(launch.sessionId), cwd, cfg);
    const ui = render(<App host={host} configDir={cfg} onQuit={() => {}} />);

    await until(() => plainFrame(ui).includes('GPT-6-Luna'), 8000, () => ui.lastFrame());
    expect(plainFrame(ui)).toContain('ChatGPT Free');

    ui.stdin.write('make a note');
    await sleep(30);
    ui.stdin.write('\r');
    await until(() => plainFrame(ui).includes('Allow Bash?'), 8000, () => ui.lastFrame());
    await sleep(50);
    ui.stdin.write('1');
    await until(() => host.state.tabs[0]?.status === 'done' && plainFrame(ui).includes('30d 0%'), 8000, () => ui.lastFrame());
    const bash = host.state.tabs[0].blocks.find((b) => b.kind === 'tool_use');
    expect(bash).toMatchObject({ name: 'Bash', input: { command: 'mkdir -p out && echo hello > out/note.txt' } });
    const answers = readFileSync(join(stateDir, 'input.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(answers.find((m) => m.id === 0 && !m.method)?.result).toEqual({ decision: 'accept' });

    // Esc Esc would rewind; Codex has no checkpoints.
    ui.stdin.write('\x1b');
    await sleep(20);
    ui.stdin.write('\x1b');
    await until(() => plainFrame(ui).includes('/rewind is not available in a Codex session'), 8000, () => ui.lastFrame());

    await session.close();
    ui.unmount();

    // Relaunching by id finds the agent in sessions.json and replays the tab.
    const again = parseArgs([launch.sessionId], cwd) as Launch;
    expect(again).toMatchObject({ sessionId: launch.sessionId, resume: true, agent: 'codex' });
    const restored = initialStateFor(again, cwd, cfg);
    expect(restored.tabs.map((t) => [t.prompt, t.status])).toEqual([['make a note', 'done']]);
  });
});
