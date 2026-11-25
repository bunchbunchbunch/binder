import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionHost } from '../host.js';
import { findSession, readSessions, upsertSession } from '../sessions.js';
import { archiveSession, archivedIds } from '../archive.js';
import { searchSessions } from '../search.js';
import { findTranscript, listTranscripts } from '../transcripts.js';
import { logPath } from '../eventLog.js';
import { configDir } from '../paths.js';
import { USAGE, enterWorktree, initialStateFor, launchConfigDir, parseArgs, sessionFor } from '../args.js';
import { HostServer } from './hostServer.js';
import { liveElsewhere } from './sockets.js';
import { expandHome, remoteCommand } from './config.js';
import { listSessions, serve } from './serve.js';
import { attachMain, startMain } from './start.js';
import { binderConfig } from '../config.js';

// Entry for the commands that need no terminal UI: `binder host`, `binder
// start`, `binder attach`, `binder serve`, `binder sessions`, `binder remote ...`
// (bin/binder.mjs routes them here).

// A host nobody watches and that has nothing to do exits after this long.
const IDLE_MS = Number(process.env.BINDER_HOST_IDLE_MS ?? 15 * 60 * 1000);

// Each build rewrites every file of binder, this one included, so a change in
// its modification time means the host runs code older than what is installed.
const CODE = fileURLToPath(import.meta.url);
const builtAt = (): number | undefined => {
  try {
    return statSync(CODE).mtimeMs;
  } catch {
    return undefined; // mid-build
  }
};

async function hostMain(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, process.cwd());
  if ('error' in parsed) {
    process.stderr.write(parsed.error.endsWith('\n') ? parsed.error : parsed.error + '\n');
    process.exit(parsed.error === USAGE ? 0 : 1);
  }
  // --worktree: the session starts in a new worktree (enterWorktree moves there).
  const cwd = enterWorktree(parsed, process.cwd());
  const other = liveElsewhere(parsed.sessionId);
  if (other) {
    process.stderr.write(`Session ${parsed.sessionId} is already open in another binder (pid ${other}).\n`);
    process.exit(1);
  }
  const cfg = launchConfigDir(parsed, cwd);
  const session = sessionFor(parsed, cwd);
  const host = new SessionHost(session, initialStateFor(parsed, cwd, cfg), cwd, cfg);
  const server = new HostServer(host, { restart: () => shutdown('restart') });
  upsertSession({ id: parsed.sessionId, cwd, configDir: cfg, agent: session.agent });
  session.start();
  await server.listen();
  process.stdout.write(`${new Date().toISOString()} hosting ${parsed.sessionId} in ${cwd} (pid ${process.pid})\n`);

  let closing = false;
  const shutdown = async (why: string) => {
    if (closing) return;
    closing = true;
    process.stdout.write(`${new Date().toISOString()} stopping: ${why}\n`);
    // A restart lets claude exit before the viewers hear the host ended, so
    // the host that replaces this one can start claude on the session at once.
    if (why === 'restart') await host.close().catch(() => {});
    server.close();
    void host.close().finally(() => process.exit(0));
  };
  const started = builtAt();
  setInterval(() => {
    const now = builtAt();
    if (started !== undefined && now !== undefined && now !== started) server.markOutdated();
  }, Math.min(30000, IDLE_MS)).unref();
  let idleSince = Date.now();
  setInterval(() => {
    if (server.viewerCount || host.busy || host.state.question) idleSince = Date.now();
    else if (Date.now() - idleSince > IDLE_MS) shutdown('idle');
  }, Math.min(60000, IDLE_MS)).unref();
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// `binder sessions`: the sessions /resume would offer, from every config dir
// binder knows (configDirs too), live ones first, archived ones marked, as
// JSON for the Mac app. `--search <text>` lists the ones whose prompts or
// replies hold it, with a snippet ([{id, snippet}]); `--archive <id>` and
// `--unarchive <id>` move one out of the lists or back.
async function sessionsMain(argv: string[]): Promise<void> {
  const [flag, arg] = argv;
  // An error as JSON too ({error}), besides the exit code and stderr.
  const refuse = (error: string): Error => (process.stdout.write(JSON.stringify({ error }) + '\n'), new Error(error));
  if (flag !== undefined && !['--search', '--archive', '--unarchive'].includes(flag)) throw refuse(`Unknown: binder sessions ${flag} (--search TEXT, --archive ID, --unarchive ID)`);
  const dirs = [...new Set([configDir(), ...Object.values(binderConfig().configDirs ?? {}).map(expandHome)])];
  if (flag === '--archive' || flag === '--unarchive') {
    if (!arg) throw refuse(`binder sessions ${flag} needs a session id`);
    // Only a session binder or Claude Code knows (or an archived one, to unarchive): a mistyped id is not kept.
    const known = findSession(arg) || dirs.some((d) => findTranscript(d, arg)) || (flag === '--unarchive' && archivedIds().has(arg));
    if (!known) throw refuse(`No session ${arg}`);
    process.stdout.write(JSON.stringify({ message: archiveSession(arg, flag === '--archive') }) + '\n');
    return;
  }
  if (flag === '--search') {
    const transcripts = dirs.flatMap((d) => listTranscripts(d)).sort((a, b) => b.modified - a.modified);
    const ids = new Set(transcripts.map((t) => t.id));
    // Binder's own sessions with no Claude Code transcript (Codex) search their event logs.
    const own = readSessions().filter((r) => !ids.has(r.id)).map((r) => ({ id: r.id, path: logPath(r.id) }));
    const hits = await searchSessions([...transcripts.slice(0, 400), ...own], arg ?? '');
    process.stdout.write(JSON.stringify(hits) + '\n');
    return;
  }
  const rows = await listSessions(undefined, { configDirs: dirs, interactiveOnly: true, includeArchived: true });
  process.stdout.write(JSON.stringify(rows) + '\n');
}

// `binder schedule`: scheduled tasks (schedule.ts), as JSON for the Mac app.
//   binder schedule [list]                       the tasks, each with its next run and last run
//   binder schedule add [--when W] [--cwd DIR] [--name N] [--mode M] -- PROMPT
//                                                (no --when: the prompt starts with it, as /schedule's does)
//   binder schedule remove|pause|resume|run ID
//   binder schedule history [ID]                 the runs, newest first
//   binder schedule tick                         starts the tasks that are due
async function scheduleMain(argv: string[]): Promise<void> {
  const [sub = 'list', ...rest] = argv;
  const out = (v: unknown): void => void process.stdout.write(JSON.stringify(v) + '\n');
  const { loadSchedules, addSchedule, removeSchedule, pauseSchedule, runNow, tick, nextFor, describeWhen, splitWhen } = await import('../schedule.js');
  if (sub === 'list') {
    const { schedules, runs } = loadSchedules();
    return out(schedules.map((s) => ({ ...s, describe: describeWhen(s.when), next: nextFor(s)?.getTime() ?? null, lastRun: [...runs].reverse().find((r) => r.scheduleId === s.id) ?? null })));
  }
  if (sub === 'add') {
    const dash = rest.indexOf('--');
    const own = dash === -1 ? rest : rest.slice(0, dash);
    const opt = (name: string) => {
      const i = own.indexOf(name);
      return i === -1 ? undefined : own[i + 1];
    };
    let when = opt('--when');
    let prompt = dash === -1 ? '' : rest.slice(dash + 1).join(' ');
    if (!when) {
      const split = splitWhen(prompt);
      if (!split) throw new Error('Start with when it runs, then the prompt: daily 9:00, weekdays 17:30, mon,thu 8:00, hourly, every 15m, or a cron line');
      ({ when, prompt } = split);
    }
    return out(addSchedule({ when, cwd: resolve(expandHome(opt('--cwd') ?? process.cwd())), name: opt('--name'), mode: opt('--mode'), prompt }));
  }
  const [id] = rest;
  if (sub === 'remove') return out(removeSchedule(id ?? ''));
  if (sub === 'pause' || sub === 'resume') return out(pauseSchedule(id ?? '', sub === 'pause'));
  if (sub === 'run') return out(await runNow(id ?? ''));
  if (sub === 'history') return out([...loadSchedules().runs].reverse().filter((r) => !id || r.scheduleId === id));
  if (sub === 'tick') return out(await tick());
  throw new Error(`Unknown: binder schedule ${sub} (list, add, remove, pause, resume, run, history, tick)`);
}

export async function remoteMain(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'host') return await hostMain(rest);
    if (cmd === 'start') return await startMain(rest);
    if (cmd === 'attach') return attachMain(rest);
    if (cmd === 'serve') return serve();
    if (cmd === 'sessions') return await sessionsMain(rest);
    if (cmd === 'remote') return remoteCommand(rest);
    if (cmd === 'schedule') return await scheduleMain(rest);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  }
}
