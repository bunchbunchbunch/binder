// Records `codex app-server` sessions as fixtures for test/fakeCodex.mjs:
// every line in both directions, scrubbed of the account, the home path and
// the machine's name.
//   npx tsx test/manual/recordCodex.ts <scenario...>   (or: all)
// Each scenario runs in its own folder under /private/tmp/binder-codex-rec and
// writes fixtures/codex/<scenario>.jsonl. Most cost one prompt of the
// logged-in account's quota; discovery and failed cost none.
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { CodexRpc, type Params, type ServerRequest } from '../../src/codex/rpc.js';

const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures');
const OUT = join(FIXTURES, 'codex');
const ROOT = '/private/tmp/binder-codex-rec';
const VERSION = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim().split(' ').pop();

type Line = { dir: 'in' | 'out'; msg: unknown };

class Recorder {
  rpc: CodexRpc;
  lines: Line[] = [];
  private waiters: Array<{ method: string; test: (p: Params) => boolean; resolve: (p: Params) => void }> = [];
  onRequest: (r: ServerRequest) => void = (r) => this.rpc.respondError(r.id, -32601, `recorder does not handle ${r.method}`);
  onNotification: (method: string, params: Params) => void = () => {};

  constructor(readonly cwd: string) {
    this.rpc = new CodexRpc({ bin: 'codex', args: ['app-server'], cwd, env: process.env });
    this.rpc.on('line', (dir, line) => this.lines.push({ dir, msg: JSON.parse(line) }));
    this.rpc.on('request', (r) => this.onRequest(r));
    this.rpc.on('notification', ({ method, params }) => {
      this.onNotification(method, params);
      this.waiters = this.waiters.filter((w) => {
        if (w.method !== method || !w.test(params)) return true;
        w.resolve(params);
        return false;
      });
    });
    this.rpc.on('stderr', (l) => process.stderr.write(`  [codex] ${l}\n`));
    this.rpc.start();
  }

  waitFor(method: string, test: (p: Params) => boolean = () => true, timeoutMs = 180000): Promise<Params> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), timeoutMs);
      this.waiters.push({ method, test, resolve: (p) => (clearTimeout(timer), resolve(p)) });
    });
  }

  async init(): Promise<void> {
    await this.rpc.request('initialize', { clientInfo: { name: 'binder', title: null, version: '0.1.0' }, capabilities: null });
    this.rpc.notify('initialized');
    await this.rpc.request('account/read', {});
  }

  async startThread(params: Params): Promise<string> {
    const r = await this.rpc.request('thread/start', { cwd: this.cwd, ...params });
    return (r.thread as { id: string }).id;
  }

  // One turn, start to turn/completed.
  async turn(threadId: string, input: Params[], extra: Params = {}): Promise<Params> {
    const done = this.waitFor('turn/completed', (p) => p.threadId === threadId);
    await this.rpc.request('turn/start', { threadId, input, clientUserMessageId: randomUUID(), summary: 'auto', ...extra });
    const completed = await done;
    const turn = completed.turn as { status: string; error?: { message: string } | null };
    console.log(`  turn ${turn.status}${turn.error ? `: ${turn.error.message}` : ''}`);
    return completed;
  }

  async close(): Promise<void> {
    await this.rpc.close();
  }
}

const text = (t: string): Params => ({ type: 'text', text: t, text_elements: [] });

// Values that identify the account or the machine.
const SECRET_KEYS = new Set(['email', 'accountId', 'chatgptAccountId', 'userId', 'installationId', 'serverName']);
const ZERO_ID = '00000000-0000-0000-0000-000000000000';

function scrub(v: unknown, home: string, host: string): unknown {
  if (typeof v === 'string') return v.split(home).join('/Users/me').split(host).join('mac.local');
  if (Array.isArray(v)) return v.map((x) => scrub(x, home, host));
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => {
        if (SECRET_KEYS.has(k) && typeof x === 'string') return [k, k === 'email' ? 'me' : k === 'serverName' ? 'mac.local' : ZERO_ID];
        if (k === 'userAgent' && typeof x === 'string') return [k, `binder/${VERSION} (binder; 0.1.0)`];
        // An MCP server's tool catalog: the names are enough.
        if (k === 'tools' && x && typeof x === 'object' && !Array.isArray(x)) return [k, Object.fromEntries(Object.keys(x).map((t) => [t, { name: t }]))];
        return [k, scrub(x, home, host)];
      }),
    );
  }
  return v;
}

function save(name: string, lines: Line[]): void {
  mkdirSync(OUT, { recursive: true });
  const header = { fixture: name, codex: VERSION };
  const body = [header, ...lines].map((l) => JSON.stringify(scrub(l, homedir(), hostname()))).join('\n') + '\n';
  writeFileSync(join(OUT, `${name}.jsonl`), body);
  console.log(`  wrote fixtures/codex/${name}.jsonl (${lines.length} lines)`);
}

function workdir(name: string, files: Record<string, string> = {}): string {
  const dir = join(ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
  return dir;
}

const NO_ASK = { approvalPolicy: 'never', sandbox: 'workspace-write' };
const ASK = { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };

const scenarios: Record<string, () => Promise<void>> = {
  // A streamed answer with a reasoning summary.
  async answer() {
    const r = new Recorder(workdir('answer'));
    await r.init();
    const thread = await r.startThread({ approvalPolicy: 'never', sandbox: 'read-only' });
    await r.turn(thread, [text('In two short sentences, what is a binder clip?')]);
    await r.close();
    save('answer', r.lines);
  },

  // A command that needs approval, approved.
  async approve() {
    const r = new Recorder(workdir('approve'));
    await r.init();
    r.onRequest = (req) => (req.method.endsWith('requestApproval') ? r.rpc.respond(req.id, { decision: 'accept' }) : r.rpc.respondError(req.id, -32601, 'unhandled'));
    const thread = await r.startThread(ASK);
    await r.turn(thread, [text('Use the shell to run exactly this command and nothing else: mkdir -p out && echo hello > out/note.txt\nThen reply with the word done.')]);
    await r.close();
    save('approve', r.lines);
  },

  // The same command, declined.
  async decline() {
    const r = new Recorder(workdir('decline'));
    await r.init();
    r.onRequest = (req) => (req.method.endsWith('requestApproval') ? r.rpc.respond(req.id, { decision: 'decline' }) : r.rpc.respondError(req.id, -32601, 'unhandled'));
    const thread = await r.startThread(ASK);
    await r.turn(thread, [text('Use the shell to run exactly this command and nothing else: mkdir -p out && echo hello > out/note.txt\nIf it is not allowed, do not retry; reply with the word skipped.')]);
    await r.close();
    save('decline', r.lines);
  },

  // A file edit, with whatever approval Codex asks for accepted.
  async edit() {
    const r = new Recorder(workdir('edit', { 'greeting.txt': 'hello\n' }));
    await r.init();
    r.onRequest = (req) => (req.method.endsWith('requestApproval') ? r.rpc.respond(req.id, { decision: 'accept' }) : r.rpc.respondError(req.id, -32601, 'unhandled'));
    const thread = await r.startThread(ASK);
    await r.turn(thread, [text('In greeting.txt, change the word hello to goodbye. Edit the file directly with a patch; do not run shell commands. Then reply with the word done.')]);
    await r.close();
    save('edit', r.lines);
  },

  // Esc while a command runs.
  async interrupt() {
    const r = new Recorder(workdir('interrupt'));
    await r.init();
    const thread = await r.startThread(NO_ASK);
    r.onNotification = (method, p) => {
      const item = p.item as { type?: string } | undefined;
      if (method === 'item/started' && item?.type === 'commandExecution') {
        setTimeout(() => void r.rpc.request('turn/interrupt', { threadId: thread, turnId: p.turnId }), 1500);
      }
    };
    await r.turn(thread, [text('Run the shell command `sleep 30`, then reply with the word done.')]);
    await r.close();
    save('interrupt', r.lines);
  },

  // Ctrl+Enter while a command runs: the follow-up joins the running turn.
  async steer() {
    const r = new Recorder(workdir('steer'));
    await r.init();
    const thread = await r.startThread(NO_ASK);
    let steered = false;
    r.onNotification = (method, p) => {
      const item = p.item as { type?: string } | undefined;
      if (method === 'item/started' && item?.type === 'commandExecution' && !steered) {
        steered = true;
        void r.rpc.request('turn/steer', { threadId: thread, input: [text('Name a vegetable instead of a fruit.')], clientUserMessageId: randomUUID(), expectedTurnId: p.turnId });
      }
    };
    await r.turn(thread, [text('Run the shell command `sleep 6`, then name one fruit in a single word.')]);
    await r.close();
    save('steer', r.lines);
  },

  // Ctrl+Enter, then Esc before the follow-up was taken in: what becomes of it.
  async 'steer-interrupt'() {
    const r = new Recorder(workdir('steer-interrupt'));
    await r.init();
    const thread = await r.startThread(NO_ASK);
    let steered = false;
    r.onNotification = (method, p) => {
      const item = p.item as { type?: string } | undefined;
      if (method === 'item/started' && item?.type === 'commandExecution' && !steered) {
        steered = true;
        void r.rpc.request('turn/steer', { threadId: thread, input: [text('Name a vegetable instead of a fruit.')], clientUserMessageId: randomUUID(), expectedTurnId: p.turnId });
        setTimeout(() => void r.rpc.request('turn/interrupt', { threadId: thread, turnId: p.turnId }), 1500);
      }
    };
    await r.turn(thread, [text('Run the shell command `sleep 30`, then name one fruit in a single word.')]);
    // Whether Codex runs the follow-up as a turn of its own.
    const again = await r.waitFor('turn/started', () => true, 8000).then(() => true, () => false);
    if (again) await r.waitFor('turn/completed');
    console.log(`  follow-up ran as its own turn: ${again}`);
    await r.close();
    save('steer-interrupt', r.lines);
  },

  // A second process picking a thread up again; only that process is saved.
  async resume() {
    const dir = workdir('resume');
    const first = new Recorder(dir);
    await first.init();
    const thread = await first.startThread({ approvalPolicy: 'never', sandbox: 'read-only' });
    await first.turn(thread, [text('Reply with just the word: pineapple')]);
    await first.close();
    const r = new Recorder(dir);
    await r.init();
    await r.rpc.request('thread/resume', { threadId: thread, approvalPolicy: 'never', sandbox: 'read-only', excludeTurns: true });
    await r.turn(thread, [text('Which word did you reply with before? Reply with just that word.')]);
    await r.close();
    save('resume', r.lines);
  },

  // A prompt with an image attached.
  async image() {
    const dir = workdir('image');
    copyFileSync(join(FIXTURES, 'orange.png'), join(dir, 'orange.png'));
    const r = new Recorder(dir);
    await r.init();
    const thread = await r.startThread({ approvalPolicy: 'never', sandbox: 'read-only' });
    await r.turn(thread, [text('What color is this image? Reply with one word.'), { type: 'localImage', path: join(dir, 'orange.png') }]);
    await r.close();
    save('image', r.lines);
  },

  // A turn that fails before reaching a model.
  async failed() {
    const r = new Recorder(workdir('failed'));
    await r.init();
    const thread = await r.startThread({ approvalPolicy: 'never', sandbox: 'read-only' });
    await r.turn(thread, [text('Reply with ok.')], { model: 'no-such-model' });
    await r.close();
    save('failed', r.lines);
  },

  // What binder's panels ask for, no prompts: models, MCP servers, usage,
  // thread list, fork and rename.
  async discovery() {
    const r = new Recorder(workdir('discovery'));
    await r.init();
    const thread = await r.startThread({ approvalPolicy: 'never', sandbox: 'read-only' });
    await r.rpc.request('model/list', {});
    await r.rpc.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly' }).catch((e) => console.log(`  mcpServerStatus/list: ${e.message}`));
    await r.rpc.request('account/rateLimits/read', {});
    await r.rpc.request('thread/list', { limit: 5, sourceKinds: ['appServer', 'cli', 'vscode', 'exec'], cwd: r.cwd });
    await r.rpc.request('thread/name/set', { threadId: thread, name: 'Discovery' }).catch((e) => console.log(`  thread/name/set: ${e.message}`));
    await r.rpc.request('thread/fork', { threadId: thread }).catch((e) => console.log(`  thread/fork: ${e.message}`));
    await r.close();
    save('discovery', r.lines);
  },
};

const names = process.argv.slice(2);
const run = names.includes('all') ? Object.keys(scenarios) : names;
if (!run.length || run.some((n) => !scenarios[n])) {
  console.error(`usage: recordCodex.ts <${Object.keys(scenarios).join('|')}|all>...`);
  process.exit(2);
}
for (const name of run) {
  console.log(name);
  await scenarios[name]();
}
// The account's quota after the run, for the record.
const after = new Recorder(ROOT);
await after.init();
const limits = (await after.rpc.request('account/rateLimits/read', {})).rateLimits as { primary?: { usedPercent: number } };
console.log(`quota used: ${limits.primary?.usedPercent ?? '?'}%`);
await after.close();
