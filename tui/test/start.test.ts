import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { hostEnv, jobPlist, loadJob, parseStartArgs } from '../src/remote/start.js';
import { FAKE_BIN, FIXTURES } from './helpers.js';

// `binder start` and `binder attach`, as the Mac app runs them over SSH: real
// processes from dist/, a real `binder host`, the fake claude.

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin/binder.mjs');
const ID = '00000000-0000-4000-8000-00000000c0a1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });
}, 120000);

let cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f();
  cleanup = [];
});

function setup() {
  const dir = mkdtempSync('/tmp/bst-');
  const project = join(dir, 'app');
  mkdirSync(project);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BINDER_STATE_DIR: join(dir, 's'),
    BINDER_CLAUDE_BIN: FAKE_BIN,
    BINDER_FAKE_FIXTURE: join(FIXTURES, 'two-turns-stdin.jsonl'),
    CLAUDE_CONFIG_DIR: join(dir, 'claude'),
    BINDER_CONFIG: '/nonexistent/binder-config.json',
  };
  // Run from an SSH login, the tests would start real launchd jobs.
  for (const k of Object.keys(env)) if (k.startsWith('SSH_')) delete env[k];
  delete env.BINDER_FAKE_DELAY_MS;
  const pidFile = join(dir, 's', 'sock', `${ID}.pid`);
  cleanup.push(() => {
    if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGTERM');
  });
  const binder = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', timeout: 40000 });
  return { dir, project, env, binder };
}

describe('binder start arguments', () => {
  it('takes the folder, the session, and flags for claude', () => {
    expect(parseStartArgs(['--cwd', '~/code/app', '--resume', ID, '--', '-n', 'Fix it'], '/x')).toEqual({ cwd: join(homedir(), 'code/app'), sessionId: ID, resume: true, passthrough: ['-n', 'Fix it'] });
    expect(parseStartArgs(['--session-id', ID], '/x/y')).toEqual({ cwd: '/x/y', sessionId: ID, resume: false, passthrough: [] });
  });

  it('refuses a missing or malformed session id, and unknown flags', () => {
    expect(parseStartArgs(['--cwd', '/x'], '/x')).toEqual({ error: 'Session id must be a UUID, got: (none)' });
    expect(parseStartArgs(['--resume', 'nope'], '/x')).toEqual({ error: 'Session id must be a UUID, got: nope' });
    expect(parseStartArgs(['--session-id', ID, '--model', 'opus'], '/x')).toEqual({ error: 'Unknown argument: --model' });
  });
});

describe("a host's launchd job", () => {
  it('runs the host once in its folder, with its environment and log', () => {
    const plist = jobPlist('com.binder.host.x', ['/n/node', '/b/binder.mjs', 'host', '--resume', ID], '/Users/me/a&b', { PATH: '/bin', ODD: 'x\x1by', TAG: '<t>' }, '/s/host.log');
    expect(plist).toContain('<key>Label</key><string>com.binder.host.x</string>');
    expect(plist).toContain(`<array><string>/n/node</string><string>/b/binder.mjs</string><string>host</string><string>--resume</string><string>${ID}</string></array>`);
    expect(plist).toContain('<key>WorkingDirectory</key><string>/Users/me/a&amp;b</string>');
    expect(plist).toContain('<key>PATH</key><string>/bin</string><key>TAG</key><string>&lt;t&gt;</string>');
    expect(plist).not.toContain('ODD');
    expect(plist).toContain('<key>StandardOutPath</key><string>/s/host.log</string>');
    expect(plist).toContain('<key>AbandonProcessGroup</key><true/>');
    if (process.platform === 'darwin') {
      const file = join(mkdtempSync('/tmp/bst-'), 'job.plist');
      writeFileSync(file, plist);
      expect(execFileSync('plutil', ['-lint', file], { encoding: 'utf8' })).toContain('OK');
    }
  });

  it('leaves no file behind once launchd has read it, loaded or not', () => {
    const file = join(mkdtempSync('/tmp/bst-'), 'job.plist');
    const seen: string[][] = [];
    loadJob('gui/501', file, '<plist/>', (...args) => {
      seen.push([...args, readFileSync(args[2], 'utf8')]);
    });
    expect(seen).toEqual([['bootstrap', 'gui/501', file, '<plist/>']]);
    expect(existsSync(file)).toBe(false);
    expect(() =>
      loadJob('gui/501', file, '<plist/>', () => {
        throw new Error('Bootstrap failed: 5: Input/output error');
      }),
    ).toThrow('Bootstrap failed');
    expect(existsSync(file)).toBe(false);
  });

  it("gets start's environment, less the SSH login's and binder's own NODE_ENV", () => {
    expect(hostEnv({ PATH: '/bin', SSH_CONNECTION: '1 2 3 4', SSH_AUTH_SOCK: '/a', NODE_ENV: 'production', BINDER_SET_NODE_ENV: '1', HOME: '/h' })).toEqual({ PATH: '/bin', HOME: '/h' });
    expect(hostEnv({ NODE_ENV: 'test' })).toEqual({ NODE_ENV: 'test' });
  });
});

describe('binder start and binder attach', () => {
  it('starts a host once, and attach speaks its socket until stdin ends', async () => {
    const { project, env, binder } = setup();
    const first = binder('start', '--cwd', project, '--session-id', ID);
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);
    const socket = JSON.parse(first.stdout).socket;
    expect(existsSync(socket)).toBe(true);
    // Live already: the same host.
    const pid = readFileSync(socket.replace(/\.sock$/, '.pid'), 'utf8');
    expect(JSON.parse(binder('start', '--cwd', project, '--resume', ID).stdout).socket).toBe(socket);
    expect(readFileSync(socket.replace(/\.sock$/, '.pid'), 'utf8')).toBe(pid);

    const attach = spawn(process.execPath, [BIN, 'attach', ID], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines: Record<string, unknown>[] = [];
    createInterface({ input: attach.stdout }).on('line', (l) => lines.push(JSON.parse(l)));
    attach.stdin.write(JSON.stringify({ t: 'hello', want: 'attach' }) + '\n');
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 600 && !check(); i++) await sleep(25);
      expect(check()).toBe(true);
    };
    await until(() => lines.some((m) => m.t === 'snapshot'));
    attach.stdin.write(JSON.stringify({ t: 'send', id: 1, text: 'first prompt' }) + '\n');
    await until(() => lines.some((m) => m.t === 'reply' && m.id === 1 && m.ok === true));
    const exited = new Promise<number | null>((r) => attach.on('exit', r));
    attach.stdin.end();
    expect(await exited).toBe(0);
  }, 60000);

  it('says why it cannot start or attach', () => {
    const { dir, binder } = setup();
    const gone = binder('start', '--cwd', join(dir, 'nope'), '--session-id', ID);
    expect(gone.status).toBe(1);
    expect(gone.stderr).toBe(`The session's folder is gone: ${join(dir, 'nope')}\n`);
    const idle = binder('attach', ID);
    expect(idle.status).toBe(1);
    expect(idle.stderr).toBe('That session is not running\n');
  });
});
