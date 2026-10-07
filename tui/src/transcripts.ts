import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import type { ClaudeEvent } from './events.js';
import { initialState, reduce, type State } from './store.js';

// Claude Code's own session transcripts (<config>/projects/<dir>/<id>.jsonl),
// for /resume across projects, worktrees and branches, and for showing a
// session binder never ran.

export type SessionSummary = {
  id: string;
  path: string;
  cwd: string;
  branch?: string;
  prompt: string;
  modified: number;
  // How Claude Code was started: 'cli' interactive, 'sdk-cli' headless (binder, scripts, hooks).
  entrypoint?: string;
};

const HEAD_BYTES = 64 * 1024;

function head(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

type TranscriptLine = {
  type?: string;
  entrypoint?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  cwd?: string;
  gitBranch?: string;
  timestamp?: string;
  uuid?: string;
  message?: { content?: unknown };
};

// The text a user typed, or "/name args" for a slash command; undefined for
// tool results and Claude Code's own injected messages.
export function promptText(content: unknown): string | undefined {
  let text: string | undefined;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((c) => c?.type === 'tool_result')) return undefined;
    text = content.filter((c) => c?.type === 'text').map((c) => String(c.text)).join('\n') || undefined;
  }
  if (!text) return undefined;
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (cmd) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
    return cmd[1].trim() + (args ? ' ' + args : '');
  }
  if (/^<(local-command|bash-|system-reminder|command-message)/.test(text.trim())) return undefined;
  return text;
}

export function summarize(path: string): SessionSummary | undefined {
  let cwd = '';
  let branch: string | undefined;
  let prompt: string | undefined;
  let entrypoint: string | undefined;
  for (const line of head(path).split('\n')) {
    let e: TranscriptLine;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    cwd ||= e.cwd ?? '';
    branch ||= e.gitBranch;
    entrypoint ||= e.entrypoint;
    if (!prompt && e.type === 'user' && !e.isMeta && !e.isSidechain) prompt = promptText(e.message?.content);
    if (cwd && prompt) break;
  }
  if (!prompt) return undefined;
  return { id: basename(path, '.jsonl'), path, cwd, branch, prompt, modified: statSync(path).mtimeMs, entrypoint };
}

export function listTranscripts(configDir: string): SessionSummary[] {
  const root = join(configDir, 'projects');
  const out: SessionSummary[] = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return out;
  }
  for (const d of dirs) {
    let files: string[] = [];
    try {
      files = readdirSync(join(root, d)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const s = summarize(join(root, d, f));
        if (s) out.push(s);
      } catch {
        // unreadable transcript
      }
    }
  }
  return out.sort((a, b) => b.modified - a.modified);
}

// Where Claude Code keeps a session's transcript, whichever project it is in.
export function findTranscript(configDir: string, sessionId: string): string | undefined {
  const root = join(configDir, 'projects');
  try {
    for (const d of readdirSync(root)) {
      const p = join(root, d, `${sessionId}.jsonl`);
      if (existsSync(p)) return p;
    }
  } catch {
    // no projects yet
  }
  return undefined;
}

// The checkout directories of the repo `cwd` is in (main tree and worktrees).
export function worktreePaths(cwd: string): string[] {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length));
  } catch {
    return [cwd];
  }
}

export function currentBranch(cwd: string): string | undefined {
  try {
    return execFileSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

// Tabs for a session binder has no log of: the whole conversation in one tab,
// one turn per prompt, as it was in Claude Code.
export function replayTranscript(sessionId: string, path: string): State {
  let state = initialState(sessionId);
  if (!existsSync(path)) return state;
  let turnStart = 0;
  let last = 0;
  const finish = () => {
    if (state.running === null) return;
    const ev = { type: 'result', subtype: 'success', is_error: false, duration_ms: Math.max(0, last - turnStart), num_turns: 1 } as ClaudeEvent;
    state = reduce(state, { type: 'event', event: ev });
  };
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let e: TranscriptLine;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.isSidechain || (e.type !== 'user' && e.type !== 'assistant')) continue;
    const at = e.timestamp ? Date.parse(e.timestamp) : last;
    const prompt = e.type === 'user' && !e.isMeta ? promptText(e.message?.content) : undefined;
    if (prompt !== undefined) {
      finish();
      if (!state.tabs.length) {
        state = reduce(state, { type: 'submit', prompt });
        state = reduce(state, { type: 'sent', tabId: state.tabs[0].id, uuid: e.uuid });
      } else {
        state = reduce(state, { type: 'followup', tabId: state.tabs[0].id, prompt });
        state = reduce(state, { type: 'sent', tabId: state.tabs[0].id, uuid: e.uuid });
      }
      turnStart = at;
    } else if (!e.isMeta && state.running !== null) {
      state = reduce(state, { type: 'event', event: { type: e.type, message: e.message, parent_tool_use_id: null } as ClaudeEvent });
    }
    last = at;
  }
  finish();
  return state;
}
