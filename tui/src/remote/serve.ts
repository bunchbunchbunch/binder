import WebSocket from 'ws';
import { connect, type Socket } from 'node:net';
import { appendFileSync, existsSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { Handshake, Opener, fingerprint, seal, type CipherState } from './noise.js';
import { configPath, expandHome, loadConfig, logPathFor, type Device, type RemoteConfig } from './config.js';
import { lockPath, socketPath, socketSessionIds } from './sockets.js';
import { insideRoots } from './hostServer.js';
import { readSessions } from '../sessions.js';
import { listTranscripts } from '../transcripts.js';
import { configDir, stateDir } from '../paths.js';
import { logPath } from '../eventLog.js';

// `binder serve`: the gateway (docs/remote-protocol.md). Holds one WebSocket to
// the relay, runs a Noise IK handshake per client, admits only enrolled
// clients, and gives each one the session list, a launcher, and a pipe to one
// session host's socket. The relay only ever sees ciphertext.

const DATA = 0;
const OPEN = 1;
const CLOSE = 2;
const MAX_CLIENTS = 8;
const PING_MS = 25000;
const START_TIMEOUT_MS = 30000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BINDER_BIN = process.env.BINDER_BIN || fileURLToPath(new URL('../../bin/binder.mjs', import.meta.url));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const oneLine = (s: string) => s.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

type HostInfo = { sessionId: string; cwd: string; title: string; running: boolean; pid: number };
export type SessionRow = { id: string; cwd: string; title: string; live: boolean; running: boolean; lastUsedAt: string; branch?: string };

/** Asks a host socket what it runs; null when nothing answers. */
export function hostInfo(sessionId: string, timeoutMs = 1500): Promise<HostInfo | null> {
  return new Promise((done) => {
    const s = connect(socketPath(sessionId));
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

// A socket left behind by a binder that crashed.
function removeStale(sessionId: string): void {
  let pid = 0;
  try {
    pid = Number(readFileSync(lockPath(sessionId), 'utf8').trim());
    process.kill(pid, 0);
    return; // its process lives; maybe it is just slow
  } catch {
    // dead or unreadable
  }
  for (const p of [socketPath(sessionId), lockPath(sessionId)]) {
    try {
      unlinkSync(p);
    } catch {
      // gone
    }
  }
}

type ListOptions = {
  // The Claude Code config dirs whose transcripts are listed.
  configDirs?: string[];
  // Leave out headless runs binder did not start (scripts and hooks that call `claude -p`), as /resume does.
  interactiveOnly?: boolean;
};

/** Live hosts first, then what /resume would offer, newest first, inside the allowed roots. */
export async function listSessions(roots: string[] | undefined, { configDirs = [configDir()], interactiveOnly = false }: ListOptions = {}): Promise<SessionRow[]> {
  const rows = new Map<string, SessionRow>();
  const transcripts = configDirs
    .flatMap((d) => listTranscripts(d))
    .filter((t) => !interactiveOnly || !t.entrypoint?.startsWith('sdk') || existsSync(logPath(t.id)))
    .sort((a, b) => b.modified - a.modified);
  for (const t of transcripts.slice(0, 300)) {
    rows.set(t.id, { id: t.id, cwd: t.cwd, title: oneLine(t.prompt).slice(0, 100), live: false, running: false, lastUsedAt: new Date(t.modified).toISOString(), branch: t.branch });
  }
  for (const r of readSessions()) {
    const prev = rows.get(r.id);
    const last = prev && prev.lastUsedAt > r.lastUsedAt ? prev.lastUsedAt : r.lastUsedAt;
    rows.set(r.id, { id: r.id, cwd: r.cwd, title: prev?.title || oneLine(r.firstPrompt ?? '').slice(0, 100), live: false, running: false, lastUsedAt: last, branch: prev?.branch });
  }
  const live = await Promise.all(socketSessionIds().map(async (id) => [id, await hostInfo(id)] as const));
  for (const [id, info] of live) {
    if (!info) {
      removeStale(id);
      continue;
    }
    const prev = rows.get(id);
    rows.set(id, { id, cwd: info.cwd, title: info.title || prev?.title || '', live: true, running: info.running, lastUsedAt: new Date().toISOString(), branch: prev?.branch });
  }
  return [...rows.values()]
    .filter((r) => r.cwd && insideRoots(r.cwd, roots))
    .sort((a, b) => Number(b.live) - Number(a.live) || b.lastUsedAt.localeCompare(a.lastUsedAt))
    .slice(0, 150);
}

/**
 * Another process running this session that has no host socket: a binder
 * from before remote control, an interactive `claude --resume`, or their
 * claude children. Starting the session again would run two claudes on it.
 */
export function sessionProcess(sessionId: string): string | undefined {
  let out = '';
  try {
    out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return undefined;
  }
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && Number(m[1]) !== process.pid && m[2].includes(sessionId)) return `pid ${m[1]}: ${m[2].slice(0, 120)}`;
  }
  return undefined;
}

// Opens a tab in the current iTerm window (or a new window) and runs the command.
const ITERM_SCRIPT = `
on run argv
  set cmd to item 1 of argv
  tell application "iTerm2"
    if (count of windows) is 0 then
      set w to (create window with default profile)
    else
      set w to current window
      tell w to create tab with default profile
    end if
    tell current session of w to write text cmd
  end tell
end run`;

/**
 * Starts binder on a session: a binder TUI in a new iTerm tab, or a host with
 * no UI. If iTerm cannot be driven (macOS asks once whether the gateway may
 * control iTerm; a refusal makes osascript fail), it falls back to a host.
 */
export function launch(kind: RemoteConfig['launcher'], dir: string, sessionId: string, resume: boolean, name?: string, log?: (line: string) => void): void {
  const args = [resume ? '--resume' : '--session-id', sessionId, ...(name && !resume ? ['--', '-n', oneLine(name).slice(0, 100)] : [])];
  if (kind === 'iterm') {
    const cmd = `cd ${shellQuote(dir)} && binder ${args.map(shellQuote).join(' ')}`;
    const osa = spawn('osascript', ['-e', ITERM_SCRIPT, cmd], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    osa.stderr.on('data', (d) => (err += d));
    osa.on('exit', (code) => {
      if (code === 0) return;
      log?.(`iTerm launch failed (${oneLine(err).slice(0, 160) || `exit ${code}`}); starting a host with no UI instead`);
      launch('headless', dir, sessionId, resume, name);
    });
    return;
  }
  const out = openSync(join(stateDir(), `host-${sessionId}.log`), 'a', 0o600);
  spawn(process.execPath, [BINDER_BIN, 'host', ...args], { cwd: dir, detached: true, stdio: ['ignore', out, out], env: process.env }).unref();
}

function notify(title: string, text: string): void {
  if (process.platform !== 'darwin') return;
  spawn('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, text], {
    stdio: 'ignore',
    detached: true,
  }).unref();
}

type Msg = Record<string, unknown> & { t?: string; id?: number };

class Client {
  private hs: Handshake | null = null;
  private sendCipher: CipherState | null = null;
  private opener: Opener | null = null;
  private device: Device | null = null;
  private host: { socket: Socket; sessionId: string } | null = null;
  private done = false;

  constructor(
    private readonly gw: Gateway,
    readonly conn: number,
  ) {}

  private get label(): string {
    return this.device ? this.device.name : `client ${this.conn}`;
  }

  data(payload: Buffer): void {
    if (this.done) return;
    try {
      if (!this.sendCipher) return this.handshake(payload);
      const text = this.opener!.open(payload);
      if (text !== null) void this.message(text);
    } catch (e) {
      this.gw.log(`${this.label} dropped: ${(e as Error).message}`);
      this.close();
    }
  }

  private handshake(payload: Buffer): void {
    const cfg = this.gw.config();
    if (!cfg) return this.close();
    this.hs = new Handshake({ initiator: false, s: cfg.keyPair });
    const hello = JSON.parse(this.hs.readMessage(payload).toString('utf8') || '{}');
    const rs = this.hs.remoteStatic!;
    const device = cfg.devices.find((d) => d.publicKey.equals(rs));
    if (!device) {
      this.gw.log(`refused a client that is not enrolled: ${fingerprint(rs)}`);
      return this.close();
    }
    if (hello.v !== 1) {
      this.gw.log(`refused ${device.name}: protocol version ${String(hello.v)}`);
      return this.close();
    }
    this.device = device;
    const reply = this.hs.writeMessage(Buffer.from('{"v":1}'));
    this.sendCipher = this.hs.send!;
    this.opener = new Opener(this.hs.receive!);
    this.gw.frame(this.conn, DATA, reply);
    if (cfg.paused) {
      this.gw.log(`refused ${device.name}: paused`);
      this.post({ t: 'closed', reason: 'Remote control is paused on the computer (binder remote unpause)' });
      return this.close();
    }
    this.gw.log(`${device.name} connected`);
    if (cfg.notify) notify('binder', `${device.name} connected for remote control`);
  }

  private post(msg: unknown): void {
    this.postText(JSON.stringify(msg));
  }

  private postText(text: string): void {
    if (this.done || !this.sendCipher) return;
    for (const chunk of seal(this.sendCipher, text)) this.gw.frame(this.conn, DATA, chunk);
  }

  private reply(id: number | undefined, result: unknown): void {
    if (id !== undefined) this.post({ t: 'reply', id, ok: true, result });
  }

  private fail(id: number | undefined, e: unknown): void {
    if (id !== undefined) this.post({ t: 'reply', id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }

  private audit(m: Msg): void {
    if (m.t === 'complete' || m.t === 'history' || m.t === 'models' || m.t === 'mcp_status' || m.t === 'rewind_targets' || m.t === 'artifacts') return;
    let detail = '';
    if (m.t === 'send' && typeof m.text === 'string') detail = ` "${oneLine(m.text).slice(0, 80)}"${typeof m.tabId === 'number' ? ` into tab ${m.tabId}` : ''}`;
    else if (m.t === 'attach' || m.t === 'resume') detail = ` ${String(m.sessionId ?? m.id)}`;
    else if (m.t === 'open') detail = ` ${String(m.cwd)}${m.sessionId ? ` ${String(m.sessionId)}` : ''}${m.resume ? ' (resume)' : ''}`;
    else if (m.t === 'cd') detail = ` ${String(m.path)}`;
    const where = this.host && m.t !== 'attach' && m.t !== 'open' ? ` [${this.host.sessionId.slice(0, 8)}]` : '';
    this.gw.log(`${this.label} ${String(m.t)}${detail}${where}`);
  }

  private async message(text: string): Promise<void> {
    let m: Msg;
    try {
      m = JSON.parse(text);
    } catch {
      return this.close();
    }
    const cfg = this.gw.config();
    // Revoking a client or pausing ends its connection at its next request.
    if (!cfg || cfg.paused || !cfg.devices.some((d) => d.publicKey.equals(this.device!.publicKey))) {
      this.post({ t: 'closed', reason: cfg?.paused ? 'Remote control is paused on the computer' : 'This client is no longer enrolled' });
      return this.close();
    }
    const id = typeof m.id === 'number' ? m.id : undefined;
    this.audit(m);
    try {
      switch (m.t) {
        case 'list':
          return this.reply(id, { sessions: await listSessions(cfg.roots), roots: cfg.roots });
        case 'attach':
          return await this.attach(id, m.sessionId, cfg);
        case 'open':
          return await this.open(id, m, cfg);
        case 'detach':
          this.detach();
          return this.reply(id, {});
        case 'hello':
          throw new Error('Unexpected hello');
        default:
          if (!this.host) throw new Error('Not attached to a session');
          // Re-serialized: one JSON line per request, whatever the client sent.
          this.host.socket.write(JSON.stringify(m) + '\n');
      }
    } catch (e) {
      this.fail(id, e);
    }
  }

  private attach(id: number | undefined, sessionId: unknown, cfg: RemoteConfig): Promise<void> {
    if (typeof sessionId !== 'string' || !UUID.test(sessionId)) throw new Error('Bad session id');
    if (!existsSync(socketPath(sessionId))) throw new Error('That session is not running');
    this.detach();
    return new Promise((done) => {
      const socket = connect(socketPath(sessionId));
      const host = { socket, sessionId };
      let first = true;
      const refuse = (error: string) => {
        first = false;
        this.fail(id, new Error(error));
        socket.destroy();
        done();
      };
      socket.on('error', () => {
        if (first) refuse('That session is not running');
      });
      const lines = createInterface({ input: socket, crlfDelay: Infinity });
      lines.on('error', () => {});
      lines.on('line', (line) => {
        if (first) {
          let m: { t?: string; error?: string } | null = null;
          try {
            m = JSON.parse(line);
          } catch {
            // not a host
          }
          if (!m || m.t === 'error') return refuse(m?.error ?? 'The session refused the connection');
          first = false;
          this.host = host;
          this.reply(id, { sessionId });
          done();
        }
        if (this.host === host) this.postText(line);
      });
      socket.on('close', () => {
        if (first) return refuse('That session is not running');
        if (this.host !== host) return;
        this.host = null;
        this.post({ t: 'detached', reason: 'The session ended' });
      });
      socket.write(JSON.stringify({ t: 'hello', want: 'attach', roots: cfg.roots }) + '\n');
    });
  }

  private async open(id: number | undefined, m: Msg, cfg: RemoteConfig): Promise<void> {
    if (typeof m.cwd !== 'string') throw new Error('cwd must be a string');
    const dir = resolve(expandHome(m.cwd));
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Not a directory: ${dir}`);
    if (!insideRoots(dir, cfg.roots)) throw new Error(`${dir} is outside the allowed folders`);
    const sessionId = m.sessionId === undefined ? randomUUID() : m.sessionId;
    if (typeof sessionId !== 'string' || !UUID.test(sessionId)) throw new Error('Bad session id');
    if (!(await hostInfo(sessionId))) {
      const other = sessionProcess(sessionId);
      if (other) throw new Error(`That session is open in another program on the Mac (${other}). Quit it there first.`);
      launch(cfg.launcher, dir, sessionId, m.resume === true, typeof m.name === 'string' ? m.name : undefined, (line) => this.gw.log(line));
      const deadline = Date.now() + START_TIMEOUT_MS;
      while (!(await hostInfo(sessionId, 1000))) {
        if (this.done) return;
        if (Date.now() > deadline) throw new Error(`The session did not start${cfg.launcher === 'headless' ? ` (see ${join(stateDir(), `host-${sessionId}.log`)})` : ''}`);
        await sleep(300);
      }
    }
    return this.attach(id, sessionId, cfg);
  }

  private detach(): void {
    const h = this.host;
    this.host = null;
    h?.socket.destroy();
  }

  /** We end it: tell the relay. */
  close(): void {
    if (this.done) return;
    this.gone();
    this.gw.frame(this.conn, CLOSE);
  }

  /** It ended (or the relay went away). */
  gone(): void {
    if (this.done) return;
    this.done = true;
    this.detach();
    this.gw.forget(this.conn);
    if (this.device) this.gw.log(`${this.device.name} disconnected`);
  }
}

export class Gateway {
  private cached: { mtime: number; cfg: RemoteConfig | null } | null = null;
  private ws: WebSocket | null = null;
  private clients = new Map<number, Client>();
  private backoff = 1000;
  private failing = false;
  private stopped = false;

  constructor(readonly path = configPath()) {}

  /** The current config, reloaded when the file changes; null (refuse everything) when it is invalid. */
  config(): RemoteConfig | null {
    let mtime = 0;
    try {
      mtime = statSync(this.path).mtimeMs;
    } catch {
      return null;
    }
    if (this.cached?.mtime !== mtime) {
      try {
        this.cached = { mtime, cfg: loadConfig(this.path) };
      } catch (e) {
        this.log(`config problem, refusing clients: ${(e as Error).message}`);
        this.cached = { mtime, cfg: null };
      }
    }
    return this.cached.cfg;
  }

  log(line: string): void {
    appendFileSync(logPathFor(this.path), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  }

  frame(conn: number, type: number, payload: Buffer = Buffer.alloc(0)): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const b = Buffer.alloc(5 + payload.length);
    b.writeUInt32BE(conn, 0);
    b[4] = type;
    payload.copy(b, 5);
    ws.send(b);
  }

  forget(conn: number): void {
    this.clients.delete(conn);
  }

  private onFrame(b: Buffer): void {
    if (b.length < 5) return;
    const conn = b.readUInt32BE(0);
    const type = b[4];
    if (type === OPEN) {
      if (this.clients.size >= MAX_CLIENTS) return this.frame(conn, CLOSE);
      this.clients.set(conn, new Client(this, conn));
    } else if (type === DATA) {
      this.clients.get(conn)?.data(b.subarray(5));
    } else if (type === CLOSE) {
      this.clients.get(conn)?.gone();
    }
  }

  connect(): void {
    if (this.stopped) return;
    const cfg = this.config();
    if (!cfg) {
      setTimeout(() => this.connect(), 30000);
      return;
    }
    const ws = new WebSocket(cfg.relayUrl, {
      headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {},
      maxPayload: 1 << 20,
      handshakeTimeout: 15000,
    });
    this.ws = ws;
    let alive = true;
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, PING_MS);
    ws.on('pong', () => (alive = true));
    ws.on('open', () => {
      this.backoff = 1000;
      this.failing = false;
      this.log('relay connected');
    });
    ws.on('message', (data, isBinary) => {
      alive = true;
      if (isBinary) this.onFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
    });
    ws.on('error', (e) => {
      if (!this.failing) this.log(`relay connection failed: ${e.message}; retrying`);
      this.failing = true;
    });
    ws.on('close', () => {
      clearInterval(ping);
      if (this.ws === ws) this.ws = null;
      for (const c of [...this.clients.values()]) c.gone();
      this.clients.clear();
      if (this.stopped) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
    });
  }

  stop(): void {
    this.stopped = true;
    for (const c of [...this.clients.values()]) c.gone();
    this.ws?.close();
  }
}

export function serve(): void {
  const gw = new Gateway();
  const cfg = gw.config();
  if (!cfg) {
    process.stderr.write(`binder serve: fix ${gw.path} first (see binder remote status)\n`);
    process.exit(1);
  }
  gw.log(`gateway started (pid ${process.pid}, ${cfg.devices.length} client(s) enrolled)`);
  gw.connect();
  const stop = () => {
    gw.log('gateway stopped');
    gw.stop();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
