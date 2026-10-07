import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logPath, replay } from './eventLog.js';
import { findTranscript, replayTranscript } from './transcripts.js';
import { latestSessionForCwd } from './sessions.js';
import { loadCachedUsage } from './statusline.js';
import type { State } from './store.js';

// Command-line arguments and the session state a launch starts from, shared by
// the TUI (cli.tsx) and the headless host (remote/cli.ts).

export const USAGE = `BinderTUI: one headless Claude Code session, in tabs

  binder                     start a new session
  binder <session-id>        resume a session
  binder -r, --resume <id>   resume a session
  binder -c, --continue      resume the latest binder session started in this directory
  binder --session-id <id>   start a new session with this id
  binder --draft <text>      start with <text> in the prompt, unsent
  binder -r <id> --fork-session
                             continue a session as a new one (the original stays as it was)
  binder -- <claude args>    pass flags to claude (e.g. binder -- --model opus)

Remote control (docs/remote-protocol.md):
  binder host [args]         run a session with no UI, for remote clients
  binder serve               the gateway: connect to the relay and serve enrolled clients
  binder sessions            list sessions (live ones first) as JSON, for the Mac app
  binder remote <command>    init, enroll <key> [name], revoke <name>, status
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseArgs(
  argv: string[],
  cwd: string,
): { sessionId: string; resume: boolean; draft?: string; forkFrom?: string; passthrough: string[] } | { error: string } {
  const dash = argv.indexOf('--');
  const own = dash === -1 ? argv : argv.slice(0, dash);
  const passthrough = dash === -1 ? [] : argv.slice(dash + 1);
  if (own.includes('-h') || own.includes('--help')) return { error: USAGE };

  let sessionId: string | undefined;
  let resume = false;
  let draft: string | undefined;
  let fork = false;
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    if (a === '-r' || a === '--resume') {
      sessionId = own[++i];
      resume = true;
    } else if (a === '-c' || a === '--continue') {
      const latest = latestSessionForCwd(cwd);
      if (!latest) return { error: `No binder session recorded for ${cwd}` };
      sessionId = latest.id;
      resume = true;
    } else if (a === '--session-id') {
      sessionId = own[++i];
      if (!sessionId || !UUID.test(sessionId)) return { error: `Session id must be a UUID, got: ${sessionId ?? '(none)'}` };
      resume = false;
    } else if (a === '--fork-session') {
      fork = true;
    } else if (a === '--draft') {
      draft = own[++i];
      if (draft === undefined) return { error: '--draft needs the text to put in the prompt' };
    } else if (UUID.test(a)) {
      sessionId = a;
      resume = true;
    } else {
      return { error: `Unknown argument: ${a}\n\n${USAGE}` };
    }
  }
  if (resume && (!sessionId || !UUID.test(sessionId))) return { error: `Session id must be a UUID, got: ${sessionId ?? '(none)'}` };
  if (fork && !resume) return { error: '--fork-session needs a session to fork: binder -r <id> --fork-session' };
  if (fork) return { sessionId: randomUUID(), resume: true, forkFrom: sessionId, ...(draft !== undefined && { draft }), passthrough };
  return { sessionId: sessionId ?? randomUUID(), resume, ...(draft !== undefined && { draft }), passthrough };
}

// The model shown before the first turn: the --model flag, else settings.json's default.
export function requestedModel(passthrough: string[]): string | undefined {
  const i = passthrough.indexOf('--model');
  return i >= 0 ? passthrough[i + 1] : undefined;
}

export function defaultModel(cfg: string): string | undefined {
  try {
    const settings = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf8'));
    return typeof settings.model === 'string' ? settings.model : undefined;
  } catch {
    return undefined;
  }
}

export type Launch = { sessionId: string; resume: boolean; draft?: string; forkFrom?: string; passthrough: string[] };

/** The tabs to show at launch: binder's own log, else Claude Code's transcript for a session binder never ran. */
export function initialStateFor({ sessionId, resume, forkFrom, passthrough }: Launch, cwd: string, cfg: string): State {
  // A fork starts from a copy of the original's log.
  if (forkFrom && existsSync(logPath(forkFrom))) copyFileSync(logPath(forkFrom), logPath(sessionId));
  const source = forkFrom ?? sessionId;
  const transcript = resume && !existsSync(logPath(sessionId)) ? findTranscript(cfg, source) : undefined;
  const initial = transcript ? { ...replayTranscript(source, transcript), sessionId } : replay(sessionId);
  if (!initial.usage) initial.usage = loadCachedUsage(cfg);
  if (!initial.cwd) initial.cwd = cwd;
  if (!initial.model) initial.model = requestedModel(passthrough) ?? defaultModel(cfg);
  return initial;
}
