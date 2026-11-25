import type { WorkflowRun } from './store.js';

// Claude Code's workflows (the Workflow tool): what a script says it is, for
// the approval card, and a running one's progress, for the background tasks.

export type WorkflowMeta = { name?: string; description?: string; phases: string[] };

// The script's `export const meta = {...}`: a pure literal, read with a small parser.
export function workflowMeta(script: unknown): WorkflowMeta {
  if (typeof script !== 'string') return { phases: [] };
  const at = /export\s+const\s+meta\s*=/.exec(script);
  let meta: unknown;
  try {
    meta = at ? readLiteral(script, at.index + at[0].length) : undefined;
  } catch {
    // not a pure literal
  }
  const m = (meta && typeof meta === 'object' ? meta : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const phases = (Array.isArray(m.phases) ? m.phases : []).flatMap((p) => str((p as { title?: unknown } | null)?.title) ?? []);
  return { ...(str(m.name) && { name: str(m.name) }), ...(str(m.description) && { description: str(m.description) }), phases };
}

// A JavaScript literal at `src[from]`: objects (bare or quoted keys), arrays,
// strings (a template without ${}), numbers, true, false and null, with
// comments and trailing commas. Throws on anything else.
function readLiteral(src: string, from: number): unknown {
  let i = from;
  const fail = (): never => {
    throw new Error(`not a literal at ${i}`);
  };
  const skip = () => {
    for (;;) {
      while (/\s/.test(src[i] ?? '')) i++;
      if (src.startsWith('//', i)) i = src.includes('\n', i) ? src.indexOf('\n', i) : src.length;
      else if (src.startsWith('/*', i)) i = src.includes('*/', i) ? src.indexOf('*/', i) + 2 : fail();
      else return;
    }
  };
  const string = (): string => {
    const q = src[i++];
    let out = '';
    while (src[i] !== q) {
      if (i >= src.length || (q === '`' && src.startsWith('${', i))) fail();
      if (src[i] === '\\') {
        const c = src[++i];
        out += c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c === '\n' ? '' : c;
      } else out += src[i];
      i++;
    }
    i++;
    return out;
  };
  const value = (): unknown => {
    skip();
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') return string();
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      const obj: Record<string, unknown> = {};
      const list: unknown[] = [];
      i++;
      for (skip(); src[i] !== close; skip()) {
        if (close === ']') list.push(value());
        else {
          let key: string;
          if (src[i] === '"' || src[i] === "'") key = string();
          else {
            key = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))?.[0] ?? fail();
            i += key.length;
          }
          skip();
          if (src[i++] !== ':') fail();
          obj[key] = value();
        }
        skip();
        if (src[i] === ',') i++;
        else if (src[i] !== close) fail();
      }
      i++;
      return close === '}' ? obj : list;
    }
    const word = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)\b/.exec(src.slice(i))?.[0] ?? fail();
    i += word.length;
    return JSON.parse(word);
  };
  return value();
}

/** A task_progress event's workflow_progress, as the background task keeps it. */
export function workflowRun(progress: unknown): WorkflowRun | undefined {
  if (!Array.isArray(progress)) return undefined;
  const phases: string[] = [];
  const agents: WorkflowRun['agents'] = [];
  for (const p of progress as Array<Record<string, unknown>>) {
    if (p?.type === 'workflow_phase' && typeof p.title === 'string') phases.push(p.title);
    if (p?.type === 'workflow_agent') {
      agents.push({
        label: String(p.label ?? ''),
        ...(typeof p.phaseTitle === 'string' && { phase: p.phaseTitle }),
        state: String(p.state ?? ''),
        ...(typeof p.model === 'string' && { model: p.model }),
        ...(typeof p.tokens === 'number' && { tokens: p.tokens }),
        ...(typeof p.durationMs === 'number' && { durationMs: p.durationMs }),
        ...(typeof p.resultPreview === 'string' && { result: p.resultPreview }),
      });
    }
  }
  return phases.length || agents.length ? { phases, agents } : undefined;
}

/** "Greet · 1/2 agents done": the phase it is in and how far along. */
export function workflowLine(run: WorkflowRun): string {
  const done = run.agents.filter((a) => a.state === 'done').length;
  const phase = run.phases.at(-1);
  return [phase, run.agents.length ? `${done}/${run.agents.length} agents done` : undefined].filter(Boolean).join(' · ');
}
