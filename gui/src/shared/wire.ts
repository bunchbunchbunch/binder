// The session state a binder host serves (bindertui docs/remote-protocol.md,
// section 4): a snapshot, then patches. These types mirror bindertui's
// src/remote/wire.ts; the protocol is the contract between the two repos.

// An image's kind and size; its bytes come with the `image` request.
export type WireImage = { mediaType: string; bytes: number };

export type ToolResult = { content: string; isError: boolean; length?: number; images?: WireImage[] };

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

// `auto`: a turn Claude Code or binder started about background work, headed by what finished.
// `seq`: its place in the session's send order across all tabs (newer hosts only).
export type WireTurn = { prompt: string; status: TabStatus; blocks: WireBlock[]; result?: TurnResult; uuid?: string; bash?: boolean; auto?: boolean; images?: WireImage[]; seq?: number };
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
  // ExitPlanMode: the plan to approve (markdown), in full.
  plan?: string;
  // Workflow: its name, description and phases, from its script.
  workflow?: { name?: string; description?: string; phases: string[] };
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
  // `auto`: binder's own follow-up about background work, not the user's.
  queue: { tabId: number; prompt: string; followup: boolean; auto?: boolean }[];
  steer: { tabId: number; prompt: string } | null;
  question: WireQuestion | null;
  childExit: { code: number | null; stderr: string[] } | null;
  effort: string | null;
  // Newer hosts only; older ones leave these out.
  suggestion?: string | null;
  backgroundTasks?: BackgroundTask[];
  // When the running turn started (ms), so the clock survives the app quitting.
  runningSince?: number | null;
  // The session's name (/rename), or null.
  title?: string | null;
  // Thinking tokens so far in the running turn (Claude Code's estimate), 0 when idle.
  thinkingTokens?: number;
  // The model's context window, once a turn has reported it.
  contextWindow?: number | null;
  // What the session has cost so far, in dollars at API list prices.
  costUsd?: number | null;
  // Fast mode: 'on', 'cooldown' (paused after a rate limit) or 'off'; null until the child says.
  fastMode?: 'on' | 'cooldown' | 'off' | null;
  // The host runs binder's code from before its latest build.
  outdated?: boolean;
  // The pull request for the session folder's branch (gh), or null.
  pr?: PrStatus | null;
};

export type PrStatus = {
  number: number;
  title: string;
  url: string;
  state: string;
  draft: boolean;
  head: string;
  mergeable: string;
  review: string;
  checks: { passing: number; failing: string[]; pending: number };
  changesRequested?: { at: string; by: string };
};

/** bindertui's prLine: "PR #12 · ✗ 2 failing (lint, test) · approved". */
export function prLine(pr: PrStatus): string {
  const c = pr.checks;
  const checks = c.failing.length ? `✗ ${c.failing.length} failing (${c.failing.slice(0, 3).join(', ')}${c.failing.length > 3 ? ', …' : ''})` : c.pending ? `◐ ${c.pending} running` : c.passing ? `✓ ${c.passing} passing` : 'no checks';
  const state = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.draft ? 'draft' : '';
  const review = pr.review === 'APPROVED' ? 'approved' : pr.review === 'CHANGES_REQUESTED' ? 'changes requested' : '';
  return [`PR #${pr.number}`, state, state === 'merged' || state === 'closed' ? '' : checks, review].filter(Boolean).join(' · ');
}

// A background shell or agent still running. toolUseId is the call that
// started it and tabId the tab whose turn made it, startedAt when (ms),
// progress an agent's latest step.
export type BackgroundTask = { id: string; type: string; description: string; toolUseId?: string; tabId?: number; startedAt?: number; progress?: string; workflow?: WorkflowRun };

// A running workflow: its phases so far, and each agent's state (start, done) and result.
export type WorkflowRun = { phases: string[]; agents: { label: string; phase?: string; state: string; model?: string; tokens?: number; durationMs?: number; result?: string }[] };

export type WireState = WireMeta & { tabs: WireTab[] };

type TabFields = { prompt: string; status: TabStatus; result: TurnResult | null; uuid: string | null; bash: boolean; auto?: boolean; seq?: number };

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
        const fields = { prompt: f.prompt, status: f.status, result: f.result ?? undefined, uuid: f.uuid ?? undefined, bash: f.bash || undefined, auto: f.auto || undefined, seq: f.seq };
        if (op.op === 'blocks') return { ...t, ...fields, blocks: t.blocks.slice(0, op.from).concat(op.blocks) };
        const blocks = t.blocks.map((b, i) => (i === op.index && b.kind !== 'tool_use' ? { ...b, text: b.text + op.text } : b));
        return { ...t, ...fields, blocks };
      });
    }
  }
  return { ...s, ...p.meta, tabs };
}
