import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImageAttachment } from '../claudeProcess.js';
import type { ClaudeEvent } from '../events.js';
import { appendLocal, appendPrompt, appendRaw, type LocalMarker } from '../eventLog.js';
import { binderConfig } from '../config.js';
import { childEnv, codexHome, stateDir } from '../paths.js';
import { findSession, upsertSession } from '../sessions.js';
import type { AgentSession, PermissionRequest, SessionEvents, SessionOptions, SwitchOptions } from '../session.js';
import { CodexRpc, type Params, type ServerRequest } from './rpc.js';
import { Translator, patchInput, rateLimitEvent, shellCommand, type RateLimits } from './translate.js';

const VERSION: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

// Binder's permission modes (Claude Code's names) as Codex's approval policy
// and sandbox. Without one, Codex's config.toml decides.
export const CODEX_MODES: Record<string, { approvalPolicy: string; sandbox: string }> = {
  bypassPermissions: { approvalPolicy: 'never', sandbox: 'danger-full-access' },
  dontAsk: { approvalPolicy: 'never', sandbox: 'workspace-write' },
  acceptEdits: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  auto: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  manual: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  default: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  plan: { approvalPolicy: 'on-request', sandbox: 'read-only' },
};

// `binder --codex -- <args>`: --model (-m), --permission-mode and --name (-n,
// which the phone passes for a new session) are binder's to apply to the
// thread; the rest go to `codex app-server` (-c key=value, --enable ...).
export function codexArgs(passthrough: string[], config = binderConfig()): { model?: string; mode?: string; name?: string; serverArgs: string[] } {
  let model: string | undefined;
  let mode = config.permissionMode;
  let name: string | undefined;
  const serverArgs: string[] = [];
  for (let i = 0; i < passthrough.length; i++) {
    const a = passthrough[i];
    if (a === '--model' || a === '-m') model = passthrough[++i];
    else if (a === '--permission-mode') mode = passthrough[++i];
    else if (a === '--name' || a === '-n') name = passthrough[++i];
    else serverArgs.push(a);
  }
  return { model, mode, name, serverArgs };
}

type CodexModel = { id: string; displayName: string; description: string; hidden: boolean; supportedReasoningEfforts: { reasoningEffort: string }[] };
type McpServerStatus = { name: string; runtimeStatus: string | null; tools?: Record<string, unknown> };

// Codex's MCP connection states as the /mcp panel's.
const MCP_STATES: Record<string, string> = {
  connected: 'connected',
  starting: 'pending',
  notStarted: 'pending',
  authenticationRequired: 'needs-auth',
  failed: 'failed',
  cancelled: 'failed',
  disabled: 'disabled',
};

const planLabel = (planType: string) => `ChatGPT ${planType.charAt(0).toUpperCase()}${planType.slice(1)}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Codex reads attached images from disk.
function saveImage(img: ImageAttachment): string {
  const dir = join(tmpdir(), 'binder-images');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${randomUUID()}.${img.mediaType.split('/')[1] ?? 'png'}`);
  writeFileSync(path, Buffer.from(img.data, 'base64'));
  return path;
}

function input(text: string, images: ImageAttachment[]): Params[] {
  return [{ type: 'text', text, text_elements: [] }, ...images.map((img) => ({ type: 'localImage', path: saveImage(img) }))];
}

// The Codex thread behind a binder session id: the one binder recorded, else
// the id itself (a thread binder never ran, resumed by its own id).
const threadOf = (sessionId: string) => findSession(sessionId)?.threadId ?? sessionId;

/**
 * One Codex session: a `codex app-server` child running one thread. Its
 * notifications go through Translator, so the host sees the same events a
 * Claude Code session gives it, and they are logged the same way for replay.
 */
export class CodexSession extends EventEmitter<SessionEvents> implements AgentSession {
  readonly agent = 'codex';
  rpc: CodexRpc | null = null;
  private id: string;
  private resume: boolean;
  private dir: string;
  private forkFrom: string | undefined;
  private threadId: string | undefined;
  private turnId: string | undefined;
  // A turn/start is on its way and Codex has not reported the turn started.
  private starting = false;
  private model: string | undefined;
  private readonly requestedModel: string | undefined;
  private readonly mode: string | undefined;
  private readonly name: string | undefined;
  private readonly serverArgs: string[];
  // Sent with every turn/start: what /model, /effort and /cd changed.
  private overrides: Params = {};
  private translator = new Translator(() => this.facts());
  // Settles once the thread is ready for turns (rejects if it never will be).
  private ready: Promise<void> = Promise.resolve();
  // Run when Codex reports the next turn started: a steer (its uuid) or a stop sent before it had.
  private onTurn: Array<{ run: () => void; steer?: string }> = [];
  // Follow-ups the running turn took in (turn/steer answered). Codex drops
  // any it has not started when the turn ends, an interrupted one's included.
  private taken: string[] = [];
  private approvals = new Map<string, ServerRequest>();

  constructor(private readonly opts: SessionOptions) {
    super();
    this.id = opts.sessionId;
    this.resume = opts.resume;
    this.dir = opts.cwd;
    this.forkFrom = opts.forkFrom;
    const { model, mode, name, serverArgs } = codexArgs(opts.passthrough);
    this.requestedModel = model;
    this.mode = mode && CODEX_MODES[mode] ? mode : undefined;
    this.name = name;
    this.serverArgs = serverArgs;
  }

  get sessionId(): string {
    return this.id;
  }

  get cwd(): string {
    return this.dir;
  }

  private facts() {
    return { sessionId: this.id, model: this.model, cwd: this.dir, permissionMode: this.mode };
  }

  // A translated event: logged for replay (stream events aside, as for Claude Code) and passed on.
  private forward(e: ClaudeEvent): void {
    appendRaw(this.id, JSON.stringify(e));
    this.emit('event', e);
  }

  start(): void {
    const id = this.id;
    const resume = this.resume;
    const forkFrom = this.forkFrom;
    const rpc = new CodexRpc({
      bin: this.opts.bin ?? process.env.BINDER_CODEX_BIN ?? 'codex',
      args: ['app-server', ...this.serverArgs],
      cwd: this.dir,
      env: childEnv(this.dir),
      stderrPath: join(stateDir(), `${id}.stderr.log`),
    });
    this.rpc = rpc;
    this.threadId = undefined;
    this.turnId = undefined;
    this.starting = false;
    this.onTurn = [];
    this.taken = [];
    this.approvals.clear();
    // A new app-server starts from the launch settings, as a new claude does.
    this.overrides = {};
    const translator = new Translator(() => this.facts());
    this.translator = translator;

    rpc.on('notification', ({ method, params }) => {
      if (this.rpc !== rpc) return;
      // Other threads' (a fork's, a subagent's) are not this session's.
      if (typeof params.threadId === 'string' && params.threadId !== this.threadId) return;
      if (method === 'turn/started') {
        this.turnId = (params.turn as { id: string }).id;
        this.starting = false;
      }
      if (method === 'turn/completed') {
        this.turnId = undefined;
        // Ahead of the result, so the turn does not end as one superseded by them.
        for (const uuid of this.taken.splice(0)) this.discard(uuid);
      }
      if (method === 'account/updated' && typeof params.planType === 'string') this.emit('plan', planLabel(params.planType));
      for (const e of translator.translate(method, params)) this.forward(e);
      if (method === 'turn/started') for (const { run } of this.onTurn.splice(0)) run();
    });
    rpc.on('request', (r) => {
      if (this.rpc === rpc) this.serverRequest(r);
    });
    rpc.on('exit', ({ code }) => {
      if (this.rpc === rpc) this.emit('exit', { code, stderr: rpc.recentStderr.slice() });
    });
    // Spawning failed (codex not on PATH): no exit follows.
    rpc.on('error', (e) => this.fail(rpc, e.message));
    rpc.start();
    this.ready = this.handshake(rpc, id, resume, forkFrom);
    this.ready.catch((e) => this.fail(rpc, errText(e)));
  }

  private async handshake(rpc: CodexRpc, id: string, resume: boolean, forkFrom: string | undefined): Promise<void> {
    await rpc.request('initialize', { clientInfo: { name: 'binder', title: 'BinderTUI', version: VERSION }, capabilities: null });
    rpc.notify('initialized');
    const { account } = (await rpc.request('account/read', {})) as { account: { type: string; planType?: string } | null };
    // requiresOpenaiAuth is true even when logged in; only a missing account says it is not.
    if (!account) throw new Error('Codex is not logged in: run `codex login`, then press Ctrl+R');
    this.emit('plan', account.type === 'chatgpt' ? planLabel(account.planType ?? '') : 'API key');
    const settings: Params = { cwd: this.dir, ...(this.requestedModel && { model: this.requestedModel }), ...(this.mode && CODEX_MODES[this.mode]) };
    const r = forkFrom
      ? await rpc.request('thread/fork', { threadId: threadOf(forkFrom), excludeTurns: true, ...settings })
      : resume
        ? await rpc.request('thread/resume', { threadId: threadOf(id), excludeTurns: true, ...settings })
        : await rpc.request('thread/start', settings);
    if (this.rpc !== rpc) return;
    // The thread exists: every later start resumes it.
    this.resume = true;
    this.forkFrom = undefined;
    this.threadId = (r.thread as { id: string }).id;
    this.model = String(r.model ?? '');
    if (this.name && !resume && !forkFrom) await rpc.request('thread/name/set', { threadId: this.threadId, name: this.name }).catch(() => {});
    upsertSession({ id, cwd: this.dir, configDir: codexHome(), agent: 'codex', threadId: this.threadId });
    this.emit('applied', { model: this.model, ...(typeof r.reasoningEffort === 'string' && { effort: r.reasoningEffort }) });
    const limits = await rpc.request('account/rateLimits/read', {}).catch(() => undefined);
    if (limits?.rateLimits && this.rpc === rpc) this.forward(rateLimitEvent(limits.rateLimits as RateLimits));
  }

  // The child cannot go on (not logged in, no such thread): report it as an exit, so Ctrl+R starts over.
  private fail(rpc: CodexRpc, message: string): void {
    if (this.rpc !== rpc || rpc.exited) return;
    this.rpc = null;
    rpc.kill();
    this.emit('exit', { code: null, stderr: [...rpc.recentStderr.slice(-4), message] });
  }

  private serverRequest(r: ServerRequest): void {
    const p = r.params;
    const command = r.method === 'item/commandExecution/requestApproval';
    if (command || r.method === 'item/fileChange/requestApproval') {
      const item = this.translator.item(String(p.itemId));
      const perm: PermissionRequest = {
        requestId: String(r.id),
        toolName: command ? 'Bash' : 'Patch',
        toolUseId: String(p.itemId),
        input: command ? { command: shellCommand(String(p.command ?? item?.command ?? '')) } : patchInput(item),
        ...(typeof p.reason === 'string' && { reason: p.reason }),
      };
      this.approvals.set(perm.requestId, r);
      this.emit('permission', perm);
      return;
    }
    // Questions, MCP forms, dynamic tools: refused at once, so the turn goes on.
    this.rpc?.respondError(r.id, -32601, `binder does not handle ${r.method}`);
  }

  private decide(req: PermissionRequest, decision: 'accept' | 'decline'): void {
    const r = this.approvals.get(req.requestId);
    if (!r) return;
    this.approvals.delete(req.requestId);
    this.rpc?.respond(r.id, { decision });
  }

  // The control requests binder's panels send, answered from Codex where it has an equivalent.
  async request(subtype: string, fields: Record<string, unknown> = {}, timeoutMs = 20000): Promise<Record<string, unknown>> {
    const rpc = this.rpc;
    if (!rpc) throw new Error('codex is not running');
    switch (subtype) {
      case 'list_models': {
        const r = await rpc.request('model/list', {}, timeoutMs);
        const models = (r.data as CodexModel[]).filter((m) => !m.hidden).map((m) => ({
          value: m.id,
          resolvedModel: m.id,
          displayName: m.displayName,
          description: m.description,
          supportedEffortLevels: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
        }));
        return { models };
      }
      case 'set_model':
        this.model = String(fields.model);
        this.overrides.model = this.model;
        return {};
      case 'apply_flag_settings': {
        const level = (fields.settings as { effortLevel?: string } | undefined)?.effortLevel;
        if (level) this.overrides.effort = level;
        return {};
      }
      case 'set_cwd':
        this.overrides.cwd = String(fields.path);
        return { status: 'ok' };
      case 'mcp_status': {
        await this.ready;
        const r = await rpc.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly', threadId: this.threadId }, timeoutMs);
        const status = (s: McpServerStatus) => MCP_STATES[s.runtimeStatus ?? ''] ?? (Object.keys(s.tools ?? {}).length ? 'connected' : 'pending');
        return { mcpServers: (r.data as McpServerStatus[]).map((s) => ({ name: s.name, status: status(s) })) };
      }
      case 'rename_session':
        await this.ready;
        await rpc.request('thread/name/set', { threadId: this.threadId, name: String(fields.title ?? '') }, timeoutMs);
        return {};
      default:
        throw new Error(`Not available in a Codex session (${subtype})`);
    }
  }

  respawn(): void {
    this.rpc?.kill();
    this.start();
  }

  // Another thread: a new one (/clear), one to resume, or a fork of this one.
  switchTo(sessionId: string, { resume, fork, cwd }: SwitchOptions): void {
    const old = this.rpc;
    this.rpc = null; // its exit is expected, not a crash
    void old?.close();
    this.forkFrom = fork ? this.id : undefined;
    this.id = sessionId;
    this.resume = resume;
    if (cwd) this.dir = cwd;
    this.start();
  }

  movedTo(cwd: string): void {
    this.dir = cwd;
  }

  logLocal(marker: LocalMarker): void {
    appendLocal(this.id, marker);
  }

  sendPrompt(prompt: string, tabId: number, images: ImageAttachment[] = [], followup = false, context = ''): string {
    const uuid = randomUUID();
    appendPrompt(this.id, { prompt, tabId, uuid, ...(followup && { kind: 'followup' as const }) });
    this.startTurn(uuid, context ? `${context}\n\n${prompt}` : prompt, images);
    return uuid;
  }

  private startTurn(uuid: string, text: string, images: ImageAttachment[]): void {
    const rpc = this.rpc;
    this.translator.expectStart(uuid);
    this.starting = true;
    this.ready
      .then(() => rpc!.request('turn/start', { threadId: this.threadId, input: input(text, images), clientUserMessageId: uuid, summary: 'auto', ...this.overrides }, 60000))
      .catch((e) => {
        if (this.rpc !== rpc) return;
        // The prompt never started: end its turn in an error, so the queue
        // moves on. A follow-up steered into it goes with it.
        this.starting = false;
        this.discard(uuid);
        for (const { steer } of this.onTurn.splice(0)) if (steer) this.discard(steer);
        this.forward({ type: 'result', subtype: 'error', is_error: true, duration_ms: 0, num_turns: 0, result: `codex refused the prompt: ${errText(e)}`, session_id: this.id });
      });
  }

  // A prompt or follow-up that will never start: the reducer stops waiting for it.
  private discard(uuid: string): void {
    if (this.translator.forget(uuid)) this.forward({ type: 'command_lifecycle', command_uuid: uuid, state: 'discarded' });
  }

  // Ctrl+Enter: the follow-up joins the running turn (turn/steer). If the
  // turn ended first (Codex can finish it before binder has shown that), it
  // runs as a turn of its own.
  steer(prompt: string, tabId: number, images: ImageAttachment[] = []): string {
    const uuid = randomUUID();
    appendPrompt(this.id, { prompt, tabId, kind: 'steer', uuid });
    const rpc = this.rpc;
    this.translator.expectSteer(uuid);
    const send = () => {
      const turn = this.turnId;
      rpc?.request('turn/steer', { threadId: this.threadId, input: input(prompt, images), clientUserMessageId: uuid, expectedTurnId: turn }).then(
        () => {
          if (this.rpc !== rpc) return;
          if (this.turnId === turn) this.taken.push(uuid);
          // The turn ended while the answer was on its way, without it.
          else this.discard(uuid);
        },
        () => {
          if (this.rpc !== rpc) return;
          this.translator.forget(uuid);
          this.startTurn(uuid, prompt, images);
        },
      );
    };
    if (this.turnId) send();
    else if (this.starting) this.onTurn.push({ run: send, steer: uuid });
    else {
      this.translator.forget(uuid);
      this.startTurn(uuid, prompt, images);
    }
    return uuid;
  }

  interrupt(): void {
    const rpc = this.rpc;
    const stop = () => void rpc?.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
    if (this.turnId) stop();
    else if (this.starting) this.onTurn.push({ run: stop });
  }

  // A Codex session asks no AskUserQuestion; anything answered is allowed.
  answerQuestion(req: PermissionRequest): void {
    this.decide(req, 'accept');
  }

  allow(req: PermissionRequest): void {
    this.decide(req, 'accept');
  }

  deny(req: PermissionRequest): void {
    this.decide(req, 'decline');
  }

  async close(): Promise<void> {
    await this.rpc?.close();
  }
}
