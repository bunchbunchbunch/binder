import { connect } from 'node:net';
import { onLines } from '../lines.js';
import { socketPath } from './sockets.js';

/** One request to a session's host over its socket (docs/remote-protocol.md): attach, ask, let go. */
export function hostRequest(sessionId: string, t: string, fields: Record<string, unknown> = {}, timeoutMs = 30000): Promise<Record<string, unknown>> {
  return new Promise((done, fail) => {
    const s = connect(socketPath(sessionId));
    let settled = false;
    const finish = (err: Error | null, result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      s.destroy();
      if (err) fail(err);
      else done(result ?? {});
    };
    const timer = setTimeout(() => finish(new Error(`${t}: the session did not answer`)), timeoutMs);
    s.on('error', (e) => finish(new Error(`The session is not running (${e.message})`)));
    s.on('close', () => finish(new Error('The session ended')));
    let attached = false;
    onLines(s, (line) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (!attached) {
        if (m.t === 'error') return finish(new Error(String(m.error)));
        // The snapshot: now ask.
        attached = true;
        s.write(JSON.stringify({ ...fields, t, id: 1 }) + '\n');
        return;
      }
      if (m.t === 'reply' && m.id === 1) finish(m.ok ? null : new Error(String(m.error ?? 'failed')), (m.result as Record<string, unknown>) ?? {});
    });
    s.write(JSON.stringify({ t: 'hello', want: 'attach' }) + '\n');
  });
}
