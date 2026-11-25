import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { hostInfo } from '../src/remote/serve.js';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { App } from '../src/ui/App.js';
import { Session } from '../src/session.js';
import { SessionHost } from '../src/host.js';
import { initialState } from '../src/store.js';
import { logPath, replay } from '../src/eventLog.js';
import { findSession } from '../src/sessions.js';
import { plainLines } from '../src/ui/panels.js';
import { FAKE_BIN, FIXTURES } from './helpers.js';
import { setBellWriter, setFocused } from '../src/attention.js';

const ENTER = '\r';
const ESC = '\x1b';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const TAB = '\t';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const plain = (ui: { lastFrame: () => string | undefined }) =>
  (ui.lastFrame() ?? '').replace(/\x1b\[[0-9;:]*[A-Za-z]/g, '').replace(/\x1b\]8;;[^\x1b\x07]*(?:\x1b\\|\x07)/g, '');

async function until(check: () => boolean, ui: { lastFrame: () => string | undefined }, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting; last frame:\n' + plain(ui));
    await sleep(25);
  }
}

// Each test gets its own state dir, transcript dir and session.
function start(name: string, opts: { cwd?: string; fixture?: string; delay?: number; env?: Record<string, string>; bell?: boolean } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), `binder-${name}-`));
  const inputOut = join(stateDir, 'input.jsonl');
  const argsOut = join(stateDir, 'args.json');
  Object.assign(process.env, {
    BINDER_STATE_DIR: stateDir,
    BINDER_CLAUDE_BIN: FAKE_BIN,
    BINDER_FAKE_FIXTURE: resolve(FIXTURES, opts.fixture ?? 'two-turns-stdin.jsonl'),
    BINDER_FAKE_INPUT_OUT: inputOut,
    BINDER_FAKE_ARGS_OUT: argsOut,
  });
  delete process.env.BINDER_FAKE_DELAY_MS;
  if (opts.delay) process.env.BINDER_FAKE_DELAY_MS = String(opts.delay);
  for (const k of ['BINDER_FAKE_CAPS', 'BINDER_FAKE_FAST_REASON', 'BINDER_FAKE_REFUSE_MODES', 'BINDER_FAKE_ANSWERS_OUT', 'BINDER_FAKE_GH_STATE']) delete process.env[k];
  process.env.BINDER_GH = '/nonexistent/gh';
  Object.assign(process.env, opts.env);
  const cwd = opts.cwd ?? process.cwd();
  const configDir = join(stateDir, 'claude');
  // The claude child's config dir too, as in production (launchConfigDir).
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const sessionId = `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`;
  const session = new Session({ sessionId, resume: false, cwd, passthrough: [] });
  session.start();
  const host = new SessionHost(session, initialState(sessionId), cwd, configDir);
  const ui = render(<App host={host} configDir={configDir} bell={opts.bell} onQuit={() => {}} />);
  const sent = () => (existsSync(inputOut) ? readFileSync(inputOut, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const requests = (subtype: string) => sent().filter((m) => m.type === 'control_request' && m.request.subtype === subtype).map((m) => m.request);
  const args = () => JSON.parse(readFileSync(argsOut, 'utf8')) as string[];
  const type = async (text: string, submit = true) => {
    ui.stdin.write(text);
    await sleep(40);
    if (submit) {
      ui.stdin.write(ENTER);
      await sleep(40);
    }
  };
  const key = async (k: string) => {
    ui.stdin.write(k);
    await sleep(60);
  };
  const frame = () => plain(ui);
  const wait = (check: () => boolean, ms?: number) => until(check, ui, ms);
  const stop = async () => {
    await session.close();
    ui.unmount();
  };
  return { ui, session, host, sessionId, stateDir, configDir, cwd, type, key, frame, wait, sent, requests, args, stop };
}

describe('prompt history', () => {
  it('walks earlier prompts with Up and back to the draft with Down', async () => {
    const t = start('history');
    await t.type('first prompt');
    await t.wait(() => t.frame().includes('1 ● first prompt'));
    await t.type('second prompt');
    await t.wait(() => t.frame().includes('2 ● second prompt'));
    await t.type('draft', false);
    await t.key(UP);
    await t.wait(() => t.frame().includes('❯ second prompt'));
    await t.key(UP);
    await t.wait(() => t.frame().includes('❯ first prompt'));
    await t.key(DOWN);
    await t.wait(() => t.frame().includes('❯ second prompt'));
    await t.key(DOWN);
    await t.wait(() => t.frame().includes('❯ draft'));
    await t.stop();
  });
});

describe('tab completion', () => {
  it('fills the common part, then lists the matches; @ lists files as you type', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'binder-tabdir-'));
    mkdirSync(join(dir, 'alpine'));
    writeFileSync(join(dir, 'alpha.txt'), '');
    const t = start('complete', { cwd: dir });
    await t.type('look at al', false);
    await t.key(TAB);
    await t.wait(() => t.frame().includes('❯ look at alp'));
    await t.key(TAB);
    await t.wait(() => t.frame().includes('alpine/') && t.frame().includes('alpha.txt'));
    await t.key(DOWN);
    await t.key(ENTER);
    await t.wait(() => t.frame().includes('❯ look at alpine/'));
    expect(t.frame()).not.toContain('alpha.txt');

    await t.key('\x15'); // Ctrl+U clears the prompt
    await t.type('read @alph', false);
    await t.wait(() => t.frame().includes('@alpha.txt'));
    await t.key(TAB);
    await t.type('now', false);
    await t.wait(() => t.frame().includes('❯ read @alpha.txt now'));
    await t.stop();
  });
});

describe('bash mode', () => {
  it('runs !commands in their own tab and hands the output to the model with the next prompt', async () => {
    const t = start('bash');
    await t.type('!echo hi-from-bash');
    await t.wait(() => t.frame().includes('1 ● !echo hi-from-bash') && t.frame().includes('hi-from-bash'));
    await t.type('what did it print?');
    await t.wait(() => t.frame().includes('2 ● what did it print?'));
    const prompt = t.sent().find((m) => m.type === 'user')!;
    expect(prompt.message.content).toBe('<bash-input>echo hi-from-bash</bash-input>\n<bash-stdout>hi-from-bash</bash-stdout>\n\nwhat did it print?');
    await t.stop();
    // The bash tab comes back on resume, and the prompt is logged without the context.
    const replayed = replay(t.sessionId);
    expect(replayed.tabs.map((tab) => [tab.id, tab.prompt, tab.status])).toEqual([[1, '!echo hi-from-bash', 'done'], [2, 'what did it print?', 'done']]);
  });
});

describe('/model and /effort', () => {
  it('pick from the models and effort levels the child reports', async () => {
    const t = start('model');
    await t.type('/model');
    await t.wait(() => t.frame().includes('Haiku 4.5'));
    await t.key(DOWN);
    await t.key(ENTER);
    await t.wait(() => t.frame().includes('Model: Haiku 4.5'));
    expect(t.requests('set_model')).toEqual([{ subtype: 'set_model', model: 'haiku' }]);

    await t.type('/effort');
    await t.wait(() => t.frame().includes('Effort') && t.frame().includes('medium'));
    await t.key(ENTER);
    await t.wait(() => t.frame().includes('Effort: low'));
    expect(t.requests('apply_flag_settings')).toEqual([{ subtype: 'apply_flag_settings', settings: { effortLevel: 'low' } }]);

    await t.type('/effort high');
    await t.wait(() => t.frame().includes('Effort: high'));
    await t.stop();
  });

  it("take pi's keys: Ctrl+L picks, Ctrl+P / Shift+Ctrl+P cycle models, Shift+Tab cycles effort", async () => {
    const t = start('pikeys');
    await t.wait(() => t.frame().includes('Opus 5.5 with xhigh effort'));
    await t.key('\x10'); // Ctrl+P
    await t.wait(() => t.frame().includes('Model: Haiku 4.5'));
    await t.key('\x1b[112;6u'); // Shift+Ctrl+P, in the kitty keyboard protocol
    await t.wait(() => t.frame().includes('Model: Opus 5.5'));
    expect(t.requests('set_model').map((r) => r.model)).toEqual(['haiku', 'default']);

    await t.key('\x1b[Z'); // Shift+Tab
    await t.wait(() => t.frame().includes('Effort: low'));
    await t.key('\x1b[Z');
    await t.wait(() => t.frame().includes('Effort: medium'));
    expect(t.requests('apply_flag_settings').map((r) => r.settings.effortLevel)).toEqual(['low', 'medium']);

    await t.key('\x0c'); // Ctrl+L
    await t.wait(() => t.frame().includes('Default (recommended)') && t.frame().includes('Haiku 4.5'));
    await t.key(ESC);
    await t.wait(() => !t.frame().includes('Default (recommended)'));
    await t.stop();
  });
});

describe('/mcp', () => {
  it('lists servers with their status and toggles one', async () => {
    const t = start('mcp');
    await t.type('/mcp');
    await t.wait(() => t.frame().includes('docs') && t.frame().includes('needs-auth'));
    await t.key(ENTER); // docs
    await t.wait(() => t.frame().includes('Disable'));
    await t.key(DOWN);
    await t.key(ENTER);
    await t.wait(() => t.frame().includes('Disabled docs'));
    expect(t.requests('mcp_toggle')).toEqual([{ subtype: 'mcp_toggle', serverName: 'docs', enabled: false }]);
    await t.wait(() => /○ docs\s+disabled/.test(t.frame()));
    await t.key(ESC);
    await t.wait(() => !t.frame().includes('MCP servers'));
    await t.stop();
  });
});

describe('/chrome', () => {
  it('shows the extension status and restarts claude with --chrome', async () => {
    const t = start('chrome');
    // Claude Code has the session on disk, as after a first turn.
    mkdirSync(join(t.configDir, 'projects', 'here'), { recursive: true });
    writeFileSync(join(t.configDir, 'projects', 'here', `${t.sessionId}.jsonl`), '');
    await t.type('/chrome');
    await t.wait(() => t.frame().includes('extension installed: yes · connected: no'));
    await t.key(ENTER);
    await t.wait(() => t.frame().includes('Restarted claude with Claude in Chrome'));
    await t.wait(() => t.args().includes('--chrome'));
    expect(t.args()).toEqual(expect.arrayContaining(['--resume', t.sessionId]));
    await t.stop();
  });
});

describe('/rewind', () => {
  it('drops a prompt and what followed, and puts the prompt back in the composer', async () => {
    const t = start('rewind');
    await t.type('first prompt');
    await t.wait(() => t.frame().includes('1 ● first prompt'));
    await t.type('second prompt');
    await t.wait(() => t.frame().includes('2 ● second prompt'));
    // Esc twice while idle opens it, as in Claude Code.
    await t.key(ESC);
    await t.key(ESC);
    await t.wait(() => t.frame().includes('Rewind to before a prompt'));
    await t.key(ENTER); // the newest prompt
    await t.wait(() => t.frame().includes('Restore code and conversation') && t.frame().includes('1 file'));
    await t.key(DOWN);
    await t.key(ENTER); // conversation only
    await t.wait(() => t.frame().includes('Restored the conversation'));
    await t.wait(() => t.frame().includes('❯ second prompt'));
    expect(t.frame()).not.toContain('2 ● second prompt');
    const second = t.sent().filter((m) => m.type === 'user')[1];
    expect(t.requests('rewind_conversation')).toEqual([{ subtype: 'rewind_conversation', target_message_uuid: second.uuid }]);
    expect(t.requests('rewind_files')).toEqual([{ subtype: 'rewind_files', user_message_id: second.uuid, dry_run: true }]);
    await t.stop();
    expect(replay(t.sessionId).tabs.map((tab) => tab.prompt)).toEqual(['first prompt']);
  });
});

describe('/fork', () => {
  it('continues in a new session forked from this one, tabs and all', async () => {
    const t = start('fork');
    await t.type('first prompt');
    await t.wait(() => t.frame().includes('1 ● first prompt'));
    await t.type('/fork');
    await t.wait(() => t.frame().includes('Forked into'));
    expect(t.session.sessionId).not.toBe(t.sessionId);
    await t.wait(() => t.args().includes('--fork-session'));
    expect(t.args()).toEqual(expect.arrayContaining(['--resume', t.sessionId, '--fork-session', '--session-id', t.session.sessionId]));
    expect(t.frame()).toContain('1 ● first prompt');
    expect(existsSync(logPath(t.session.sessionId))).toBe(true);
    await t.stop();
  });
});

describe('/cd', () => {
  it('asks to trust a new folder, then moves the session there', async () => {
    const t = start('cd');
    await t.type('/cd test');
    await t.wait(() => t.frame().includes('Trust this folder?'));
    await t.key(ENTER);
    await t.wait(() => t.frame().includes(`Now in ${join(t.cwd, 'test')}`));
    expect(t.requests('set_cwd')).toEqual([
      { subtype: 'set_cwd', path: join(t.cwd, 'test') },
      { subtype: 'set_cwd', path: join(t.cwd, 'test'), trust_accepted: true, trusted_directory: join(t.cwd, 'test') },
    ]);
    expect(t.session.cwd).toBe(join(t.cwd, 'test'));
    await t.type('/cd /definitely/not/here');
    await t.wait(() => t.frame().includes('Not a directory'));
    await t.stop();
  });

  it("follows claude's own cd, keeping history and the session's folder where they were", async () => {
    // The real path, which is what claude (and the fake) report as their folder.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'binder-follow-')));
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    // The second turn's init reports the folder a Bash cd in the first turn left claude in.
    let inits = 0;
    const lines = readFileSync(join(FIXTURES, 'two-turns-stdin.jsonl'), 'utf8').trim().split('\n').map((l) => {
      const e = JSON.parse(l);
      return e.type === 'system' && e.subtype === 'init' ? JSON.stringify({ ...e, cwd: inits++ ? sub : dir }) : l;
    });
    const fixture = join(dir, 'fixture.jsonl');
    writeFileSync(fixture, lines.join('\n') + '\n');
    const t = start('follow', { cwd: dir, fixture });
    await t.type('first prompt');
    await t.wait(() => t.frame().includes('1 ● first prompt'));
    expect(t.host.cwd).toBe(dir);
    await t.type('second prompt');
    await t.wait(() => t.host.cwd === sub);
    expect(t.session.cwd).toBe(dir);
    expect(findSession(t.sessionId)?.cwd).toBe(dir);
    await t.wait(() => !t.host.busy);
    await t.type('draft', false);
    await t.key(UP);
    await t.wait(() => t.frame().includes('❯ second prompt'));
    await t.key(UP);
    await t.wait(() => t.frame().includes('❯ first prompt'));
    await t.stop();
  });
});

describe('/artifacts', () => {
  it('says when the session has none, from the panel and from Ctrl+]', async () => {
    const t = start('artifacts');
    await t.type('/artifacts');
    await t.wait(() => t.frame().includes('no artifacts published in this session yet'));
    await t.key(ESC);
    await t.key('\x1d');
    await t.wait(() => t.frame().includes('No artifact published in this session yet'));
    await t.stop();
  });
});

describe('background tasks', () => {
  it("shows a command's output as plain lines: no escape sequences, and what a progress bar drew last", () => {
    expect(plainLines('\x1b[32mok\x1b[0m line\n10%\r50%\r100%\n\x1b]8;;http://x\x07link\x1b]8;;\x07\n\n')).toEqual(['ok line', '100%', 'link']);
  });

  it("/tasks shows a running shell's output and stops it", async () => {
    const t = start('tasks', { fixture: 'background-bash.jsonl' });
    await t.type('Start the background job');
    await t.wait(() => t.frame().includes('◷ sleep 8; echo BG_DONE'));
    await t.type('/tasks');
    await t.wait(() => t.frame().includes('output of bifp3kil2'));
    expect(t.frame()).toContain('Background tasks');
    expect(t.frame()).toMatch(/◷ sleep 8; echo BG_DONE +shell · tab 1 · /);
    expect(t.frame()).toContain('── output · last 8 KB of 20 KB');
    expect(t.frame()).toContain('tick 2');
    await t.key('x');
    await t.wait(() => t.frame().includes('no background tasks running'));
    expect(t.frame()).toContain('Stopped sleep 8; echo BG_DONE');
    expect(t.requests('stop_task')).toEqual([{ subtype: 'stop_task', task_id: 'bifp3kil2' }]);
    await t.key(ESC);
    await t.wait(() => !t.frame().includes('Background tasks'));
    expect(t.frame()).not.toContain('◷');
    await t.stop();
  });

  it("Ctrl+B moves the running command to the background; the tab that launched finished work carries on with it", async () => {
    const t = start('ctrlb', { fixture: 'background-midturn.jsonl', delay: 150 });
    await t.type('Start the background job');
    await t.wait(() => t.frame().includes('◷ sleep 8; echo BG_DONE'), 15000);
    await t.wait(() => !t.frame().includes('esc to interrupt'), 15000);
    await t.type('Run the foreground job');
    await t.wait(() => t.frame().includes('ctrl+b to run in background'), 15000);
    await t.key('\x02');
    await t.wait(() => t.requests('background_tasks').length === 1);
    await t.wait(() => t.frame().includes('Running in the background'));
    // Tab 1's shell finished during tab 2's turn: a follow-up waits for tab 1.
    await t.key('\x1b[1;5D'); // Ctrl+Left
    await t.wait(() => t.frame().includes('Claude carries on with it here once the current turn ends'), 15000);
    expect(t.frame()).toContain('⏺ Background task finished: sleep 8; echo BG_DONE');
    // Then it goes to the model, with what binder asks of it.
    await t.wait(() => t.sent().some((m) => m.type === 'user' && String(m.message.content).startsWith('[binder] Background task "sleep 8; echo BG_DONE" (completed)')), 15000);
    await t.wait(() => !t.frame().includes('Claude carries on with it here'));
    expect(t.frame()).toContain('⏺ Background task finished: sleep 8; echo BG_DONE');
    await t.stop();
  });
});

describe('fast mode', () => {
  const ALT_O = '\x1bo';
  it('Alt+O and /fast turn it on and off, with the indicator under the prompt', async () => {
    const t = start('fast');
    await t.wait(() => t.frame().includes('? for shortcuts'));
    await t.key(ALT_O);
    await t.wait(() => t.frame().includes('Fast mode on') && t.frame().includes('↯ fast mode on'));
    expect(t.requests('apply_flag_settings').map((r) => r.settings)).toEqual([{ fastMode: true }]);
    // It holds through a turn: the child reports it on init and result.
    await t.type('first prompt');
    await t.wait(() => t.frame().includes('1 ● first prompt'));
    expect(t.frame()).toContain('↯ fast mode on');
    await t.type('/fast off');
    await t.wait(() => t.frame().includes('Fast mode off') && !t.frame().includes('↯'));
    await t.type('/fast on');
    await t.wait(() => t.frame().includes('↯ fast mode on'));
    await t.stop();
  });

  it('says why when fast mode cannot run, and stops asking for it', async () => {
    const t = start('fast-no', { env: { BINDER_FAKE_FAST_REASON: 'extra_usage_disabled' } });
    await t.wait(() => t.frame().includes('? for shortcuts'));
    await t.key(ALT_O);
    await t.wait(() => t.frame().includes('Fast mode requires usage credits'));
    expect(t.frame()).not.toContain('↯');
    await t.wait(() => t.requests('apply_flag_settings').length === 2);
    expect(t.requests('apply_flag_settings').map((r) => r.settings)).toEqual([{ fastMode: true }, { fastMode: false }]);
    // So the next press tries again rather than turning it "off".
    expect(t.session.fastMode).toBe(false);
    await t.stop();
  });
});

describe('permission mode', () => {
  const ALT_M = '\x1bm';
  it('Alt+M steps through the modes, skipping the ones Claude refuses', async () => {
    const t = start('mode-cycle', { env: { BINDER_FAKE_REFUSE_MODES: 'auto,bypassPermissions' } });
    await t.wait(() => t.frame().includes('? for shortcuts'));
    await t.key(ALT_M);
    await t.wait(() => t.frame().includes('Permission mode: accept edits') && t.frame().includes('▸▸ accept edits on'));
    await t.key(ALT_M);
    await t.wait(() => t.frame().includes('⏸ plan mode on'));
    await t.key(ALT_M);
    await t.wait(() => t.frame().includes('Permission mode: manual'));
    expect(t.frame()).not.toContain('plan mode on');
    expect(t.requests('set_permission_mode').map((r) => r.mode)).toEqual(['acceptEdits', 'plan', 'auto', 'bypassPermissions', 'default']);
    await t.stop();
  });

  it('/permission-mode picks one; /mode (its alias) <mode> sets it', async () => {
    const t = start('mode-pick');
    await t.wait(() => t.frame().includes('? for shortcuts'));
    await t.type('/permission-mode');
    await t.wait(() => t.frame().includes('Permission mode') && t.frame().includes('bypass permissions'));
    await t.key(DOWN);
    await t.key(DOWN);
    await t.key(ENTER);
    await t.wait(() => t.frame().includes('⏸ plan mode on'));
    await t.type('/mode acceptEdits');
    await t.wait(() => t.frame().includes('▸▸ accept edits on'));
    // A name that is not a mode: refused, naming the ones there are.
    await t.type('/mode bogus');
    await t.wait(() => t.frame().includes('Not a permission mode: bogus (one of default, acceptEdits, plan'));
    expect(t.requests('set_permission_mode').map((r) => r.mode)).toEqual(['plan', 'acceptEdits']);
    // "/mode" then Enter in the menu runs the command it names, not /model.
    await t.type('/mode');
    await t.wait(() => t.frame().includes('For this session, until it restarts'));
    await t.key(ESC);
    await t.stop();
  });
});

describe('always allow', () => {
  const answer = async (choice: string, env: Record<string, string> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'binder-always-'));
    const answersOut = join(dir, 'answers.json');
    const t = start('always', { fixture: 'permission-suggestions.jsonl', env: { BINDER_FAKE_ANSWERS_OUT: answersOut, ...env } });
    await t.type('make a folder');
    await t.wait(() => t.frame().includes('Allow Bash?'));
    const frame = t.frame();
    await sleep(50); // let the picker's input hook attach after its first paint
    await t.key(choice);
    await t.wait(() => t.frame().includes('Made the folder.'));
    const sent = JSON.parse(readFileSync(answersOut, 'utf8')).response.response;
    await t.stop();
    return { frame, sent };
  };

  it("offers Claude's rules and its mode switch as separate choices", async () => {
    const { frame, sent } = await answer('2');
    // Too long to sit beside the labels at 100 columns: each description goes under its label.
    expect(frame).toMatch(/2\.\s+Always allow Bash\(mkdir -p alpha && echo made\)\s+│\n│\s+this project, in \.claude\/settings\.local\.json\s+│/);
    expect(frame).toMatch(/3\.\s+Allow, and accept all edits from now on\s+│\n│\s+switches this session to accept edits/);
    expect(frame).toMatch(/4\.\s+Deny/);
    expect(sent.behavior).toBe('allow');
    expect(sent.decisionClassification).toBe('user_permanent');
    expect(sent.updatedPermissions.map((u: { type: string }) => u.type)).toEqual(['addRules', 'addDirectories']);
  });

  it('sends the mode switch alone, and plain Allow sends no rules', async () => {
    expect((await answer('3')).sent.updatedPermissions.map((u: { type: string }) => u.type)).toEqual(['setMode', 'addDirectories']);
    const plain = (await answer('1')).sent;
    expect(plain.behavior).toBe('allow');
    expect(plain.updatedPermissions).toBeUndefined();
  });
});

describe('the pull request', () => {
  it("shows the branch's PR under the status row; /pr asks Claude to fix the failing checks", async () => {
    const t = start('pr', { env: { BINDER_GH: join(FIXTURES, '..', 'test', 'fakeGh.mjs'), BINDER_FAKE_GH_STATE: join(FIXTURES, 'gh-pr.json') } });
    await t.wait(() => t.frame().includes('⎇ PR #12 · ✗ 2 failing (lint, test)'));
    expect(t.frame()).toContain('Fix the parser · /pr');
    await t.type('/pr');
    await t.wait(() => t.frame().includes('PR #12: Fix the parser'));
    expect(t.frame()).toContain('Fix the failing checks');
    await t.key(DOWN);
    await t.key(ENTER);
    await t.wait(() => t.sent().some((m) => m.type === 'user' && String(m.message.content).startsWith('[binder] CI checks failed on PR #12')));
    await t.stop();
  });
});

describe('/plugins', () => {
  it('disables an installed plugin and installs one from the marketplaces, loading each change into the session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'binder-plugins-'));
    const state = join(dir, 'plugins.json');
    writeFileSync(state, JSON.stringify({
      installed: [{ id: 'formatter@market', version: '1.0.0', scope: 'user', enabled: true }],
      available: [
        { pluginId: 'formatter@market', name: 'formatter', description: 'Formats code', marketplaceName: 'market' },
        { pluginId: 'linter@market', name: 'linter', description: 'Lints the code you change', marketplaceName: 'market' },
        { pluginId: 'notes@other', name: 'notes', description: 'Keeps notes', marketplaceName: 'other' },
      ],
    }));
    const t = start('plugins', { env: { BINDER_FAKE_PLUGINS: state } });
    const plugins = () => JSON.parse(readFileSync(state, 'utf8'));
    await t.type('/plugins');
    await t.wait(() => t.frame().includes('1 installed (1 enabled)'), 20000);
    expect(t.frame()).toMatch(/Install a plugin…\s+from your marketplaces/);
    expect(t.frame()).toMatch(/formatter@market\s+enabled · user · 1\.0\.0/);
    await t.key(DOWN);
    await t.key(DOWN);
    await t.key(ENTER);
    await t.wait(() => t.frame().includes('Disable'), 20000);
    await t.key(ENTER);
    await t.wait(() => t.frame().includes('Successfully disabled plugin: formatter (scope: user). Loaded 0 plugins with'), 20000);
    expect(plugins().installed[0].enabled).toBe(false);
    // Install: the marketplaces' plugins not installed yet; typing filters.
    await t.key(ENTER);
    await t.wait(() => t.frame().includes('Install a plugin') && t.frame().includes('3 in your marketplaces'), 20000);
    expect(t.frame()).toContain('notes');
    expect(t.frame()).not.toMatch(/formatter\s+market: Formats code/);
    await t.key('lint');
    await t.wait(() => !t.frame().includes('Keeps notes'), 20000);
    await t.key(ENTER);
    await t.wait(() => t.frame().includes('Successfully installed plugin: linter (scope: user). Loaded 1 plugin with'), 20000);
    expect(plugins().installed.map((p: { id: string }) => p.id)).toEqual(['formatter@market', 'linter@market']);
    expect(t.sent().filter((m) => m.type === 'control_request' && m.request.subtype === 'reload_plugins')).toHaveLength(2);
    // Its command is in the menu now.
    await t.key(ESC);
    await t.key(ESC);
    await t.key('/lint');
    await t.wait(() => t.frame().includes('From the linter@market plugin'), 20000);
    await t.stop();
  }, 60000);
});

describe('/schedule', () => {
  it('adds a task in this folder from "/schedule <when> <prompt>", lists it, runs it now in a fresh session, and deletes it', async () => {
    const dir = realpathSync(mkdtempSync('/tmp/bsa-'));
    // Hosts' socket paths must stay short, and over ssh binder would start them through launchd.
    delete process.env.SSH_CONNECTION;
    const t = start('schedule', { cwd: dir, env: { BINDER_STATE_DIR: join(dir, 's') } });
    await t.type('/schedule weekdays 9:00 Say A');
    await t.wait(() => t.frame().includes('Scheduled "Say A": weekdays at 09:00, next '));
    await t.type('/schedule');
    await t.wait(() => t.frame().includes('Scheduled tasks') && /Say A\s+weekdays at 09:00 · next /.test(t.frame()));
    await t.key(ENTER);
    await t.wait(() => t.frame().includes('Run it now'));
    expect(t.frame()).toContain(`weekdays at 09:00 in ${dir}: Say A`);
    await t.key(ENTER);
    await t.wait(() => t.frame().includes('Say A is running in session'));
    const runs = () => JSON.parse(readFileSync(join(dir, 's', 'schedules.json'), 'utf8')).runs as Array<{ sessionId?: string; error?: string }>;
    const [run] = runs();
    expect(run.error).toBeUndefined();
    // The run's own session got the prompt (this one sent nothing).
    await t.wait(() => t.sent().some((m) => m.type === 'user' && m.message.content === 'Say A'));
    // Delete it: the list is empty again.
    for (let i = 0; i < 3; i++) await t.key(DOWN);
    await t.key(ENTER);
    await t.wait(() => t.frame().includes('Deleted Say A'));
    await t.wait(() => t.frame().includes('None yet'));
    const info = await hostInfo(run.sessionId!);
    if (info) process.kill(info.pid, 'SIGTERM');
    await t.stop();
  }, 30000);
});

describe('/btw', () => {
  it('asks side questions in a side chat, with the earlier ones as history, and keeps them out of the transcript; Esc closes it', async () => {
    const t = start('btw');
    await t.type('Say A');
    await t.wait(() => t.frame().includes('A') && t.sent().filter((m) => m.type === 'user').length === 1);
    await t.type('/btw what did I ask?');
    await t.wait(() => t.frame().includes('Side answer to: what did I ask?'));
    expect(t.frame()).toContain('❯ what did I ask?');
    expect(t.frame()).toContain('Side chat: answered from the session so far, kept out of its transcript');
    // The prompt now asks the side chat, with what came before.
    await t.type('and before that?');
    await t.wait(() => t.frame().includes('Side answer to: and before that? (after 1 earlier)'));
    const asks = t.sent().filter((m) => m.type === 'control_request' && m.request.subtype === 'side_question').map((m) => m.request);
    expect(asks).toEqual([
      { subtype: 'side_question', question: 'what did I ask?' },
      { subtype: 'side_question', question: 'and before that?', history: [{ question: 'what did I ask?', response: '**Side answer** to: what did I ask?' }] },
    ]);
    // Nothing went to the conversation.
    expect(t.sent().filter((m) => m.type === 'user')).toHaveLength(1);
    await t.key(ESC);
    await t.wait(() => !t.frame().includes('Side chat:'));
    expect(t.frame()).not.toContain('Side answer');
    await t.stop();
  });

  it("puts a late answer on its own question, not on one asked in a side chat opened since; binder's stand-in answer is not history", async () => {
    const t = start('btw-late');
    const waiting = new Map<string, (r: { response: string; synthetic: boolean }) => void>();
    const histories: unknown[] = [];
    t.host.sideQuestion = (question, history = []) => {
      histories.push(history);
      return new Promise((resolve) => waiting.set(question, resolve));
    };
    await t.wait(() => t.frame().includes('? for shortcuts'));
    await t.type('/btw one');
    await t.wait(() => t.frame().includes('❯ one') && waiting.has('one'));
    await t.key(ESC);
    await t.wait(() => !t.frame().includes('Side chat:'));
    await t.type('/btw two');
    await t.wait(() => t.frame().includes('❯ two') && waiting.has('two'));
    waiting.get('one')!({ response: 'Answer to one', synthetic: false });
    await sleep(100);
    expect(t.frame()).toContain('❯ two');
    expect(t.frame()).toContain('thinking…');
    expect(t.frame()).not.toContain('Answer to one');
    waiting.get('two')!({ response: 'No answer for this side question. Try again, or ask in the conversation.', synthetic: true });
    await t.wait(() => t.frame().includes('No answer for this side question'));
    await t.type('three');
    await t.wait(() => waiting.has('three'));
    expect(histories.at(-1)).toEqual([]);
    await t.key(ESC);
    await t.stop();
  });
});

describe('code review findings', () => {
  it('a review lists its findings; /findings asks Claude to fix one in its tab, and /diff marks them on their lines', async () => {
    const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'binder-findings-'))), 'app');
    mkdirSync(dir, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', dir, ...args]);
    writeFileSync(join(dir, 'calc.js'), 'function average(xs) {\n  let sum = 0;\n  for (const x of xs) sum += x;\n  return sum / xs.length;\n}\n');
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-qm', 'init');
    writeFileSync(join(dir, 'calc.js'), 'function average(xs) {\n  let sum = 0;\n  for (let i = 1; i <= xs.length; i++) sum += xs[i];\n  return sum / xs.length;\n}\nfunction max(xs) {\n  let m = 0;\n  for (const x of xs) if (x > m) m = x;\n  return m;\n}\n');
    const t = start('findings', { cwd: dir, fixture: 'code-review.jsonl' });
    await t.type('/code-review medium');
    await t.wait(() => t.frame().includes('▸ 4 findings (2 important, 1 pre-existing, 1 nit) · /findings fixes one or all'));
    expect(t.frame()).toMatch(/Nit\s+calc\.js:7\s+:\s+max\(\) returns 0/);
    await t.type('/findings');
    await t.wait(() => t.frame().includes('Findings: 4 (2 important, 1 pre-existing, 1 nit)'));
    expect(t.frame()).toMatch(/Apply fixes\s+asks Claude to fix all 4 in one prompt/);
    expect(t.frame()).toMatch(/calc\.js:3\s+important: average\(\) returns NaN/);
    await t.key(DOWN);
    await t.key(ENTER);
    await t.wait(() => t.sent().some((m) => m.type === 'user' && String(m.message.content).startsWith('Fix this finding from the code review:\n\ncalc.js:3 (important): average() returns NaN')));
    await t.wait(() => t.frame().includes('Fixed the loop'));
    // Into the review's tab: still one tab.
    expect(t.frame()).not.toMatch(/\b2 [^\n]*Fix this finding/);
    await t.type('/diff');
    await t.wait(() => t.frame().includes('1 file changed against HEAD'));
    const diff = t.frame();
    const at = (s: string) => diff.split('\n').findIndex((l) => l.includes(s));
    expect(at('▲ ● important average() returns NaN for every')).toBe(at('3 + ') + 1);
    expect(at('▲ ● important max() initializes')).toBe(at('7 + ') + 1);
    // Line 4 is not changed, but shows as context in the hunk: its finding sits under it.
    expect(at('▲ ● pre-existing average() returns NaN for an empty')).toBe(at('4   ') + 1);
    await t.key(ESC);
    await t.stop();
  });
});

describe('/diff', () => {
  it("shows the session folder's changes in place of the transcript; Esc closes it", async () => {
    const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'binder-diffapp-'))), 'app');
    mkdirSync(dir, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', dir, ...args]);
    writeFileSync(join(dir, 'a.ts'), 'one\ntwo\n');
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-qm', 'init');
    writeFileSync(join(dir, 'a.ts'), 'one\nTWO\n');
    const t = start('diff', { cwd: dir });
    await t.type('/diff');
    await t.wait(() => t.frame().includes('1 file changed against HEAD'));
    expect(t.frame()).toContain('▸ a.ts  modified');
    expect(t.frame()).toMatch(/2 \+ TWO/);
    expect(t.frame()).toMatch(/2 - two/);
    await t.key(ESC);
    await t.wait(() => !t.frame().includes('changed against HEAD'));
    await t.stop();
  });
});

describe('workflows', () => {
  it('asks with the workflow card, can allow workflows from then on, and shows the run in the background tasks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'binder-wf-'));
    const answersOut = join(dir, 'answers.json');
    const t = start('workflow', { fixture: 'workflow.jsonl', env: { BINDER_FAKE_ANSWERS_OUT: answersOut } });
    await t.type('run a workflow');
    await t.wait(() => t.frame().includes('Run the workflow hello-probe?'));
    const card = t.frame();
    expect(card).toContain('Single agent call that replies with one word');
    expect(card).toContain('Phases: Greet → Check');
    expect(card).not.toContain('export const meta');
    expect(card).toMatch(/1\.\s+Run once/);
    expect(card).toMatch(/2\.\s+Always allow workflows/);
    expect(card).toMatch(/3\.\s+Deny/);
    await sleep(50);
    await t.key('2');
    await t.wait(() => existsSync(answersOut));
    expect(JSON.parse(readFileSync(answersOut, 'utf8')).response.response.updatedPermissions).toEqual([{ type: 'addRules', rules: [{ toolName: 'Workflow' }], behavior: 'allow', destination: 'localSettings' }]);
    await t.wait(() => t.frame().includes('The workflow is running.'));
    // Still running: its row says the phase and how many agents are done.
    expect(t.frame()).toContain('Greet · 0/1 agents done');
    await t.type('/tasks');
    await t.wait(() => t.frame().includes('── phases'));
    expect(t.frame()).toMatch(/Greet[^\n]*\n[^\n]*◐ Reply with the single word ok/);
    await t.stop();
  });
});

describe('attachments', () => {
  it('turns a pasted path to a PDF into an attachment that reaches Claude as a document', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'binder-pdf-'));
    const pdf = join(dir, 'my notes.pdf');
    writeFileSync(pdf, '%PDF-1.4 hello');
    const t = start('attach');
    await t.wait(() => t.frame().includes('? for shortcuts'));
    // iTerm2 types a dropped file's path, spaces escaped, as a bracketed paste.
    await t.key(`\x1b[200~${pdf.replace(/ /g, '\\ ')} \x1b[201~`);
    await t.wait(() => t.frame().includes('[File #1: my notes.pdf]'));
    await t.type(' sum it up', false);
    await t.key(ENTER);
    await t.wait(() => t.sent().some((m) => m.type === 'user'));
    const content = t.sent().find((m) => m.type === 'user').message.content;
    expect(content[0]).toEqual({ type: 'text', text: '[File #1: my notes.pdf] sum it up' });
    expect(content[1]).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from('%PDF-1.4 hello').toString('base64') }, title: 'my notes.pdf' });
    await t.stop();
  });
});

describe('the todo and plan panel', () => {
  it('pins the latest todos above the prompt; Ctrl+T opens every item', async () => {
    const t = start('pinned', { fixture: 'todos.jsonl' });
    await t.type('fix the parser');
    await t.wait(() => t.frame().includes('On it.'));
    expect(t.frame()).toContain('☑ 1/3 · ◐ Writing the tests');
    await t.key('\x14');
    await t.wait(() => t.frame().includes('ctrl+t closes'));
    expect(t.frame()).toMatch(/☑ Read the parser\n.*◐ Write the tests\n.*☐ Fix the bug/);
    await t.key('\x14');
    await t.wait(() => t.frame().includes('☑ 1/3'));
    await t.stop();
  });

  it('pins the current plan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'binder-pinplan-'));
    const t = start('pinned-plan', { fixture: 'plan-approval.jsonl', env: { BINDER_FAKE_ANSWERS_OUT: join(dir, 'a.json') } });
    await t.type('plan it');
    await t.wait(() => t.frame().includes('Ready to code?'));
    expect(t.frame()).toContain('▤ Plan: Add hello.txt (waiting for you)');
    await sleep(50);
    await t.key('3');
    await t.wait(() => t.frame().includes('Starting on the plan.'));
    expect(t.frame()).toContain('▤ Plan: Add hello.txt');
    await t.stop();
  });
});

describe('/files', () => {
  it("lists the files the tab's tool calls named and opens one with config.json's editor", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'binder-files-'));
    mkdirSync('/private/tmp/demo', { recursive: true });
    writeFileSync('/private/tmp/demo/orange.png', '');
    const opened = join(dir, 'opened');
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ editor: `printf '%s:%s' {file} {line} > ${opened}` }));
    const before = process.env.BINDER_CONFIG;
    process.env.BINDER_CONFIG = file;
    const t = start('files', { fixture: 'image-result.jsonl' });
    try {
      await t.type('what is this');
      await t.wait(() => t.frame().includes('orange square'));
      await t.type('/files');
      await t.wait(() => t.frame().includes('Files in this tab'));
      expect(t.frame()).toMatch(/\/private\/tmp\/demo\/orange\.png\s+Read/);
      await t.key(ENTER);
      await t.wait(() => existsSync(opened) && readFileSync(opened, 'utf8').length > 0);
      expect(readFileSync(opened, 'utf8')).toBe('/private/tmp/demo/orange.png:1');
    } finally {
      process.env.BINDER_CONFIG = before;
      await t.stop();
    }
  });
});

describe('the bell', () => {
  it('rings when a turn ends and when a question arrives, only while the terminal is in the background', async () => {
    const rung: string[] = [];
    setBellWriter((s) => rung.push(s));
    try {
      const t = start('bell', { fixture: 'permission-suggestions.jsonl', bell: true });
      await t.wait(() => t.frame().includes('? for shortcuts'));
      setFocused(false);
      await t.type('make a folder');
      await t.wait(() => t.frame().includes('Allow Bash?'));
      await t.wait(() => rung.length === 1);
      setFocused(true);
      await sleep(50);
      await t.key('1');
      await t.wait(() => t.frame().includes('Made the folder.'));
      await sleep(100);
      // In focus when the turn ended: no second bell.
      expect(rung).toEqual(['\x07']);
      await t.stop();
      const u = start('bell-done', { bell: true });
      await u.wait(() => u.frame().includes('? for shortcuts'));
      setFocused(false);
      await u.type('first prompt');
      await u.wait(() => u.frame().includes('1 ● first prompt'));
      await u.wait(() => rung.length === 2);
      await u.stop();
    } finally {
      setFocused(true);
    }
  });

  it('stays quiet when config.json bell is false', async () => {
    const rung: string[] = [];
    setBellWriter((s) => rung.push(s));
    setFocused(false);
    try {
      const t = start('bell-off', { bell: false });
      await t.wait(() => t.frame().includes('? for shortcuts'));
      await t.type('first prompt');
      await t.wait(() => t.frame().includes('1 ● first prompt'));
      await sleep(200);
      expect(rung).toEqual([]);
      await t.stop();
    } finally {
      setFocused(true);
    }
  });
});

describe('plan approval', () => {
  const approve = async (keys: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'binder-plan-'));
    const answersOut = join(dir, 'answers.json');
    const t = start('plan', { fixture: 'plan-approval.jsonl', env: { BINDER_FAKE_ANSWERS_OUT: answersOut } });
    await t.type('plan a hello file');
    await t.wait(() => t.frame().includes('Ready to code?'));
    const frame = t.frame();
    await sleep(50); // let the picker's input hook attach after its first paint
    for (const k of keys) await t.key(k);
    await t.wait(() => existsSync(answersOut));
    const sent = JSON.parse(readFileSync(answersOut, 'utf8')).response.response;
    await t.wait(() => t.frame().includes('Starting on the plan.'));
    const after = t.frame();
    await t.stop();
    return { frame, sent, after };
  };

  it('shows the plan as markdown above its choices; a yes approves and sets the mode', async () => {
    const { frame, sent, after } = await approve(['2']);
    // The choices fit beside their descriptions at 100 columns, keeping the box short.
    expect(frame).toMatch(/1\.\s+Yes, and use auto mode\s+a classifier decides what would need asking/);
    expect(frame).toMatch(/2\.\s+Yes, and auto-accept edits/);
    expect(frame).toMatch(/3\.\s+Yes, and manually approve edits/);
    expect(frame).toMatch(/4\.\s+No, keep planning/);
    expect(frame).toMatch(/5\.\s+No, and tell Claude what to change/);
    expect(frame).not.toContain('planFilePath');
    expect(sent.behavior).toBe('allow');
    expect(sent.updatedPermissions).toEqual([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
    // The mode switch lasts the session only: allowed once, as Claude Code classifies it.
    expect(sent.decisionClassification).toBe('user_temporary');
    // The plan stays in the transcript as markdown (the heading without its #,
    // bold without **), not folded into the work, once the question is gone.
    expect(after).toMatch(/⏺ Plan · approved/);
    expect(after).toContain('Add hello.txt');
    expect(after).not.toContain('# Add hello.txt');
    expect(after).toContain('Create the file:');
    expect(after).not.toContain('**Create the file:**');
    expect(after).not.toContain('tool call');
  });

  it('sends typed changes back, and Esc keeps planning', async () => {
    const typed = (await approve(['5', 'use bye.txt instead', ENTER])).sent;
    expect(typed.behavior).toBe('deny');
    expect(typed.message).toContain('use bye.txt instead');
    const esc = (await approve([ESC])).sent;
    expect(esc.behavior).toBe('deny');
    expect(esc.message).toMatch(/Stay in plan mode/);
  });
});

describe('/settings', () => {
  it('saves to config.json: sticky prompt, markdown style, status text, artifacts, fast mode, always allow, worktree prefix, workflow card, todo panel, editor, images, bell, plan approval, permission mode, and a config dir added then removed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'binder-settings-'));
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ permissionMode: 'plan', mine: true }));
    const work = join(dir, 'work');
    mkdirSync(work);
    const account = join(dir, 'claude-work');
    const config = () => JSON.parse(readFileSync(file, 'utf8'));
    const before = process.env.BINDER_CONFIG;
    process.env.BINDER_CONFIG = file;
    const t = start('settings');
    try {
      await t.type('/settings');
      await t.wait(() => t.frame().includes('Sticky prompt') && t.frame().includes('plan'));
      await t.key(DOWN);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('Sticky prompt off'));
      await t.key(DOWN);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('Markdown: classic'));
      expect(config()).toEqual({ permissionMode: 'plan', mine: true, stickyPrompt: false, markdownStyle: 'classic' });
      // Status text: the template opens for editing; typing adds the cost.
      await t.key(DOWN);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('{maxTokens}') && t.frame().includes('"36.9k/1M 4%"'));
      await t.key(' · {cost}');
      await t.wait(() => t.frame().includes('"36.9k/1M 4% · $0.42"'));
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('Status text: {context}(/{maxTokens})( {percent}) · {cost}'));
      expect(config().statusText).toBe('{context}(/{maxTokens})( {percent}) · {cost}');
      await t.key(DOWN);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('Artifacts off'));
      expect(config().artifacts).toBe(false);
      await t.key(DOWN);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('Fast mode on at the start of sessions'));
      expect(config().fastMode).toBe(true);
      await t.key(DOWN);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('"Always allow" choices off'));
      expect(config().alwaysAllow).toBe(false);
      await t.key(DOWN);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('Pull request watching off'));
      expect(config().prWatch).toBe(false);
      await t.key(DOWN);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('PR auto-fix on'));
      expect(config().prAutoFix).toBe(true);
      // The worktree branch prefix: typed, then saved.
      for (let i = 0; i < 3; i++) await t.key(DOWN);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes("The start of a worktree's branch name"));
      await t.key('wip/');
      await t.wait(() => t.frame().includes('Save: wip/'));
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('Worktree branch prefix: wip/'));
      expect(config().worktrees).toEqual({ branchPrefix: 'wip/' });
      await t.key(DOWN);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('Workflow card off'));
      expect(config().workflowCard).toBe(false);
      await t.key(DOWN);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('Todo and plan panel off'));
      expect(config().todoPanel).toBe(false);
      // Editor: a picker of commands; typing one offers it.
      await t.key(DOWN);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('Editor: how /files'));
      await t.key('nvim-qt');
      await t.wait(() => t.frame().includes('Use: nvim-qt'));
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('Editor: nvim-qt'));
      expect(config().editor).toBe('nvim-qt');
      await t.key(DOWN);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('Images off'));
      expect(config().showImages).toBe(false);
      await t.key(DOWN);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('Bell off'));
      expect(config().bell).toBe(false);
      await t.key(DOWN);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('Plan approval off'));
      expect(config().planApproval).toBe(false);
      await t.key(DOWN);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('Findings card off'));
      expect(config().findingsCard).toBe(false);
      await t.key(DOWN);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes("Plugin changes load at claude's next start"));
      expect(config().pluginReload).toBe(false);
      await t.key(DOWN);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('Scheduled tasks off'));
      expect(config().schedules).toBe(false);
      await t.key(DOWN);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('Side chat off'));
      expect(config().sideChat).toBe(false);

      // Back to Claude Code's own default: the key goes.
      for (let i = 0; i < 21; i++) await t.key(UP);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('bypassPermissions'));
      for (let i = 0; i < 3; i++) await t.key(UP);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes("Permission mode: Claude Code's default"));
      expect(config().permissionMode).toBeUndefined();

      // Add a config dir: type the folder, then a config dir that does not exist yet.
      for (let i = 0; i < 22; i++) await t.key(DOWN);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('Add a config dir: the folder'));
      for (let i = 0; i < 2; i++) await t.key('\x7f');
      await t.key(work);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes(`Config dir for ${work}`));
      for (let i = 0; i < '~/.claude'.length; i++) await t.key('\x7f');
      await t.key(account);
      await t.wait(() => t.frame().includes('does not'));
      await t.key(ENTER);
      await t.wait(() => config().configDirs?.[work] === account);
      expect(config().configDirs).toEqual({ [work]: account });

      // The cursor is back on the new row: remove it.
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('Remove'));
      await t.key(ENTER);
      await t.wait(() => !config().configDirs);
      expect(config()).toEqual({ mine: true, stickyPrompt: false, markdownStyle: 'classic', statusText: '{context}(/{maxTokens})( {percent}) · {cost}', artifacts: false, fastMode: true, alwaysAllow: false, prWatch: false, prAutoFix: true, worktrees: { branchPrefix: 'wip/' }, workflowCard: false, todoPanel: false, editor: 'nvim-qt', showImages: false, bell: false, planApproval: false, findingsCard: false, pluginReload: false, schedules: false, sideChat: false });
      await t.key(ESC);
      await t.wait(() => !t.frame().includes('Sticky prompt'));
    } finally {
      process.env.BINDER_CONFIG = before;
      await t.stop();
    }
  });

  it('removes the key when sticky prompt or artifacts goes back to its default', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'binder-settings-')), 'config.json');
    writeFileSync(file, JSON.stringify({ stickyPrompt: false, artifacts: false, mine: true }));
    const before = process.env.BINDER_CONFIG;
    process.env.BINDER_CONFIG = file;
    const t = start('settings-default');
    try {
      await t.type('/settings');
      await t.wait(() => t.frame().includes('Sticky prompt'));
      await t.key(DOWN);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('Sticky prompt on'));
      for (let i = 0; i < 3; i++) await t.key(DOWN);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('Artifacts on'));
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ mine: true });
    } finally {
      process.env.BINDER_CONFIG = before;
      await t.stop();
    }
  });

  it('shows why when config.json does not parse, and leaves it alone', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'binder-settings-')), 'config.json');
    writeFileSync(file, '{}');
    const before = process.env.BINDER_CONFIG;
    process.env.BINDER_CONFIG = file;
    const t = start('settings-bad');
    // Broken while binder runs (a launch with it broken stops at once, saying why).
    writeFileSync(file, '{');
    try {
      await t.type('/settings');
      await t.wait(() => t.frame().includes(`${file}:`));
      await t.key(DOWN);
      await t.key(ENTER);
      expect(readFileSync(file, 'utf8')).toBe('{');
    } finally {
      process.env.BINDER_CONFIG = before;
      await t.stop();
    }
  });
});

describe('/resume: archive and full-text search', () => {
  it('finds a session by what Claude said; Ctrl+X archives it out of the list and Ctrl+D shows the archived', async () => {
    const t = start('resume-search');
    const dir = join(t.configDir, 'projects', 'here');
    mkdirSync(dir, { recursive: true });
    const id = '33333333-3333-4333-8333-333333333333';
    writeFileSync(
      join(dir, `${id}.jsonl`),
      JSON.stringify({ type: 'user', cwd: t.cwd, gitBranch: 'main', message: { content: 'look at the logs' } }) + '\n' + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'The pelican service restarted twice.' }] } }) + '\n',
    );
    await t.type('/resume');
    await t.wait(() => t.frame().includes('look at the logs'));
    await t.type('pelican', false);
    await t.wait(() => t.frame().includes('The pelican service restarted twice.'));
    expect(t.frame()).toContain('look at the logs');
    await t.key('\x18'); // Ctrl+X
    await t.wait(() => t.frame().includes('Archived look at the logs'));
    await t.wait(() => !t.frame().includes('The pelican service'));
    await t.key('\x04'); // Ctrl+D
    await t.wait(() => t.frame().includes('Archived sessions') && t.frame().includes('look at the logs'));
    await t.key('\x18');
    await t.wait(() => t.frame().includes('Unarchived look at the logs'));
    await t.stop();
  });
});

describe('/resume scopes', () => {
  it('starts with this folder; Ctrl+A shows all projects and typing filters', async () => {
    const t = start('resume');
    const projects = join(t.configDir, 'projects');
    const write = (dir: string, id: string, cwd: string, prompt: string) => {
      mkdirSync(join(projects, dir), { recursive: true });
      writeFileSync(join(projects, dir, `${id}.jsonl`), JSON.stringify({ type: 'user', cwd, gitBranch: 'main', message: { content: prompt } }) + '\n');
    };
    write('here', '11111111-1111-4111-8111-111111111111', t.cwd, 'work in this folder');
    write('there', '22222222-2222-4222-8222-222222222222', '/elsewhere/project', 'work somewhere else');
    await t.type('/resume');
    await t.wait(() => t.frame().includes('work in this folder'));
    expect(t.frame()).not.toContain('work somewhere else');
    await t.key('\x01'); // Ctrl+A
    await t.wait(() => t.frame().includes('all projects') && t.frame().includes('work somewhere else'));
    expect(t.frame()).toContain('/elsewhere/project');
    await t.type('somewhere', false);
    await t.wait(() => !t.frame().includes('work in this folder'));
    await t.key(ENTER);
    // That folder does not exist here, so the session resumes in the current one.
    await t.wait(() => t.frame().includes('Resumed 22222222'));
    await t.wait(() => t.frame().includes('1 ● work somewhere else'));
    expect(t.args()).toEqual(expect.arrayContaining(['--resume', '22222222-2222-4222-8222-222222222222']));
    await t.stop();
  });
});
