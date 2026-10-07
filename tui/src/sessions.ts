import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './paths.js';

export type SessionRecord = {
  id: string;
  cwd: string;
  configDir: string;
  createdAt: string;
  lastUsedAt: string;
  firstPrompt?: string;
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

export function upsertSession(update: Pick<SessionRecord, 'id' | 'cwd' | 'configDir'> & { firstPrompt?: string }): void {
  const now = new Date().toISOString();
  const all = readSessions();
  const existing = all.find((s) => s.id === update.id);
  if (existing) {
    existing.lastUsedAt = now;
    existing.cwd = update.cwd;
    existing.configDir = update.configDir;
    if (update.firstPrompt && !existing.firstPrompt) existing.firstPrompt = update.firstPrompt;
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
