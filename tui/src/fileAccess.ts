import { execFile } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

// The Mac app's file pane: the session folder's files, listed, found, read and
// written through the host (so it works for a session on another computer).
// Every path is relative to the session folder and must stay inside it.

/** The most a file the pane opens may hold. */
export const FILE_MAX = 2 * 1024 * 1024;
// How many files the quick-open index lists at most.
const INDEX_MAX = 20000;
// Never listed: git's own folder and Finder's litter.
const HIDDEN = new Set(['.git', '.DS_Store']);
// Not walked for the index when git cannot list the files.
const HEAVY = new Set(['node_modules', '.next', 'dist', 'build', 'out', '.venv', 'venv', '__pycache__', 'target', '.cache']);
// A save opens its file following no symlink: on macOS none on the way
// (O_NOFOLLOW_ANY, which Node has no name for), elsewhere none at the end.
const NOFOLLOW = process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW;

const contains = (base: string, full: string) => full === base || full.startsWith(base + sep);

/** The real path of `path` (relative to `root`), refused when it is outside `root`. */
async function inside(root: string, path: string): Promise<{ base: string; full: string }> {
  const base = await realpath(root);
  let full = resolve(base, path);
  try {
    full = await realpath(full);
  } catch {
    // Not there: the error comes from whoever reads it.
  }
  if (!contains(base, full)) throw new Error(`${path} is outside the session folder`);
  return { base, full };
}

export type DirEntry = { name: string; dir: boolean };

/** One folder's entries (relative to the session folder): folders first, then files, by name. */
export async function listDir(root: string, dir = ''): Promise<{ dir: string; entries: DirEntry[] }> {
  const { base, full } = await inside(root, dir);
  const all = await readdir(full, { withFileTypes: true });
  // A symlink is a folder here only when it leads to one inside the session folder (one leading out would be refused).
  const folder = (link: string) => realpath(link).then(async (p) => contains(base, p) && (await stat(p)).isDirectory(), () => false);
  const entries = await Promise.all(
    all
      .filter((e) => !HIDDEN.has(e.name))
      .map(async (e) => ({ name: e.name, dir: e.isDirectory() || (e.isSymbolicLink() && (await folder(resolve(full, e.name)))) })),
  );
  entries.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
  return { dir: relative(base, full), entries };
}

/** Every file in the session folder, for quick open: git's list (tracked, and untracked not ignored), else a walk that skips heavy folders. */
export async function fileIndex(root: string): Promise<{ files: string[]; cut: boolean }> {
  const git = await new Promise<string | null>((done) =>
    execFile('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 }, (err, out) => done(err ? null : out)),
  );
  if (git !== null) {
    const files = [...new Set(git.split('\0').filter((f) => f && !HIDDEN.has(f.slice(f.lastIndexOf('/') + 1))))];
    return { files: files.slice(0, INDEX_MAX), cut: files.length > INDEX_MAX };
  }
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(resolve(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length > INDEX_MAX) return;
      if (HIDDEN.has(e.name)) continue;
      const path = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!HEAVY.has(e.name)) await walk(path);
      } else if (e.isFile()) files.push(path);
    }
  };
  await walk('');
  return { files: files.slice(0, INDEX_MAX), cut: files.length > INDEX_MAX };
}

export type FileText = { path: string; size: number; mtime: number; text?: string; binary?: true };

/** A file's text and when it last changed; a binary file says so instead. */
export async function readText(root: string, path: string): Promise<FileText> {
  const { base, full } = await inside(root, path);
  const st = await stat(full);
  if (!st.isFile()) throw new Error(`${path} is not a file`);
  const rel = relative(base, full);
  if (st.size > FILE_MAX) throw new Error(`${rel} is ${st.size.toLocaleString('en-US')} bytes, over the ${FILE_MAX / 1024 / 1024} MB limit: too big to open here`);
  const bytes = await readFile(full);
  if (bytes.subarray(0, 8000).includes(0)) return { path: rel, size: st.size, mtime: st.mtimeMs, binary: true };
  // Text in another encoding (Latin-1, say) would be changed by a save: not opened.
  if (!isUtf8(bytes)) throw new Error(`${rel} is not UTF-8 text, so it cannot be opened here`);
  return { path: rel, size: st.size, mtime: st.mtimeMs, text: bytes.toString('utf8') };
}

/**
 * Saves a file the pane opened; refused when it changed on disk since `mtime`
 * (as read), unless `force`. Never writes outside the session folder: the
 * folder it goes in is confined by its real path, and the file is opened
 * without following a symlink, then checked to be the one in that folder.
 */
export async function writeText(root: string, path: string, text: string, mtime?: number, force = false): Promise<{ path: string; mtime: number; size: number }> {
  const { base, full } = await inside(root, path);
  // The folder it goes in, by its real path (a new file's too): a symlinked folder leading out is refused.
  const dir = await realpath(dirname(full));
  if (!contains(base, dir)) throw new Error(`${path} is outside the session folder`);
  const name = basename(full);
  const file = join(dir, name);
  const rel = relative(base, file);
  const before = await lstat(file).catch(() => null);
  // A symlink to a file was followed above; one still here leads nowhere.
  if (before?.isSymbolicLink()) throw new Error(`${rel} is a broken symlink`);
  if (before && !before.isFile()) throw new Error(`${path} is not a file`);
  if (Buffer.byteLength(text) > FILE_MAX) throw new Error('Too big to save from here');
  // So a symlink swapped in since the checks is refused, not followed; and a new file is made only while it is still new.
  const flags = constants.O_WRONLY | NOFOLLOW | (before ? 0 : constants.O_CREAT | constants.O_EXCL);
  const fh = await open(file, flags).catch((e: NodeJS.ErrnoException) => {
    throw e.code === 'ELOOP' || e.code === 'EEXIST' ? new Error(`${rel} changed on disk since it was opened`) : e;
  });
  try {
    // And it is the file in the session folder (off macOS, a folder on the way
    // swapped for a symlink after the checks would lead the open elsewhere).
    const st = await fh.stat();
    const where = await realpath(dir).catch(() => '');
    const now = contains(base, where) ? await lstat(join(where, name)).catch(() => null) : null;
    if (!st.isFile() || !now || now.ino !== st.ino || now.dev !== st.dev) throw new Error(`${path} is outside the session folder`);
    if (!force && mtime !== undefined && before && Math.abs(st.mtimeMs - mtime) > 1) throw new Error(`${rel} changed on disk since it was opened`);
    await fh.truncate(0);
    await fh.writeFile(text);
  } finally {
    await fh.close();
  }
  const after = await stat(file);
  return { path: rel, mtime: after.mtimeMs, size: after.size };
}
