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
//   BINDER_FAKE_FAST_REASON  why fast mode cannot serve (e.g. extra_usage_disabled);
//                         unset, fast mode turns on when asked
//   BINDER_FAKE_REFUSE_MODES comma-separated permission modes set_permission_mode refuses
//   BINDER_FAKE_PLUGINS   a JSON file of {installed, available} that `plugin ...` runs read and write
//
// A user message with a uuid gets command_lifecycle frames, and a send_now
// interrupt cuts the running turn short with an aborted result, as the real
// binary does for Ctrl+Enter. Init lines report the folder the fake runs in
// where the recording reported its own (its first init's), as the real binary
// reports where it runs; a folder the recording moved to stays as recorded.
// Control requests binder sends for its panels
// (initialize, list_models, mcp_status, rewind_*, set_cwd, get_task_output,
// stop_task, rename_session, ...) get canned answers.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// `claude plugin list|install|uninstall|enable|disable ... --json`, as the real CLI answers.
if (process.argv[2] === 'plugin') {
  const file = process.env.BINDER_FAKE_PLUGINS;
  const state = file ? JSON.parse(readFileSync(file, 'utf8')) : { installed: [], available: [] };
  const [, , , cmd, id] = process.argv;
  if (cmd === 'list') {
    process.stdout.write(JSON.stringify(process.argv.includes('--available') ? state : state.installed) + '\n');
    process.exit(0);
  }
  const say = (outcome, message) => {
    process.stdout.write(JSON.stringify({ command: cmd, outcome, plugin: id, scope: 'user', message }) + '\n');
    if (file && outcome === 'ok') writeFileSync(file, JSON.stringify(state));
    process.exit(outcome === 'ok' ? 0 : 1);
  };
  const found = state.installed.find((p) => p.id === id);
  if (cmd === 'install') {
    const a = state.available.find((p) => p.pluginId === id);
    if (!a) say('failed', `Plugin "${id}" not found`);
    state.installed.push({ id, version: '1.0.0', scope: 'user', enabled: true });
    say('ok', `Successfully installed plugin: ${a.name} (scope: user)`);
  }
  if (!found) say('failed', `Plugin "${id}" is not installed`);
  if (cmd === 'uninstall') state.installed = state.installed.filter((p) => p.id !== id);
  else found.enabled = cmd === 'enable';
  say('ok', `Successfully ${cmd === 'uninstall' ? 'uninstalled' : `${cmd}d`} plugin: ${id.split('@')[0]} (scope: user)`);
}

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
const refusedModes = (process.env.BINDER_FAKE_REFUSE_MODES ?? '').split(',').filter(Boolean);
// Fast mode, once binder has asked about it (apply_flag_settings fastMode):
// it shows on init lines from then on, as the real binary always reports it.
let fast = null;
const fastFields = () => {
  const reason = fast ? process.env.BINDER_FAKE_FAST_REASON : 'sdk_opt_in_required';
  return { fast_mode_state: fast && !reason ? 'on' : 'off', ...(reason && { fast_mode_disabled_reason: reason }) };
};
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const lines = readFileSync(fixture, 'utf8').split('\n').filter((l) => l.trim());
const recordedCwd = lines.map((l) => JSON.parse(l)).find((e) => e.type === 'system' && e.subtype === 'init')?.cwd;
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
    const init = e.type === 'system' && e.subtype === 'init';
    const result = e.type === 'result' && fast !== null;
    process.stdout.write((init || result ? JSON.stringify({ ...e, ...(init && e.cwd === recordedCwd && { cwd: process.cwd() }), ...(init && caps && { capabilities: caps }), ...(fast !== null && fastFields()) }) : line) + '\n');
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
  initialize: () => ({ commands: FAKE_COMMANDS, account: { subscriptionType: 'Claude Max' }, ...fastFields() }),
  get_settings: () => ({ applied: { model: 'claude-opus-5-5', effort: 'xhigh' } }),
  get_context_usage: () => ({
    categories: [
      { name: 'System prompt', tokens: 3500, kind: 'used' },
      { name: 'MCP tools (deferred)', tokens: 30000, kind: 'deferred' },
      { name: 'Messages', tokens: 46500, kind: 'used' },
      { name: 'Free space', tokens: 117000, kind: 'free' },
    ],
    totalTokens: 50000,
    maxTokens: 200000,
    percentage: 25,
  }),
  list_models: () => ({
    models: [
      { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5', supportedEffortLevels: ['low', 'medium', 'high'] },
      { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Fastest for quick answers' },
    ],
  }),
  set_model: () => ({}),
  // The plugins as they now are: the enabled ones, each with a command named for it.
  reload_plugins: () => {
    const file = process.env.BINDER_FAKE_PLUGINS;
    const on = file ? JSON.parse(readFileSync(file, 'utf8')).installed.filter((p) => p.enabled) : [];
    return { commands: [...FAKE_COMMANDS, ...on.map((p) => ({ name: p.id.split('@')[0], description: `From the ${p.id} plugin`, argumentHint: '' }))], agents: [], plugins: on.map((p) => ({ name: p.id.split('@')[0], source: p.id })), mcpServers: [], error_count: 0 };
  },
  // A side question (/btw): answered at once, saying what it was asked and how many came before.
  side_question: (r) => ({ response: `**Side answer** to: ${r.question}${r.history?.length ? ` (after ${r.history.length} earlier)` : ''}`, synthetic: false }),
  apply_flag_settings: (r) => {
    if (typeof r.settings?.fastMode === 'boolean') fast = r.settings.fastMode;
    return {};
  },
  // The real binary reports the new mode in a status event before it answers.
  set_permission_mode: (r) => {
    if (refusedModes.includes(r.mode)) throw new Error(`Cannot set permission mode to ${r.mode}`);
    const mode = r.mode === 'manual' ? 'default' : r.mode;
    emit({ type: 'system', subtype: 'status', status: null, permissionMode: mode, session_id: 'fake' });
    return { mode };
  },
  // The real binary names the session (tidied) before it answers.
  rename_session: (r) => {
    emit({ type: 'system', subtype: 'session_title_changed', title: String(r.title).replace(/\s+/g, ' ').trim(), uuid: 'fake-title', session_id: 'fake' });
    return {};
  },
  mcp_status: () => ({ mcpServers: mcp }),
  mcp_toggle: (r) => {
    const s = mcp.find((x) => x.name === r.serverName);
    if (s) s.status = r.enabled ? 'connected' : 'disabled';
    return {};
  },
  mcp_reconnect: () => ({}),
  mcp_authenticate: (r) => ({ authUrl: `https://auth.example/${r.serverName}` }),
  mcp_clear_auth: () => ({}),
  get_chrome_dialog: () => ({ allowed: true, subscriber: true, installed: true, connected: false, enabled_by_default: false, urls: { install: 'https://claude.ai/chrome', reconnect: 'https://clau.de/chrome/reconnect', permissions: 'https://clau.de/chrome/permissions' } }),
  rewind_files: (r) => (r.dry_run ? { canRewind: true, filesChanged: ['/tmp/a.txt'], insertions: 0, deletions: 1 } : { canRewind: true }),
  rewind_conversation: (r) => ({ rewound: true, targetMessageUuid: r.target_message_uuid, prefillText: prompts.get(r.target_message_uuid) ?? '' }),
  set_cwd: (r) => (r.trust_accepted ? { status: 'ok', changed: true } : { status: 'needs_trust', directory: r.path, trust_root: r.path }),
  get_task_output: (r) => ({ output: `tick 1\ntick 2\noutput of ${r.task_id}\n`, total_bytes: 20480, truncated: true }),
  // The real binary then reports the task stopped; this fake only ever runs one.
  stop_task: (r) => {
    setTimeout(() => {
      emit({ type: 'system', subtype: 'task_notification', task_id: r.task_id, status: 'stopped', summary: 'stopped' });
      emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    }, 10);
    return {};
  },
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
    let response;
    try {
      response = CONTROL[msg.request.subtype](msg.request);
    } catch (e) {
      emit({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: e.message } });
      return;
    }
    emit({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } });
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
