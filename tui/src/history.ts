import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './paths.js';

// Prompt history for Up/Down in the composer, per directory, oldest first.

function historyPath(): string {
  return join(stateDir(), 'history.jsonl');
}

export function loadHistory(cwd: string, limit = 500): string[] {
  const p = historyPath();
  if (!existsSync(p)) return [];
  const out: string[] = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    try {
      const e = JSON.parse(line) as { cwd?: string; prompt?: string };
      if (e.cwd === cwd && e.prompt && e.prompt !== out[out.length - 1]) out.push(e.prompt);
    } catch {
      // a torn line from a concurrent write
    }
  }
  return out.slice(-limit);
}

export function addHistory(cwd: string, prompt: string): void {
  appendFileSync(historyPath(), JSON.stringify({ cwd, prompt, at: new Date().toISOString() }) + '\n');
}
