import { memo, useState, type ReactNode } from 'react';
import type { ToolBlock, WireBlock } from '@shared/wire';
import { diffLines, withContext, type DiffRow } from '../lib/diff';
import { plural, shortPath } from '../lib/format';
import { errText, request, toast } from '../store';
import { highlight, Markdown } from './Markdown';

// A turn's blocks: response text as Markdown, thinking, and tool calls with a
// view per tool (bindertui src/ui/toolView.ts): Edit as a diff, Write as the
// new file, Bash with its output, TodoWrite as a checklist, Read and Grep as
// one line with counts. Each shows a few lines until opened; Ctrl+O opens all.

export type BlockCtx = { conn: string; tabId: number; cwd: string; detail: boolean };

export function Blocks({ blocks, ctx }: { blocks: WireBlock[]; ctx: BlockCtx }) {
  return (
    <>
      {blocks.map((b, i) => (
        <Block key={b.kind === 'tool_use' ? b.id : `${b.kind}-${i}`} block={b} ctx={ctx} />
      ))}
    </>
  );
}

const Block = memo(function Block({ block, ctx }: { block: WireBlock; ctx: BlockCtx }) {
  if (block.kind === 'tool_use') return <ToolCall block={block} ctx={ctx} />;
  if (!block.text.trim()) return null;
  return block.kind === 'text' ? <Markdown text={block.text} /> : <Thinking text={block.text} detail={ctx.detail} />;
});

function Thinking({ text, detail }: { text: string; detail: boolean }) {
  const [open, setOpen] = useState(false);
  const lines = text.trim().split('\n');
  const shown = open || detail ? lines : lines.slice(0, 3);
  return (
    <div className="thinking" onClick={() => setOpen(!open)} title={open ? 'Click to fold' : 'Click to show all'}>
      {shown.join('\n')}
      {shown.length < lines.length ? ' …' : ''}
    </div>
  );
}

function args(block: ToolBlock): Record<string, unknown> {
  return block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {};
}

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

const LANG: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', py: 'python', sh: 'bash', zsh: 'bash', json: 'json', md: 'markdown', yml: 'yaml', yaml: 'yaml', css: 'css', html: 'xml', xml: 'xml', go: 'go', rs: 'rust', rb: 'ruby', swift: 'swift', toml: 'ini', sql: 'sql', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', php: 'php' };
const langOf = (path: string) => LANG[path.split('.').pop()?.toLowerCase() ?? ''];

// Strings binder cut from a tool's input end like this.
const CUT = /… \[\d+ more characters\]/;

function isCut(block: ToolBlock): boolean {
  return (block.result?.length ?? 0) > (block.result?.content.length ?? 0) || CUT.test(JSON.stringify(block.input ?? null));
}

type Arg = { text: string; kind?: 'path' | 'cmd' | 'agent' };

type View = {
  name: string;
  arg?: Arg;
  meta?: string;
  // Body rows; the first `preview` show until the call is opened.
  rows: ReactNode[];
  preview: number;
  // Rows render inside a frame of this kind.
  frame?: 'out' | 'diff' | 'code' | 'plain';
};

function outputRows(block: ToolBlock): string[] {
  const text = block.result?.content.replace(/\s+$/, '') ?? '';
  return text ? text.split('\n') : [];
}

function diffRows(rows: DiffRow[]): ReactNode[] {
  return rows.map((r, i) =>
    r.kind === 'skip' ? (
      <div key={i} className="diff-row skip">
        ⋯ {plural(r.count, 'unchanged line')}
      </div>
    ) : (
      <div key={i} className={`diff-row ${r.kind}`}>
        <span className="sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}</span>
        {r.text}
      </div>
    ),
  );
}

function prettyName(name: string): string {
  // mcp__server__tool -> server › tool
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1].replace(/^claude_ai_/, '').replace(/_/g, ' ')} › ${m[2]}` : name;
}

function firstStringArg(a: Record<string, unknown>): string | undefined {
  for (const k of ['command', 'file_path', 'pattern', 'description', 'prompt', 'query', 'url', 'skill', 'path']) {
    const v = a[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return Object.values(a).find((v): v is string => typeof v === 'string');
}

function describe(block: ToolBlock, cwd: string): View {
  const a = args(block);
  const out = outputRows(block);
  const done = Boolean(block.result);
  switch (block.name) {
    case 'Edit':
    case 'MultiEdit': {
      const edits = block.name === 'MultiEdit' && Array.isArray(a.edits) ? (a.edits as Record<string, unknown>[]) : [a];
      const rows = edits.flatMap((e, i) => [
        ...(i ? [<div key={`sep${i}`} className="diff-row skip">⋯</div>] : []),
        ...diffRows(withContext(diffLines(str(e.old_string), str(e.new_string)))).map((r, j) => <div key={`${i}-${j}`}>{r}</div>),
      ]);
      return { name: 'Edit', arg: { text: shortPath(str(a.file_path), cwd), kind: 'path' }, meta: a.replace_all ? 'all occurrences' : undefined, rows, preview: 12, frame: 'diff' };
    }
    case 'Write': {
      const path = str(a.file_path);
      const content = str(a.content);
      const lines = content ? content.split('\n') : [];
      return { name: 'Write', arg: { text: shortPath(path, cwd), kind: 'path' }, meta: plural(lines.length, 'line'), rows: lines.map((l, i) => <div key={i} dangerouslySetInnerHTML={{ __html: highlight(l, langOf(path)) || ' ' }} />), preview: 6, frame: 'code' };
    }
    case 'Read': {
      const offset = Number(a.offset ?? 0);
      const limit = Number(a.limit ?? 0);
      const range = offset || limit ? `lines ${offset || 1}${limit ? `-${(offset || 1) + limit - 1}` : '+'}` : '';
      return { name: 'Read', arg: { text: shortPath(str(a.file_path), cwd), kind: 'path' }, meta: [range, done && !block.result?.isError ? plural(out.length, 'line') : ''].filter(Boolean).join(' · '), rows: block.result?.isError ? out : [], preview: 4, frame: 'out' };
    }
    case 'Bash':
      return { name: 'Bash', arg: { text: str(a.command).replace(/\s+/g, ' ').trim(), kind: 'cmd' }, meta: str(a.description) || undefined, rows: out, preview: 5, frame: 'out' };
    case 'Grep':
    case 'Glob': {
      const where = str(a.path || a.glob);
      const n = out.filter((l) => l.trim()).length;
      return { name: block.name, arg: { text: str(a.pattern), kind: 'cmd' }, meta: [where && `in ${shortPath(where, cwd)}`, done ? plural(n, 'result') : ''].filter(Boolean).join(' · '), rows: out, preview: 4, frame: 'out' };
    }
    case 'TodoWrite': {
      const todos = Array.isArray(a.todos) ? (a.todos as { content: string; status: string }[]) : [];
      const rows = todos.map((t, i) => (
        <li key={i} className={t.status}>
          <span className="box">{t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐'}</span>
          <span>{t.content}</span>
        </li>
      ));
      return { name: 'Todos', meta: `${todos.filter((t) => t.status === 'completed').length}/${todos.length} done`, rows, preview: 12, frame: 'plain' };
    }
    case 'Task':
    case 'Agent':
      return { name: 'Agent', arg: { text: str(a.description) || str(a.prompt).replace(/\s+/g, ' ').slice(0, 80), kind: 'agent' }, meta: str(a.subagent_type) || undefined, rows: out, preview: 4, frame: 'out' };
    case 'WebFetch':
      return { name: 'WebFetch', arg: { text: str(a.url), kind: 'path' }, rows: out, preview: 3, frame: 'out' };
    case 'WebSearch':
      return { name: 'WebSearch', arg: { text: str(a.query), kind: 'cmd' }, rows: out, preview: 3, frame: 'out' };
    case 'Skill':
      return { name: 'Skill', arg: { text: `/${str(a.skill)}${a.args ? ' ' + str(a.args) : ''}`, kind: 'agent' }, rows: [], preview: 0 };
    case 'AskUserQuestion': {
      const qs = Array.isArray(a.questions) ? (a.questions as { question: string }[]) : [];
      const answered = block.result?.content.match(/"([^"]+)"="([^"]+)"/g) ?? [];
      const rows = answered.map((m, i) => (
        <div key={i} className="qa">
          {m.replace(/"([^"]+)"="([^"]+)"/, '$1 → $2')}
        </div>
      ));
      return { name: 'Question', arg: { text: qs.map((q) => q.question).join(' · '), kind: 'agent' }, rows, preview: 4, frame: 'plain' };
    }
    default: {
      const arg = firstStringArg(a);
      return { name: prettyName(block.name), arg: arg ? { text: arg.replace(/\s+/g, ' ').trim() } : undefined, rows: out, preview: 4, frame: 'out' };
    }
  }
}

function ToolCall({ block: wire, ctx }: { block: ToolBlock; ctx: BlockCtx }) {
  // The untruncated call, once asked for.
  const [full, setFull] = useState<ToolBlock | null>(null);
  const [open, setOpen] = useState<boolean | null>(null);
  const [showKids, setShowKids] = useState(false);
  // Asked for only once the call has finished, so it never stands in for a call still updating.
  const block = full ?? wire;
  const view = describe(block, ctx.cwd);
  const expanded = open ?? ctx.detail;
  const error = block.result?.isError;
  const errorRows = error && view.frame !== 'out' ? outputRows(block) : [];
  const rows = expanded ? view.rows : view.rows.slice(0, view.preview);
  const hidden = view.rows.length - rows.length;
  const pending = !block.result && !(block.final && block.name === 'Skill');
  const loadFull = () => {
    request(ctx.conn, 'tool_detail', { tabId: ctx.tabId, toolUseId: block.id })
      .then((r) => {
        setFull(r.block as ToolBlock);
        setOpen(true);
      })
      .catch((e) => toast(errText(e), true));
  };

  let body: ReactNode = null;
  if (rows.length) {
    if (view.frame === 'diff') body = <div className="diff">{rows}</div>;
    else if (view.frame === 'code') body = <pre className="tool-out">{rows}</pre>;
    else if (view.frame === 'plain') body = block.name === 'TodoWrite' ? <ul className="todos">{rows}</ul> : <div>{rows}</div>;
    else body = <pre className={`tool-out${error ? ' error' : ''}`}>{(rows as string[]).join('\n')}</pre>;
  }
  const kids = block.children;
  return (
    <div className="tool">
      <div className="tool-head" onClick={() => setOpen(!expanded)}>
        <span className={`tool-dot${pending ? ' pending' : error ? ' error' : ''}`} />
        <span className="tool-name">{view.name}</span>
        {view.arg && (
          <span className={`tool-arg ${view.arg.kind ?? ''}`} title={view.arg.text}>
            {view.arg.text}
          </span>
        )}
        {view.meta && <span className="tool-meta">{view.meta}</span>}
        {pending && block.inputChars ? <span className="tool-meta">{plural(block.inputChars, 'char')}…</span> : null}
      </div>
      {(body || errorRows.length > 0 || hidden > 0 || kids.length > 0) && (
        <div className="tool-body">
          {body}
          {errorRows.length > 0 && <pre className="tool-out error">{errorRows.join('\n')}</pre>}
          {hidden > 0 && (
            <button className="more" onClick={() => setOpen(true)}>
              ⋯ {plural(hidden, 'more line')}
            </button>
          )}
          {expanded && !full && isCut(block) && block.result && (
            <button className="more" onClick={loadFull}>
              {block.result?.length ? `Output cut at ${block.result.content.length.toLocaleString()} of ${block.result.length.toLocaleString()} characters. ` : 'Input cut short. '}
              Load all
            </button>
          )}
          {kids.length > 0 &&
            (showKids || ctx.detail ? (
              <div className="subagent">
                <Blocks blocks={kids} ctx={ctx} />
              </div>
            ) : (
              <button className="more" onClick={() => setShowKids(true)}>
                {plural(kids.length, 'subagent step')}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
