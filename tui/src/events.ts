// Shapes of the JSON lines `claude -p --output-format stream-json` writes.
// Only the fields the TUI reads are typed; everything else is left open.

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content?: unknown; is_error?: boolean };

export type ApiMessage = {
  id?: string;
  role: 'assistant' | 'user';
  model?: string;
  content: ContentBlock[] | string;
};

export type InitEvent = {
  type: 'system';
  subtype: 'init';
  session_id: string;
  cwd: string;
  model: string;
  permissionMode: string;
  claude_code_version?: string;
  // Protocol features this CLI supports, e.g. interrupt_send_now_v1.
  capabilities?: string[];
};

export type OtherSystemEvent = {
  type: 'system';
  subtype: string;
  session_id?: string;
  [key: string]: unknown;
};

export type AssistantEvent = {
  type: 'assistant';
  message: ApiMessage;
  parent_tool_use_id: string | null;
  session_id: string;
};

export type UserEvent = {
  type: 'user';
  message: ApiMessage;
  parent_tool_use_id: string | null;
  session_id?: string;
  // Present when the TUI logs its own prompt line (see eventLog.ts).
  hc_prompt?: string;
};

export type StreamDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'input_json_delta'; partial_json: string }
  | { type: 'signature_delta'; signature: string };

export type StreamEvent = {
  type: 'stream_event';
  parent_tool_use_id: string | null;
  event:
    | { type: 'message_start'; message: ApiMessage }
    | { type: 'content_block_start'; index: number; content_block: ContentBlock }
    | { type: 'content_block_delta'; index: number; delta: StreamDelta }
    | { type: 'content_block_stop'; index: number }
    | { type: 'message_delta'; [key: string]: unknown }
    | { type: 'message_stop' };
};

export type RateLimitWindow = { utilization: number; resetsAt: number };

export type RateLimitEvent = {
  type: 'rate_limit_event';
  rate_limit_info: {
    status: string;
    rateLimitType?: string;
    resetsAt?: number;
    // thirty_day: a Codex free plan's only window.
    unifiedWindows?: { five_hour?: RateLimitWindow; seven_day?: RateLimitWindow; thirty_day?: RateLimitWindow };
  };
};

export type ResultEvent = {
  type: 'result';
  subtype: string;
  is_error: boolean;
  duration_ms: number;
  duration_api_ms?: number;
  num_turns: number;
  result?: string;
  total_cost_usd?: number;
  session_id: string;
  stop_reason?: string;
  terminal_reason?: string;
};

export type ControlRequestEvent = {
  type: 'control_request';
  request_id: string;
  request: { subtype: string; [key: string]: unknown };
};

export type ControlResponseEvent = {
  type: 'control_response';
  response: { subtype: string; request_id: string; [key: string]: unknown };
};

// Progress of one user message that carried a uuid: queued, then started
// when a turn takes it in, then completed, cancelled or discarded.
export type CommandLifecycleEvent = {
  type: 'command_lifecycle';
  command_uuid: string;
  state: 'queued' | 'started' | 'completed' | 'cancelled' | 'discarded';
};

// The next prompt Claude Code predicts, written after a turn's result
// (--prompt-suggestions). It may not come at all.
export type PromptSuggestionEvent = {
  type: 'prompt_suggestion';
  suggestion: string;
};

export type ClaudeEvent =
  | InitEvent
  | OtherSystemEvent
  | AssistantEvent
  | UserEvent
  | StreamEvent
  | RateLimitEvent
  | ResultEvent
  | ControlRequestEvent
  | ControlResponseEvent
  | CommandLifecycleEvent
  | PromptSuggestionEvent
  | { type: string; [key: string]: unknown };

export function isInit(e: ClaudeEvent): e is InitEvent {
  return e.type === 'system' && (e as OtherSystemEvent).subtype === 'init';
}

export function parseEventLine(line: string): ClaudeEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
      return parsed as ClaudeEvent;
    }
    return null;
  } catch {
    return null;
  }
}
