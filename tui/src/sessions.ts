import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, STATE_FILE_MODE } from './paths.js';
import type { Agent } from './session.js';
import type { SessionSummary } from './transcripts.js';
import { logPath } from './eventLog.js';
import type { Worktree } from './worktree.js';

export type SessionRecord = {
  id: string;
  cwd: string;
  configDir: string;
  createdAt: string;
  lastUsedAt: string;
  firstPrompt?: string;
  // The session's name (/rename, /fork's title), once it has one.
  title?: string;
  // Absent for Claude Code sessions, which predate the field.
  agent?: Agent;
  // A Codex session's thread, which Codex names itself (binder's id is its own).
  threadId?: string;
  // The worktree binder made for it (binder --worktree); archiving removes it.
  worktree?: Worktree;
};

function indexPath(): string {
  return join(stateDir(), 'sessions.json');
}

export function readSessions(): SessionRecord[] {
  const p = indexPath();
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function upsertSession(update: Pick<SessionRecord, 'id' | 'cwd' | 'configDir'> & Partial<Pick<SessionRecord, 'firstPrompt' | 'title' | 'agent' | 'threadId' | 'worktree'>>): void {
  const now = new Date().toISOString();
  const all = readSessions();
  const existing = all.find((s) => s.id === update.id);
  if (existing) {
    existing.lastUsedAt = now;
    existing.cwd = update.cwd;
    existing.configDir = update.configDir;
    if (update.firstPrompt && !existing.firstPrompt) existing.firstPrompt = update.firstPrompt;
    if (update.title) existing.title = update.title;
    if (update.agent) existing.agent = update.agent;
    if (update.threadId) existing.threadId = update.threadId;
    if (update.worktree) existing.worktree = update.worktree;
  } else {
    all.push({ ...update, createdAt: now, lastUsedAt: now });
  }
  writeFileSync(indexPath(), JSON.stringify(all, null, 2) + '\n', { mode: STATE_FILE_MODE });
}

export function latestSessionForCwd(cwd: string): SessionRecord | undefined {
  return readSessions()
    .filter((s) => s.cwd === cwd)
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))[0];
}

export function findSession(id: string): SessionRecord | undefined {
  return readSessions().find((s) => s.id === id);
}

/** Binder's own Codex sessions, newest first, for /resume in a Codex session (each has an event log to replay). */
export function codexSessions(): SessionSummary[] {
  return readSessions()
    .filter((s) => s.agent === 'codex' && s.firstPrompt)
    .map((s) => ({ id: s.id, path: logPath(s.id), cwd: s.cwd, prompt: s.firstPrompt!, ...(s.title && { title: s.title }), modified: Date.parse(s.lastUsedAt) }))
    .sort((a, b) => b.modified - a.modified);
}
