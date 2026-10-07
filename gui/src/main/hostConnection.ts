import { connect, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import type { HostMessage } from '../shared/wire';

type Pending = { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void };

/**
 * One attached viewer on a session host's unix socket: JSON lines, a hello,
 * then a snapshot and patches (docs/remote-protocol.md). Replies to requests
 * are matched here; everything else goes to `onMessage`.
 */
export class HostConnection {
  private socket: Socket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  // We closed it (the window let the session go), so nobody needs telling.
  private dropped = false;

  constructor(
    path: string,
    private readonly onMessage: (msg: HostMessage) => void,
    private readonly onClose: (reason: string) => void,
  ) {
    this.socket = connect(path);
  }

  /** Sends the hello; resolves at the snapshot, rejects if the host refuses or goes away. */
  attach(): Promise<void> {
    return new Promise((done, fail) => {
      let attached = false;
      this.socket.on('error', () => {});
      const lines = createInterface({ input: this.socket, crlfDelay: Infinity });
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
      this.socket.on('close', () => {
        this.closed = true;
        for (const p of this.pending.values()) p.reject(new Error('The session ended'));
        this.pending.clear();
        if (!attached) fail(new Error('The session is not running'));
        else if (!this.dropped) this.onClose('The session ended');
      });
      this.socket.write(JSON.stringify({ t: 'hello', want: 'attach' }) + '\n');
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
    this.socket.write(JSON.stringify({ ...fields, t, id }) + '\n');
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close(): void {
    this.dropped = true;
    this.socket.destroy();
  }
}
