import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// ~/.config/binder/config.json: one person's defaults, kept out of the code.
//   permissionMode  passed to claude as --permission-mode, unless one comes after --
//   configDirs      folder -> CLAUDE_CONFIG_DIR for claude run inside it, when
//                   CLAUDE_CONFIG_DIR is not set already
//   stickyPrompt    keep the tab's latest prompt under the tab bar; on unless false
//   markdownStyle   how responses render: vivid (the default) or classic
//   agent           what new sessions run: claude (the default) or codex
//   artifacts       let Claude publish artifacts (live claude.ai pages); on unless false
//   statusText      the status row's right end, a template: {context}, {maxTokens},
//                   {percent}, {cost}; "{context}(/{maxTokens})( {percent})" by default
//   fastMode        start sessions with Claude Code's fast mode on; off unless true
//   alwaysAllow     offer the rules Claude suggests ("always allow") on permission
//                   prompts; on unless false
//   planApproval    show a plan (ExitPlanMode) with its approve choices; on unless
//                   false, which asks the plain allow / deny instead
//   bell            ring the terminal bell when a turn finishes or a question
//                   arrives while the terminal is in the background; on unless false
//   notifications   the Mac app's notifications for the same; on unless false
//   pluginReload    a plugin installed, enabled or disabled from /plugins loads into
//                   the running session at once; on unless false (else at
//                   claude's next start)
//   schedules       scheduled tasks run (binder schedule tick, and the apps' minute
//                   ticks); on unless false
//   sideChat        /btw asks side questions in binder's side chat (answered from
//                   the conversation, kept out of the transcript); on unless false
//   findingsCard    a code review's findings (/code-review) as a list to fix
//                   from (/findings) and marked in /diff; on unless false
//   prWatch         watch the session's pull request (through gh): its checks and
//                   reviews in the status row and /pr; on unless false
//   prAutoFix       when the PR's checks fail or a review asks for changes, ask
//                   Claude to fix it (once each); off unless true
//   diffBase        what /diff and the Mac app's diff pane compare the session's
//                   folder against: "HEAD" (what is not committed, the default) or a branch
//   worktrees       binder --worktree's new worktrees: { location, branchPrefix };
//                   location is relative to the repo, ~ and {repo} filled in
//                   ("../{repo}-worktrees" by default), branches start "binder/"
//   workflowCard    ask about a workflow with its name, description and phases, and
//                   offer to allow workflows from then on; on unless false
//   todoPanel       keep the latest todo list and the current plan pinned above the
//                   prompt; on unless false
//   editor          how a file opens from /files and the Mac app's tool calls: "open"
//                   (the default app, the default), a command ("code"), or a command
//                   with {file} and {line} ("code -g {file}:{line}")
//   showImages      draw images in the transcript (a tool's, ones you send; the Mac
//                   app's markdown images too); on unless false, which shows a caption
export type BinderConfig = {
  permissionMode?: string;
  configDirs?: Record<string, string>;
  stickyPrompt?: boolean;
  markdownStyle?: string;
  agent?: 'claude' | 'codex';
  artifacts?: boolean;
  statusText?: string;
  fastMode?: boolean;
  alwaysAllow?: boolean;
  planApproval?: boolean;
  bell?: boolean;
  notifications?: boolean;
  showImages?: boolean;
  editor?: string;
  todoPanel?: boolean;
  workflowCard?: boolean;
  worktrees?: { location?: string; branchPrefix?: string };
  diffBase?: string;
  prWatch?: boolean;
  prAutoFix?: boolean;
  findingsCard?: boolean;
  fileEditing?: boolean;
  sideChat?: boolean;
  schedules?: boolean;
  pluginReload?: boolean;
};

export const configPath = () => process.env.BINDER_CONFIG || join(homedir(), '.config', 'binder', 'config.json');

export function readConfig(path = configPath()): BinderConfig {
  if (!existsSync(path)) return {};
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`${path}: not a JSON object`);
  return config as BinderConfig;
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

// Read again whenever the file changes (its size or mtime), so a setting saved
// from /settings or the Mac app applies without a restart. Settings for
// "sessions opened from now on" are kept by each session as it starts. A file
// that stops parsing while binder runs leaves the last good settings in place.
let cached: { path: string; stamp: string; config: BinderConfig } | undefined;
export function binderConfig(): BinderConfig {
  const path = configPath();
  let stamp = '';
  try {
    const st = statSync(path);
    stamp = `${st.size}:${st.mtimeMs}`;
  } catch {
    // no file: the defaults
  }
  if (cached?.path === path && cached.stamp === stamp) return cached.config;
  let config: BinderConfig;
  try {
    config = readConfig(path);
  } catch (e) {
    if (cached?.path !== path) throw e;
    return cached.config;
  }
  cached = { path, stamp, config };
  return config;
}
