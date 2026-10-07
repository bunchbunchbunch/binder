import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

// Tab completion for the composer: file paths (also after "@") and, in bash
// mode, command names from PATH.

// The word ending at the cursor and where it starts.
export function wordAt(value: string, cursor: number): { start: number; word: string } {
  let start = cursor;
  while (start > 0 && !/\s/.test(value[start - 1])) start--;
  return { start, word: value.slice(start, cursor) };
}

function expand(dir: string, cwd: string): string {
  if (dir === '~' || dir.startsWith('~/')) return join(homedir(), dir.slice(1));
  return isAbsolute(dir) ? dir : join(cwd, dir);
}

// Paths that complete `partial`, written the way it was typed ("src/u" ->
// "src/ui/"); directories end in "/". Hidden entries only when asked for.
export function completePath(partial: string, cwd: string, limit = 200): string[] {
  const slash = partial.lastIndexOf('/');
  const dir = slash >= 0 ? partial.slice(0, slash + 1) : '';
  const base = slash >= 0 ? partial.slice(slash + 1) : partial;
  if (partial === '~') return ['~/'];
  let entries;
  try {
    entries = readdirSync(expand(dir || '.', cwd), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.name.startsWith(base) || (e.name.startsWith('.') && !base.startsWith('.'))) continue;
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        isDir = statSync(join(expand(dir || '.', cwd), e.name)).isDirectory();
      } catch {
        // dangling link
      }
    }
    out.push(dir + e.name + (isDir ? '/' : ''));
  }
  return out.sort().slice(0, limit);
}

let pathCommands: string[] | null = null;

export function completeCommand(prefix: string, limit = 200): string[] {
  if (!pathCommands) {
    const names = new Set<string>();
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      try {
        for (const name of readdirSync(dir)) names.add(name);
      } catch {
        // missing PATH entry
      }
    }
    pathCommands = [...names].sort();
  }
  return pathCommands.filter((c) => c.startsWith(prefix)).slice(0, limit);
}

export function commonPrefix(items: string[]): string {
  if (!items.length) return '';
  let p = items[0];
  for (const s of items) while (!s.startsWith(p)) p = p.slice(0, -1);
  return p;
}
