import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { branches, diffRows, sessionDiff } from '../src/gitDiff.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', cwd, ...args], { encoding: 'utf8' }).trim();

function repo(): string {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'binder-diff-'))), 'app');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'one\ntwo\nthree\n');
  writeFileSync(join(dir, 'gone.txt'), 'bye\n');
  writeFileSync(join(dir, 'old-name.md'), '# same\n\nkept\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

describe('the session diff', () => {
  it("lists each changed file against HEAD, untracked ones as new", async () => {
    const dir = repo();
    writeFileSync(join(dir, 'src', 'a.ts'), 'one\n2\nthree\n');
    rmSync(join(dir, 'gone.txt'));
    git(dir, 'mv', 'old-name.md', 'new-name.md');
    writeFileSync(join(dir, 'notes.txt'), 'fresh\nfile\n');
    const d = await sessionDiff(join(dir, 'src'));
    expect(d.base).toBe('HEAD');
    expect(d.repo).toBe(dir);
    expect(d.files.map((f) => [f.path, f.status])).toEqual([
      ['gone.txt', 'deleted'],
      ['new-name.md', 'renamed'],
      ['notes.txt', 'untracked'],
      ['src/a.ts', 'modified'],
    ]);
    const a = d.files.find((f) => f.path === 'src/a.ts')!;
    expect(diffRows(a.patch).filter((r) => r.kind !== 'hunk')).toEqual([
      { kind: 'same', text: 'one', old: 1, new: 1 },
      { kind: 'del', text: 'two', old: 2 },
      { kind: 'add', text: '2', new: 2 },
      { kind: 'same', text: 'three', old: 3, new: 3 },
    ]);
    expect(diffRows(d.files.find((f) => f.path === 'notes.txt')!.patch)).toEqual([
      { kind: 'hunk', text: '' },
      { kind: 'add', text: 'fresh', new: 1 },
      { kind: 'add', text: 'file', new: 2 },
    ]);
  });

  it('compares against a branch, and lists the branches with the current one first', async () => {
    const dir = repo();
    git(dir, 'checkout', '-qb', 'feature');
    writeFileSync(join(dir, 'src', 'a.ts'), 'one\ntwo\nthree\nfour\n');
    git(dir, 'commit', '-qam', 'four');
    expect((await sessionDiff(dir)).files).toEqual([]);
    expect((await sessionDiff(dir, 'main')).files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(await branches(dir)).toEqual(['feature', 'main']);
    await expect(sessionDiff(tmpdir())).rejects.toThrow(/Not in a git repo/);
  });

  it('refuses a base that is not a branch or commit, and never passes one starting with - to git', async () => {
    const dir = repo();
    const written = join(dir, '..', 'written.txt');
    await expect(sessionDiff(dir, `--output=${written}`)).rejects.toThrow(`Not a branch or commit in this repo: --output=${written}`);
    expect(existsSync(written)).toBe(false);
    await expect(sessionDiff(dir, 'nope')).rejects.toThrow('Not a branch or commit in this repo: nope');
    expect((await sessionDiff(dir, 'main~0')).files).toEqual([]);
  });

  it('names paths with spaces, quotes and accents as they are', async () => {
    const dir = repo();
    const names = ['my file.txt', 'résumé.md', 'say "hi".txt', 'tab\there.txt'];
    for (const n of names) writeFileSync(join(dir, n), 'one\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'odd names');
    for (const n of names) writeFileSync(join(dir, n), 'two\n');
    // Empty new files have no ---/+++ lines: their names come from diff --git's own line.
    writeFileSync(join(dir, 'empty one.txt'), '');
    writeFileSync(join(dir, 'empty "q".txt'), '');
    git(dir, 'add', 'empty one.txt', 'empty "q".txt');
    const d = await sessionDiff(dir);
    expect(d.files.map((f) => [f.path, f.status])).toEqual([
      ['empty "q".txt', 'added'],
      ['empty one.txt', 'added'],
      ['my file.txt', 'modified'],
      ['résumé.md', 'modified'],
      ['say "hi".txt', 'modified'],
      ['tab\there.txt', 'modified'],
    ]);
  });

  it('shows odd untracked entries without failing the diff, and never follows a symlink', async () => {
    const dir = repo();
    const out = join(dir, '..', 'out');
    mkdirSync(out);
    writeFileSync(join(out, 'secret.txt'), 'SECRET\n');
    writeFileSync(join(dir, 'résumé notes.md'), 'hello\n');
    writeFileSync(join(dir, 'say "hi".txt'), 'hi\n');
    symlinkSync(join(out, 'secret.txt'), join(dir, 'secret-link'));
    symlinkSync(out, join(dir, 'folder-link'));
    symlinkSync(join(out, 'gone.txt'), join(dir, 'dangling'));
    mkdirSync(join(dir, 'nested'));
    git(join(dir, 'nested'), 'init', '-q');
    const d = await sessionDiff(dir);
    expect(d.files.map((f) => [f.path, f.patch])).toEqual([
      ['dangling', `@@ -0,0 +1,1 @@\n+${join(out, 'gone.txt')}`],
      ['folder-link', `@@ -0,0 +1,1 @@\n+${out}`],
      ['résumé notes.md', '@@ -0,0 +1,1 @@\n+hello'],
      ['say "hi".txt', '@@ -0,0 +1,1 @@\n+hi'],
      ['secret-link', `@@ -0,0 +1,1 @@\n+${join(out, 'secret.txt')}`],
    ]);
  });
});
