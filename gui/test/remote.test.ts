import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readComputers, readDefaultComputer } from '../src/main/binder';
import { Remote, shellQuote } from '../src/main/remote';

// Another computer over e2e/fixtures/fake-ssh, which runs the command here as
// that computer (e2e/remote.spec.ts covers start, attach and the session list).

const ROOT = resolve(__dirname, '..');
const FAKE_SSH = join(ROOT, 'e2e/fixtures/fake-ssh');
const tmp = realpathSync(mkdtempSync('/tmp/bgrt-'));

beforeAll(() => {
  process.env.FAKE_SSH_ROOT = join(tmp, 'remote');
  process.env.BINDER_BIN = resolve(ROOT, '../tui/bin/binder.mjs');
});

const mini = () => new Remote('mini', FAKE_SSH, join(tmp, 'ssh'));

describe("config.json's computers", () => {
  it('keeps SSH destinations, once each, and nothing that would read as an ssh option', () => {
    const file = join(tmp, 'config.json');
    writeFileSync(file, JSON.stringify({ computers: ['mini', 'me@studio.local', 'mini', '-oProxyCommand=x', 'two words', 7, ''] }));
    expect(readComputers({ BINDER_CONFIG: file })).toEqual(['mini', 'me@studio.local']);
    writeFileSync(file, JSON.stringify({ computers: 'mini' }));
    expect(readComputers({ BINDER_CONFIG: file })).toEqual([]);
    expect(readComputers({ BINDER_CONFIG: join(tmp, 'missing.json') })).toEqual([]);
  });

  it('takes defaultComputer only when it is one of them', () => {
    const file = join(tmp, 'default.json');
    writeFileSync(file, JSON.stringify({ computers: ['mini'], defaultComputer: 'mini' }));
    expect(readDefaultComputer({ BINDER_CONFIG: file })).toBe('mini');
    writeFileSync(file, JSON.stringify({ computers: ['mini'], defaultComputer: 'studio' }));
    expect(readDefaultComputer({ BINDER_CONFIG: file })).toBe(null);
    writeFileSync(file, JSON.stringify({ defaultComputer: 'mini' }));
    expect(readDefaultComputer({ BINDER_CONFIG: file })).toBe(null);
  });
});

describe('another computer', () => {
  it('quotes words for its shell', () => {
    expect(shellQuote("it's here")).toBe(`'it'\\''s here'`);
  });

  it('asks ssh never to prompt, to give up on a dead link, and to share one connection', () => {
    const args = mini().sshArgs('true');
    expect(args.slice(-2)).toEqual(['mini', 'true']);
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain(`ControlPath=${join(tmp, 'ssh', '%C')}`);
  });

  it('checks folders there, ~ being its home', async () => {
    const r = mini();
    expect(await r.isDirectory('~')).toBe(true);
    expect(await r.isDirectory(tmp)).toBe(true);
    expect(await r.isDirectory(join(tmp, 'nope'))).toBe(false);
    expect((await r.sessions()).home).toBe(homedir());
  });

  it('lists the folders in folders there, but hidden ones', async () => {
    const top = join(tmp, 'top');
    for (const d of ['b', 'a', '.hidden', 'with space']) mkdirSync(join(top, d), { recursive: true });
    writeFileSync(join(top, 'file'), '');
    symlinkSync(join(top, 'a'), join(top, 'link'));
    expect(await mini().subfolders([top, `${top}/a/`, join(tmp, 'nope')])).toEqual(['a', 'b', 'link', 'with space'].map((d) => join(top, d)));
    expect(await new Remote('offline', FAKE_SSH, join(tmp, 'ssh')).subfolders([top])).toEqual([]);
  });

  it("reads a folder's checkouts and branch there", async () => {
    const repo = join(tmp, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'trunk'], { cwd: repo });
    expect(await mini().repoInfo(repo)).toEqual({ worktrees: [repo], branch: 'trunk' });
    expect(await mini().repoInfo(join(tmp, 'nope'))).toEqual({ worktrees: [join(tmp, 'nope')], branch: null });
  });

  it('runs the sidebar script there, in the session folder, with the session on stdin', async () => {
    const input = { session_id: 'abc', cwd: tmp, model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' }, status: 'idle', title: 't', prompt: 'p' };
    expect(await mini().sidebarScript(`printf '\\n\\033[32m%s\\033[0m in %s\\n' "$(sed -E 's/.*"session_id":"([^"]*)".*/\\1/')" "$(basename "$PWD")"`, input)).toBe(`abc in ${tmp.split('/').pop()}`);
    expect(await mini().sidebarScript('echo partial; exit 3', input)).toBe('');
  });

  it('names the computer when it cannot be reached', async () => {
    const r = new Remote('offline', FAKE_SSH, join(tmp, 'ssh'));
    await expect(r.sessions()).rejects.toThrow('offline: ssh: connect to host offline port 22: Operation timed out');
    expect(await r.isDirectory('~')).toBe(false);
  });
});
