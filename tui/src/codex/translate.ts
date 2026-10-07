import type { ClaudeEvent, ContentBlock, StreamEvent } from '../events.js';
import type { Params } from './rpc.js';

// Codex app-server notifications as the stream-json events binder's reducer
// reads (src/store.ts), so the tabs, the event log and remote viewers work the
// same whichever agent runs the session. Codex items become Claude Code's
// blocks and tools:
//   agentMessage → text            reasoning summary → thinking
//   commandExecution → Bash        fileChange → Patch
//   mcpToolCall → mcp__server__tool    webSearch → WebSearch
//   imageView → Read               turn/plan/updated → TodoWrite

export type Item = { type: string; id: string; [key: string]: unknown };

// What a turn's init reports, as the session knows it at the time.
export type SessionFacts = { sessionId: string; model?: string; cwd: string; permissionMode?: string };

type RateLimitWindow = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null };
export type RateLimits = { primary: RateLimitWindow | null; secondary: RateLimitWindow | null; rateLimitReachedType?: string | null };

// The init capabilities that turn on Ctrl+Enter: Codex's turn/steer, with the
// follow-up's start reported as a command_lifecycle frame.
const STEER_CAPS = ['interrupt_send_now_v1', 'msg_lifecycle_v1'];

const WINDOW_KEYS: Record<number, 'five_hour' | 'seven_day' | 'thirty_day'> = { 300: 'five_hour', 10080: 'seven_day', 43200: 'thirty_day' };

/** Codex's usage windows under the names the status bar knows, by length. */
export function usageWindows(limits: RateLimits): Record<string, { utilization: number; resetsAt: number }> {
  const out: Record<string, { utilization: number; resetsAt: number }> = {};
  for (const w of [limits.primary, limits.secondary]) {
    const key = w && WINDOW_KEYS[w.windowDurationMins ?? 0];
    if (key) out[key] = { utilization: w.usedPercent / 100, resetsAt: w.resetsAt ?? 0 };
  }
  return out;
}

export function rateLimitEvent(limits: RateLimits): ClaudeEvent {
  return { type: 'rate_limit_event', rate_limit_info: { status: limits.rateLimitReachedType ? 'rejected' : 'allowed', unifiedWindows: usageWindows(limits) } };
}

// "/bin/zsh -lc 'mkdir -p out && echo hi'" → "mkdir -p out && echo hi"
export function shellCommand(command: string): string {
  const m = /^\S*\/(?:ba|z)?sh -l?c '([\s\S]*)'$/.exec(command);
  return m ? m[1].replace(/'\\''/g, "'") : command;
}

// A failed turn's message is sometimes the API's JSON error body.
export function errorText(message: string): string {
  try {
    const body = JSON.parse(message);
    return body?.error?.message ?? body?.message ?? message;
  } catch {
    return message;
  }
}

/** A fileChange item as the Patch tool's input; file_path names the first file for one-line summaries. */
export function patchInput(item: Item | undefined): Record<string, unknown> {
  const changes = ((item?.changes as Array<{ path: string; kind: { type: string }; diff: string }> | undefined) ?? []).map((c) => ({ path: c.path, kind: c.kind?.type ?? 'update', diff: c.diff }));
  return { file_path: changes[0]?.path ?? '', changes };
}

export class Translator {
  // Prompts written with turn/start, oldest first: each started when its turn does.
  private starts: string[] = [];
  // Follow-ups written with turn/steer: each started when its userMessage item does.
  private steers = new Set<string>();
  // The running turn's items, for approvals that name one.
  private items = new Map<string, Item>();
  // Tool calls already shown, so a completion adds only the result.
  private tools = new Set<string>();
  // Streamed text and thinking: item id → content block index.
  private streams = new Map<string, number>();
  private nextIndex = 0;
  private plans = 0;

  constructor(private readonly facts: () => SessionFacts) {}

  expectStart(uuid: string): void {
    this.starts.push(uuid);
  }

  expectSteer(uuid: string): void {
    this.steers.add(uuid);
  }

  // A turn/start or turn/steer the server refused, or a follow-up Codex
  // dropped: it will never start. False if it already has.
  forget(uuid: string): boolean {
    const waiting = this.starts.includes(uuid) || this.steers.has(uuid);
    this.starts = this.starts.filter((u) => u !== uuid);
    this.steers.delete(uuid);
    return waiting;
  }

  item(id: string): Item | undefined {
    return this.items.get(id);
  }

  translate(method: string, p: Params): ClaudeEvent[] {
    switch (method) {
      case 'turn/started': {
        this.items.clear();
        this.streams.clear();
        const out: ClaudeEvent[] = [];
        // The lifecycle frame goes first: for a follow-up that became a turn
        // of its own, it is what makes the turn binder's (see store.ts).
        const uuid = this.starts.shift();
        if (uuid) out.push({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' });
        const f = this.facts();
        out.push({ type: 'system', subtype: 'init', session_id: f.sessionId, cwd: f.cwd, model: f.model ?? '', permissionMode: f.permissionMode ?? 'default', capabilities: STEER_CAPS });
        return out;
      }
      case 'turn/completed': {
        const turn = p.turn as { status: string; error: { message: string } | null; durationMs: number | null };
        this.streams.clear();
        const result = turn.error ? errorText(turn.error.message) : undefined;
        return [
          {
            type: 'result',
            subtype: turn.status === 'completed' ? 'success' : turn.status,
            is_error: turn.status !== 'completed',
            duration_ms: turn.durationMs ?? 0,
            num_turns: 1,
            ...(result && { result }),
            session_id: this.facts().sessionId,
          },
        ];
      }
      case 'item/started':
        return this.started(p.item as Item);
      case 'item/completed':
        return this.completed(p.item as Item);
      case 'item/agentMessage/delta':
        return this.delta(String(p.itemId), 'text', String(p.delta ?? ''));
      case 'item/reasoning/summaryTextDelta':
        return this.delta(String(p.itemId), 'thinking', String(p.delta ?? ''));
      case 'item/reasoning/summaryPartAdded':
        return this.streams.has(String(p.itemId)) ? this.delta(String(p.itemId), 'thinking', '\n\n') : [];
      case 'turn/plan/updated': {
        const plan = (p.plan as Array<{ step: string; status: string }>) ?? [];
        const todos = plan.map((s) => ({ content: s.step, status: s.status === 'inProgress' ? 'in_progress' : s.status }));
        return this.tool(`plan-${String(p.turnId)}-${this.plans++}`, 'TodoWrite', { todos }, '');
      }
      case 'thread/tokenUsage/updated': {
        // The latest call's prompt size, which the reducer reads as the context in use.
        const last = (p.tokenUsage as { last?: { inputTokens?: number } }).last;
        return last?.inputTokens ? [this.assistant([], { input_tokens: last.inputTokens })] : [];
      }
      case 'account/rateLimits/updated':
        return [rateLimitEvent(p.rateLimits as RateLimits)];
      case 'error': {
        // A failure that ends the turn arrives again with turn/completed.
        if (!p.willRetry) return [];
        const message = (p.error as { message?: string } | undefined)?.message ?? '';
        return [{ type: 'system', subtype: 'status', status: `Retrying: ${errorText(message)}` }];
      }
      default:
        return [];
    }
  }

  private started(item: Item): ClaudeEvent[] {
    this.items.set(item.id, item);
    switch (item.type) {
      case 'userMessage': {
        const id = item.clientId as string | null;
        return id && this.steers.delete(id) ? [{ type: 'command_lifecycle', command_uuid: id, state: 'started' }] : [];
      }
      case 'commandExecution':
        return this.call(item.id, 'Bash', { command: shellCommand(String(item.command ?? '')) });
      case 'fileChange':
        return this.call(item.id, 'Patch', patchInput(item));
      case 'mcpToolCall':
        return this.call(item.id, `mcp__${item.server}__${item.tool}`, item.arguments ?? {});
      default:
        return [];
    }
  }

  private completed(item: Item): ClaudeEvent[] {
    switch (item.type) {
      case 'agentMessage':
        this.streams.delete(item.id);
        return item.text ? [this.assistant([{ type: 'text', text: String(item.text) }])] : [];
      case 'reasoning': {
        this.streams.delete(item.id);
        // Each summary part opens with a "**Heading**" line; thinking is drawn as plain text.
        const text = ((item.summary as string[] | undefined) ?? []).join('\n\n').replace(/^\*\*(.+?)\*\*[ \t]*$/gm, '$1');
        return text ? [this.assistant([{ type: 'thinking', thinking: text }])] : [];
      }
      case 'commandExecution': {
        const declined = item.status === 'declined';
        const failed = declined || item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0);
        const output = String(item.aggregatedOutput ?? '') || (declined ? 'Declined' : '');
        return this.tool(item.id, 'Bash', { command: shellCommand(String(item.command ?? '')) }, output, failed);
      }
      case 'fileChange': {
        const failed = item.status === 'failed' || item.status === 'declined';
        return this.tool(item.id, 'Patch', patchInput(item), failed ? String(item.status) : '', failed);
      }
      case 'mcpToolCall': {
        const error = (item.error as { message?: string } | null)?.message;
        const content = error ?? (item.result as { content?: unknown } | null)?.content ?? '';
        return this.tool(item.id, `mcp__${item.server}__${item.tool}`, item.arguments ?? {}, content, Boolean(error) || item.status === 'failed');
      }
      case 'webSearch':
        return this.tool(item.id, 'WebSearch', { query: String(item.query ?? '') }, '');
      case 'imageView':
        return this.tool(item.id, 'Read', { file_path: String(item.path ?? '') }, '');
      default:
        return [];
    }
  }

  private delta(itemId: string, kind: 'text' | 'thinking', text: string): ClaudeEvent[] {
    const out: ClaudeEvent[] = [];
    let index = this.streams.get(itemId);
    if (index === undefined) {
      index = this.nextIndex++;
      this.streams.set(itemId, index);
      out.push(stream({ type: 'content_block_start', index, content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' } }));
    }
    out.push(stream({ type: 'content_block_delta', index, delta: kind === 'text' ? { type: 'text_delta', text } : { type: 'thinking_delta', thinking: text } }));
    return out;
  }

  // A tool call, shown once.
  private call(id: string, name: string, input: unknown): ClaudeEvent[] {
    if (this.tools.has(id)) return [];
    this.tools.add(id);
    return [this.assistant([{ type: 'tool_use', id, name, input }])];
  }

  // A finished tool call: the call if it was not shown yet, then its result.
  private tool(id: string, name: string, input: unknown, content: unknown, isError = false): ClaudeEvent[] {
    const result: ClaudeEvent = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
      parent_tool_use_id: null,
    };
    return [...this.call(id, name, input), result];
  }

  private assistant(content: ContentBlock[], usage?: Record<string, number>): ClaudeEvent {
    return { type: 'assistant', message: { role: 'assistant', content, ...(usage && { usage }) }, parent_tool_use_id: null, session_id: this.facts().sessionId };
  }
}

function stream(event: StreamEvent['event']): StreamEvent {
  return { type: 'stream_event', parent_tool_use_id: null, event };
}
