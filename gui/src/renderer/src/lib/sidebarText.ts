import type { SidebarConfig } from '@shared/api';
import type { WireState } from '@shared/wire';
import { baseName, firstLine, fmtTokens, modelDisplayName, shortPath } from './format';
import { turnVerb } from './work';

// An open session's row in the sidebar, from config.json's `sidebar`
// templates. `{field}` puts in a field, `{a|b}` the first of them with a
// value, and text in `( )` shows only when a field inside it has one. A
// backslash makes the next character plain text. Spaces left by empty fields
// collapse; a placeholder naming no field stays as written, so a typo shows.

export type SidebarTemplates = { title: string; subtitle: string };

export const DEFAULT_SIDEBAR: SidebarTemplates = { title: '{status} {elapsed} {title}', subtitle: '{folder}( · {waiting})' };

export const sidebarTemplates = (c: SidebarConfig): SidebarTemplates => ({ title: c.title ?? DEFAULT_SIDEBAR.title, subtitle: c.subtitle ?? DEFAULT_SIDEBAR.subtitle });

// What a row is made from: an open session as the window knows it.
export type SessionFacts = {
  state: WireState | null;
  cwd: string;
  // The first prompt, or what the session was opened as.
  title: string;
  // Its host went away or claude exited.
  problem: boolean;
  // A turn finished while you were elsewhere, and you have not looked since.
  unseen: boolean;
  // When the running turn started, and how long the last one took.
  runningSince: number | null;
  lastTurnMs: number | null;
  branch?: string;
  script?: string;
};

export type Status = 'stopped' | 'waiting' | 'working' | 'background' | 'done' | '';

export function sessionStatus(f: SessionFacts): Status {
  const s = f.state;
  if (f.problem) return 'stopped';
  if (s?.question) return 'waiting';
  if (s && s.running !== null) return 'working';
  if (s?.backgroundTasks?.length) return 'background';
  return f.unseen ? 'done' : '';
}

const STATUS_ICON: Record<Status, string> = { stopped: '⚠️', waiting: '❓', working: '⏳', background: '🐝', done: '✅', '': '' };

export const FIELDS: { name: string; about: string }[] = [
  { name: 'status', about: '⏳ working ❓ asking 🐝 tasks ✅ done, unseen ⚠️ stopped' },
  { name: 'title', about: 'The first prompt' },
  { name: 'prompt', about: 'The latest prompt' },
  { name: 'folder', about: "The session's folder" },
  { name: 'path', about: "The folder's path" },
  { name: 'branch', about: 'The git branch' },
  { name: 'model', about: 'The model, as Opus 5.5' },
  { name: 'modelLetter', about: 'Its first letter: O, S, H, F' },
  { name: 'effort', about: 'The effort level' },
  { name: 'elapsed', about: 'How long the turn has run, or the last one ran' },
  { name: 'activity', about: 'What the running turn does: Thinking, Running Bash' },
  { name: 'waiting', about: '"waiting for you" while a question is open' },
  { name: 'context', about: 'Tokens in context' },
  { name: 'tabs', about: 'How many tabs' },
  { name: 'tasks', about: 'Background tasks running' },
  { name: 'script', about: "The first line config.json's sidebar.script prints" },
];

const KNOWN = new Set(FIELDS.map((f) => f.name));

// Whole minutes, rounded down: "0m", "3m", "1h5m".
export function shortDuration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`;
}

export function sessionFields(f: SessionFacts, now: number): Record<string, string> {
  const s = f.state;
  const running = s && s.running !== null ? s.tabs.find((t) => t.id === s.running) : undefined;
  const latest = running ?? s?.tabs.at(-1);
  const elapsedMs = running && f.runningSince !== null ? now - f.runningSince : f.lastTurnMs;
  const model = modelDisplayName(s?.model);
  const count = (n: number | undefined) => (n ? String(n) : '');
  return {
    status: STATUS_ICON[sessionStatus(f)],
    title: f.title,
    prompt: latest ? firstLine(latest.prompt) : '',
    folder: baseName(f.cwd),
    path: shortPath(f.cwd),
    branch: f.branch ?? '',
    model,
    modelLetter: model.charAt(0).toUpperCase(),
    effort: s?.effort ?? '',
    elapsed: elapsedMs === null ? '' : shortDuration(elapsedMs),
    activity: running ? turnVerb(running.blocks, s!.activity, s!.interrupting) : '',
    waiting: s?.question ? 'waiting for you' : '',
    context: s?.contextTokens ? fmtTokens(s.contextTokens) : '',
    tabs: count(s?.tabs.length),
    tasks: count(s?.backgroundTasks?.length),
    script: f.script ?? '',
  };
}

type Node = string | { names: string[]; raw: string } | { group: Node[] };

function parse(src: string): Node[] {
  let i = 0;
  const seq = (inGroup: boolean): Node[] => {
    const out: Node[] = [];
    let text = '';
    const flush = () => {
      if (text) out.push(text);
      text = '';
    };
    while (i < src.length) {
      const c = src[i];
      if (c === '\\' && i + 1 < src.length) {
        text += src[i + 1];
        i += 2;
      } else if (c === '{' && src.indexOf('}', i) > i) {
        flush();
        const raw = src.slice(i, src.indexOf('}', i) + 1);
        out.push({ names: raw.slice(1, -1).split('|').map((n) => n.trim()), raw });
        i += raw.length;
      } else if (c === '(') {
        flush();
        i++;
        out.push({ group: seq(true) });
      } else if (c === ')' && inGroup) {
        i++;
        break;
      } else {
        text += c;
        i++;
      }
    }
    flush();
    return out;
  };
  return seq(false);
}

// The text, and how many fields it had and how many of them had a value.
function render(nodes: Node[], values: Record<string, string>): { text: string; fields: number; filled: number } {
  let text = '';
  let fields = 0;
  let filled = 0;
  for (const n of nodes) {
    if (typeof n === 'string') text += n;
    else if ('names' in n) {
      if (!n.names.every((name) => KNOWN.has(name))) {
        text += n.raw;
        continue;
      }
      const v = n.names.map((name) => values[name]).find(Boolean) ?? '';
      fields++;
      if (v) filled++;
      text += v;
    } else {
      const g = render(n.group, values);
      fields += g.fields;
      filled += g.filled;
      if (g.fields === 0 || g.filled > 0) text += g.text;
    }
  }
  return { text, fields, filled };
}

export function renderTemplate(template: string, values: Record<string, string>): string {
  return render(parse(template), values).text.replace(/\s+/g, ' ').trim();
}

/** Whether a template shows `field` (for the fields that cost something to get). */
export function usesField(template: string, field: string): boolean {
  return parse(template).some(function has(n: Node): boolean {
    if (typeof n === 'string') return false;
    return 'names' in n ? n.names.includes(field) : n.group.some(has);
  });
}

/** A row's two lines; a title that comes out empty shows the first prompt. */
export function sidebarText(t: SidebarTemplates, f: SessionFacts, now: number): { title: string; subtitle: string } {
  const values = sessionFields(f, now);
  return { title: renderTemplate(t.title, values) || f.title, subtitle: renderTemplate(t.subtitle, values) };
}
