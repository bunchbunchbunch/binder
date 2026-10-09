import type { ClaudeEvent, CommandLifecycleEvent, ContentBlock, PromptSuggestionEvent, RateLimitEvent, StreamEvent } from './events.js';
import { isInit } from './events.js';
import type { ImageAttachment } from './claudeProcess.js';

export type ToolResult = { content: string; isError: boolean };

export type Block =
  | { kind: 'thinking'; text: string; final: boolean }
  | { kind: 'text'; text: string; final: boolean }
  | {
      kind: 'tool_use';
      id: string;
      name: string;
      input: unknown;
      inputJson: string;
      final: boolean;
      result?: ToolResult;
      // Output of a subagent spawned by this tool call (parent_tool_use_id === id).
      children: Block[];
    };

// 'superseded': the turn was cut short or overtaken by a follow-up sent with Ctrl+Enter.
export type TabStatus = 'queued' | 'running' | 'done' | 'error' | 'interrupted' | 'superseded';

// One prompt and its response.
export type Turn = {
  prompt: string;
  status: TabStatus;
  blocks: Block[];
  result?: { durationMs: number; costUsd: number; numTurns: number; isError: boolean; text?: string };
  // The uuid the prompt was sent with (rewind targets it) and its place in
  // the session's send order across all tabs.
  uuid?: string;
  seq?: number;
  // A `!command` run by binder itself, not by the child.
  bash?: boolean;
  // A turn the child started on its own, to report background work that finished.
  auto?: boolean;
};

// A tab is its latest turn plus the turns before it (follow-ups sent with
// Ctrl+Enter stay in the tab instead of opening a new one).
export type Tab = Turn & {
  id: number;
  earlier: Turn[];
};

// A prompt waiting for the child to be idle: a new tab's first prompt, or a
// follow-up for an existing tab. `auto` marks binder's own follow-up about
// background work another tab's turn took in: `prompt` heads the turn, and
// `text` is what the model reads.
export type QueuedPrompt = { tabId: number; prompt: string; images: ImageAttachment[]; followup: boolean; auto?: { text: string; notices: Notice[] } };

export type Usage = NonNullable<RateLimitEvent['rate_limit_info']['unifiedWindows']>;

// A background shell or agent still running (background_tasks_changed).
export type BackgroundTask = {
  id: string;
  type: string;
  description: string;
  // The tool call that started it, and the tab whose turn made that call.
  toolUseId?: string;
  tabId?: number;
  // When it started (ms), from the timestamp of the message that started it.
  startedAt?: number;
  // An agent's latest step, e.g. "Searching for …" (task_progress).
  progress?: string;
};

// Background work that finished, until a turn takes in its result.
export type Notice = { toolUseId: string; status: string; summary?: string };

export type Question = {
  requestId: string;
  toolUseId?: string;
  // The tool asking: AskUserQuestion, or one waiting for permission (with its input).
  toolName?: string;
  toolInput?: Record<string, unknown>;
  // Why a permission prompt was raised, as the child explains it.
  reason?: string;
  questions: Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options: Array<{ label: string; description?: string }>;
  }>;
};

export type State = {
  sessionId: string;
  tabs: Tab[];
  active: number; // index into tabs, -1 when there are none
  queue: QueuedPrompt[];
  running: number | null; // tab id whose turn is in flight
  // A follow-up written to the child mid-turn (Ctrl+Enter), until the child
  // reports it started; its turn then replaces the running one in the tab.
  steer?: { tabId: number; prompt: string; uuid: string };
  // The child supports sending a message mid-turn (send_now and command_lifecycle).
  canSteer: boolean;
  interrupting: boolean;
  activity: string; // last system/status text, cleared on result
  model?: string;
  cwd?: string;
  permissionMode?: string;
  usage?: Usage;
  question?: Question;
  // Prompt size of the latest API call (input + cache tokens), like Claude Code's context counter.
  contextTokens?: number;
  // The streamed blocks of the in-progress assistant message, by content index.
  streamIndex: Record<number, number>;
  // Send order counter for Turn.seq.
  seq: number;
  // Output of `!commands` not yet seen by the model; it goes ahead of the next prompt.
  bashContext: string[];
  childExit?: { code: number | null; stderr: string[] };
  // The uuid of the prompt last written to the child until the child reports
  // it started (command_lifecycle). Nothing else is sent meanwhile: the child
  // may be busy with a turn of its own. Only tracked when it reports lifecycle.
  unstarted?: string;
  // Background tasks that finished and that no turn has taken in yet: what a
  // turn the child then starts on its own is about.
  notices: Notice[];
  // Background shells and agents still running (background_tasks_changed).
  backgroundTasks: BackgroundTask[];
  // The tool call that started each task not yet finished, by task id.
  taskCalls: Record<string, string>;
  // Tasks the user asked to stop: their end needs no word from anyone.
  stopping: string[];
  // When the latest message was written (ms), to date background tasks.
  messageAt?: number;
  // The next prompt Claude Code predicts after a turn, until anything is sent.
  suggestion?: string;
};

export type Action =
  // tabId: the id a replayed tab had when it was created.
  | { type: 'submit'; prompt: string; images?: ImageAttachment[]; tabId?: number }
  | { type: 'followup'; tabId: number; prompt: string; images?: ImageAttachment[] }
  | { type: 'steer'; tabId: number; prompt: string; uuid: string }
  // A prompt still queued for tab `tabId` becomes `text`; empty text drops it.
  | { type: 'edit_queued'; tabId: number; prompt: string; text: string }
  // `auto`: whether the prompt sent was binder's own follow-up (replay names it).
  | { type: 'sent'; tabId: number; uuid?: string; auto?: boolean }
  // The user stopped a background task (stop_task).
  | { type: 'task_stopping'; taskId: string }
  | { type: 'bash_start'; command: string; tabId?: number }
  | { type: 'bash_done'; tabId: number; output: string; exitCode: number | null }
  // Drop the turn sent with this uuid and every turn sent after it.
  | { type: 'rewind'; uuid: string }
  // /model changed it; the next init confirms.
  | { type: 'model'; model: string }
  | { type: 'event'; event: ClaudeEvent }
  | { type: 'events'; events: ClaudeEvent[] }
  | { type: 'select'; index: number }
  | { type: 'select_relative'; delta: number }
  | { type: 'interrupt_requested' }
  | { type: 'question'; question: Question }
  | { type: 'question_answered' }
  | { type: 'child_exit'; code: number | null; stderr: string[] }
  | { type: 'child_restarted' }
  // The child moved to another session (/clear, /resume): its tabs replace these.
  | { type: 'reset'; state: State };

export function initialState(sessionId: string): State {
  return {
    sessionId,
    tabs: [],
    active: -1,
    queue: [],
    running: null,
    canSteer: false,
    interrupting: false,
    activity: '',
    streamIndex: {},
    seq: 0,
    bashContext: [],
    notices: [],
    backgroundTasks: [],
    taskCalls: {},
    stopping: [],
  };
}

function nextTabId(state: State): number {
  return state.tabs.length ? Math.max(...state.tabs.map((t) => t.id)) + 1 : 1;
}

// Tabs stay in creation (id) order, so a replayed tab lands where it was.
function addTab(state: State, tab: Tab): State {
  const tabs = state.tabs.concat(tab).sort((a, b) => a.id - b.id);
  return { ...state, tabs, active: tabs.indexOf(tab) };
}

function runningTab(state: State): Tab | undefined {
  return state.running === null ? undefined : state.tabs.find((t) => t.id === state.running);
}

function replaceTab(state: State, tab: Tab): State {
  return { ...state, tabs: state.tabs.map((t) => (t.id === tab.id ? tab : t)) };
}

// Moves the tab's current turn into its history and starts `prompt` as the new one.
function startTurn(tab: Tab, prompt: string, previous: TabStatus = tab.status): Tab {
  const { id: _id, earlier, ...turn } = tab;
  const done: Turn = { ...turn, status: previous, blocks: tab.blocks.map((b) => ({ ...b, final: true })) };
  return { id: tab.id, earlier: earlier.concat(done), prompt, status: 'running', blocks: [] };
}

export function firstPrompt(tab: Tab): string {
  return tab.earlier[0]?.prompt ?? tab.prompt;
}

function newBlock(cb: ContentBlock): Block | null {
  switch (cb.type) {
    case 'text':
      return { kind: 'text', text: cb.text ?? '', final: false };
    case 'thinking':
      return { kind: 'thinking', text: cb.thinking ?? '', final: false };
    case 'tool_use':
      return { kind: 'tool_use', id: cb.id, name: cb.name, input: cb.input ?? {}, inputJson: '', final: false, children: [] };
    default:
      return null;
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

// Finalize streamed blocks with the authoritative content from an `assistant`
// event. Claude Code emits one `assistant` line per content block, so each
// incoming block replaces the oldest unfinished block of the same kind, or is
// appended when nothing was streamed (replay without partial messages).
function finalizeBlocks(blocks: Block[], content: ContentBlock[]): Block[] {
  const out = blocks.slice();
  for (const cb of content) {
    const fresh = newBlock(cb);
    if (!fresh) continue;
    fresh.final = true;
    const idx = out.findIndex((b) => !b.final && b.kind === fresh.kind);
    if (idx >= 0) {
      if (fresh.kind === 'tool_use' && out[idx].kind === 'tool_use') fresh.children = (out[idx] as Extract<Block, { kind: 'tool_use' }>).children;
      out[idx] = fresh;
    } else {
      out.push(fresh);
    }
  }
  return out;
}

function attachToolResults(blocks: Block[], content: ContentBlock[]): Block[] {
  let out = blocks;
  for (const cb of content) {
    if (cb.type !== 'tool_result') continue;
    out = mapTool(out, cb.tool_use_id, (b) => ({ ...b, result: { content: toolResultText(cb.content), isError: Boolean(cb.is_error) } }));
  }
  return out;
}

type ToolBlock = Extract<Block, { kind: 'tool_use' }>;

function mapTool(blocks: Block[], toolId: string, fn: (b: ToolBlock) => ToolBlock): Block[] {
  return blocks.map((b) => {
    if (b.kind !== 'tool_use') return b;
    if (b.id === toolId) return fn(b);
    if (b.children.length) return { ...b, children: mapTool(b.children, toolId, fn) };
    return b;
  });
}

// Tool call `toolId` in any turn of `tabs`, a subagent's included.
export function findCall(tabs: Tab[], toolId: string): ToolBlock | undefined {
  const find = (blocks: Block[]): ToolBlock | undefined => {
    for (const b of blocks) {
      if (b.kind !== 'tool_use') continue;
      if (b.id === toolId) return b;
      const hit = find(b.children);
      if (hit) return hit;
    }
    return undefined;
  };
  for (const tab of tabs) for (const turn of [tab, ...tab.earlier]) {
    const hit = find(turn.blocks);
    if (hit) return hit;
  }
  return undefined;
}

function hasTool(blocks: Block[], toolId: string): boolean {
  return blocks.some((b) => b.kind === 'tool_use' && (b.id === toolId || hasTool(b.children, toolId)));
}

// mapTool in whichever tab and turn holds the call (the running tab first): a
// background agent keeps working after the turn that launched it has ended.
function mapToolAnywhere(state: State, toolId: string, fn: (b: ToolBlock) => ToolBlock): State {
  const running = runningTab(state);
  for (const tab of running ? [running, ...state.tabs.filter((t) => t !== running)] : state.tabs) {
    if (hasTool(tab.blocks, toolId)) return replaceTab(state, { ...tab, blocks: mapTool(tab.blocks, toolId, fn) });
    const at = tab.earlier.findIndex((t) => hasTool(t.blocks, toolId));
    if (at >= 0) return replaceTab(state, { ...tab, earlier: tab.earlier.map((t, i) => (i === at ? { ...t, blocks: mapTool(t.blocks, toolId, fn) } : t)) });
  }
  return state;
}

// The tab whose own turn (not a subagent) made tool call `toolId`, and the call.
function launchedBy(state: State, toolId: string): { tab: Tab; call: ToolBlock } | undefined {
  for (const tab of state.tabs) {
    for (const turn of [tab, ...tab.earlier]) {
      const call = turn.blocks.find((b): b is ToolBlock => b.kind === 'tool_use' && b.id === toolId);
      if (call) return { tab, call };
    }
  }
  return undefined;
}

// The non-bash tab whose latest turn was sent last.
function lastRun(state: State): Tab | undefined {
  return state.tabs.filter((t) => !t.bash).reduce<Tab | undefined>((last, t) => (!last || (t.seq ?? -1) >= (last.seq ?? -1) ? t : last), undefined);
}

type Finished = { call: ToolBlock; status: string };

// What a background call is called: its description, else its command.
function taskName(call: ToolBlock): string {
  const input = (call.input ?? {}) as { description?: unknown; command?: unknown };
  return String(input.description || input.command || call.name);
}

// Heads a turn about background work that finished: what finished, and how
// unless it completed.
function finishedPrompt(finished: Finished[]): string {
  const names = finished.map(({ call, status }) => (status === 'completed' ? taskName(call) : `${taskName(call)} (${status})`));
  return names.length ? `Background ${names.length > 1 ? 'tasks' : 'task'} finished: ${names.join(', ')}` : 'Background work finished';
}

// What binder asks the model when a turn in another tab took in background
// work: to carry on with it in the tab that started it, where the user follows it.
function followupText(finished: Finished[]): string {
  const one = finished.length === 1;
  const what = finished.map(({ call, status }) => `"${taskName(call)}" (${status})`).join(', ');
  return (
    `[binder] Background ${one ? 'task' : 'tasks'} ${what} finished while you were working on a different request, so ${one ? 'its result' : 'their results'} reached you there. ` +
    `The user follows this work in the thread where ${one ? 'it' : 'they'} started, so continue it here: do what you said you would do once ${one ? 'it' : 'they'} finished. ` +
    `If your other reply already did that, summarize the outcome in a few sentences instead of repeating the work.`
  );
}

// Queues binder's own follow-up into `tab` about `notices`, or adds them to
// the one already queued there.
function queueFollowup(state: State, tab: Tab, notices: Notice[]): State {
  const at = state.queue.findIndex((q) => q.tabId === tab.id && q.auto);
  const all = (at >= 0 ? state.queue[at].auto!.notices : []).concat(notices);
  const finished = all.flatMap((n): Finished[] => {
    const l = launchedBy(state, n.toolUseId);
    return l ? [{ call: l.call, status: n.status }] : [];
  });
  const item: QueuedPrompt = { tabId: tab.id, prompt: finishedPrompt(finished), images: [], followup: true, auto: { text: followupText(finished), notices: all } };
  return { ...state, queue: at >= 0 ? state.queue.map((q, i) => (i === at ? item : q)) : state.queue.concat(item) };
}

// The turn in tab `tabId` took in the background work that finished. Work
// another tab launched carries on there, in a turn of binder's own once the
// child is idle; work that was stopped (by that turn, or by a time limit)
// only gets a note there, as nothing is left to do.
function takeIn(state: State, tabId: number): State {
  if (!state.notices.length) return state;
  let s: State = { ...state, notices: [] };
  const elsewhere = new Map<number, Notice[]>();
  for (const n of state.notices) {
    const at = launchedBy(s, n.toolUseId);
    if (!at || at.tab.id === tabId) continue;
    if (n.status !== 'stopped') {
      elsewhere.set(at.tab.id, (elsewhere.get(at.tab.id) ?? []).concat(n));
      continue;
    }
    const why = n.summary && n.summary !== taskName(at.call) ? ` ${n.summary.replace(/\.?$/, '.')}` : '';
    const text = `*Stopped during the turn in tab ${tabId}.${why}*`;
    const note: Tab = { ...startTurn(at.tab, finishedPrompt([{ call: at.call, status: n.status }])), status: 'done', blocks: [{ kind: 'text', text, final: true }], auto: true, seq: s.seq };
    s = { ...replaceTab(s, note), seq: s.seq + 1 };
  }
  for (const [id, notices] of elsewhere) s = queueFollowup(s, s.tabs.find((t) => t.id === id)!, notices);
  return s;
}

// A turn the child started with no prompt of ours running: it is reporting
// background work that finished. It goes into the tab that launched the work
// (else the tab that ran last), headed by what finished there.
function startAutoTurn(state: State): State {
  const finished = state.notices.flatMap((n) => {
    const at = launchedBy(state, n.toolUseId);
    return at ? [{ ...at, status: n.status }] : [];
  });
  const owner = finished[finished.length - 1]?.tab ?? lastRun(state);
  const prompt = finishedPrompt(finished.filter((f) => f.tab === owner));
  const next = { ...(owner ? takeIn(state, owner.id) : state), notices: [], streamIndex: {} };
  const seq = next.seq;
  if (!owner) {
    const tab: Tab = { id: nextTabId(state), prompt, status: 'running', blocks: [], earlier: [], auto: true, seq };
    return { ...addTab({ ...next, seq: seq + 1 }, tab), running: tab.id };
  }
  return { ...replaceTab(next, { ...startTurn(owner, prompt), auto: true, seq }), running: owner.id, seq: seq + 1 };
}

// The tab without its latest turn: its last earlier turn is the latest again,
// or the tab goes when it has none.
function dropLatest(state: State, tab: Tab): State {
  const last = tab.earlier[tab.earlier.length - 1];
  if (last) return replaceTab(state, { ...last, id: tab.id, earlier: tab.earlier.slice(0, -1) });
  const at = state.tabs.indexOf(tab);
  const tabs = state.tabs.filter((t) => t !== tab);
  return { ...state, tabs, active: state.active > at ? state.active - 1 : Math.min(state.active, tabs.length - 1) };
}

// Each task's call and tab, once the tool call that started it is known.
function placeTasks(state: State, tasks: BackgroundTask[]): BackgroundTask[] {
  return tasks.map((t) => {
    const call = state.taskCalls[t.id];
    if (t.toolUseId !== undefined || call === undefined) return t;
    const tab = state.tabs.find((tab) => [tab, ...tab.earlier].some((turn) => hasTool(turn.blocks, call)));
    return { ...t, toolUseId: call, ...(tab && { tabId: tab.id }) };
  });
}

function applyStream(tab: Tab, state: State, ev: StreamEvent): { tab: Tab; streamIndex: Record<number, number> } {
  const e = ev.event;
  let blocks = tab.blocks;
  let streamIndex = state.streamIndex;
  switch (e.type) {
    case 'message_start':
      streamIndex = {};
      break;
    case 'content_block_start': {
      const b = newBlock(e.content_block);
      if (b) {
        blocks = blocks.concat(b);
        streamIndex = { ...streamIndex, [e.index]: blocks.length - 1 };
      }
      break;
    }
    case 'content_block_delta': {
      const at = streamIndex[e.index];
      const b = at === undefined ? undefined : blocks[at];
      if (!b) break;
      const d = e.delta;
      let updated: Block | null = null;
      if (d.type === 'text_delta' && b.kind === 'text') updated = { ...b, text: b.text + d.text };
      else if (d.type === 'thinking_delta' && b.kind === 'thinking') updated = { ...b, text: b.text + d.thinking };
      else if (d.type === 'input_json_delta' && b.kind === 'tool_use') updated = { ...b, inputJson: b.inputJson + d.partial_json };
      if (updated) blocks = blocks.map((x, i) => (i === at ? updated! : x));
      break;
    }
    default:
      break;
  }
  return { tab: { ...tab, blocks }, streamIndex };
}

function applyEvent(state: State, ev: ClaudeEvent): State {
  if (isInit(ev)) {
    const caps = ev.capabilities ?? [];
    const canSteer = caps.includes('interrupt_send_now_v1') && caps.includes('msg_lifecycle_v1');
    const next = { ...state, model: ev.model, cwd: ev.cwd, permissionMode: ev.permissionMode, canSteer, suggestion: undefined };
    // Every turn starts with an init. With no prompt of ours running, the turn
    // is the child's own, reporting background work that finished.
    return state.running === null ? startAutoTurn(next) : takeIn(next, state.running);
  }
  if (ev.type === 'command_lifecycle') {
    const { command_uuid: uuid, state: phase } = ev as CommandLifecycleEvent;
    const steer = state.steer;
    if (steer && uuid === steer.uuid) {
      const tab = state.tabs.find((t) => t.id === steer.tabId);
      if (phase === 'started' && tab) {
        // Either the running turn took the follow-up in (it never gets a result
        // of its own) or the turn was stopped for it and already has one.
        const next = { ...startTurn(tab, steer.prompt, tab.status === 'running' ? 'superseded' : tab.status), uuid: steer.uuid, seq: state.seq };
        return { ...replaceTab(state, next), running: tab.id, steer: undefined, streamIndex: {}, seq: state.seq + 1 };
      }
      if (phase === 'cancelled' || phase === 'discarded') return { ...state, steer: undefined };
      return state;
    }
    if (uuid !== state.unstarted) return state;
    if (phase === 'cancelled' || phase === 'discarded') return { ...state, unstarted: undefined };
    if (phase !== 'started') return state;
    const next = { ...state, unstarted: undefined };
    const tab = state.tabs.find((t) => t.uuid === uuid);
    if (!tab || state.running === tab.id) return next;
    // A turn of the child's own ran first: it either took this prompt in (and
    // gets no result of its own) or ended with a result that closed this tab.
    const other = runningTab(next);
    const s = other ? replaceTab(next, { ...other, status: 'done', blocks: other.blocks.map((b) => ({ ...b, final: true })) }) : next;
    return { ...replaceTab(s, { ...tab, status: 'running', result: undefined }), running: tab.id, streamIndex: {} };
  }
  // It follows the turn's result; a prompt sent meanwhile makes it stale.
  if (ev.type === 'prompt_suggestion') {
    const idle = state.running === null && !state.queue.length && !state.steer && !state.unstarted;
    return idle ? { ...state, suggestion: (ev as PromptSuggestionEvent).suggestion || undefined } : state;
  }
  if (ev.type === 'rate_limit_event') {
    const w = (ev as RateLimitEvent).rate_limit_info?.unifiedWindows;
    return w ? { ...state, usage: { ...state.usage, ...w } } : state;
  }
  if (ev.type === 'system') {
    const sub = (ev as { subtype: string }).subtype;
    if (sub === 'status') {
      // A mode change mid-turn (EnterPlanMode, ExitPlanMode) comes as a status event.
      const { status, permissionMode } = ev as { status?: unknown; permissionMode?: unknown };
      return { ...state, activity: String(status ?? ''), ...(typeof permissionMode === 'string' && { permissionMode }) };
    }
    if (sub === 'background_tasks_changed') {
      const tasks = (ev as { tasks?: { task_id: string; task_type?: string; description?: string }[] }).tasks ?? [];
      const before = new Map(state.backgroundTasks.map((t) => [t.id, t]));
      const list = tasks.map((t) => ({ startedAt: state.messageAt, ...before.get(t.task_id), id: t.task_id, type: t.task_type ?? '', description: t.description ?? '' }));
      return { ...state, backgroundTasks: placeTasks(state, list) };
    }
    if (sub === 'task_started') {
      const t = ev as { task_id?: string; tool_use_id?: string };
      if (!t.task_id || !t.tool_use_id) return state;
      const next = { ...state, taskCalls: { ...state.taskCalls, [t.task_id]: t.tool_use_id } };
      return state.backgroundTasks.some((b) => b.id === t.task_id) ? { ...next, backgroundTasks: placeTasks(next, next.backgroundTasks) } : next;
    }
    if (sub === 'task_progress') {
      const p = ev as { task_id?: string; description?: string };
      const task = state.backgroundTasks.find((t) => t.id === p.task_id);
      const progress = p.description && p.description !== task?.description ? p.description : undefined;
      if (!task || progress === task.progress) return state;
      return { ...state, backgroundTasks: state.backgroundTasks.map((t) => (t === task ? { ...t, progress } : t)) };
    }
    // What finishes waits for a turn to take it in: the running turn's next
    // request, else a turn the child starts on its own about it.
    if (sub === 'task_notification') {
      const n = ev as { task_id?: string; tool_use_id?: string; status?: string; summary?: string };
      const { [n.task_id ?? '']: _done, ...taskCalls } = state.taskCalls;
      // One the user stopped needs no word from anyone, and the child starts no turn about it.
      const stopped = n.task_id !== undefined && state.stopping.includes(n.task_id);
      const next = { ...state, taskCalls, stopping: stopped ? state.stopping.filter((id) => id !== n.task_id) : state.stopping };
      return n.tool_use_id && !stopped ? { ...next, notices: next.notices.concat({ toolUseId: n.tool_use_id, status: n.status ?? 'completed', summary: n.summary }) } : next;
    }
    return state;
  }

  const parent = (ev as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;

  if (ev.type === 'assistant' || ev.type === 'user') {
    const msg = (ev as { message: { content: ContentBlock[] | string; usage?: Record<string, number> } }).message;
    if (!msg || typeof msg.content === 'string') return state;
    const at = Date.parse(String((ev as { timestamp?: unknown }).timestamp));
    if (!Number.isNaN(at)) state = { ...state, messageAt: at };
    const apply = (blocks: Block[]) =>
      ev.type === 'assistant' ? finalizeBlocks(blocks, msg.content as ContentBlock[]) : attachToolResults(blocks, msg.content as ContentBlock[]);
    // A subagent's messages go to the call that spawned it, wherever it is.
    if (parent) return mapToolAnywhere(state, parent, (b) => ({ ...b, children: apply(b.children) }));
    const tab = runningTab(state);
    if (!tab) return state;
    if (ev.type === 'assistant' && msg.usage) {
      const u = msg.usage;
      const total = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      if (total > 0) state = { ...state, contextTokens: total };
    }
    const next = replaceTab(state, { ...tab, blocks: apply(tab.blocks) });
    // Tool results go back to the model with whatever finished meanwhile,
    // unless the turn is being stopped.
    const toModel = ev.type === 'user' && !state.interrupting && (msg.content as ContentBlock[]).some((c) => c.type === 'tool_result');
    return toModel ? takeIn(next, tab.id) : next;
  }

  const tab = runningTab(state);
  if (!tab) return state;

  if (ev.type === 'stream_event') {
    if (parent) return state; // subagent streaming is not shown; its final messages are
    const r = applyStream(tab, state, ev as StreamEvent);
    return { ...replaceTab(state, r.tab), streamIndex: r.streamIndex };
  }

  if (ev.type === 'result') {
    const r = ev as { is_error: boolean; duration_ms: number; total_cost_usd?: number; num_turns: number; result?: string; subtype?: string };
    const idle = { running: null, interrupting: false, activity: '', streamIndex: {}, question: undefined };
    // A turn the child started for work an earlier turn already took in: it
    // ran nothing, so it leaves no trace.
    if (tab.auto && !r.is_error && r.num_turns === 0 && !tab.blocks.length) return { ...dropLatest(state, tab), ...idle };
    // A turn stopped to make way for a Ctrl+Enter follow-up ends in an error result.
    const steered = state.steer?.tabId === tab.id && r.is_error;
    const status: TabStatus = state.interrupting ? 'interrupted' : steered ? 'superseded' : r.is_error ? 'error' : 'done';
    const blocks = tab.blocks.map((b) => ({ ...b, final: true }));
    // An error result carries its message in `result`; show it when nothing streamed.
    if (r.is_error && !steered && r.result && !blocks.some((b) => b.kind === 'text' && b.text)) {
      blocks.push({ kind: 'text', text: r.result, final: true });
    }
    const done: Tab = {
      ...tab,
      status,
      blocks,
      result: { durationMs: r.duration_ms, costUsd: r.total_cost_usd ?? 0, numTurns: r.num_turns, isError: r.is_error, text: r.result },
    };
    return { ...replaceTab(state, done), ...idle };
  }

  return state;
}

export function reduce(state: State, action: Action): State {
  switch (action.type) {
    case 'submit': {
      const id = action.tabId ?? nextTabId(state);
      const tab: Tab = { id, prompt: action.prompt, status: 'queued', blocks: [], earlier: [] };
      const queued: QueuedPrompt = { tabId: id, prompt: action.prompt, images: action.images ?? [], followup: false };
      return { ...addTab(state, tab), queue: state.queue.concat(queued), suggestion: undefined };
    }
    case 'bash_start': {
      const tab: Tab = { id: action.tabId ?? nextTabId(state), prompt: `!${action.command}`, status: 'running', blocks: [], earlier: [], bash: true, seq: state.seq };
      return { ...addTab(state, tab), seq: state.seq + 1, suggestion: undefined };
    }
    case 'bash_done': {
      const tab = state.tabs.find((t) => t.id === action.tabId);
      if (!tab || !tab.bash) return state;
      const command = tab.prompt.slice(1);
      const body = action.output.trimEnd();
      const failed = action.exitCode !== 0;
      const note = action.exitCode === null ? 'interrupted' : failed ? `exit code ${action.exitCode}` : '';
      const text = (body ? '```\n' + body + '\n```' : '') + (note ? `${body ? '\n\n' : ''}*${note}*` : '');
      const done: Tab = { ...tab, status: action.exitCode === null ? 'interrupted' : failed ? 'error' : 'done', blocks: text ? [{ kind: 'text', text, final: true }] : [] };
      // What the model sees ahead of the next prompt, as Claude Code records bash mode.
      const context = `<bash-input>${command}</bash-input>\n<bash-stdout>${body}</bash-stdout>${failed ? `<bash-stderr>${note}</bash-stderr>` : ''}`;
      return { ...replaceTab(state, done), bashContext: state.bashContext.concat(context) };
    }
    case 'rewind': {
      const target = state.tabs.flatMap((t) => [...t.earlier, t]).find((turn) => turn.uuid === action.uuid);
      if (target?.seq === undefined) return state;
      const keep = (turn: Turn) => turn.seq === undefined || turn.seq < target.seq!;
      const tabs: Tab[] = [];
      for (const tab of state.tabs) {
        if (keep(tab)) {
          tabs.push({ ...tab, earlier: tab.earlier.filter(keep) });
          continue;
        }
        // The tab's latest turn goes; its last remaining earlier turn becomes the latest.
        const earlier = tab.earlier.filter(keep);
        const last = earlier.pop();
        if (last) tabs.push({ ...last, id: tab.id, earlier });
      }
      return { ...state, tabs, active: Math.min(state.active, tabs.length - 1), bashContext: [], suggestion: undefined };
    }
    case 'followup': {
      if (!state.tabs.some((t) => t.id === action.tabId)) return state;
      const queued: QueuedPrompt = { tabId: action.tabId, prompt: action.prompt, images: action.images ?? [], followup: true };
      return { ...state, queue: state.queue.concat(queued), suggestion: undefined };
    }
    case 'steer':
      return { ...state, steer: { tabId: action.tabId, prompt: action.prompt, uuid: action.uuid }, suggestion: undefined };
    case 'edit_queued': {
      // Binder's own follow-ups are not the user's to edit.
      const at = state.queue.findIndex((q) => q.tabId === action.tabId && q.prompt === action.prompt && !q.auto);
      if (at < 0) return state;
      const item = state.queue[at];
      if (action.text) {
        const queue = state.queue.map((q, i) => (i === at ? { ...q, prompt: action.text } : q));
        if (item.followup) return { ...state, queue };
        // The prompt that opens a tab is the tab's prompt too.
        return { ...state, queue, tabs: state.tabs.map((t) => (t.id === item.tabId ? { ...t, prompt: action.text } : t)) };
      }
      if (item.followup) return { ...state, queue: state.queue.filter((_, i) => i !== at) };
      // The prompt that opens a tab: the tab goes, and whatever was queued into it.
      const gone = state.tabs.findIndex((t) => t.id === item.tabId);
      const tabs = state.tabs.filter((t) => t.id !== item.tabId);
      const active = state.active > gone ? state.active - 1 : Math.min(state.active, tabs.length - 1);
      return { ...state, tabs, active, queue: state.queue.filter((q) => q.tabId !== item.tabId) };
    }
    case 'sent': {
      const at = state.queue.findIndex((q) => q.tabId === action.tabId && (action.auto === undefined || Boolean(q.auto) === action.auto));
      const tab = state.tabs.find((t) => t.id === action.tabId);
      if (at < 0 || !tab) return state;
      const item = state.queue[at];
      const started = item.followup ? startTurn(tab, item.prompt) : { ...tab, status: 'running' as const };
      return {
        ...replaceTab(state, { ...started, uuid: action.uuid, seq: state.seq, ...(item.auto && { auto: true }) }),
        queue: state.queue.filter((_, i) => i !== at),
        running: action.tabId,
        streamIndex: {},
        seq: state.seq + 1,
        bashContext: [],
        unstarted: state.canSteer && action.uuid ? action.uuid : undefined,
      };
    }
    case 'task_stopping':
      return state.stopping.includes(action.taskId) ? state : { ...state, stopping: state.stopping.concat(action.taskId) };
    case 'event':
      return applyEvent(state, action.event);
    case 'events':
      return action.events.reduce(applyEvent, state);
    case 'select':
      return state.tabs.length ? { ...state, active: Math.max(0, Math.min(state.tabs.length - 1, action.index)) } : state;
    case 'select_relative': {
      if (!state.tabs.length) return state;
      const n = state.tabs.length;
      return { ...state, active: (((state.active + action.delta) % n) + n) % n };
    }
    case 'interrupt_requested':
      return state.running === null ? state : { ...state, interrupting: true };
    case 'question':
      return { ...state, question: action.question };
    case 'question_answered':
      return { ...state, question: undefined };
    case 'child_exit': {
      // Whatever was in flight is over; keep queued prompts so a respawn can send them.
      const tab = runningTab(state);
      const s = tab ? replaceTab(state, { ...tab, status: 'error' }) : state;
      return {
        ...s,
        running: null,
        steer: undefined,
        unstarted: undefined,
        interrupting: false,
        activity: '',
        notices: [],
        backgroundTasks: [], // they ran inside the child
        taskCalls: {},
        stopping: [],
        childExit: { code: action.code, stderr: action.stderr },
      };
    }
    case 'child_restarted':
      return { ...state, childExit: undefined };
    case 'model':
      return { ...state, model: action.model };
    case 'reset': {
      // Account-wide and per-process facts carry over until the new child reports its own.
      const next = action.state;
      return { ...next, usage: next.usage ?? state.usage, model: next.model ?? state.model, cwd: next.cwd ?? state.cwd, permissionMode: next.permissionMode ?? state.permissionMode, canSteer: state.canSteer };
    }
    default:
      return state;
  }
}

// The next prompt to write to the child, if the child is idle. A follow-up
// sent mid-turn keeps it busy until that follow-up has run, and a prompt
// sent until the child has started it.
export function nextToSend(state: State): QueuedPrompt | undefined {
  if (state.running !== null || state.steer || state.unstarted || state.childExit) return undefined;
  return state.queue[0];
}

export function tabText(tab: Tab): string {
  return tab.blocks.filter((b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text').map((b) => b.text).join('\n');
}
