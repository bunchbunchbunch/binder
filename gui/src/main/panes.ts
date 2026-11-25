import { homedir } from 'node:os';
import { spawn, type IPty } from 'node-pty';
import type { PaneEvent } from '../shared/api';
import type { PaneConfig } from './binder';

// Panes: programs from config.json's `panes`, each in a pty that the window
// shows in a terminal. One runs per pane while the app does (it starts again
// when the window asks after it exits), and it outlives a window reload.

// What a pane has printed, for a reloaded window to show again.
const KEEP = 256 * 1024;

const running = new Map<string, { pty: IPty; output: string }>();
// Programs told to end that may not have yet.
const ending = new Set<Promise<void>>();

// How long a program has after each signal before the next, stronger one.
const GRACE_MS = 1000;

/** Sends `sig` to `pid` (a process group when negative); false when nothing is there. */
function signal(pid: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ends a pane's program, or with `group` everything in its process group (a
 * dev server's own children): the hangup a closed terminal sends, then
 * SIGTERM and SIGKILL for one that ignores it.
 */
function end(pty: IPty, group: boolean): void {
  const pid = group && signal(-pty.pid, 0) ? -pty.pid : pty.pid;
  const done = (async () => {
    for (const sig of ['SIGHUP', 'SIGTERM', 'SIGKILL'] as const) {
      if (!signal(pid, sig)) return;
      for (let waited = 0; waited < GRACE_MS; waited += 50) {
        await new Promise((r) => setTimeout(r, 50));
        if (!signal(pid, 0)) return;
      }
    }
  })();
  ending.add(done);
  void done.finally(() => ending.delete(done));
}

/**
 * Starts the pane's program at `cols` x `rows` unless it runs, and returns
 * what it has printed so far. A running program is made to redraw, since the
 * window asking again has lost its screen.
 */
export function startPane(pane: PaneConfig, env: NodeJS.ProcessEnv, cols: number, rows: number, emit: (e: PaneEvent) => void): string {
  const p = running.get(pane.name);
  if (p) {
    // A size change is what makes a full-screen program draw everything again.
    p.pty.resize(cols, Math.max(1, rows - 1));
    p.pty.resize(cols, rows);
    return p.output;
  }
  const pty = spawn(env.SHELL || '/bin/zsh', ['-c', pane.command], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: (pane.cwd ?? '~').replace(/^~(?=$|\/)/, homedir()),
    env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Binder' },
  });
  const entry = { pty, output: '' };
  running.set(pane.name, entry);
  pty.onData((data) => {
    entry.output = (entry.output + data).slice(-KEEP);
    emit({ t: 'data', data });
  });
  pty.onExit(({ exitCode }) => {
    // Stopped, or another runs under its name now (/preview <command> again): its exit is not the pane's.
    if (running.get(pane.name) !== entry) return;
    running.delete(pane.name);
    emit({ t: 'exit', code: exitCode });
  });
  return '';
}

/** Ends one pane's program (a session's terminal, when the session closes). */
export function stopPane(name: string): void {
  const p = running.get(name);
  if (!p) return;
  running.delete(name);
  end(p.pty, false);
}

/** Ends a pane's program and everything it started (a dev server's own children), by its process group. */
export function stopPaneGroup(name: string): void {
  const p = running.get(name);
  if (!p) return;
  running.delete(name);
  end(p.pty, true);
}

export function paneInput(name: string, data: string): void {
  running.get(name)?.pty.write(data);
}

export function resizePane(name: string, cols: number, rows: number): void {
  running.get(name)?.pty.resize(cols, rows);
}

/**
 * At quit: the programs get the hangup a closed terminal sends. Resolves once
 * they, and any stopped before, have ended; null when none is left.
 */
export function stopPanes(): Promise<void> | null {
  for (const p of running.values()) end(p.pty, false);
  running.clear();
  return ending.size ? Promise.all(ending).then(() => {}) : null;
}
