import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from '../paths.js';

// Each live session host listens on <state dir>/sock/<session id>.sock and
// writes its pid next to it (<id>.pid). The pid file is the session's lock:
// while that process lives, no other binder may run the session.

export function socketDir(): string {
  const dir = join(stateDir(), 'sock');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

export const socketPath = (sessionId: string) => join(socketDir(), `${sessionId}.sock`);
export const lockPath = (sessionId: string) => join(socketDir(), `${sessionId}.pid`);

/** The pid of another live process that holds the session, if any. */
export function liveElsewhere(sessionId: string): number | undefined {
  let pid: number;
  try {
    pid = Number(readFileSync(lockPath(sessionId), 'utf8').trim());
  } catch {
    return undefined;
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !existsSync(socketPath(sessionId))) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' ? pid : undefined;
  }
}

/** Session ids that have a socket file (live, or left behind by a crash). */
export function socketSessionIds(): string[] {
  return readdirSync(socketDir())
    .filter((f) => f.endsWith('.sock'))
    .map((f) => f.slice(0, -'.sock'.length));
}
