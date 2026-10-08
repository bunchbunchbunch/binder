// The session state a binder host serves (bindertui docs/remote-protocol.md,
// section 4): a snapshot, then patches. These types mirror bindertui's
// src/remote/wire.ts; the protocol is the contract between the two repos.

export type ToolResult = { content: string; isError: boolean; length?: number };

export type TextBlock = { kind: 'text' | 'thinking'; text: string; final: boolean };
export type ToolBlock = {
  kind: 'tool_use';
  id: string;
  name: string;
  input: unknown;
  final: boolean;
  result?: ToolResult;
  children: WireBlock[];
  inputChars?: number;
};
export type WireBlock = TextBlock | ToolBlock;

export type TabStatus = 'queued' | 'running' | 'done' | 'error' | 'interrupted' | 'superseded';
export type TurnResult = { durationMs: number; costUsd: number; numTurns: number; isError: boolean; text?: string };

export type WireTurn = { prompt: string; status: TabStatus; blocks: WireBlock[]; result?: TurnResult; uuid?: string; bash?: boolean };
export type WireTab = WireTurn & { id: number; earlier: WireTurn[] };

export type QuestionItem = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
};

export type WireQuestion = {
  requestId: string;
  kind: 'ask' | 'permission';
  toolName?: string;
  toolInput?: unknown;
  reason?: string;
  questions: QuestionItem[];
};

export type UsageWindow = { utilization: number; resetsAt: number };

export type WireMeta = {
  sessionId: string;
  cwd: string;
  model: string | null;
  permissionMode: string | null;
  usage: { five_hour?: UsageWindow; seven_day?: UsageWindow } | null;
  contextTokens: number | null;
  running: number | null;
  activity: string;
  interrupting: boolean;
  canSteer: boolean;
  queue: { tabId: number; prompt: string; followup: boolean }[];
  steer: { tabId: number; prompt: string } | null;
  question: WireQuestion | null;
  childExit: { code: number | null; stderr: string[] } | null;
  effort: string | null;
  // Newer hosts only; older ones leave these out.
  suggestion?: string | null;
  backgroundTasks?: BackgroundTask[];
};

// A background shell or agent still running. tabId is the tab whose turn
// started it, startedAt when (ms), progress an agent's latest step.
export type BackgroundTask = { id: string; type: string; description: string; tabId?: number; startedAt?: number; progress?: string };

export type WireState = WireMeta & { tabs: WireTab[] };

type TabFields = { prompt: string; status: TabStatus; result: TurnResult | null; uuid: string | null; bash: boolean };

export type TabOp =
  | { op: 'set'; tab: WireTab }
  | { op: 'remove'; id: number }
  | { op: 'blocks'; id: number; from: number; blocks: WireBlock[]; fields: TabFields }
  | { op: 'append'; id: number; index: number; text: string; fields: TabFields };

export type Patch = { t: 'patch'; meta?: Partial<WireMeta>; tabs?: TabOp[] };

export type SlashCommand = { name: string; description: string; argumentHint?: string; aliases?: string[] };

/** What a host sends an attached viewer, plus `detached` from the app's own connection. */
export type HostMessage =
  | { t: 'snapshot'; state: WireState; commands: SlashCommand[]; effort: string | null }
  | Patch
  | { t: 'commands'; commands: SlashCommand[] }
  | { t: 'notice'; text: string }
  | { t: 'ended' }
  | { t: 'detached'; reason: string };

/** Applies a patch to a wire state, keeping every untouched tab and block as it was. */
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
