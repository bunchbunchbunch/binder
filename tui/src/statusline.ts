import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { childEnv, stateDir } from './paths.js';
import type { Usage } from './store.js';

// The status bar runs the user's own statusLine command from settings.json
// with a payload shaped like the one Claude Code sends, so the bar matches a
// normal session exactly.

export function readStatusLineCommand(configDir: string): string | undefined {
  const p = join(configDir, 'settings.json');
  if (!existsSync(p)) return undefined;
  try {
    const settings = JSON.parse(readFileSync(p, 'utf8'));
    const sl = settings.statusLine;
    if (sl && sl.type === 'command' && typeof sl.command === 'string') return sl.command;
  } catch {
    // unreadable settings: fall back to the built-in bar
  }
  return undefined;
}

// "claude-haiku-4-5-20251001" -> "Haiku 4.5", "claude-fable-5-1" -> "Fable 5.1",
// and a bare alias like "opus" -> "Opus" until the init event names the real model.
// Codex's "gpt-6-luna" -> "GPT-6-Luna", as Codex's model list names it.
export function modelDisplayName(modelId: string | undefined): string {
  if (!modelId) return '';
  if (/^gpt-/.test(modelId)) return modelId.replace(/^gpt/, 'GPT').replace(/-([a-z])/g, (_, c: string) => '-' + c.toUpperCase());
  const parts = modelId.replace(/^claude-/, '').split('-');
  const family = parts.shift() ?? '';
  const version = parts.filter((p) => /^\d{1,2}$/.test(p)).join('.');
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return version ? `${name} ${version}` : name || modelId;
}

export type StatusInput = {
  sessionId: string;
  model?: string;
  cwd: string;
  usage?: Usage;
};

export function buildPayload(input: StatusInput): Record<string, unknown> {
  const window = (w?: { utilization: number; resetsAt: number }) =>
    w ? { used_percentage: Math.round(w.utilization * 100), resets_at: w.resetsAt } : undefined;
  const rate_limits: Record<string, unknown> = {};
  const five = window(input.usage?.five_hour);
  const week = window(input.usage?.seven_day);
  const month = window(input.usage?.thirty_day);
  if (five) rate_limits.five_hour = five;
  if (week) rate_limits.seven_day = week;
  if (month) rate_limits.thirty_day = month;
  return {
    session_id: input.sessionId,
    model: { id: input.model ?? '', display_name: modelDisplayName(input.model) },
    workspace: { current_dir: input.cwd, project_dir: input.cwd },
    cwd: input.cwd,
    rate_limits,
  };
}

export function runStatusLine(command: string, payload: Record<string, unknown>, cwd: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { cwd, env: childEnv(cwd), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('statusline timed out'));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.replace(/\s+$/, ''));
      else reject(new Error(err || `statusline exited ${code}`));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

// "claude-work" for ~/.claude-work, in the bar and the usage cache's name.
const configName = (configDir: string) => basename(configDir).replace(/^\./, '');

// Plain bar used when no command is configured: the config dir unless it is
// the default, then folder, model and usage.
export function fallbackStatusLine(configDir: string, input: StatusInput): string {
  const home = process.env.HOME ?? '';
  const dir = home && input.cwd.startsWith(home) ? '~' + input.cwd.slice(home.length) : input.cwd;
  const parts = [dir, modelDisplayName(input.model) || '…'];
  if (configDir !== join(homedir(), '.claude')) parts.unshift(configName(configDir));
  const u = input.usage;
  if (u?.five_hour || u?.seven_day || u?.thirty_day) {
    const seg = (label: string, w?: { utilization: number }) => (w ? `${label} ${Math.round(w.utilization * 100)}%` : '');
    parts.push([seg('5h', u.five_hour), seg('7d', u.seven_day), seg('30d', u.thirty_day)].filter(Boolean).join(' '));
  }
  return parts.join(' │ ');
}

// Last known usage per account, so the bar is populated before the first turn.
function usageCachePath(configDir: string): string {
  return join(stateDir(), `usage-${configName(configDir)}.json`);
}

export function loadCachedUsage(configDir: string): Usage | undefined {
  const p = usageCachePath(configDir);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return undefined;
  }
}

export function saveCachedUsage(configDir: string, usage: Usage): void {
  writeFileSync(usageCachePath(configDir), JSON.stringify(usage));
}
