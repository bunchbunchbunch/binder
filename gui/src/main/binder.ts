import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { SessionRow, Settings, SettingsPatch, SidebarConfig, SidebarScriptInput } from '../shared/api';

export type PaneConfig = { name: string; command: string; cwd?: string };

// How the app finds and runs bindertui's `binder`. An app started from the
// Dock gets launchd's bare environment, so the user's login shell supplies
// PATH (node, binder, claude) and the rest of their environment, once.

export type Binder = {
  env: NodeJS.ProcessEnv;
  // How to run binder: its command on PATH (version-manager shims such as
  // Volta's dispatch on that name, so it is not resolved to a real path), or
  // node with BINDER_BIN.
  command: [string, ...string[]];
};

export type HostInfo = { sessionId: string; cwd: string; title: string; running: boolean; pid: number };

const START_TIMEOUT_MS = 30000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; timeout?: number } = {}): Promise<string> {
  return new Promise((done, fail) => {
    // SIGKILL on timeout: an interactive shell ignores SIGTERM.
    const child = execFile(cmd, args, { ...opts, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      if (err) fail(new Error(stderr.trim() || err.message));
      else done(stdout);
    });
    // Nothing reads stdin; closing it ends a startup file's `read` at once.
    child.stdin?.end();
  });
}

async function loginShellEnv(): Promise<NodeJS.ProcessEnv> {
  const shell = process.env.SHELL || '/bin/zsh';
  const mark = '__binder_gui_env__';
  try {
    // Markers around the output: an interactive shell may print a greeting or
    // set the title. It starts in the home folder, as a new terminal does, so
    // folder hooks (one that sets CLAUDE_CONFIG_DIR) see a fixed place.
    const out = await run(shell, ['-l', '-i', '-c', `printf ${mark}; env -0; printf ${mark}`], { timeout: 15000, cwd: homedir() });
    const env: NodeJS.ProcessEnv = {};
    for (const kv of (out.split(mark)[1] ?? '').split('\0')) {
      const i = kv.indexOf('=');
      if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return env.PATH ? env : { ...process.env };
  } catch {
    return { ...process.env };
  }
}

function which(name: string, path: string): string | undefined {
  return path
    .split(':')
    .map((d) => join(d, name))
    .find((p) => existsSync(p));
}

async function locate(): Promise<Binder> {
  const env = await loginShellEnv();
  // Settings the app itself was started with win (tests point binder at temp dirs this way).
  for (const [k, v] of Object.entries(process.env)) if (/^(BINDER_|CLAUDE_)/.test(k) && v !== undefined) env[k] = v;
  const node = which('node', env.PATH ?? '');
  if (!node) throw new Error('node is not on your PATH');
  // Version managers put folders on PATH that are shims (Volta, mise) or
  // per-shell links that can go away (fnm). Node's own folder goes first: it
  // is real, and for fnm it also holds the global npm bins (binder, claude).
  const real = (await run(node, ['-p', 'process.execPath'], { env, timeout: 15000 })).trim();
  env.PATH = [dirname(real), env.PATH].join(':');
  if (env.BINDER_BIN) return { env, command: [real, env.BINDER_BIN] };
  const bin = which('binder', env.PATH);
  if (!bin) throw new Error('binder is not on your PATH. Install the binder TUI (npm install && npm run build && npm link in its tui folder), or set BINDER_BIN to its bin/binder.mjs.');
  return { env, command: [bin] };
}

let found: Promise<Binder> | null = null;

/** The login shell's environment and how to run binder; found once (again after a failure, or `forget()`). */
export function binder(): Promise<Binder> {
  if (!found) {
    found = locate();
    found.catch(() => (found = null));
  }
  return found;
}

/** Look again next time: what was found stopped working (a node upgrade removed it). */
function forget(): void {
  found = null;
}

const binderArgs = (b: Binder, ...args: string[]): [string, string[]] => [b.command[0], [...b.command.slice(1), ...args]];

export function stateDir(env: NodeJS.ProcessEnv): string {
  return env.BINDER_STATE_DIR || join(homedir(), '.local', 'state', 'bindertui');
}

export const socketPath = (env: NodeJS.ProcessEnv, sessionId: string) => join(stateDir(env), 'sock', `${sessionId}.sock`);

const configPath = (env: NodeJS.ProcessEnv) => env.BINDER_CONFIG || join(homedir(), '.config', 'binder', 'config.json');

function readConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
}

// config.json's sidebar, keeping only the keys that are strings.
function readSidebar(v: unknown): SidebarConfig {
  if (!v || typeof v !== 'object') return {};
  const s = v as Record<string, unknown>;
  return Object.fromEntries((['title', 'subtitle', 'script'] as const).filter((k) => typeof s[k] === 'string').map((k) => [k, s[k]]));
}

/** binder's config.json, from where binder reads it. */
export function readSettings(env: NodeJS.ProcessEnv): Settings {
  const path = configPath(env);
  try {
    const c = readConfig(path);
    const dirs = c.configDirs && typeof c.configDirs === 'object' ? (c.configDirs as Record<string, string>) : {};
    const appearance = c.appearance === 'light' || c.appearance === 'dark' ? c.appearance : 'auto';
    return { path, permissionMode: typeof c.permissionMode === 'string' ? c.permissionMode : null, stickyPrompt: c.stickyPrompt !== false, appearance, configDirs: dirs, sidebar: readSidebar(c.sidebar) };
  } catch (e) {
    return { path, permissionMode: null, stickyPrompt: true, appearance: 'auto', configDirs: {}, sidebar: {}, error: (e as Error).message };
  }
}

const SCRIPT_TIMEOUT_MS = 5000;

/**
 * Runs config.json's sidebar.script for a session, as Claude Code runs a
 * statusLine command: `sh -c` in the session's folder with `input` as JSON
 * on stdin. Its first line, without color codes, is the {script} field.
 */
export function runSidebarScript(env: NodeJS.ProcessEnv, input: SidebarScriptInput): Promise<string> {
  const command = readSettings(env).sidebar.script;
  if (!command) return Promise.resolve('');
  return new Promise((done) => {
    const child = spawn('sh', ['-c', command], { cwd: existsSync(input.cwd) ? input.cwd : homedir(), env, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), SCRIPT_TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stdin.on('error', () => {});
    child.on('error', () => done(''));
    child.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0 ? (out.replace(/\x1b\[[0-9;]*m/g, '').split('\n').find((l) => l.trim()) ?? '').trim() : '');
    });
    child.stdin.end(JSON.stringify(input));
  });
}

/** config.json's `panes`: programs that run in a terminal beside the sessions. */
export function readPanes(env: NodeJS.ProcessEnv): PaneConfig[] {
  let panes: unknown;
  try {
    panes = readConfig(configPath(env)).panes;
  } catch {
    return [];
  }
  if (!Array.isArray(panes)) return [];
  return panes
    .filter((p): p is PaneConfig => typeof p?.name === 'string' && typeof p.command === 'string')
    .map(({ name, command, cwd }) => ({ name, command, ...(typeof cwd === 'string' && { cwd }) }));
}

/**
 * Sets keys in config.json and keeps the rest, as bindertui's /settings does.
 * Written in place, so a symlink into a dotfiles repo stays a symlink; a file
 * that does not parse is left alone.
 */
export function writeSettings(env: NodeJS.ProcessEnv, patch: SettingsPatch): Settings {
  const path = configPath(env);
  const next = readConfig(path);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else if (v !== undefined) next[k] = v;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
  return readSettings(env);
}

/** Asks a host socket what it runs; null when nothing answers. */
export function hostInfo(path: string, timeoutMs = 1500): Promise<HostInfo | null> {
  return new Promise((done) => {
    if (!existsSync(path)) return done(null);
    const s = connect(path);
    const finish = (v: HostInfo | null) => {
      clearTimeout(timer);
      s.destroy();
      done(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    s.on('error', () => finish(null));
    const lines = createInterface({ input: s });
    lines.on('error', () => {});
    lines.once('line', (line) => {
      try {
        const m = JSON.parse(line);
        finish(m.t === 'info' ? m : null);
      } catch {
        finish(null);
      }
    });
    s.write(JSON.stringify({ t: 'hello', want: 'info' }) + '\n');
  });
}

export async function listSessions(b: Binder): Promise<SessionRow[]> {
  try {
    return JSON.parse(await run(...binderArgs(b, 'sessions'), { env: b.env, timeout: 30000 }));
  } catch (e) {
    const msg = (e as Error).message;
    // A bindertui from before `binder sessions` prints its usage instead.
    if (/Unknown argument: sessions/.test(msg)) throw new Error(`This app needs a newer bindertui (with \`binder sessions\`). Update it and run npm run build there. Found: ${b.command.join(' ')}`);
    if (/ENOENT/.test(msg)) forget();
    throw e;
  }
}

/**
 * A claude already running this session with no host socket (an interactive
 * `claude --resume`): starting it again would run two claudes on one session.
 * Only claude processes resuming it count; not a fork of it (`--fork-session`),
 * a binder host that has moved on to another session, or a `tail` of its log.
 */
export function runsSession(cmd: string, sessionId: string): boolean {
  return new RegExp(`(--resume|-r|--session-id)[ =]${sessionId}\\b`).test(cmd) && /claude/i.test(cmd) && !cmd.includes('--fork-session');
}

async function sessionProcess(sessionId: string): Promise<string | undefined> {
  const out = await run('ps', ['-axo', 'pid=,command=']).catch(() => '');
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && Number(m[1]) !== process.pid && runsSession(m[2], sessionId)) return `pid ${m[1]}: ${m[2].slice(0, 120)}`;
  }
  return undefined;
}

/** Makes sure a host serves `sessionId`, starting `binder host` in `cwd` (with `claudeArgs` for claude) when none does. Returns its socket path. */
export async function ensureHost(b: Binder, cwd: string, sessionId: string, resume: boolean, claudeArgs: string[] = []): Promise<string> {
  const path = socketPath(b.env, sessionId);
  if (await hostInfo(path)) return path;
  const other = await sessionProcess(sessionId);
  if (other) throw new Error(`That session is open in another program (${other}). Quit it there first.`);
  if (!existsSync(cwd)) throw new Error(`The session's folder is gone: ${cwd}`);
  const dir = stateDir(b.env);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, `host-${sessionId}.log`);
  const out = openSync(log, 'a', 0o600);
  const [cmd, args] = binderArgs(b, 'host', resume ? '--resume' : '--session-id', sessionId, ...(claudeArgs.length ? ['--', ...claudeArgs] : []));
  const child = spawn(cmd, args, { cwd, env: b.env, detached: true, stdio: ['ignore', out, out] });
  closeSync(out);
  // A failure to start, or an early exit, ends the wait at once.
  let failed: string | null = null;
  child.on('error', (e) => {
    failed = `Could not run ${cmd}: ${e.message}`;
    forget();
  });
  child.on('exit', (code) => {
    failed ??= `binder host exited (code ${code}); see ${log}`;
  });
  child.unref();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (!(await hostInfo(path, 1000))) {
    if (failed) throw new Error(failed);
    if (Date.now() > deadline) throw new Error(`The session did not start (see ${log})`);
    await sleep(200);
  }
  return path;
}

export async function repoInfo(cwd: string): Promise<{ worktrees: string[]; branch: string | null }> {
  const worktrees = await run('git', ['worktree', 'list', '--porcelain'], { cwd })
    .then((out) => out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length)))
    .catch(() => [cwd]);
  const branch = await run('git', ['branch', '--show-current'], { cwd })
    .then((out) => out.trim() || null)
    .catch(() => null);
  return { worktrees, branch };
}
