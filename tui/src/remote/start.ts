import { connect } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandHome, stateDir } from '../paths.js';
import { socketPath } from './sockets.js';
import { hostInfo, sessionProcess } from './serve.js';

// `binder start` and `binder attach`: what the Mac app runs over SSH to drive
// the sessions of another computer. `start` makes sure a host serves a
// session; `attach` connects stdin and stdout to that host's socket, which
// then speaks docs/remote-protocol.md's host socket protocol.
//
// A host started from an SSH login cannot read Claude Code's login (macOS
// keeps it in the login keychain, which SSH sessions cannot unlock) or count
// on the Mac's screen, so over SSH `start` has launchd run the host in the
// user's login session instead.

const START_TIMEOUT_MS = 30000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BINDER_BIN = process.env.BINDER_BIN || fileURLToPath(new URL('../../bin/binder.mjs', import.meta.url));
const JOB_PREFIX = 'com.binder.host.';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(message: string): never {
  process.stderr.write(message + '\n');
  process.exit(1);
}

export type StartArgs = { cwd: string; sessionId: string; resume: boolean; passthrough: string[] };

export function parseStartArgs(argv: string[], cwd: string): StartArgs | { error: string } {
  const dash = argv.indexOf('--');
  const own = dash === -1 ? argv : argv.slice(0, dash);
  const passthrough = dash === -1 ? [] : argv.slice(dash + 1);
  let dir = cwd;
  let sessionId: string | undefined;
  let resume = false;
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    if (a === '--cwd') dir = own[++i] ?? '';
    else if (a === '--session-id' || a === '--resume') {
      sessionId = own[++i];
      resume = a === '--resume';
    } else return { error: `Unknown argument: ${a}` };
  }
  if (!sessionId || !UUID.test(sessionId)) return { error: `Session id must be a UUID, got: ${sessionId ?? '(none)'}` };
  if (!dir) return { error: '--cwd needs a folder' };
  return { cwd: expandHome(dir), sessionId, resume, passthrough };
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlString = (s: string) => `<string>${xml(s)}</string>`;

/** A launchd job that runs `args` once, in `cwd`, with `env`, logging to `log`. */
export function jobPlist(label: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, log: string): string {
  // XML 1.0 cannot hold most control characters; a variable that has them is left out.
  const vars = Object.entries(env).filter((kv): kv is [string, string] => kv[1] !== undefined && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(kv[0] + kv[1]));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${xmlString(label)}`,
    `  <key>ProgramArguments</key><array>${args.map(xmlString).join('')}</array>`,
    `  <key>WorkingDirectory</key>${xmlString(cwd)}`,
    `  <key>EnvironmentVariables</key><dict>${vars.map(([k, v]) => `<key>${xml(k)}</key>${xmlString(v)}`).join('')}</dict>`,
    `  <key>StandardOutPath</key>${xmlString(log)}`,
    `  <key>StandardErrorPath</key>${xmlString(log)}`,
    '  <key>RunAtLoad</key><true/>',
    // The host's children (claude, background shells) are its own to end.
    '  <key>AbandonProcessGroup</key><true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** The environment a host gets: start's own, less what belongs to the SSH login. */
export function hostEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('SSH_')) out[k] = v;
  // bin/binder.mjs sets NODE_ENV for itself and marks it; the host sets its own.
  if (out.BINDER_SET_NODE_ENV) {
    delete out.NODE_ENV;
    delete out.BINDER_SET_NODE_ENV;
  }
  return out;
}

const launchctl = (...args: string[]) => execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Loads a launchd job from `plist`, written to `file` only for as long as
 * `launchctl bootstrap` reads it: launchd keeps the job, and the environment
 * in it (the login shell's, tokens and all), in memory.
 */
export function loadJob(domain: string, file: string, plist: string, run: (...args: string[]) => unknown = launchctl): void {
  writeFileSync(file, plist, { mode: 0o600 });
  try {
    run('bootstrap', domain, file);
  } finally {
    unlinkSync(file);
  }
}

/** Has launchd run the host in the login session (gui/<uid>), replacing any job left from an earlier host of this session. */
function startInLoginSession(dir: string, args: string[], log: string, sessionId: string): void {
  const domain = `gui/${process.getuid!()}`;
  const jobs = join(stateDir(), 'launchd');
  mkdirSync(jobs, { recursive: true, mode: 0o700 });
  // A job stays loaded after its host exits: let go of those, this session's
  // too (a host still running it would have answered, or been found by
  // sessionProcess). The domain's services list a job that is not running as pid 0.
  let services = '';
  try {
    services = launchctl('print', domain);
  } catch {
    // nothing to tidy
  }
  for (const [, pid, label] of services.matchAll(/^\s+(\d+)\s+\S+\s+(com\.binder\.host\.\S+)$/gm)) {
    if (pid !== '0') continue;
    try {
      launchctl('bootout', `${domain}/${label}`);
    } catch {
      // already gone
    }
  }
  const label = JOB_PREFIX + sessionId;
  try {
    loadJob(domain, join(jobs, `${label}.plist`), jobPlist(label, [process.execPath, BINDER_BIN, ...args], dir, hostEnv(process.env), log));
  } catch (e) {
    const why = String((e as { stderr?: string }).stderr ?? (e as Error).message).trim();
    fail(`Could not start the session in this Mac's login session (${why}). Is ${process.env.USER ?? 'this user'} logged in at its screen?`);
  }
}

export async function startMain(argv: string[]): Promise<void> {
  const a = parseStartArgs(argv, process.cwd());
  if ('error' in a) fail(a.error);
  const out = () => process.stdout.write(JSON.stringify({ socket: socketPath(a.sessionId) }) + '\n');
  if (await hostInfo(a.sessionId)) return void out();
  if (!existsSync(a.cwd)) fail(`The session's folder is gone: ${a.cwd}`);
  if (!statSync(a.cwd).isDirectory()) fail(`Not a directory: ${a.cwd}`);
  const other = sessionProcess(a.sessionId);
  if (other) fail(`That session is open in another program (${other}). Quit it there first.`);
  const log = join(stateDir(), `host-${a.sessionId}.log`);
  const args = ['host', a.resume ? '--resume' : '--session-id', a.sessionId, ...(a.passthrough.length ? ['--', ...a.passthrough] : [])];
  let failed: string | null = null;
  if (process.platform === 'darwin' && process.env.SSH_CONNECTION) startInLoginSession(a.cwd, args, log, a.sessionId);
  else {
    const fd = openSync(log, 'a', 0o600);
    const child = spawn(process.execPath, [BINDER_BIN, ...args], { cwd: a.cwd, detached: true, stdio: ['ignore', fd, fd], env: hostEnv(process.env) });
    child.on('exit', (code) => (failed ??= `binder host exited (code ${code}); see ${log}`));
    child.unref();
  }
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (!(await hostInfo(a.sessionId, 1000))) {
    if (failed) fail(failed);
    if (Date.now() > deadline) fail(`The session did not start (see ${log})`);
    await sleep(200);
  }
  out();
}

export function attachMain(argv: string[]): void {
  const [sessionId] = argv;
  if (!sessionId || !UUID.test(sessionId)) fail(`Session id must be a UUID, got: ${sessionId ?? '(none)'}`);
  if (!existsSync(socketPath(sessionId))) fail('That session is not running');
  const socket = connect(socketPath(sessionId));
  socket.on('error', (e) => fail(`That session is not running (${e.message})`));
  // stdin ends when the viewer goes (SSH closes it), which ends the connection.
  process.stdin.pipe(socket);
  socket.pipe(process.stdout, { end: false });
  // stdout to a pipe is written asynchronously: flush it before exiting.
  socket.on('close', () => process.stdout.write('', () => process.exit(0)));
}
