import React from 'react';
import { render } from 'ink';
import { App } from './ui/App.js';
import { RENDER_OPTIONS } from './renderOptions.js';
import { filterInput, keypadToText } from './keypad.js';
import { MOUSE_OFF, MOUSE_ON, takeMouse } from './mouse.js';
import { Session } from './session.js';
import { SessionHost } from './host.js';
import { HostServer } from './remote/hostServer.js';
import { liveElsewhere } from './remote/sockets.js';
import { upsertSession } from './sessions.js';
import { childEnv, configDir } from './paths.js';
import { readStatusLineCommand } from './statusline.js';
import { USAGE, initialStateFor, parseArgs } from './args.js';
import { stampFrames } from './ui/lineAttrs.js';
import { MARKDOWN_STYLES, setMarkdownStyle } from './ui/md/theme.js';

export { parseArgs };

export function main(argv = process.argv.slice(2)): void {
  const cwd = process.cwd();
  const parsed = parseArgs(argv, cwd);
  if ('error' in parsed) {
    process.stderr.write(parsed.error.endsWith('\n') ? parsed.error : parsed.error + '\n');
    process.exit(parsed.error === USAGE ? 0 : 1);
  }
  const { sessionId, resume, draft, forkFrom, passthrough } = parsed;
  const other = liveElsewhere(sessionId);
  if (other) {
    process.stderr.write(`Session ${sessionId} is already open in another binder (pid ${other}).\n`);
    process.exit(1);
  }
  const cfg = configDir(childEnv(cwd));
  const initial = initialStateFor(parsed, cwd, cfg);

  const session = new Session({ sessionId, resume, cwd, passthrough, forkFrom });
  const host = new SessionHost(session, initial, cwd, cfg);
  // Remote viewers attach through this socket; without it binder still works locally.
  const server = new HostServer(host);
  upsertSession({ id: sessionId, cwd, configDir: cfg });
  session.start();
  server.listen().catch(() => {});

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close();
    void host.close().finally(() => {
      process.stdout.write(`\nResume with: binder ${sessionId}\n`);
      process.exit(0);
    });
  };

  // Ink sends the kitty keyboard query (see renderOptions.ts) before its input
  // hooks turn on raw mode, and the terminal's reply would be echoed onto the
  // screen. In raw mode it waits unechoed until Ink reads it.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  if (process.stdout.isTTY) stampFrames(process.stdout);
  // Responses render vivid unless BINDER_MD=classic; /md switches while running.
  setMarkdownStyle(MARKDOWN_STYLES.find((s) => s === process.env.BINDER_MD) ?? 'vivid');
  const app = render(
    <App host={host} configDir={cfg} statusLineCommand={readStatusLineCommand(cfg)} draft={draft} onQuit={shutdown} />,
    { ...RENDER_OPTIONS, stdin: filterInput(process.stdin, (chunk) => takeMouse(keypadToText(chunk))) },
  );
  // The wheel scrolls the tab (see mouse.ts). Turned off on any exit, or the
  // shell would get mouse reports.
  if (process.stdout.isTTY) {
    process.stdout.write(MOUSE_ON);
    process.on('exit', () => process.stdout.write(MOUSE_OFF));
  }
  app.waitUntilExit().then(shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
}
