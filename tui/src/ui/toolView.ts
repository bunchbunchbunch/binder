import type { Block } from '../store.js';
import { diffLines, withContext } from './diff.js';
import { highlightCode } from './md/highlight.js';
import { truncate, width as strWidth, wrap } from './md/text.js';
import { styled, theme, type Style } from './md/theme.js';
import { toolSummary } from './toolSummary.js';

type ToolBlock = Extract<Block, { kind: 'tool_use' }>;

const ADD: Style = { fg: '#61AFEF' };
const DEL: Style = { fg: '#D19A66' };
const ADD_BG: Style = { bg: '#1E2A3A' };
const DEL_BG: Style = { bg: '#332A1E' };
const PATH: Style = { fg: '#7CC4FF' };
const MUTED: Style = theme.muted;

export type ToolRendering = {
  // One-line header after the ⏺ marker.
  title: string;
  // Body lines (already ANSI), truncated to `preview` lines unless detail is on.
  body: string[];
  // How many body lines to show in the collapsed form.
  preview: number;
};

function args(block: ToolBlock): Record<string, unknown> {
  if (block.input && typeof block.input === 'object' && Object.keys(block.input as object).length) return block.input as Record<string, unknown>;
  if (block.inputJson) {
    try {
      return JSON.parse(block.inputJson);
    } catch {
      return {};
    }
  }
  return {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function shortPath(p: string): string {
  const home = process.env.HOME;
  const rel = p.startsWith(process.cwd() + '/') ? p.slice(process.cwd().length + 1) : home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
  return rel;
}

function langFromPath(p: string): string | undefined {
  const ext = p.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', py: 'python', sh: 'bash', zsh: 'bash', json: 'json', md: 'markdown', yml: 'yaml', yaml: 'yaml', css: 'css', html: 'html', go: 'go', rs: 'rust', rb: 'ruby', swift: 'swift', toml: 'ini' };
  return ext ? map[ext] : undefined;
}

function resultLines(block: ToolBlock, w: number, style: Style = MUTED): string[] {
  const r = block.result;
  if (!r) return [];
  const text = r.content.replace(/\s+$/, '');
  if (!text) return [];
  return text.split('\n').flatMap((l) => wrap(styled(l, r.isError ? { fg: '#E06C75' } : style), w));
}

function renderDiff(oldText: string, newText: string, w: number): string[] {
  const out: string[] = [];
  for (const l of withContext(diffLines(oldText, newText))) {
    if (l.kind === 'skip') {
      out.push(styled(`  ⋯ ${l.count} unchanged line${l.count === 1 ? '' : 's'}`, MUTED));
      continue;
    }
    const prefix = l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  ';
    const st = l.kind === 'add' ? { ...ADD, ...ADD_BG } : l.kind === 'del' ? { ...DEL, ...DEL_BG } : MUTED;
    out.push(styled(truncate(prefix + l.text, w), st));
  }
  return out;
}

// A unified diff (a Codex fileChange), drawn like renderDiff. Hunks after the
// first are set apart by ⋯; a new file's diff may be its plain content.
function renderUnifiedDiff(diff: string, kind: string, w: number): string[] {
  if (!diff.trim()) return [];
  const lines = diff.replace(/\n$/, '').split('\n');
  const plain = kind === 'add' && !lines.some((l) => /^(@@|[+-])/.test(l));
  return lines.flatMap((l, i) => {
    if (plain || l.startsWith('+')) return [styled(truncate('+ ' + (plain ? l : l.slice(1)), w), { ...ADD, ...ADD_BG })];
    if (l.startsWith('-')) return [styled(truncate('- ' + l.slice(1), w), { ...DEL, ...DEL_BG })];
    if (l.startsWith('@@')) return i === 0 ? [] : [styled('  ⋯', MUTED)];
    return [styled(truncate('  ' + l.replace(/^ /, ''), w), MUTED)];
  });
}

export function renderTool(block: ToolBlock, w: number): ToolRendering {
  const a = args(block);
  const name = block.name;
  const done = Boolean(block.result);

  switch (name) {
    case 'Edit': {
      const path = str(a.file_path);
      const body = renderDiff(str(a.old_string), str(a.new_string), w);
      if (block.result?.isError) body.push(...resultLines(block, w));
      return { title: `Edit ${styled(shortPath(path), PATH)}${a.replace_all ? styled(' (all)', MUTED) : ''}`, body, preview: 12 };
    }
    case 'Write': {
      const path = str(a.file_path);
      const content = str(a.content);
      const lines = content ? content.split('\n') : [];
      const code = highlightCode(lines.slice(0, 200).join('\n'), langFromPath(path)).split('\n');
      const body = code.map((l) => styled('+ ', ADD) + truncate(l, w - 2));
      if (block.result?.isError) body.push(...resultLines(block, w));
      return { title: `Write ${styled(shortPath(path), PATH)} ${styled(`${lines.length} lines`, MUTED)}`, body, preview: 6 };
    }
    case 'Patch': {
      const changes = Array.isArray(a.changes) ? (a.changes as Array<{ path: string; kind?: string; diff?: string }>) : [];
      const many = changes.length > 1;
      const label = (c: { path: string; kind?: string }) => styled(shortPath(c.path), PATH) + (c.kind === 'add' ? styled(' (new)', MUTED) : c.kind === 'delete' ? styled(' (deleted)', MUTED) : '');
      const body = changes.flatMap((c) => [...(many ? [label(c)] : []), ...renderUnifiedDiff(c.diff ?? '', c.kind ?? 'update', w)]);
      if (block.result?.isError) body.push(...resultLines(block, w));
      const title = changes.length ? `Patch ${many ? styled(`${changes.length} files`, MUTED) : label(changes[0])}` : 'Patch';
      return { title, body, preview: 12 };
    }
    case 'Read': {
      const path = str(a.file_path);
      const range = a.offset || a.limit ? styled(` lines ${a.offset ?? 1}${a.limit ? `-${Number(a.offset ?? 1) + Number(a.limit) - 1}` : '+'}`, MUTED) : '';
      const n = block.result ? block.result.content.split('\n').length : 0;
      return { title: `Read ${styled(shortPath(path), PATH)}${range}${done ? styled(` · ${n} lines`, MUTED) : ''}`, body: block.result?.isError ? resultLines(block, w) : [], preview: 0 };
    }
    case 'Bash': {
      const cmd = str(a.command).replace(/\s+/g, ' ').trim();
      const desc = str(a.description);
      const title = `Bash ${styled(truncate(cmd, Math.max(10, w - 8)), { fg: '#E8C07D' })}${desc ? styled(`  ${desc}`, MUTED) : ''}`;
      return { title, body: resultLines(block, w), preview: 5 };
    }
    case 'Grep':
    case 'Glob': {
      const pattern = str(a.pattern);
      const where = str(a.path || a.glob);
      const n = block.result ? block.result.content.trim().split('\n').filter(Boolean).length : 0;
      return {
        title: `${name} ${styled(pattern, { fg: '#E8C07D' })}${where ? styled(` in ${shortPath(where)}`, MUTED) : ''}${done ? styled(` · ${n} result${n === 1 ? '' : 's'}`, MUTED) : ''}`,
        body: resultLines(block, w),
        preview: 4,
      };
    }
    case 'TodoWrite': {
      const todos = Array.isArray(a.todos) ? (a.todos as Array<{ content: string; status: string }>) : [];
      const body = todos.map((t) => {
        const mark = t.status === 'completed' ? styled('☑', theme.checked) : t.status === 'in_progress' ? styled('◐', { fg: '#E8C07D' }) : styled('☐', theme.checkbox);
        const text = t.status === 'completed' ? styled(t.content, { dim: true, strike: true }) : t.status === 'in_progress' ? styled(t.content, { bold: true }) : t.content;
        return truncate(`${mark} ${text}`, w);
      });
      return { title: `Todos ${styled(`${todos.filter((t) => t.status === 'completed').length}/${todos.length} done`, MUTED)}`, body, preview: 12 };
    }
    case 'Task':
    case 'Agent': {
      const desc = str(a.description) || truncate(str(a.prompt).replace(/\s+/g, ' '), 60);
      const kind = str(a.subagent_type);
      return { title: `Agent ${styled(desc, { fg: '#C9A0FF' })}${kind ? styled(` (${kind})`, MUTED) : ''}`, body: resultLines(block, w), preview: 4 };
    }
    case 'WebFetch':
      return { title: `WebFetch ${styled(truncate(str(a.url), w - 10), theme.link)}`, body: resultLines(block, w), preview: 3 };
    case 'WebSearch':
      return { title: `WebSearch ${styled(str(a.query), { fg: '#E8C07D' })}`, body: resultLines(block, w), preview: 3 };
    case 'Skill':
      return { title: `Skill ${styled('/' + str(a.skill), { fg: '#C9A0FF' })}${a.args ? ' ' + str(a.args) : ''}`, body: [], preview: 0 };
    case 'AskUserQuestion': {
      const qs = Array.isArray(a.questions) ? (a.questions as Array<{ question: string }>) : [];
      const answered = block.result?.content.match(/"([^"]+)"="([^"]+)"/g) ?? [];
      const body = answered.map((m) => styled(m.replace(/"([^"]+)"="([^"]+)"/, '$1 → $2'), { fg: '#98C379' }));
      return { title: `Question ${styled(qs.map((q) => q.question).join(' · '), { fg: '#C9A0FF' })}`, body, preview: 4 };
    }
    default: {
      const title = toolSummary(name, block.input, block.inputJson);
      return { title: styled(title, { bold: true }), body: resultLines(block, w), preview: 4 };
    }
  }
}

export function toolWidth(w: number): number {
  return Math.max(20, w - 4);
}

export { strWidth };
