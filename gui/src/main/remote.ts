import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionList, SessionRow, SidebarScriptInput } from '../shared/api';

// Another computer's sessions, over SSH: config.json's `computers`, each an
// SSH destination (a Host in ~/.ssh/config, say). That computer's own binder
// does the work: `binder sessions` lists, `binder start` makes sure a host
// serves a session, and `binder attach` pipes the host's socket, which speaks
// the same protocol as a host here (bindertui's src/remote/start.ts).

export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sh = (args: string[]) => args.map(shellQuote).join(' ');

const MARK = '__binder_remote__';
const SCRIPT_TIMEOUT_MS = 5000;

// How to run binder there, found once through its login shell, as binder.ts does here.
type Found = { home: string; path: string; command: string[] };

export class Remote {
  private found: Promise<Found> | null = null;

  constructor(
    readonly name: string,
    // ssh, or a stand-in for tests (BINDER_SSH).
    private readonly ssh: string,
    // Where ssh keeps the shared connection's socket.
    private readonly controlDir: string,
  ) {}

  /** ssh's arguments to run `command` there: never ask for a password, give up on a dead link, and share one connection. */
  sshArgs(command: string): string[] {
    mkdirSync(this.controlDir, { recursive: true, mode: 0o700 });
    const opts = ['BatchMode=yes', 'ConnectTimeout=5', 'ServerAliveInterval=15', 'ServerAliveCountMax=2', 'ControlMaster=auto', `ControlPath=${join(this.controlDir, '%C')}`, 'ControlPersist=60'];
    return [...opts.flatMap((o) => ['-o', o]), this.name, command];
  }

  /** Runs `command` there; resolves with what it printed, rejects with the last line of its errors. */
  private exec(command: string, { input, timeout = 30000 }: { input?: string; timeout?: number } = {}): Promise<string> {
    return new Promise((done, fail) => {
      // A startup file may read stdin, so it is closed unless there is input.
      const child = spawn(this.ssh, this.sshArgs(command), { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout!.on('data', (d) => (out += d));
      child.stderr!.on('data', (d) => (err += d));
      const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
      child.on('error', (e) => {
        clearTimeout(timer);
        fail(new Error(`${this.name}: ${e.message}`));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) return done(out);
        const why = err.trim().split('\n').pop()?.trim();
        fail(new Error(`${this.name}: ${why || (signal ? 'timed out' : `exit ${code}`)}`));
      });
      if (input !== undefined) {
        child.stdin!.on('error', () => {});
        child.stdin!.end(input);
      }
    });
  }

  private locate(): Promise<Found> {
    if (!this.found) {
      // Node's own folder goes first on PATH, as binder.ts puts it here; binder is
      // on that PATH, or BINDER_BIN names it. The login shell (zsh, bash, fish...)
      // only supplies the environment; sh reads it.
      const probe = [
        `printf ${MARK}; printf %s "$HOME"; printf ${MARK}`,
        'n=$(node -p process.execPath) || exit 1',
        'export PATH="${n%/*}:$PATH"',
        `printf %s "$PATH"; printf ${MARK}; printf %s "$n"; printf ${MARK}`,
        `if [ -n "$BINDER_BIN" ]; then printf %s "$BINDER_BIN"; else command -v binder; fi; printf ${MARK}`,
      ].join('\n');
      this.found = this.exec(`exec "$SHELL" -l -i -c ${shellQuote(`exec /bin/sh -c ${shellQuote(probe)}`)}`, { timeout: 20000 }).then((out) => {
        const [, home, path, node, bin] = out.split(MARK).map((s) => s.trim());
        if (!node) throw new Error(`${this.name}: node is not on the login shell's PATH`);
        if (!bin) throw new Error(`${this.name}: binder is not on the login shell's PATH (npm link in its bindertui)`);
        return { home, path, command: [node, bin] };
      });
      this.found.catch(() => (this.found = null));
    }
    return this.found;
  }

  /** A command there with binder's PATH, from a `sh` that skips the login shell. */
  private async withPath(command: string): Promise<string> {
    return `export PATH=${shellQuote((await this.locate()).path)}; ${command}`;
  }

  async sessions(): Promise<SessionList> {
    const { home, command } = await this.locate();
    const rows: SessionRow[] = JSON.parse(await this.exec(await this.withPath(`exec ${sh([...command, 'sessions'])}`)));
    return { sessions: rows.map((r) => ({ ...r, computer: this.name })), home };
  }

  /**
   * Makes sure a host serves the session there. `binder start` runs in the
   * login shell, so the host gets the environment a terminal would have.
   */
  async start(cwd: string, sessionId: string, resume: boolean, claudeArgs: string[] = []): Promise<void> {
    const { command } = await this.locate();
    const start = [...command, 'start', '--cwd', cwd, resume ? '--resume' : '--session-id', sessionId, ...(claudeArgs.length ? ['--', ...claudeArgs] : [])];
    await this.exec(`exec "$SHELL" -l -i -c ${shellQuote(`exec ${sh(start)}`)}`, { timeout: 45000 });
  }

  /** ssh running `binder attach`: its stdin and stdout are the host's socket. */
  async attach(sessionId: string): Promise<ChildProcess> {
    const { command } = await this.locate();
    return spawn(this.ssh, this.sshArgs(`exec ${sh([...command, 'attach', sessionId])}`), { stdio: ['pipe', 'pipe', 'pipe'] });
  }

  /** `path` (maybe ~/...) is a folder there; false when it is not, or the computer cannot say. */
  async isDirectory(path: string): Promise<boolean> {
    try {
      const { home } = await this.locate();
      await this.exec(`test -d ${shellQuote(path.replace(/^~(?=$|\/)/, home))}`);
      return true;
    } catch {
      return false;
    }
  }

  async repoInfo(cwd: string): Promise<{ worktrees: string[]; branch: string | null }> {
    try {
      const out = await this.exec(await this.withPath(`cd ${shellQuote(cwd)} || exit 1; git worktree list --porcelain 2>/dev/null; printf ${MARK}; git branch --show-current 2>/dev/null`));
      const [list, branch] = out.split(MARK);
      const worktrees = list
        .split('\n')
        .filter((l) => l.startsWith('worktree '))
        .map((l) => l.slice('worktree '.length));
      return { worktrees: worktrees.length ? worktrees : [cwd], branch: branch.trim() || null };
    } catch {
      return { worktrees: [cwd], branch: null };
    }
  }

  /** config.json's sidebar.script for a session there, run there (the files it reads are there), as binder.ts runs it here. */
  async sidebarScript(command: string, input: SidebarScriptInput): Promise<string> {
    try {
      const out = await this.exec(await this.withPath(`cd ${shellQuote(input.cwd)} 2>/dev/null; exec sh -c ${shellQuote(command)}`), { input: JSON.stringify(input), timeout: SCRIPT_TIMEOUT_MS });
      return (out.replace(/\x1b\[[0-9;]*m/g, '').split('\n').find((l) => l.trim()) ?? '').trim();
    } catch {
      return '';
    }
  }
}
