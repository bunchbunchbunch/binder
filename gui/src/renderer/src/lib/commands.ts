import type { SlashCommand } from '@shared/wire';

// Slash commands the app runs itself rather than sending to Claude Code
// (bindertui runs the same set; its host lists them among the commands).
export type LocalCommandName = 'help' | 'resume' | 'clear' | 'exit' | 'fork' | 'rewind' | 'cd' | 'mcp' | 'model' | 'effort' | 'chrome' | 'artifacts' | 'tasks' | 'settings';

const LOCAL: Record<LocalCommandName, string[]> = {
  help: [],
  resume: [],
  clear: ['reset', 'new'],
  exit: ['quit'],
  fork: ['branch'],
  rewind: ['checkpoint'],
  cd: [],
  mcp: [],
  model: [],
  effort: [],
  chrome: [],
  artifacts: [],
  tasks: ['bashes'],
  settings: [],
};

// The TUI's markdown style switch means nothing here.
const HIDDEN = new Set(['markdown']);

// Where the TUI's description does not fit the app.
const DESCRIPTIONS: Record<string, string> = {
  exit: 'Close this session in the app (it keeps running until idle)',
  settings: "Binder's settings (config.json): permission mode, sticky prompt, config dirs",
};

export function visibleCommands(commands: SlashCommand[]): SlashCommand[] {
  return commands.filter((c) => !HIDDEN.has(c.name)).map((c) => (DESCRIPTIONS[c.name] ? { ...c, description: DESCRIPTIONS[c.name] } : c));
}

/** Commands for the menu while the prompt is "/" plus a partial name: prefix matches first, then substring ones. */
export function matchCommands(commands: SlashCommand[], value: string): SlashCommand[] {
  const m = /^\/(\S*)$/.exec(value);
  if (!m) return [];
  const q = m[1].toLowerCase();
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q) || c.aliases?.some((a) => a.startsWith(q)));
  const contains = commands.filter((c) => !starts.includes(c) && c.name.toLowerCase().includes(q));
  return starts.concat(contains);
}

/** A prompt that is one of the app's own commands, by name or alias. */
export function localCommand(text: string): { name: LocalCommandName; args: string } | null {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  const hit = (Object.keys(LOCAL) as LocalCommandName[]).find((n) => n === m[1] || LOCAL[n].includes(m[1]));
  return hit ? { name: hit, args: m[2].trim() } : null;
}

/** The word around the cursor (for @ and Tab completion): where it starts, and its text up to the cursor. */
export function wordAt(value: string, cursor: number): { start: number; word: string } {
  let start = cursor;
  while (start > 0 && !/\s/.test(value[start - 1])) start--;
  return { start, word: value.slice(start, cursor) };
}

export function commonPrefix(items: string[]): string {
  if (!items.length) return '';
  let p = items[0];
  for (const s of items) while (!s.startsWith(p)) p = p.slice(0, -1);
  return p;
}
