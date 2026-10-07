import { describe, it, expect } from 'vitest';
import { lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSettings, runSidebarScript, runsSession, writeSettings } from '../src/main/binder';

const id = '00000000-0000-4000-8000-0000000000a1';

describe('a session already open elsewhere', () => {
  it('is a claude resuming or starting it', () => {
    expect(runsSession(`/usr/local/bin/claude --resume ${id}`, id)).toBe(true);
    expect(runsSession(`/Users/me/.local/bin/claude.exe -r ${id}`, id)).toBe(true);
    expect(runsSession(`claude -p --output-format stream-json --session-id ${id}`, id)).toBe(true);
  });

  it('is not a fork of it, a binder host that moved on, or a tail of its log', () => {
    expect(runsSession(`claude -p --resume ${id} --fork-session`, id)).toBe(false);
    expect(runsSession(`node /x/bindertui/bin/binder.mjs host --resume ${id}`, id)).toBe(false);
    expect(runsSession(`tail -f /Users/me/.local/state/bindertui/host-${id}.log`, id)).toBe(false);
  });
});

describe("binder's config.json", () => {
  const dir = mkdtempSync(join(tmpdir(), 'bg-settings-'));
  const env = (name: string) => ({ BINDER_CONFIG: join(dir, name) });

  it('reads defaults when the file is missing, and names it when it does not parse', () => {
    expect(readSettings(env('missing.json'))).toEqual({ path: join(dir, 'missing.json'), permissionMode: null, stickyPrompt: true, appearance: 'auto', configDirs: {}, sidebar: {} });
    writeFileSync(join(dir, 'bad.json'), '{');
    expect(readSettings(env('bad.json')).error).toContain(join(dir, 'bad.json'));
  });

  it('writes keys in place: others kept, null removes one, a symlink stays a symlink', () => {
    writeFileSync(join(dir, 'dotfiles.json'), JSON.stringify({ permissionMode: 'plan', extra: 1 }));
    symlinkSync(join(dir, 'dotfiles.json'), join(dir, 'linked.json'));
    const s = writeSettings(env('linked.json'), { permissionMode: null, stickyPrompt: true, configDirs: { '~/work': '~/.claude-work' } });
    expect(s).toMatchObject({ permissionMode: null, stickyPrompt: true, configDirs: { '~/work': '~/.claude-work' } });
    expect(lstatSync(join(dir, 'linked.json')).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'dotfiles.json'), 'utf8'))).toEqual({ extra: 1, stickyPrompt: true, configDirs: { '~/work': '~/.claude-work' } });
  });

  it('reads appearance as auto unless it is light or dark', () => {
    for (const [value, want] of [['light', 'light'], ['dark', 'dark'], ['auto', 'auto'], ['Dark', 'auto'], [true, 'auto']]) {
      writeFileSync(join(dir, 'appearance.json'), JSON.stringify({ appearance: value }));
      expect(readSettings(env('appearance.json')).appearance).toBe(want);
    }
  });

  it('reads the sidebar templates and script, keeping only strings', () => {
    writeFileSync(join(dir, 'sidebar.json'), JSON.stringify({ sidebar: { title: '{status} {title}', subtitle: '', script: 7, other: 'x' } }));
    expect(readSettings(env('sidebar.json')).sidebar).toEqual({ title: '{status} {title}', subtitle: '' });
    writeFileSync(join(dir, 'sidebar.json'), JSON.stringify({ sidebar: 'nope' }));
    expect(readSettings(env('sidebar.json')).sidebar).toEqual({});
  });

  it('leaves a file that does not parse alone', () => {
    expect(() => writeSettings(env('bad.json'), { stickyPrompt: true })).toThrow(join(dir, 'bad.json'));
    expect(readFileSync(join(dir, 'bad.json'), 'utf8')).toBe('{');
  });
});

describe("config.json's sidebar.script", () => {
  const dir = mkdtempSync(join(tmpdir(), 'bg-script-'));
  const input = { session_id: 's1', cwd: dir, model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' }, status: 'idle', title: 'Fix it', prompt: 'Fix it' };
  const withScript = (script?: string) => {
    const path = join(dir, `config-${Math.random()}.json`);
    writeFileSync(path, JSON.stringify(script === undefined ? {} : { sidebar: { script } }));
    return { ...process.env, BINDER_CONFIG: path };
  };

  it('runs in the session folder with the session on stdin, and gives its first line without colors', async () => {
    writeFileSync(join(dir, 's1.title'), 'Login fix/app\n');
    expect(await runSidebarScript(withScript(`cat "$(sed -E 's/.*"session_id":"([^"]*)".*/\\1/').title"`), input)).toBe('Login fix/app');
    expect(await runSidebarScript(withScript(`printf '\\n\\033[1;32m  %s  \\033[0m\\nmore' "$(sed -E 's/.*"display_name":"([^"]*)".*/\\1/')"`), input)).toBe('Opus 5.5');
  });

  it('is empty without a script, or when it fails', async () => {
    expect(await runSidebarScript(withScript(), input)).toBe('');
    expect(await runSidebarScript(withScript('echo partial; exit 3'), input)).toBe('');
    expect(await runSidebarScript(withScript('cat missing-file'), input)).toBe('');
  });
});
