import { SessionHost } from '../host.js';
import { upsertSession } from '../sessions.js';
import { configDir } from '../paths.js';
import { USAGE, initialStateFor, launchConfigDir, parseArgs, sessionFor } from '../args.js';
import { HostServer } from './hostServer.js';
import { liveElsewhere } from './sockets.js';
import { expandHome, remoteCommand } from './config.js';
import { listSessions, serve } from './serve.js';
import { binderConfig } from '../config.js';

// Entry for the commands that need no terminal UI: `binder host`, `binder
// serve`, `binder sessions`, `binder remote ...` (bin/binder.mjs routes them here).

// A host nobody watches and that has nothing to do exits after this long.
const IDLE_MS = Number(process.env.BINDER_HOST_IDLE_MS ?? 15 * 60 * 1000);

async function hostMain(argv: string[]): Promise<void> {
  const cwd = process.cwd();
  const parsed = parseArgs(argv, cwd);
  if ('error' in parsed) {
    process.stderr.write(parsed.error.endsWith('\n') ? parsed.error : parsed.error + '\n');
    process.exit(parsed.error === USAGE ? 0 : 1);
  }
  const other = liveElsewhere(parsed.sessionId);
  if (other) {
    process.stderr.write(`Session ${parsed.sessionId} is already open in another binder (pid ${other}).\n`);
    process.exit(1);
  }
  const cfg = launchConfigDir(parsed, cwd);
  const session = sessionFor(parsed, cwd);
  const host = new SessionHost(session, initialStateFor(parsed, cwd, cfg), cwd, cfg);
  const server = new HostServer(host);
  upsertSession({ id: parsed.sessionId, cwd, configDir: cfg, agent: session.agent });
  session.start();
  await server.listen();
  process.stdout.write(`${new Date().toISOString()} hosting ${parsed.sessionId} in ${cwd} (pid ${process.pid})\n`);

  let closing = false;
  const shutdown = (why: string) => {
    if (closing) return;
    closing = true;
    process.stdout.write(`${new Date().toISOString()} stopping: ${why}\n`);
    server.close();
    void host.close().finally(() => process.exit(0));
  };
  let idleSince = Date.now();
  setInterval(() => {
    if (server.viewerCount || host.busy || host.state.question) idleSince = Date.now();
    else if (Date.now() - idleSince > IDLE_MS) shutdown('idle');
  }, Math.min(60000, IDLE_MS)).unref();
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// `binder sessions`: the sessions /resume would offer, from every config dir
// binder knows (configDirs too), live ones first, as JSON for the Mac app.
async function sessionsMain(): Promise<void> {
  const dirs = [configDir(), ...Object.values(binderConfig().configDirs ?? {}).map(expandHome)];
  const rows = await listSessions(undefined, { configDirs: [...new Set(dirs)], interactiveOnly: true });
  process.stdout.write(JSON.stringify(rows) + '\n');
}

export async function remoteMain(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'host') return await hostMain(rest);
    if (cmd === 'serve') return serve();
    if (cmd === 'sessions') return await sessionsMain();
    if (cmd === 'remote') return remoteCommand(rest);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  }
}
