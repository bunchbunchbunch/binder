import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, STATE_FILE_MODE } from './paths.js';
import { findSession } from './sessions.js';
import { removeWorktree } from './worktree.js';
import { liveElsewhere } from './remote/sockets.js';

// Sessions archived out of /resume, ⌘K and the Mac app's sidebar: their ids,
// in binder's state dir. The sessions themselves are untouched, and an
// archived one still opens by id.

const file = () => join(stateDir(), 'archived.json');

export function archivedIds(): Set<string> {
  if (!existsSync(file())) return new Set();
  try {
    const ids = JSON.parse(readFileSync(file(), 'utf8'));
    return new Set(Array.isArray(ids) ? ids.filter((i): i is string => typeof i === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * Archives a session (and removes the worktree binder made for it, if nothing
 * would be lost and no host still runs the session in it), or brings it back;
 * says what happened.
 */
export function archiveSession(id: string, on: boolean): string {
  setArchived(id, on);
  const w = on ? findSession(id)?.worktree : undefined;
  const tree = w && (liveElsewhere(id) !== undefined ? 'Kept the worktree: the session is still open' : removeWorktree(w));
  return [on ? 'Archived' : 'Unarchived', tree].filter(Boolean).join('. ');
}

export function setArchived(id: string, on: boolean): void {
  const ids = archivedIds();
  if (on) ids.add(id);
  else ids.delete(id);
  writeFileSync(file(), JSON.stringify([...ids], null, 2) + '\n', { mode: STATE_FILE_MODE });
}
