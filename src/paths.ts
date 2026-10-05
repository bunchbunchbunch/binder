import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { binderConfig, type BinderConfig } from './config.js';

// Where binder keeps its own state (event logs, session index, cached usage).
export function stateDir(): string {
  const dir = process.env.BINDER_STATE_DIR || join(homedir(), '.local', 'state', 'bindertui');
  mkdirSync(dir, { recursive: true });
  return dir;
}

// The Claude Code config dir in effect.
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

const expandHome = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()));

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
