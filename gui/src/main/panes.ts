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
    running.delete(pane.name);
    emit({ t: 'exit', code: exitCode });
  });
  return '';
}

export function paneInput(name: string, data: string): void {
  running.get(name)?.pty.write(data);
}

export function resizePane(name: string, cols: number, rows: number): void {
  running.get(name)?.pty.resize(cols, rows);
}

/** At quit: the programs get the hangup a closed terminal sends. */
export function stopPanes(): void {
  for (const p of running.values()) p.pty.kill('SIGHUP');
  running.clear();
}
