#!/usr/bin/env node
// Stand-in for the `claude` binary. Replays a captured stream-json fixture,
// one turn (everything up to and including a `result` line) per user message
// read from stdin. Exits 0 when stdin closes, like the real binary.
//
//   BINDER_FAKE_FIXTURE   path to a .jsonl fixture (required)
//   BINDER_FAKE_DELAY_MS  pause between emitted lines (default 0)
//   BINDER_FAKE_ARGS_OUT  if set, the argv this process received is written here
//   BINDER_FAKE_INPUT_OUT if set, every stdin line is appended here
//   BINDER_FAKE_CAPS      comma-separated capabilities added to init lines
//
// A user message with a uuid gets command_lifecycle frames, and a send_now
// interrupt cuts the running turn short with an aborted result, as the real
// binary does for Ctrl+Enter. Control requests binder sends for its panels
// (initialize, list_models, mcp_status, rewind_*, set_cwd, ...) get canned answers.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const fixture = process.env.BINDER_FAKE_FIXTURE;
if (!fixture) {
  process.stderr.write('BINDER_FAKE_FIXTURE not set\n');
  process.exit(2);
}
if (process.env.BINDER_FAKE_ARGS_OUT) {
  writeFileSync(process.env.BINDER_FAKE_ARGS_OUT, JSON.stringify(process.argv.slice(2)));
}
const delay = Number(process.env.BINDER_FAKE_DELAY_MS ?? 0);
const caps = process.env.BINDER_FAKE_CAPS ? process.env.BINDER_FAKE_CAPS.split(',') : null;
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const lines = readFileSync(fixture, 'utf8').split('\n').filter((l) => l.trim());
const turns = [];
let current = [];
for (const line of lines) {
  current.push(line);
  if (JSON.parse(line).type === 'result') {
    turns.push(current);
    current = [];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let busy = Promise.resolve();

let inTurn = false;
let cut = false;

async function emitTurn(uuid) {
  const turn = turns.shift();
  if (uuid) emit({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' });
  if (!turn) {
    process.stdout.write(
      JSON.stringify({ type: 'result', subtype: 'error', is_error: true, duration_ms: 0, num_turns: 0, result: 'fake: fixture exhausted', session_id: 'fake' }) + '\n',
    );
    return;
  }
  inTurn = true;
  cut = false;
  for (const line of turn) {
    if (delay) await sleep(delay);
    if (cut) {
      emit({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', duration_ms: 0, num_turns: 1, session_id: 'fake' });
      break;
    }
    const e = JSON.parse(line);
    process.stdout.write((caps && e.type === 'system' && e.subtype === 'init' ? JSON.stringify({ ...e, capabilities: caps }) : line) + '\n');
    // A recorded can_use_tool request blocks the turn until the host answers,
    // like the real binary does.
    if (e.type === 'control_request') {
      await new Promise((resolve) => { pendingControl = resolve; });
    }
  }
  inTurn = false;
  if (uuid) emit({ type: 'command_lifecycle', command_uuid: uuid, state: cut ? 'cancelled' : 'completed' });
}
let pendingControl = null;

// Prompts by message uuid, for rewind_conversation's prefillText.
const prompts = new Map();
const mcp = [
  { name: 'docs', status: 'connected', scope: 'user', config: { type: 'stdio' } },
  { name: 'calendar', status: 'needs-auth', scope: 'claudeai', config: { type: 'http' } },
];

// Answers shaped like the real binary's, for the control requests binder's panels send.
const CONTROL = {
  initialize: () => ({ commands: FAKE_COMMANDS, account: { subscriptionType: 'Claude Max' } }),
  get_settings: () => ({ applied: { model: 'claude-opus-5-5', effort: 'xhigh' } }),
  list_models: () => ({
    models: [
      { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5', supportedEffortLevels: ['low', 'medium', 'high'] },
      { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Fastest for quick answers' },
    ],
  }),
  set_model: () => ({}),
  apply_flag_settings: () => ({}),
  mcp_status: () => ({ mcpServers: mcp }),
  mcp_toggle: (r) => {
    const s = mcp.find((x) => x.name === r.serverName);
    if (s) s.status = r.enabled ? 'connected' : 'disabled';
    return {};
  },
  mcp_reconnect: () => ({}),
  get_chrome_dialog: () => ({ allowed: true, subscriber: true, installed: true, connected: false, enabled_by_default: false, urls: { install: 'https://claude.ai/chrome', reconnect: 'https://clau.de/chrome/reconnect', permissions: 'https://clau.de/chrome/permissions' } }),
  rewind_files: (r) => (r.dry_run ? { canRewind: true, filesChanged: ['/tmp/a.txt'], insertions: 0, deletions: 1 } : { canRewind: true }),
  rewind_conversation: (r) => ({ rewound: true, targetMessageUuid: r.target_message_uuid, prefillText: prompts.get(r.target_message_uuid) ?? '' }),
  set_cwd: (r) => (r.trust_accepted ? { status: 'ok', changed: true } : { status: 'needs_trust', directory: r.path, trust_root: r.path }),
};

// What `initialize` reports, shaped like the real binary's list.
const FAKE_COMMANDS = [
  { name: 'clear', description: 'Start a new session with empty context', argumentHint: '[name]', aliases: ['reset', 'new'], builtin: true },
  { name: 'compact', description: 'Free up context by summarizing the conversation so far', argumentHint: '<optional custom summarization instructions>', builtin: true },
  { name: 'context', description: 'Show current context usage', argumentHint: '', builtin: true },
  { name: 'model', description: 'Set the AI model for Claude Code', argumentHint: '<model>', builtin: true },
  { name: 'bump-version', description: 'Bump the package version (user)', argumentHint: '' },
];

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (process.env.BINDER_FAKE_INPUT_OUT) appendFileSync(process.env.BINDER_FAKE_INPUT_OUT, line + '\n');
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === 'user') {
    if (msg.uuid) prompts.set(msg.uuid, typeof msg.message?.content === 'string' ? msg.message.content : '');
    if (msg.uuid) emit({ type: 'command_lifecycle', command_uuid: msg.uuid, state: 'queued' });
    busy = busy.then(() => emitTurn(msg.uuid));
  } else if (msg.type === 'control_request' && CONTROL[msg.request?.subtype]) {
    emit({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: CONTROL[msg.request.subtype](msg.request) } });
  } else if (msg.type === 'control_request') {
    const sendNow = msg.request?.send_now === true && inTurn;
    if (sendNow) cut = true;
    emit({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { still_queued: [], ...(sendNow && { send_now: 'stopped' }) } } });
  } else if (msg.type === 'control_response') {
    if (process.env.BINDER_FAKE_ANSWERS_OUT) writeFileSync(process.env.BINDER_FAKE_ANSWERS_OUT, line);
    if (pendingControl) { pendingControl(); pendingControl = null; }
  }
});
rl.on('close', () => {
  busy.then(() => process.exit(0));
});
