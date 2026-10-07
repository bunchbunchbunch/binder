import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

// One `codex app-server`: JSON-RPC 2.0 over stdio, one message per line,
// without the "jsonrpc" field. Requests go both ways: binder's (initialize,
// turn/start, ...) get responses, and the server's (approvals) wait for ours.

export type RpcId = number | string;
export type Params = Record<string, unknown>;
export type ServerRequest = { id: RpcId; method: string; params: Params };

type RpcEvents = {
  notification: [{ method: string; params: Params }];
  request: [ServerRequest];
  // Every line in either direction, for recordings.
  line: ['in' | 'out', string];
  stderr: [string];
  exit: [{ code: number | null; signal: NodeJS.Signals | null }];
  error: [Error];
};

export type RpcOptions = {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stderrPath?: string;
};

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

type Pending = { method: string; resolve: (r: Params) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class CodexRpc extends EventEmitter<RpcEvents> {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stderrLog: WriteStream | null = null;
  private nextId = 1;
  private pending = new Map<RpcId, Pending>();
  readonly recentStderr: string[] = [];
  exited = false;

  constructor(private readonly opts: RpcOptions) {
    super();
  }

  start(): void {
    if (this.opts.stderrPath) {
      mkdirSync(dirname(this.opts.stderrPath), { recursive: true });
      this.stderrLog = createWriteStream(this.opts.stderrPath, { flags: 'a' });
    }
    const child = spawn(this.opts.bin, this.opts.args, { cwd: this.opts.cwd, env: this.opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    // A write after the child died is reported by its exit, not as a crash.
    child.stdin.on('error', () => {});

    createInterface({ input: child.stdout }).on('line', (line) => {
      this.emit('line', 'in', line);
      let m: { id?: RpcId; method?: string; params?: Params; result?: Params; error?: { code: number; message: string } };
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (!m || typeof m !== 'object') return;
      if (m.method !== undefined && m.id !== undefined) this.emit('request', { id: m.id, method: m.method, params: m.params ?? {} });
      else if (m.method !== undefined) this.emit('notification', { method: m.method, params: m.params ?? {} });
      else if (m.id !== undefined) this.settle(m.id, m.result, m.error);
    });

    createInterface({ input: child.stderr }).on('line', (line) => {
      this.stderrLog?.write(line + '\n');
      this.recentStderr.push(line);
      if (this.recentStderr.length > 20) this.recentStderr.shift();
      this.emit('stderr', line);
    });

    child.on('error', (e) => this.emit('error', e));
    child.on('exit', (code, signal) => {
      this.exited = true;
      this.stderrLog?.end();
      for (const [id, p] of this.pending) this.settle(id, undefined, { code: -32000, message: `codex exited before answering ${p.method}` });
      this.emit('exit', { code, signal });
    });
  }

  private settle(id: RpcId, result: Params | undefined, error: { code: number; message: string } | undefined): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (error) p.reject(new RpcError(error.code, error.message));
    else p.resolve(result ?? {});
  }

  private write(message: object): void {
    if (!this.child || this.exited) return;
    const line = JSON.stringify(message);
    this.emit('line', 'out', line);
    this.child.stdin.write(line + '\n');
  }

  request(method: string, params: Params = {}, timeoutMs = 20000): Promise<Params> {
    if (!this.child || this.exited) return Promise.reject(new Error('codex is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer from codex`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: Params): void {
    this.write(params ? { method, params } : { method });
  }

  respond(id: RpcId, result: object): void {
    this.write({ id, result });
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  // Closes stdin so the server exits; SIGTERM after a grace period.
  async close(graceMs = 3000): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.stdin.end();
    const timer = setTimeout(() => {
      if (!this.exited) child.kill('SIGTERM');
    }, graceMs);
    await exited;
    clearTimeout(timer);
  }

  kill(): void {
    if (this.child && !this.exited) this.child.kill('SIGKILL');
  }
}
