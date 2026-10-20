import { chmodSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { createInterface } from 'node:readline';
import type { ControlReply, ControlRequest } from '../shared/api';

// The control socket: other programs (a pane's program, a script a session
// runs) ask the app to open or close a session. One JSON line in, one reply
// line out. The panes and the session hosts the app starts find it in
// BINDER_GUI_SOCKET.

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The only passthrough a caller may set is the session name (-n). The socket is
// inherited by every program the app starts (a pane, a session's Bash tool), so
// without this a prompt-injected command could open a session with
// --dangerously-skip-permissions or --permission-mode bypassPermissions.
const safeArgs = (args: string[]): boolean => args.length === 0 || (args.length === 2 && args[0] === '-n' && !args[1].startsWith('-'));

/** A request as the window takes it, or what is wrong with it. */
export function parseControl(line: string): ControlRequest | string {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(line);
  } catch {
    return 'Not JSON';
  }
  if (m?.t === 'open') {
    if (typeof m.cwd !== 'string' || !m.cwd) return 'open needs cwd';
    if (m.sessionId !== undefined && (typeof m.sessionId !== 'string' || !UUID.test(m.sessionId))) return 'sessionId must be a UUID';
    if (m.draft !== undefined && typeof m.draft !== 'string') return 'draft must be a string';
    if (m.args !== undefined && !strings(m.args)) return 'args must be strings';
    if (m.args !== undefined && !safeArgs(m.args as string[])) return 'args may only set the session name (-n <name>)';
    return { t: 'open', cwd: m.cwd, sessionId: m.sessionId, resume: m.resume === true, draft: m.draft, args: m.args };
  }
  if (m?.t === 'close') {
    if (typeof m.sessionId !== 'string') return 'close needs sessionId';
    if (m.show !== undefined && typeof m.show !== 'string') return 'show must be a string';
    return { t: 'close', sessionId: m.sessionId, show: m.show };
  }
  return 'Unknown request; send open or close';
}

export function listenControl(path: string, handle: (req: ControlRequest) => Promise<ControlReply>): Server {
  // A socket left by an app that did not quit cleanly.
  rmSync(path, { force: true });
  // Half-open: a client may close its side once it has sent the line, as
  // `printf ... | nc -U` does, and still get the reply.
  const server = createServer({ allowHalfOpen: true }, (s) => {
    s.on('error', () => {});
    const reply = (r: ControlReply) => s.end(JSON.stringify(r) + '\n');
    const lines = createInterface({ input: s });
    lines.on('error', () => {});
    lines.once('line', (line) => {
      const req = parseControl(line);
      if (typeof req === 'string') return reply({ ok: false, error: req });
      handle(req).then(reply, (e: Error) => reply({ ok: false, error: e.message }));
    });
  });
  server.listen(path, () => chmodSync(path, 0o600));
  return server;
}
