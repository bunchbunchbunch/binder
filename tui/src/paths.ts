import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chmodSync, mkdirSync } from 'node:fs';
import { binderConfig, type BinderConfig } from './config.js';

// Where binder keeps its own state (event logs, session index, cached usage).
// It holds full transcripts, so it is private to the user (0700), matching the
// socket dir and Claude Code's own ~/.claude/projects. chmod self-heals a dir
// created 0755 by an older binder.
export function stateDir(): string {
  const dir = process.env.BINDER_STATE_DIR || join(homedir(), '.local', 'state', 'bindertui');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Not ours to chmod (a shared BINDER_STATE_DIR); the mode above still applies to one we create.
  }
  return dir;
}

// Mode for files under the state dir: readable only by the user, since they
// hold prompts, responses, and tool output.
export const STATE_FILE_MODE = 0o600;

// The Claude Code config dir in effect.
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

// Codex's home: its login, config.toml and session files.
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || join(homedir(), '.codex');
}

export const expandHome = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()));

// The environment for the claude child: the user's own, minus the NODE_ENV
// binder set for itself. Without CLAUDE_CONFIG_DIR, the first configDirs folder
// holding cwd picks one, for launches that skip the shell hook that would set
// it (binder serve under launchd, for one).
export function childEnv(cwd: string, inherited: NodeJS.ProcessEnv = process.env, config: BinderConfig = binderConfig()): NodeJS.ProcessEnv {
  // Headless Claude Code keeps file checkpoints (for /rewind) only when asked.
  let env: NodeJS.ProcessEnv = { CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: 'true', ...inherited };
  if (env.BINDER_SET_NODE_ENV) {
    delete env.NODE_ENV;
    delete env.BINDER_SET_NODE_ENV;
  }
  if (env.CLAUDE_CONFIG_DIR) return env;
  for (const [folder, dir] of Object.entries(config.configDirs ?? {})) {
    const root = expandHome(folder);
    if (cwd === root || cwd.startsWith(root + '/')) return { ...env, CLAUDE_CONFIG_DIR: expandHome(dir) };
  }
  return env;
}
