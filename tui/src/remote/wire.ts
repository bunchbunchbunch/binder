import type { Block, Question, State, Tab, Turn } from '../store.js';

// The session state as remote viewers see it (docs/remote-protocol.md,
// section 4): a snapshot, then patches computed from the reducer's immutable
// state (an unchanged tab or block keeps its identity, so diffing is cheap).

const RESULT_MAX = 4000;
const INPUT_STRING_MAX = 2000;

export type WireBlock =
  | { kind: 'text' | 'thinking'; text: string; final: boolean }
  | {
      kind: 'tool_use';
      id: string;
      name: string;
      input: unknown;
      final: boolean;
      result?: { content: string; isError: boolean; length?: number };
      children: WireBlock[];
      inputChars?: number;
    };

export type WireTurn = { prompt: string; status: string; blocks: WireBlock[]; result?: Turn['result']; uuid?: string; bash?: boolean };
export type WireTab = WireTurn & { id: number; earlier: WireTurn[] };

export type WireQuestion = {
  requestId: string;
  kind: 'ask' | 'permission';
  toolName?: string;
  toolInput?: unknown;
  // Why a permission prompt was raised, as the child explains it.
  reason?: string;
  questions: Question['questions'];
};

export type WireMeta = {
  sessionId: string;
  cwd: string;
  model: string | null;
  permissionMode: string | null;
  usage: State['usage'] | null;
  contextTokens: number | null;
  running: number | null;
  // When the running turn started (ms since the epoch).
  runningSince: number | null;
  activity: string;
  interrupting: boolean;
  canSteer: boolean;
  queue: { tabId: number; prompt: string; followup: boolean }[];
  steer: { tabId: number; prompt: string } | null;
  question: WireQuestion | null;
  childExit: { code: number | null; stderr: string[] } | null;
  effort: string | null;
  // The next prompt Claude Code predicts after a turn, until anything is sent.
  suggestion: string | null;
  // Background shells and agents still running.
  backgroundTasks: { id: string; type: string; description: string }[];
};

export type WireState = WireMeta & { tabs: WireTab[] };

type TabFields = { prompt: string; status: string; result: Turn['result'] | null; uuid: string | null; bash: boolean };

export type TabOp =
  | { op: 'set'; tab: WireTab }
  | { op: 'remove'; id: number }
  | { op: 'blocks'; id: number; from: number; blocks: WireBlock[]; fields: TabFields }
  | { op: 'append'; id: number; index: number; text: string; fields: TabFields };

export type Patch = { t: 'patch'; meta?: Partial<WireMeta>; tabs?: TabOp[] };

/** What a diff compares: the reducer state plus the host's own facts. */
export type Source = { state: State; cwd: string; effort?: string; runningSince?: number };

// Long strings in a tool's input (file contents, big commands) are cut.
function cutStrings(v: unknown, max: number): unknown {
  if (typeof v === 'string') return v.length > max ? `${v.slice(0, max)}… [${v.length - max} more characters]` : v;
  if (Array.isArray(v)) return v.map((x) => cutStrings(x, max));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cutStrings(x, max)]));
  return v;
}

export function wireBlock(b: Block, full = false): WireBlock {
  if (b.kind !== 'tool_use') return { kind: b.kind, text: b.text, final: b.final };
  const out: WireBlock = {
    kind: 'tool_use',
    id: b.id,
    name: b.name,
    input: full ? b.input : cutStrings(b.input, INPUT_STRING_MAX),
    final: b.final,
    children: b.children.map((c) => wireBlock(c, full)),
  };
  if (!b.final && b.inputJson) out.inputChars = b.inputJson.length;
  if (b.result) {
    const c = b.result.content;
    out.result = !full && c.length > RESULT_MAX ? { content: c.slice(0, RESULT_MAX), isError: b.result.isError, length: c.length } : { content: c, isError: b.result.isError };
  }
  return out;
}

function wireTurn(t: Turn): WireTurn {
  return { prompt: t.prompt, status: t.status, blocks: t.blocks.map((b) => wireBlock(b)), result: t.result, uuid: t.uuid, bash: t.bash };
}

export function wireTab(t: Tab): WireTab {
  return { ...wireTurn(t), id: t.id, earlier: t.earlier.map(wireTurn) };
}

function wireQuestion(q: Question | undefined): WireQuestion | null {
  if (!q) return null;
  const permission = q.toolName !== undefined && q.toolName !== 'AskUserQuestion';
  return {
    requestId: q.requestId,
    kind: permission ? 'permission' : 'ask',
    toolName: q.toolName,
    ...(permission && { toolInput: cutStrings(q.toolInput ?? {}, INPUT_STRING_MAX) }),
    ...(permission && q.reason && { reason: q.reason }),
    questions: q.questions,
  };
}

// Each meta field with the source value it comes from: a changed source
// (by identity) means the field goes in the next patch.
const META: { [K in keyof WireMeta]: [(s: Source) => unknown, (s: Source) => WireMeta[K]] } = {
  sessionId: [(s) => s.state.sessionId, (s) => s.state.sessionId],
  cwd: [(s) => s.cwd, (s) => s.cwd],
  model: [(s) => s.state.model, (s) => s.state.model ?? null],
  permissionMode: [(s) => s.state.permissionMode, (s) => s.state.permissionMode ?? null],
  usage: [(s) => s.state.usage, (s) => s.state.usage ?? null],
  contextTokens: [(s) => s.state.contextTokens, (s) => s.state.contextTokens ?? null],
  running: [(s) => s.state.running, (s) => s.state.running],
  runningSince: [(s) => s.runningSince, (s) => s.runningSince ?? null],
  activity: [(s) => s.state.activity, (s) => s.state.activity],
  interrupting: [(s) => s.state.interrupting, (s) => s.state.interrupting],
  canSteer: [(s) => s.state.canSteer, (s) => s.state.canSteer],
  queue: [(s) => s.state.queue, (s) => s.state.queue.map((q) => ({ tabId: q.tabId, prompt: q.prompt, followup: q.followup }))],
  steer: [(s) => s.state.steer, (s) => (s.state.steer ? { tabId: s.state.steer.tabId, prompt: s.state.steer.prompt } : null)],
  question: [(s) => s.state.question, (s) => wireQuestion(s.state.question)],
  childExit: [(s) => s.state.childExit, (s) => s.state.childExit ?? null],
  effort: [(s) => s.effort, (s) => s.effort ?? null],
  suggestion: [(s) => s.state.suggestion, (s) => s.state.suggestion ?? null],
  backgroundTasks: [(s) => s.state.backgroundTasks, (s) => s.state.backgroundTasks],
};

export function wireState(src: Source): WireState {
  const meta = Object.fromEntries(Object.entries(META).map(([k, [, make]]) => [k, make(src)])) as WireMeta;
  return { ...meta, tabs: src.state.tabs.map(wireTab) };
}

function tabFields(t: Tab): TabFields {
  return { prompt: t.prompt, status: t.status, result: t.result ?? null, uuid: t.uuid ?? null, bash: Boolean(t.bash) };
}

export function diffTabs(prev: Tab[], next: Tab[]): TabOp[] {
  if (prev === next) return [];
  const ops: TabOp[] = [];
  const before = new Map(prev.map((t) => [t.id, t]));
  const ids = new Set(next.map((t) => t.id));
  for (const t of prev) if (!ids.has(t.id)) ops.push({ op: 'remove', id: t.id });
  for (const t of next) {
    const p = before.get(t.id);
    if (p === t) continue;
    if (!p || p.earlier !== t.earlier) {
      ops.push({ op: 'set', tab: wireTab(t) });
      continue;
    }
    const fields = tabFields(t);
    let i = 0;
    while (i < p.blocks.length && i < t.blocks.length && p.blocks[i] === t.blocks[i]) i++;
    // The common case while streaming: only the last text block grew.
    if (i === t.blocks.length - 1 && i === p.blocks.length - 1) {
      const a = p.blocks[i];
      const b = t.blocks[i];
      if (a.kind !== 'tool_use' && b.kind === a.kind && b.final === a.final && b.text.startsWith(a.text)) {
        ops.push({ op: 'append', id: t.id, index: i, text: b.text.slice(a.text.length), fields });
        continue;
      }
    }
    ops.push({ op: 'blocks', id: t.id, from: i, blocks: t.blocks.slice(i).map((b) => wireBlock(b)), fields });
  }
  return ops;
}

export function diff(prev: Source, next: Source): Patch | null {
  const meta: Partial<WireMeta> = {};
  let changed = false;
  for (const [k, [source, make]] of Object.entries(META) as [keyof WireMeta, [(s: Source) => unknown, (s: Source) => never]][]) {
    if (source(prev) !== source(next)) {
      meta[k] = make(next);
      changed = true;
    }
  }
  const tabs = diffTabs(prev.state.tabs, next.state.tabs);
  if (!changed && !tabs.length) return null;
  return { t: 'patch', ...(changed && { meta }), ...(tabs.length && { tabs }) };
}

/** Applies a patch to a wire state, as a client does (tests and the terminal client use it). */
export function applyPatch(s: WireState, p: Patch): WireState {
  let tabs = s.tabs;
  for (const op of p.tabs ?? []) {
    if (op.op === 'remove') {
      tabs = tabs.filter((t) => t.id !== op.id);
    } else if (op.op === 'set') {
      tabs = tabs.filter((t) => t.id !== op.tab.id).concat(op.tab).sort((a, b) => a.id - b.id);
    } else {
      tabs = tabs.map((t) => {
        if (t.id !== op.id) return t;
        const f = op.fields;
        const fields = { prompt: f.prompt, status: f.status, result: f.result ?? undefined, uuid: f.uuid ?? undefined, bash: f.bash || undefined };
        if (op.op === 'blocks') return { ...t, ...fields, blocks: t.blocks.slice(0, op.from).concat(op.blocks) };
        const blocks = t.blocks.map((b, i) => (i === op.index && b.kind !== 'tool_use' ? { ...b, text: b.text + op.text } : b));
        return { ...t, ...fields, blocks };
      });
    }
  }
  return { ...s, ...p.meta, tabs };
}
