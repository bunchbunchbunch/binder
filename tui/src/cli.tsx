import React from 'react';
import { render } from 'ink';
import { App } from './ui/App.js';
import { RENDER_OPTIONS } from './renderOptions.js';
import { filterInput, keypadToText } from './keypad.js';
import { MOUSE_OFF, MOUSE_ON, takeMouse } from './mouse.js';
import { FOCUS_OFF, FOCUS_ON, takeFocus } from './attention.js';
import { setShowImages } from './ui/images.js';
import { SessionHost } from './host.js';
import { HostServer } from './remote/hostServer.js';
import { liveElsewhere } from './remote/sockets.js';
import { upsertSession } from './sessions.js';
import { binderConfig } from './config.js';
import { readStatusLineCommand } from './statusline.js';
import { USAGE, initialStateFor, launchConfigDir, parseArgs, sessionFor, enterWorktree } from './args.js';
import { stampFrames } from './ui/lineAttrs.js';
import { MARKDOWN_STYLES, setMarkdownStyle } from './ui/md/theme.js';

export { parseArgs };

export function main(argv = process.argv.slice(2)): void {
  let parsed: ReturnType<typeof parseArgs>;
  // A config.json that does not parse: say which and why in one line, and leave it as it is.
  try {
    parsed = parseArgs(argv, process.cwd());
    if (!('error' in parsed)) binderConfig();
  } catch (e) {
    process.stderr.write(`binder: ${(e as Error).message}\n`);
    process.exit(1);
  }
  if ('error' in parsed) {
    process.stderr.write(parsed.error.endsWith('\n') ? parsed.error : parsed.error + '\n');
    process.exit(parsed.error === USAGE ? 0 : 1);
  }
  let cwd: string;
  try {
    cwd = enterWorktree(parsed, process.cwd());
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  }
  const { sessionId, draft } = parsed;
  const other = liveElsewhere(sessionId);
  if (other) {
    process.stderr.write(`Session ${sessionId} is already open in another binder (pid ${other}).\n`);
    process.exit(1);
  }
  const cfg = launchConfigDir(parsed, cwd);
  const initial = initialStateFor(parsed, cwd, cfg);

  const session = sessionFor(parsed, cwd);
  const host = new SessionHost(session, initial, cwd, cfg);
  // Remote viewers attach through this socket; without it binder still works locally.
  const server = new HostServer(host);
  upsertSession({ id: sessionId, cwd, configDir: cfg, agent: session.agent });
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
  // Responses render vivid unless BINDER_MD or config.json's markdownStyle says
  // classic; /md switches while running.
  const style = (s?: string) => MARKDOWN_STYLES.find((m) => m === s);
  setMarkdownStyle(style(process.env.BINDER_MD) ?? style(binderConfig().markdownStyle) ?? 'vivid');
  setShowImages(binderConfig().showImages !== false);
  const app = render(
    <App host={host} configDir={cfg} statusLineCommand={readStatusLineCommand(cfg)} draft={draft} stickyPrompt={binderConfig().stickyPrompt !== false} statusText={binderConfig().statusText} bell={binderConfig().bell !== false} todoPanel={binderConfig().todoPanel !== false} onQuit={shutdown} />,
    { ...RENDER_OPTIONS, stdin: filterInput(process.stdin, (chunk) => takeFocus(takeMouse(keypadToText(chunk)))) },
  );
  // The wheel scrolls the tab (see mouse.ts), and focus reports say when to
  // ring the bell (attention.ts). Turned off on any exit, or the shell would
  // get the reports.
  if (process.stdout.isTTY) {
    process.stdout.write(MOUSE_ON + FOCUS_ON);
    process.on('exit', () => process.stdout.write(MOUSE_OFF + FOCUS_OFF));
  }
  app.waitUntilExit().then(shutdown);
  // Scheduled tasks run while binder is open (schedule.ts; the Mac app ticks too).
  const ticker = setInterval(() => void import('./schedule.js').then((m) => m.tick()).catch(() => {}), 60_000);
  ticker.unref();
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
}
