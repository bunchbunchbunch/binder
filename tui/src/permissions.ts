// Claude Code's permission updates (the SDK's PermissionUpdate): what a
// permission prompt suggests in `permission_suggestions`, and what an
// "always allow" answer sends back as `updatedPermissions`.

type Destination = 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg';
export type PermissionRule = { toolName: string; ruleContent?: string };
type RulesUpdate = { type: 'addRules' | 'replaceRules' | 'removeRules'; rules: PermissionRule[]; behavior: 'allow' | 'deny' | 'ask'; destination: Destination };
type ModeUpdate = { type: 'setMode'; mode: string; destination: Destination };
type DirsUpdate = { type: 'addDirectories' | 'removeDirectories'; directories: string[]; destination: Destination };
export type PermissionUpdate = RulesUpdate | ModeUpdate | DirsUpdate;

// An extra choice on a permission prompt: allow the call and apply `updates`.
export type AlwaysChoice = { label: string; description: string; updates: PermissionUpdate[] };

// Permission modes as people see them, in the order the picker lists them and
// Alt+M steps through (dontAsk is left out of the cycle, as in Claude Code).
export const PERMISSION_MODES: Record<string, [label: string, description: string]> = {
  default: ['manual', 'Claude asks before it edits files or runs commands'],
  acceptEdits: ['accept edits', 'Claude edits files without asking; it still asks before running other tools'],
  plan: ['plan mode', 'Claude reads and plans but changes nothing until you approve the plan'],
  auto: ['auto mode', 'A classifier approves or refuses the tools Claude would ask about'],
  dontAsk: ["don't ask", 'Tools that would need your permission are refused instead of asking'],
  bypassPermissions: ['bypass permissions', 'Claude runs every tool, including commands and edits, without asking'],
};
export const MODE_CYCLE = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];

export const modeLabel = (mode: string): string => PERMISSION_MODES[mode]?.[0] ?? mode;

/** Throws, naming the modes there are, unless `mode` is one ("manual" is Claude Code's other name for default). */
export function checkMode(mode: string): void {
  if (mode !== 'manual' && !Object.hasOwn(PERMISSION_MODES, mode)) throw new Error(`Not a permission mode: ${mode} (one of ${Object.keys(PERMISSION_MODES).join(', ')})`);
}

// Plan approval (ExitPlanMode): each "yes" approves the plan and switches the
// mode in the same answer (a setMode update; one the session cannot take,
// such as bypass in a session not started in it, leaves it in manual mode).
export const KEEP_PLANNING = 'No, keep planning';
export const PLAN_FEEDBACK = 'No, and tell Claude what to change';

export function planChoices(returnMode?: string): AlwaysChoice[] {
  const choice = (label: string, description: string, mode: string): AlwaysChoice => ({ label, description, updates: [{ type: 'setMode', mode, destination: 'session' }] });
  return [
    // Plan mode entered from bypass mode goes back to it first, as it came.
    ...(returnMode === 'bypassPermissions' ? [choice('Yes, and bypass permissions', 'runs every tool without asking, as before', 'bypassPermissions')] : []),
    choice('Yes, and use auto mode', 'a classifier decides what would need asking', 'auto'),
    choice('Yes, and auto-accept edits', 'edits files without asking', 'acceptEdits'),
    choice('Yes, and manually approve edits', 'asks before edits and commands', 'default'),
  ];
}

const WHERE: Record<string, string> = {
  session: 'this session only',
  cliArg: 'this session only',
  localSettings: 'this project, in .claude/settings.local.json',
  projectSettings: "this project, shared in .claude/settings.json",
  userSettings: 'every project, in ~/.claude/settings.json',
};

const LABEL_MAX = 90;
const cut = (s: string) => (s.length > LABEL_MAX ? `${s.slice(0, LABEL_MAX - 1)}…` : s);

// A rule as settings.json writes it: Bash(npm test:*), Read(//etc/**), WebSearch.
const ruleText = (r: PermissionRule) => (r.ruleContent === undefined ? r.toolName : `${r.toolName}(${r.ruleContent})`);

// macOS paths come in pairs (/etc and /private/etc); naming one is enough.
function shown(rules: PermissionRule[]): string[] {
  const texts = [...new Set(rules.map(ruleText))];
  return texts.filter((t) => !(t.includes('(//private/') && texts.includes(t.replace('(//private/', '(//'))));
}

function valid(u: unknown): u is PermissionUpdate {
  const x = u as Record<string, unknown> | null;
  if (!x || typeof x !== 'object' || typeof x.destination !== 'string') return false;
  if (x.type === 'addRules') return Array.isArray(x.rules) && x.rules.every((r) => typeof (r as PermissionRule)?.toolName === 'string');
  if (x.type === 'setMode') return typeof x.mode === 'string';
  if (x.type === 'addDirectories') return Array.isArray(x.directories) && x.directories.every((d) => typeof d === 'string');
  return false;
}

/**
 * The "always allow" choices for a prompt's suggestions: one for the rules
 * (allow these calls from now on) and one per mode switch, each with the
 * directories the suggestions add. Kept apart because a Bash prompt may
 * suggest a rule and accept-edits mode at once, and taking a rule should not
 * also switch the mode.
 */
export function alwaysChoices(suggestions: unknown): AlwaysChoice[] {
  if (!Array.isArray(suggestions)) return [];
  const all = suggestions.filter(valid);
  const rules = all.filter((u): u is RulesUpdate => u.type === 'addRules' && u.behavior === 'allow' && u.rules.length > 0);
  const modes = all.filter((u): u is ModeUpdate => u.type === 'setMode' && u.mode in PERMISSION_MODES);
  const dirs = all.filter((u): u is DirsUpdate => u.type === 'addDirectories' && u.directories.length > 0);
  const out: AlwaysChoice[] = [];
  if (rules.length) {
    out.push({ label: cut(`Always allow ${shown(rules.flatMap((u) => u.rules)).join(', ')}`), description: WHERE[rules[0].destination] ?? '', updates: [...rules, ...dirs] });
  }
  for (const m of modes) {
    const label = m.mode === 'acceptEdits' ? 'Allow, and accept all edits from now on' : `Allow, and switch to ${modeLabel(m.mode)}`;
    out.push({ label, description: `switches this session to ${modeLabel(m.mode)}`, updates: [m, ...dirs] });
  }
  if (!rules.length && !modes.length && dirs.length) {
    out.push({ label: cut(`Always allow access to ${[...new Set(dirs.flatMap((u) => u.directories))].join(', ')}`), description: WHERE[dirs[0].destination] ?? '', updates: dirs });
  }
  return out;
}
