import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './paths.js';
import type { Agent } from './session.js';
import type { SessionSummary } from './transcripts.js';
import { logPath } from './eventLog.js';

export type SessionRecord = {
  id: string;
  cwd: string;
  configDir: string;
  createdAt: string;
  lastUsedAt: string;
  firstPrompt?: string;
  // Absent for Claude Code sessions, which predate the field.
  agent?: Agent;
  // A Codex session's thread, which Codex names itself (binder's id is its own).
  threadId?: string;
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

export function upsertSession(update: Pick<SessionRecord, 'id' | 'cwd' | 'configDir'> & Partial<Pick<SessionRecord, 'firstPrompt' | 'agent' | 'threadId'>>): void {
  const now = new Date().toISOString();
  const all = readSessions();
  const existing = all.find((s) => s.id === update.id);
  if (existing) {
    existing.lastUsedAt = now;
    existing.cwd = update.cwd;
    existing.configDir = update.configDir;
    if (update.firstPrompt && !existing.firstPrompt) existing.firstPrompt = update.firstPrompt;
    if (update.agent) existing.agent = update.agent;
    if (update.threadId) existing.threadId = update.threadId;
  } else {
    all.push({ ...update, createdAt: now, lastUsedAt: now });
  }
  writeFileSync(indexPath(), JSON.stringify(all, null, 2) + '\n');
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
    .map((s) => ({ id: s.id, path: logPath(s.id), cwd: s.cwd, prompt: s.firstPrompt!, modified: Date.parse(s.lastUsedAt) }))
    .sort((a, b) => b.modified - a.modified);
}
