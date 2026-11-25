import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';

// A session's changes for review (/diff, the Mac app's diff pane): its
// folder's working tree against a base, HEAD (what is not committed yet) or
// a branch (everything since), with files git does not track yet as added.

export type DiffFile = { path: string; status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'; patch: string; cut?: boolean };
export type SessionDiff = { base: string; repo: string; files: DiffFile[] };

const MAX_FILE_LINES = 3000;
const MAX_UNTRACKED_BYTES = 256 * 1024;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, out, errOut) => (err ? fail(new Error(String(errOut || err.message).trim())) : done(out)));
  });
}

function cut(patch: string): { patch: string; cut?: boolean } {
  const lines = patch.split('\n');
  return lines.length > MAX_FILE_LINES ? { patch: lines.slice(0, MAX_FILE_LINES).join('\n'), cut: true } : { patch };
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

// A path as git's diff headers write it: in C-style quotes when it holds a
// quote, a backslash, a control character or (core.quotePath, on by default)
// a non-ASCII character, written as octal bytes; else as it is.
function unquote(s: string): string {
  if (!/^".*"$/s.test(s)) return s;
  const parts = [...s.slice(1, -1).matchAll(/\\([0-7]{3}|.)|[^\\]+/gs)].map(([m, e]) =>
    e === undefined ? Buffer.from(m) : Buffer.from([e.length === 3 ? parseInt(e, 8) : (ESCAPES[e] ?? e.charCodeAt(0))]),
  );
  return Buffer.concat(parts).toString('utf8');
}

// One side of a ---/+++ line ("a/path", "b/path" or /dev/null); git adds a tab after a path with a space in it.
function side(label: string | undefined, prefix: string): string | undefined {
  const name = label === undefined ? undefined : unquote(label.replace(/\t$/, ''));
  return name?.startsWith(prefix) ? name.slice(prefix.length) : undefined;
}

// `git diff` output, one entry per file: its path (the new one for a rename) and how it changed.
export function splitDiff(out: string): DiffFile[] {
  return out
    .split(/^(?=diff --git )/m)
    .filter((chunk) => chunk.startsWith('diff --git '))
    .map((chunk) => {
      const header = chunk.slice(0, chunk.search(/^(@@|Binary files)/m) >>> 0);
      const line = (re: RegExp) => re.exec(header)?.[1];
      const renamed = line(/^rename to (.*)$/m);
      // With no ---/+++ lines (an empty or binary file) and no rename, both halves of
      // diff --git's own line ("a/path b/path") name the same path: the second one.
      const both = line(/^diff --git (.*)$/m) ?? '';
      const to = side(line(/^\+\+\+ (.*)$/m), 'b/') ?? (renamed === undefined ? undefined : unquote(renamed)) ?? side(both.slice((both.length + 1) / 2), 'b/') ?? '';
      const from = side(line(/^--- (.*)$/m), 'a/');
      const status: DiffFile['status'] = /^new file mode/m.test(header) ? 'added' : /^deleted file mode/m.test(header) ? 'deleted' : /^rename from/m.test(header) ? 'renamed' : 'modified';
      const path = status === 'deleted' ? (from ?? to) : to;
      const body = chunk.slice(chunk.search(/^(@@|Binary files)/m) >>> 0);
      return { path, status, ...cut(body.trimEnd()) };
    });
}

/** The repo's branches, the current one first. */
export async function branches(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['branch', '--format=%(HEAD) %(refname:short)']);
  const rows = out.split('\n').filter(Boolean);
  return [...rows.filter((r) => r.startsWith('*')), ...rows.filter((r) => !r.startsWith('*'))].map((r) => r.slice(2));
}

/** The changes in `cwd`'s working tree against `base` (HEAD unless given). */
export async function sessionDiff(cwd: string, base = 'HEAD'): Promise<SessionDiff> {
  let repo: string;
  try {
    repo = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    throw new Error(`Not in a git repo: ${cwd}`);
  }
  // A branch or commit, checked first: a base starting with - would reach git as an option.
  const known = !base.startsWith('-') && (await git(repo, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).then(() => true, () => false));
  if (!known) throw new Error(`Not a branch or commit in this repo: ${base}`);
  const files = splitDiff(await git(repo, ['diff', '--no-color', '--no-ext-diff', '-M', base, '--']));
  for (const path of (await git(repo, ['ls-files', '-z', '--others', '--exclude-standard'])).split('\0').filter(Boolean)) {
    // One odd entry (gone or unreadable since git listed it) never fails the whole diff.
    const file = await untracked(repo, path).catch(() => ({ path, status: 'untracked' as const, patch: '(could not read it)' }));
    if (file) files.push(file);
  }
  return { base, repo, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

// A file git does not track yet, as all added. A symlink shows as git would
// commit it, the path it points to (never followed: it may lead out of the
// repo); a folder (a repo of its own) shows nothing.
async function untracked(repo: string, path: string): Promise<DiffFile | undefined> {
  const full = join(repo, path);
  const st = await lstat(full);
  if (!st.isFile() && !st.isSymbolicLink()) return undefined;
  if (st.size > MAX_UNTRACKED_BYTES) return { path, status: 'untracked', patch: `(${Math.round(st.size / 1024)} KB, too big to show)` };
  const body = st.isSymbolicLink() ? Buffer.from(await readlink(full)) : await readFile(full, { flag: constants.O_RDONLY | constants.O_NOFOLLOW });
  if (body.subarray(0, 8000).includes(0)) return { path, status: 'untracked', patch: 'Binary file' };
  const lines = body.toString('utf8').replace(/\n$/, '').split('\n');
  return { path, status: 'untracked', ...cut([`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => '+' + l)].join('\n')) };
}

/** A unified diff's rows, numbered: what the panes draw. */
export type DiffRow = { kind: 'hunk' | 'add' | 'del' | 'same' | 'note'; text: string; old?: number; new?: number };

export function diffRows(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let o = 0;
  let n = 0;
  for (const line of patch.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      rows.push({ kind: 'hunk', text: h[3].trim() });
    } else if (line.startsWith('+')) rows.push({ kind: 'add', text: line.slice(1), new: n++ });
    else if (line.startsWith('-')) rows.push({ kind: 'del', text: line.slice(1), old: o++ });
    else if (line.startsWith(' ')) rows.push({ kind: 'same', text: line.slice(1), old: o++, new: n++ });
    else if (line.startsWith('\\')) continue;
    else if (line) rows.push({ kind: 'note', text: line });
  }
  return rows;
}
