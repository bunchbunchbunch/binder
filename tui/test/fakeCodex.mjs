#!/usr/bin/env node
// Stand-in for `codex app-server`. Replays a session recorded by
// test/manual/recordCodex.ts in lockstep: it writes the recorded server lines
// in order and, at each line the recorded client sent, waits for binder to
// send the same kind of message (the same method, or the answer to the same
// server request) before going on. A request binder sends that the recording
// does not expect there gets the recording's answer for that method, or {}.
// Exits 0 when stdin closes, like the real server.
//
//   BINDER_FAKE_FIXTURE   path to a fixtures/codex/*.jsonl recording (required)
//   BINDER_FAKE_DELAY_MS  pause between written lines (default 0)
//   BINDER_FAKE_ARGS_OUT  if set, the argv this process received is written here
//   BINDER_FAKE_INPUT_OUT if set, every stdin line is appended here
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const entries = readFileSync(fixture, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))
  .filter((l) => l.dir);

const isRequest = (m) => m.method !== undefined && m.id !== undefined;
const isResponse = (m) => m.method === undefined && m.id !== undefined;

// The recording's answer to each method, for requests sent out of turn.
const answers = new Map();
for (const [i, e] of entries.entries()) {
  if (e.dir !== 'out' || !isRequest(e.msg) || answers.has(e.msg.method)) continue;
  const reply = entries.slice(i + 1).find((r) => r.dir === 'in' && isResponse(r.msg) && r.msg.id === e.msg.id);
  if (reply) answers.set(e.msg.method, reply.msg);
}

// Recorded request id → binder's id for the same request.
const ids = new Map();
// Recorded clientUserMessageId → binder's.
const messageIds = new Map();

function write(msg) {
  let line = JSON.stringify(msg);
  for (const [recorded, actual] of messageIds) line = line.split(recorded).join(actual);
  process.stdout.write(line + '\n');
}

let cursor = 0;
let pumping = false;

// Writes recorded server lines until the next one the client sent.
async function pump() {
  if (pumping) return;
  pumping = true;
  while (cursor < entries.length && entries[cursor].dir === 'in') {
    const { msg } = entries[cursor++];
    if (isResponse(msg)) {
      // Answers a request binder sent: under binder's id, or not at all.
      if (!ids.has(msg.id)) continue;
      const id = ids.get(msg.id);
      ids.delete(msg.id);
      if (delay) await sleep(delay);
      write({ ...msg, id });
      continue;
    }
    if (delay) await sleep(delay);
    write(msg);
  }
  pumping = false;
}

function matches(recorded, m) {
  if (recorded.method !== undefined) return m.method === recorded.method && isRequest(m) === isRequest(recorded);
  return isResponse(m) && m.method === undefined && m.id === recorded.id;
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (process.env.BINDER_FAKE_INPUT_OUT) appendFileSync(process.env.BINDER_FAKE_INPUT_OUT, line + '\n');
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  const expected = entries[cursor];
  if (expected?.dir === 'out' && matches(expected.msg, m)) {
    cursor++;
    if (isRequest(m)) ids.set(expected.msg.id, m.id);
    const recordedMsgId = expected.msg.params?.clientUserMessageId;
    if (recordedMsgId && m.params?.clientUserMessageId) messageIds.set(recordedMsgId, m.params.clientUserMessageId);
    void pump();
    return;
  }
  if (isRequest(m)) {
    const reply = answers.get(m.method);
    write(reply ? { ...reply, id: m.id } : { id: m.id, result: {} });
  }
});
process.stdin.on('end', () => process.exit(0));
void pump();
