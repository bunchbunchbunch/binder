import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ~/.config/binder/config.json: one person's defaults, kept out of the code.
//   permissionMode  passed to claude as --permission-mode, unless one comes after --
//   configDirs      folder -> CLAUDE_CONFIG_DIR for claude run inside it, when
//                   CLAUDE_CONFIG_DIR is not set already
//   stickyPrompt    pin a turn's prompt to the top of the tab once it scrolls out
export type BinderConfig = {
  permissionMode?: string;
  configDirs?: Record<string, string>;
  stickyPrompt?: boolean;
};

export const configPath = () => process.env.BINDER_CONFIG || join(homedir(), '.config', 'binder', 'config.json');

export function readConfig(path = configPath()): BinderConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BinderConfig;
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
}

let cached: BinderConfig | undefined;
export const binderConfig = (): BinderConfig => (cached ??= readConfig());
