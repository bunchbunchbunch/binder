import type { ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { HostMessage } from '../shared/wire';

type Pending = { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void };

/** The line to a host: its unix socket here, or `binder attach` over ssh. `onClose` may say why it closed. */
export type HostStream = { input: Readable; write(text: string): void; end(): void; onClose(cb: (why: string | null) => void): void };

export function socketStream(path: string): HostStream {
  const socket = connect(path);
  socket.on('error', () => {});
  return { input: socket, write: (t) => socket.write(t), end: () => socket.destroy(), onClose: (cb) => socket.on('close', () => cb(null)) };
}

/** A child whose stdin and stdout are the host's socket; the last line of its errors is why it closed. */
export function processStream(child: ChildProcess): HostStream {
  let err = '';
  child.stderr?.on('data', (d) => (err += d));
  child.stdin!.on('error', () => {});
  child.on('error', (e) => (err += `\n${e.message}`));
  return {
    input: child.stdout!,
    write: (t) => child.stdin!.write(t),
    end: () => child.kill(),
    onClose: (cb) => child.on('close', () => cb(err.trim().split('\n').pop()?.trim() || null)),
  };
}

/**
 * One attached viewer on a session host's socket: JSON lines, a hello,
 * then a snapshot and patches (docs/remote-protocol.md). Replies to requests
 * are matched here; everything else goes to `onMessage`.
 */
export class HostConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  // We closed it (the window let the session go), so nobody needs telling.
  private dropped = false;

  constructor(
    private readonly stream: HostStream,
    private readonly onMessage: (msg: HostMessage) => void,
    private readonly onClose: (reason: string) => void,
  ) {}

  /** Sends the hello; resolves at the snapshot, rejects if the host refuses or goes away. */
  attach(): Promise<void> {
    return new Promise((done, fail) => {
      let attached = false;
      const lines = createInterface({ input: this.stream.input, crlfDelay: Infinity });
      lines.on('error', () => {});
      lines.on('line', (line) => {
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(line);
        } catch {
          return;
        }
        if (!attached) {
          if (m.t === 'error') return fail(new Error(String(m.error ?? 'The session refused the connection')));
          attached = true;
          done();
        }
        if (m.t === 'reply') return this.reply(m);
        this.onMessage(m as HostMessage);
      });
      this.stream.onClose((why) => {
        this.closed = true;
        for (const p of this.pending.values()) p.reject(new Error('The session ended'));
        this.pending.clear();
        if (!attached) fail(new Error(why ?? 'The session is not running'));
        else if (!this.dropped) this.onClose(why ? `The session ended (${why})` : 'The session ended');
      });
      this.stream.write(JSON.stringify({ t: 'hello', want: 'attach' }) + '\n');
    });
  }

  private reply(m: Record<string, unknown>): void {
    const p = this.pending.get(Number(m.id));
    if (!p) return;
    this.pending.delete(Number(m.id));
    if (m.ok) p.resolve((m.result as Record<string, unknown>) ?? {});
    else p.reject(new Error(String(m.error ?? 'failed')));
  }

  request(t: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('The session ended'));
    const id = this.nextId++;
    this.stream.write(JSON.stringify({ ...fields, t, id }) + '\n');
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close(): void {
    this.dropped = true;
    this.stream.end();
  }
}
