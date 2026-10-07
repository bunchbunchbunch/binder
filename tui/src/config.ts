import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// ~/.config/binder/config.json: one person's defaults, kept out of the code.
//   permissionMode  passed to claude as --permission-mode, unless one comes after --
//   configDirs      folder -> CLAUDE_CONFIG_DIR for claude run inside it, when
//                   CLAUDE_CONFIG_DIR is not set already
//   stickyPrompt    keep the tab's latest prompt under the tab bar; on unless false
//   markdownStyle   how responses render: vivid (the default) or classic
//   agent           what new sessions run: claude (the default) or codex
export type BinderConfig = {
  permissionMode?: string;
  configDirs?: Record<string, string>;
  stickyPrompt?: boolean;
  markdownStyle?: string;
  agent?: 'claude' | 'codex';
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

// Sets keys in config.json (undefined removes one), keeping the rest of the
// file. Written in place, so a symlink into a dotfiles repo stays a symlink.
// A file that does not parse is left alone: readConfig throws first.
export function saveConfig(patch: BinderConfig, path = configPath()): BinderConfig {
  const next: Record<string, unknown> = { ...readConfig(path) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
  return next;
}

// Read once per process: a running binder keeps the settings it started with.
let cached: BinderConfig | undefined;
export const binderConfig = (): BinderConfig => (cached ??= readConfig());
