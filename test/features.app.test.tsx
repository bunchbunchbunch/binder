import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/ui/App.js';
import { Session } from '../src/session.js';
import { SessionHost } from '../src/host.js';
import { initialState } from '../src/store.js';
import { logPath, replay } from '../src/eventLog.js';
import { FAKE_BIN, FIXTURES } from './helpers.js';

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
function start(name: string, opts: { cwd?: string; fixture?: string } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), `binder-${name}-`));
  const inputOut = join(stateDir, 'input.jsonl');
  const argsOut = join(stateDir, 'args.json');
  Object.assign(process.env, {
    BINDER_STATE_DIR: stateDir,
    BINDER_CLAUDE_BIN: FAKE_BIN,
    BINDER_FAKE_FIXTURE: join(FIXTURES, opts.fixture ?? 'two-turns-stdin.jsonl'),
    BINDER_FAKE_INPUT_OUT: inputOut,
    BINDER_FAKE_ARGS_OUT: argsOut,
  });
  delete process.env.BINDER_FAKE_DELAY_MS;
  delete process.env.BINDER_FAKE_CAPS;
  const cwd = opts.cwd ?? process.cwd();
  const configDir = join(stateDir, 'claude');
  const sessionId = `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`;
  const session = new Session({ sessionId, resume: false, cwd, passthrough: [] });
  session.start();
  const ui = render(<App host={new SessionHost(session, initialState(sessionId), cwd, configDir)} configDir={configDir} onQuit={() => {}} />);
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
  return { ui, session, sessionId, stateDir, configDir, cwd, type, key, frame, wait, sent, requests, args, stop };
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

describe('/settings', () => {
  it('saves to config.json: sticky prompt, markdown style, permission mode, and a config dir added then removed', async () => {
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
      await t.wait(() => t.frame().includes('Sticky prompt on'));
      await t.key(DOWN);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('Markdown: classic'));
      expect(config()).toEqual({ permissionMode: 'plan', mine: true, stickyPrompt: true, markdownStyle: 'classic' });

      // Back to Claude Code's own default: the key goes.
      await t.key(UP);
      await t.key(UP);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes('bypassPermissions'));
      for (let i = 0; i < 3; i++) await t.key(UP);
      await t.key(ENTER);
      await t.wait(() => t.frame().includes("Permission mode: Claude Code's default"));
      expect(config().permissionMode).toBeUndefined();

      // Add a config dir: type the folder, then a config dir that does not exist yet.
      for (let i = 0; i < 3; i++) await t.key(DOWN);
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
      expect(config()).toEqual({ mine: true, stickyPrompt: true, markdownStyle: 'classic' });
      await t.key(ESC);
      await t.wait(() => !t.frame().includes('Sticky prompt'));
    } finally {
      process.env.BINDER_CONFIG = before;
      await t.stop();
    }
  });

  it('shows why when config.json does not parse, and leaves it alone', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'binder-settings-')), 'config.json');
    writeFileSync(file, '{');
    const before = process.env.BINDER_CONFIG;
    process.env.BINDER_CONFIG = file;
    const t = start('settings-bad');
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
