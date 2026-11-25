import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { binderConfig } from './config.js';

// A session in a new git worktree (binder --worktree, ⌥⏎ in the Mac app's new
// session panel): its own branch and folder, made from the repo the session
// was started in, and removed when the session is archived if nothing in it
// would be lost. config.json's `worktrees` says where (`location`, ~ and
// {repo} filled in, relative to the repo) and what the branch starts with.

export type Worktree = { path: string; branch: string; repo: string };

export const DEFAULT_LOCATION = '../{repo}-worktrees';
export const DEFAULT_PREFIX = 'binder/';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function stamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** Makes a worktree from `cwd`'s repo on a new branch; returns it and the folder to work in (the same place within it as `cwd`). */
export function createWorktree(cwd: string, name?: string, config = binderConfig().worktrees ?? {}): Worktree & { cwd: string } {
  let repo: string;
  try {
    repo = git(cwd, 'rev-parse', '--show-toplevel');
  } catch {
    throw new Error(`Not in a git repo: ${cwd}`);
  }
  const id = (name?.trim() || stamp()).replace(/[^\w.-]+/g, '-');
  const branch = `${config.branchPrefix ?? DEFAULT_PREFIX}${id}`;
  const where = (config.location ?? DEFAULT_LOCATION).replace(/^~(?=$|\/)/, homedir()).replaceAll('{repo}', basename(repo));
  const path = join(resolve(repo, where), id);
  mkdirSync(dirname(path), { recursive: true });
  try {
    git(repo, 'worktree', 'add', '-b', branch, path, 'HEAD');
  } catch (e) {
    throw new Error(`git worktree add failed: ${String((e as { stderr?: unknown }).stderr ?? (e as Error).message).trim()}`);
  }
  return { path, branch, repo, cwd: join(path, relative(repo, cwd)) };
}

/** Removes a session's worktree and its branch, unless that would lose work; says what it did. */
export function removeWorktree(w: Worktree): string {
  try {
    git(w.repo, 'worktree', 'remove', w.path);
  } catch {
    return `Kept the worktree ${w.path}: it has changes not committed`;
  }
  try {
    git(w.repo, 'branch', '-d', w.branch);
  } catch {
    return `Removed the worktree; kept the branch ${w.branch}: it is not merged`;
  }
  return `Removed the worktree and the branch ${w.branch}`;
}
