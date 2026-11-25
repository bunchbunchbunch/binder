import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, removeWorktree } from '../src/worktree.js';
import { archiveSession } from '../src/archive.js';
import { upsertSession } from '../src/sessions.js';
import { parseArgs } from '../src/args.js';
import { lockPath, socketPath } from '../src/remote/sockets.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', cwd, ...args], { encoding: 'utf8' }).trim();

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'binder-wt-')));
  const dir = join(root, 'app');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export {};\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

describe('worktrees', () => {
  beforeEach(() => {
    process.env.BINDER_STATE_DIR = mkdtempSync(join(tmpdir(), 'binder-wt-state-'));
  });

  it('makes one beside the repo on a new branch, and starts in the same subfolder', () => {
    const dir = repo();
    const w = createWorktree(join(dir, 'src'), 'fix parser', {});
    expect(w.path).toBe(join(dir, '..', 'app-worktrees', 'fix-parser'));
    expect(w.branch).toBe('binder/fix-parser');
    expect(w.cwd).toBe(join(w.path, 'src'));
    expect(existsSync(join(w.cwd, 'a.ts'))).toBe(true);
    expect(git(dir, 'branch', '--list', 'binder/fix-parser')).toContain('binder/fix-parser');
    // Where and what, from config.json's worktrees.
    const named = createWorktree(dir, undefined, { location: '.wt/{repo}', branchPrefix: 'wip/' });
    expect(named.path.startsWith(join(dir, '.wt', 'app') + '/')).toBe(true);
    expect(named.branch).toMatch(/^wip\/\d{4}-\d{6}$/);
    expect(() => createWorktree(tmpdir(), undefined, {})).toThrow(/Not in a git repo/);
  });

  it('removes a worktree and its branch, but keeps what would lose work', () => {
    const dir = repo();
    const clean = createWorktree(dir, 'clean', {});
    expect(removeWorktree(clean)).toBe('Removed the worktree and the branch binder/clean');
    expect(existsSync(clean.path)).toBe(false);

    const dirty = createWorktree(dir, 'dirty', {});
    writeFileSync(join(dirty.path, 'src', 'a.ts'), 'changed\n');
    expect(removeWorktree(dirty)).toMatch(/^Kept the worktree .*dirty: it has changes not committed$/);
    expect(existsSync(dirty.path)).toBe(true);

    const ahead = createWorktree(dir, 'ahead', {});
    writeFileSync(join(ahead.path, 'b.ts'), 'new\n');
    git(ahead.path, 'add', '.');
    git(ahead.path, 'commit', '-qm', 'work');
    expect(removeWorktree(ahead)).toBe('Removed the worktree; kept the branch binder/ahead: it is not merged');
  });

  it("archiving a session removes the worktree binder made for it", () => {
    const dir = repo();
    const w = createWorktree(dir, 'session', {});
    upsertSession({ id: 'sid-wt', cwd: w.cwd, configDir: '/tmp/c', worktree: { path: w.path, branch: w.branch, repo: w.repo } });
    expect(archiveSession('sid-wt', true)).toBe('Archived. Removed the worktree and the branch binder/session');
    expect(archiveSession('sid-other', true)).toBe('Archived');
  });

  it('keeps the worktree of a session a host still runs, and removes it once the host is gone', () => {
    const dir = repo();
    const w = createWorktree(dir, 'live', {});
    upsertSession({ id: 'sid-live', cwd: w.cwd, configDir: '/tmp/c', worktree: { path: w.path, branch: w.branch, repo: w.repo } });
    // Another live process holds the session: its pid file and socket.
    writeFileSync(lockPath('sid-live'), String(process.ppid));
    writeFileSync(socketPath('sid-live'), '');
    expect(archiveSession('sid-live', true)).toBe('Archived. Kept the worktree: the session is still open');
    expect(existsSync(w.path)).toBe(true);
    rmSync(socketPath('sid-live'));
    expect(archiveSession('sid-live', true)).toBe('Archived. Removed the worktree and the branch binder/live');
    expect(existsSync(w.path)).toBe(false);
  });

  it('takes --worktree with an optional name, for a new session only', () => {
    expect(parseArgs(['--worktree', 'feat'], '/tmp')).toMatchObject({ worktree: 'feat', resume: false });
    expect(parseArgs(['--worktree'], '/tmp')).toMatchObject({ worktree: '' });
    expect(parseArgs(['-w', '--codex'], '/tmp')).toMatchObject({ worktree: '', agent: 'codex' });
    expect(parseArgs(['--worktree', '-r', '00000000-0000-4000-8000-000000000001'], '/tmp')).toEqual({ error: '--worktree starts a new session; it cannot resume one' });
  });
});
