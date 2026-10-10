import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ControlRequest } from '../shared/api';
import { parseControl } from './control';

// What a web pane's page may ask of the app (window.binderPane). The page
// comes from a server, so nothing it sends is trusted: sessions open only in
// folders inside home, the app builds claude's flags itself, and folders are
// read and made only inside home.

const MAX_PATH = 4096;
// A todo's title and notes.
const MAX_DRAFT = 25000;
const MAX_NAME = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

/** Whether `url` is on `base`'s origin (scheme, host and port). */
export function sameOrigin(url: string, base: string): boolean {
  return URL.canParse(url) && URL.canParse(base) && new URL(url).origin === new URL(base).origin;
}

/** Whether normalized `path` is `home` or inside it. */
export function inHome(path: string, home: string): boolean {
  const rel = relative(home, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// A folder field's text as a normalized path: `~` is home, relative is under home.
const fromHome = (input: string, home: string) => resolve(home, input.replace(/^~(?=$|\/)/, home));

function insideHome(path: string, home: string): string {
  if (!inHome(path, home)) throw new Error(`${path} is outside your home folder`);
  return path;
}

/** Folder names in `dir`, following symlinks; unreadable means none. */
function subfolders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || (e.isSymbolicLink() && statSync(join(dir, e.name), { throwIfNoEntry: false })?.isDirectory()))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** window.binderPane.completeFolder: the todo TUI's tab completion, inside home only. */
export function completeFolder(input: unknown, home: string): { value: string; options: string[] } {
  if (!text(input, MAX_PATH)) throw new Error('input must be a path');
  if (input === '~') return { value: '~/', options: [] };
  const slash = input.lastIndexOf('/');
  const dirPart = input.slice(0, slash + 1);
  const prefix = input.slice(slash + 1);
  const dir = fromHome(dirPart, home);
  const matches = inHome(dir, home) ? subfolders(dir).filter((name) => name.startsWith(prefix) && (prefix.startsWith('.') || !name.startsWith('.'))) : [];
  if (matches.length === 0) return { value: input, options: [] };
  if (matches.length === 1) return { value: `${dirPart}${matches[0]}/`, options: [] };
  let common = matches[0];
  for (const m of matches) while (!m.startsWith(common)) common = common.slice(0, -1);
  return { value: dirPart + common, options: matches };
}

/** window.binderPane.missingFolder; rejects a path outside home. */
export function missingFolder(input: unknown, home: string): string | null {
  if (!text(input, MAX_PATH)) throw new Error('input must be a path');
  const path = input.trim();
  if (!path) return null;
  const abs = insideHome(fromHome(path, home), home);
  return existsSync(abs) ? null : abs;
}

/** window.binderPane.makeFolder: a folder and its missing parents, inside home. */
export function makeFolder(path: unknown, home: string): void {
  if (!text(path, MAX_PATH)) throw new Error('path must be a path');
  mkdirSync(insideHome(fromHome(path, home), home), { recursive: true });
}

/**
 * window.binderPane.open's request as the control socket's `open` (so it
 * behaves the same), or what is wrong with it. cwd is normalized (tab
 * completion leaves a trailing slash) and must be a folder inside home. A
 * new session's name becomes claude's `-n`, the only flag a page can set.
 */
export function paneOpen(req: unknown, home: string): ControlRequest | string {
  const m = (req && typeof req === 'object' ? req : {}) as Record<string, unknown>;
  if (!text(m.cwd, MAX_PATH) || !isAbsolute(m.cwd)) return 'cwd must be an absolute path';
  const cwd = resolve(m.cwd);
  if (!inHome(cwd, home)) return 'cwd must be inside your home folder';
  if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) return `cwd is not a folder: ${cwd}`;
  if (typeof m.sessionId !== 'string' || !UUID.test(m.sessionId)) return 'sessionId must be a UUID';
  if (m.resume !== undefined && typeof m.resume !== 'boolean') return 'resume must be true or false';
  if (m.draft !== undefined && !text(m.draft, MAX_DRAFT)) return `draft must be a string of at most ${MAX_DRAFT} characters`;
  if (m.name !== undefined && !text(m.name, MAX_NAME)) return `name must be a string of at most ${MAX_NAME} characters`;
  return parseControl(JSON.stringify({ t: 'open', cwd, sessionId: m.sessionId, resume: m.resume, draft: m.draft, args: m.name ? ['-n', m.name] : undefined }));
}
