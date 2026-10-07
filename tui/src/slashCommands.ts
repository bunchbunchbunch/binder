// Slash commands: the child reports the ones it runs headless (through the
// `initialize` control request); binder runs the few that headless refuses or
// that change which session the child is on.

export type SlashCommand = { name: string; description: string; argumentHint?: string; aliases?: string[] };

export type LocalCommandName = 'help' | 'resume' | 'clear' | 'exit' | 'fork' | 'rewind' | 'cd' | 'mcp' | 'model' | 'effort' | 'chrome' | 'artifacts' | 'markdown' | 'settings';

const LOCAL: Array<SlashCommand & { name: LocalCommandName }> = [
  { name: 'help', description: 'Show keys and commands' },
  { name: 'resume', description: 'Resume a session: this folder, its worktrees, this branch, or all projects', argumentHint: '[session id]' },
  { name: 'clear', description: 'Start a new session with empty context; this one stays resumable with /resume', aliases: ['reset', 'new'] },
  { name: 'exit', description: 'Quit binder', aliases: ['quit'] },
  { name: 'fork', description: 'Fork the conversation into a new session and continue there; the original stays resumable', argumentHint: '[title]', aliases: ['branch'] },
  { name: 'rewind', description: 'Restore the conversation and/or code to before an earlier prompt', aliases: ['checkpoint'] },
  { name: 'cd', description: 'Change the working directory', argumentHint: '<path>' },
  { name: 'mcp', description: 'MCP servers: status, authenticate, reconnect, enable or disable' },
  { name: 'model', description: 'Pick the model', argumentHint: '[model]' },
  { name: 'effort', description: 'Pick the effort level for this session', argumentHint: '[level]' },
  { name: 'chrome', description: 'Claude in Chrome: status and setup' },
  { name: 'artifacts', description: 'Artifacts published in this session (Ctrl+] opens the latest)' },
  { name: 'markdown', description: 'Switch the markdown style for responses: classic or vivid', argumentHint: '[style]', aliases: ['md'] },
  { name: 'settings', description: "Binder's settings (config.json): permission mode, sticky prompt, markdown style, config dirs" },
];

// Binder's commands a Codex session cannot run: Codex keeps no file
// checkpoints to rewind to, and has no Claude in Chrome.
export const CODEX_UNSUPPORTED: LocalCommandName[] = ['rewind', 'chrome'];

// The child's commands plus binder's own (less `hide`), which replace any of
// the same name. Names starting with "__" are internal and hidden, as in Claude Code.
export function mergeCommands(child: SlashCommand[], hide: LocalCommandName[] = []): SlashCommand[] {
  const local = new Set(LOCAL.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
  return child
    .filter((c) => !local.has(c.name) && !c.name.startsWith('__'))
    .concat(LOCAL.filter((c) => !hide.includes(c.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Commands for the menu while the prompt is "/" plus a partial name: names
// and aliases that start with it first, then names that contain it.
export function matchCommands(commands: SlashCommand[], value: string): SlashCommand[] {
  const m = /^\/(\S*)$/.exec(value);
  if (!m) return [];
  const q = m[1].toLowerCase();
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q) || c.aliases?.some((a) => a.startsWith(q)));
  const contains = commands.filter((c) => !starts.includes(c) && c.name.toLowerCase().includes(q));
  return starts.concat(contains);
}

// A prompt that is one of binder's own commands, by name or alias.
export function localCommand(text: string): { name: LocalCommandName; args: string } | null {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  const cmd = LOCAL.find((c) => c.name === m[1] || c.aliases?.includes(m[1]));
  return cmd ? { name: cmd.name, args: m[2].trim() } : null;
}
