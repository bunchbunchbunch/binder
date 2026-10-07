import { spawn, type ChildProcess } from 'node:child_process';

// Bash mode (`!command`): binder runs the command itself in the session's
// directory, like Claude Code does, and the output goes to the model with the
// next prompt.

const MAX_OUTPUT = 30000;

export type BashRun = { child: ChildProcess; kill: () => void; done: Promise<{ output: string; exitCode: number | null }> };

export function runBash(command: string, cwd: string): BashRun {
  // Its own process group, so Esc stops the whole pipeline, not just the shell.
  const child = spawn(process.env.SHELL || '/bin/bash', ['-c', command], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let output = '';
  let truncated = false;
  const take = (d: Buffer) => {
    if (output.length < MAX_OUTPUT) output += d.toString('utf8');
    else truncated = true;
  };
  child.stdout?.on('data', take);
  child.stderr?.on('data', take);
  const done = new Promise<{ output: string; exitCode: number | null }>((resolve) => {
    child.on('error', (e) => resolve({ output: String(e.message), exitCode: 127 }));
    child.on('close', (code, signal) => {
      const text = output.length > MAX_OUTPUT ? output.slice(0, MAX_OUTPUT) : output;
      resolve({ output: text + (truncated ? '\n… output truncated' : ''), exitCode: signal ? null : (code ?? 0) });
    });
  });
  const kill = () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGINT');
    } catch {
      child.kill('SIGINT');
    }
  };
  return { child, kill, done };
}
