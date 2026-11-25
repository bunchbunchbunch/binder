import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeProcess, buildArgs, type ImageAttachment } from './claudeProcess.js';
import type { ClaudeEvent, ControlRequestEvent, FastModeState, OtherSystemEvent } from './events.js';
import type { PermissionUpdate } from './permissions.js';
import { binderConfig } from './config.js';
import { appendLocal, appendPrompt, appendRaw, logPath, type LocalMarker } from './eventLog.js';
import { childEnv, configDir, stateDir } from './paths.js';
import type { SlashCommand } from './slashCommands.js';
import { findTranscript } from './transcripts.js';

export type SessionOptions = {
  sessionId: string;
  resume: boolean;
  cwd: string;
  passthrough: string[];
  bin?: string;
  // Start sessionId as a fork of this session (binder --fork-session).
  forkFrom?: string;
};

export type PermissionRequest = {
  requestId: string;
  toolName: string;
  toolUseId?: string;
  input: Record<string, unknown>;
  // Why the child is asking, e.g. a safety check that bypass mode does not skip.
  reason?: string;
  // The rules (or mode switch) the child suggests for "always allow", unchecked.
  suggestions?: unknown;
  // ExitPlanMode: the mode the session was in before plan mode, if it entered it here.
  returnMode?: string;
  // What the child says the call is (a workflow re-run by name or script path has no script to read it from).
  description?: string;
};

// Fast mode as the child reports it, and why it cannot serve, if it cannot.
export type FastReport = { state?: FastModeState; reason?: string };

export function fastReport(r: Record<string, unknown>): FastReport {
  const state = r.fast_mode_state;
  if (state !== 'on' && state !== 'off' && state !== 'cooldown') return {};
  return { state, ...(typeof r.fast_mode_disabled_reason === 'string' && { reason: r.fast_mode_disabled_reason }) };
}

// Which CLI runs the session.
export type Agent = 'claude' | 'codex';

// Claude Code's decisionClassification: user_temporary for an allow once,
// user_permanent for an "always allow".
export type DecisionClassification = 'user_temporary' | 'user_permanent';

export type SessionEvents = {
  event: [ClaudeEvent];
  permission: [PermissionRequest];
  exit: [{ code: number | null; stderr: string[] }];
  // The slash commands the child runs, from its `initialize` response.
  commands: [SlashCommand[]];
  // The account's plan ("Claude Max"), from the same response.
  plan: [string];
  // The model and effort the child starts with, from `get_settings`.
  applied: [{ model?: string; effort?: string }];
  // Fast mode as a new child starts, from its `initialize` response.
  fast: [FastReport];
};

// Owns the child process for one session id: spawn, respawn after a crash,
// switch to another session, write prompts, answer control requests, and log
// everything for replay.
export type SwitchOptions = {
  resume: boolean;
  // Start as a fork of the current session (--fork-session).
  fork?: boolean;
  // Run the child in another directory from now on.
  cwd?: string;
  // Extra claude flags for this child only (e.g. --chrome).
  extraArgs?: string[];
};

type PendingRequest = { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void };

// What the host, the panels and the remote server use of a session, whichever
// agent runs it. Panels ask through request() with Claude Code's control
// request names; a Codex session answers the ones it can.
export interface AgentSession extends EventEmitter<SessionEvents> {
  readonly agent: Agent;
  readonly sessionId: string;
  readonly cwd: string;
  start(): void;
  request(subtype: string, fields?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  // The agent's own CLI (`claude plugin ...`), run with the session's binary, folder and config dir.
  cli(args: string[], timeoutMs?: number): Promise<string>;
  respawn(): void;
  switchTo(sessionId: string, opts: SwitchOptions): void;
  movedTo(cwd: string): void;
  logLocal(marker: LocalMarker): void;
  // `auto`: binder's own follow-up, whose `prompt` is the turn's heading and `auto` what the model reads.
  sendPrompt(prompt: string, tabId: number, images?: ImageAttachment[], followup?: boolean, context?: string, auto?: string): string;
  steer(prompt: string, tabId: number, images?: ImageAttachment[]): string;
  interrupt(): void;
  answerQuestion(req: PermissionRequest, answers: Record<string, string>): void;
  // `updates`: an "always allow" answer's rules or mode switch; `classification`, how lasting the user meant it.
  allow(req: PermissionRequest, updates?: PermissionUpdate[], classification?: DecisionClassification): void;
  deny(req: PermissionRequest, message?: string): void;
  // Whether fast mode is asked for (it may still be unable to serve).
  readonly fastMode: boolean;
  // Asks for fast mode or stops asking, and reports what the child then says.
  setFastMode(on: boolean): Promise<FastReport>;
  close(): Promise<void>;
}

export class Session extends EventEmitter<SessionEvents> implements AgentSession {
  readonly agent = 'claude';
  proc: ClaudeProcess | null = null;
  private id: string;
  private resume: boolean;
  private dir: string;
  private forkFrom: string | undefined;
  private extraArgs: string[] = [];
  private requests = new Map<string, PendingRequest>();
  // The child's permission mode, and the one it was in when it entered plan mode.
  private mode: string | undefined;
  private beforePlan: string | undefined;
  // config.json as this session started: its permission mode, artifacts,
  // config dirs and fast mode wait for the next session (/clear included).
  private config = binderConfig();
  // Headless Claude Code takes fast mode only from flag settings, which a new child starts without.
  private fast = this.config.fastMode === true;

  constructor(private readonly opts: SessionOptions) {
    super();
    this.id = opts.sessionId;
    this.resume = opts.resume;
    this.dir = opts.cwd;
    this.forkFrom = opts.forkFrom;
  }

  get sessionId(): string {
    return this.id;
  }

  get cwd(): string {
    return this.dir;
  }

  get fastMode(): boolean {
    return this.fast;
  }

  start(): void {
    const id = this.id;
    const env = childEnv(this.dir, process.env, this.config);
    // Nothing to resume (linked to a todo but never used, or cleaned up by
    // Claude Code): start it fresh under the same id instead of failing.
    if (this.resume && !this.forkFrom && !findTranscript(configDir(env), id)) this.resume = false;
    const args = buildArgs({ sessionId: id, resume: this.resume, passthrough: this.opts.passthrough.concat(this.extraArgs), forkFrom: this.forkFrom }, this.config);
    const proc = new ClaudeProcess({
      bin: this.opts.bin ?? process.env.BINDER_CLAUDE_BIN ?? 'claude',
      args,
      cwd: this.dir,
      env,
      stderrPath: join(stateDir(), `${id}.stderr.log`),
    });
    this.proc = proc;
    // The mode the child starts in, until its first init says: switched to
    // plan before then, plan mode still knows where it came from.
    const flag = args.lastIndexOf('--permission-mode');
    this.mode = flag >= 0 ? args[flag + 1] : undefined;
    // Once the session exists on disk every later spawn must resume it.
    this.resume = true;
    this.forkFrom = undefined;

    // The store sums cost across children; this marks where one starts. Only
    // in a log that exists: a resumed Claude Code session has none until it is used.
    if (existsSync(logPath(id))) appendLocal(id, { type: 'hc_spawn' });
    this.emit('event', { type: 'hc_spawn' });
    proc.on('raw', (line) => appendRaw(id, line));
    proc.on('event', (e) => {
      // A child being replaced by switchTo() may still flush a few lines.
      if (this.proc !== proc) return;
      // Each turn's init carries the mode, and a status event carries a change mid-turn.
      const mode = e.type === 'system' ? (e as OtherSystemEvent).permissionMode : undefined;
      if (typeof mode === 'string') {
        if (mode === 'plan' && this.mode !== 'plan') this.beforePlan = this.mode;
        this.mode = mode;
      }
      if (e.type === 'control_response') {
        const r = (e as { response?: { subtype?: string; request_id?: string; error?: string; response?: Record<string, unknown> } }).response;
        const waiting = r?.request_id ? this.requests.get(r.request_id) : undefined;
        if (waiting) {
          this.requests.delete(r!.request_id!);
          if (r!.subtype === 'error') waiting.reject(new Error(r!.error ?? 'request failed'));
          else waiting.resolve(r!.response ?? {});
          return;
        }
      }
      if (e.type === 'control_request') {
        const req = e as ControlRequestEvent;
        if (req.request.subtype === 'can_use_tool') {
          const perm: PermissionRequest = {
            requestId: req.request_id,
            toolName: String(req.request.tool_name ?? ''),
            toolUseId: req.request.tool_use_id as string | undefined,
            input: (req.request.input as Record<string, unknown>) ?? {},
            reason: req.request.decision_reason as string | undefined,
            suggestions: req.request.permission_suggestions,
            ...(typeof req.request.description === 'string' && { description: req.request.description }),
            ...(req.request.tool_name === 'ExitPlanMode' && this.beforePlan && { returnMode: this.beforePlan }),
          };
          // In plan mode entered from bypass mode, interactive Claude Code asks
          // only for its safety checks and the tools that need the user
          // (AskUserQuestion, the plan itself). Headless Claude Code asks binder
          // about every tool it can't prove read-only, so answer those here.
          const bypassed = this.mode === 'plan' && this.beforePlan === 'bypassPermissions'
            && req.request.requires_user_interaction !== true && req.request.decision_reason_type !== 'safetyCheck';
          if (bypassed) this.allow(perm);
          else this.emit('permission', perm);
          return;
        }
      }
      this.emit('event', e);
    });
    proc.on('exit', ({ code }) => {
      if (this.proc === proc) this.emit('exit', { code, stderr: proc.recentStderr.slice() });
    });
    proc.start();
    // Written before any prompt, so the first turn already runs in fast mode.
    if (this.fast) this.request('apply_flag_settings', { settings: { fastMode: true } }).catch(() => {});
    this.request('initialize')
      .then((r) => {
        this.emit('commands', (r.commands as SlashCommand[] | undefined) ?? []);
        const plan = (r.account as { subscriptionType?: string } | undefined)?.subscriptionType;
        if (plan) this.emit('plan', plan);
        const fast = fastReport(r);
        // Asked for (config.json fastMode) but unable to serve: not asked for any
        // more, so the first Alt+O tries again and says why.
        if (this.fast && fast.state === 'off' && fast.reason !== 'pending') this.fast = false;
        if (fast.state) this.emit('fast', fast);
      })
      .catch(() => {});
    this.request('get_settings')
      .then((r) => {
        const applied = r.applied as { model?: string; effort?: string } | undefined;
        if (applied) this.emit('applied', applied);
      })
      .catch(() => {});
  }

  /**
   * The claude binary's own CLI (`claude plugin ...`), run as this session's
   * child is: the same binary, folder and config dir. Resolves its stdout even
   * when it exits non-zero (a --json result says how it went).
   */
  cli(args: string[], timeoutMs = 120_000): Promise<string> {
    return new Promise((done, fail) => {
      execFile(this.opts.bin ?? process.env.BINDER_CLAUDE_BIN ?? 'claude', args, { cwd: this.dir, env: childEnv(this.dir, process.env, this.config), timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, out, errOut) => {
        if (err && !String(out).trim()) fail(new Error(String(errOut || err.message).trim().split('\n').pop() ?? 'claude failed'));
        else done(String(out));
      });
    });
  }

  // A control request to the child (mcp_status, set_model, rewind_files, ...),
  // resolved with its response or rejected with its error.
  request(subtype: string, fields: Record<string, unknown> = {}, timeoutMs = 20000): Promise<Record<string, unknown>> {
    const proc = this.proc;
    if (!proc) return Promise.reject(new Error('claude is not running'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(requestId);
        reject(new Error(`${subtype}: no answer from claude`));
      }, timeoutMs);
      this.requests.set(requestId, {
        resolve: (r) => (clearTimeout(timer), resolve(r)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      proc.send({ type: 'control_request', request_id: requestId, request: { subtype, ...fields } });
    });
  }

  respawn(): void {
    this.proc?.kill();
    this.start();
  }

  // Runs the child on another session: a fresh one (/clear), one to resume,
  // or a fork of this one. Only while idle, so the old child has nothing left
  // to write; it exits on its own while the new one starts.
  switchTo(sessionId: string, { resume, fork, cwd, extraArgs }: SwitchOptions): void {
    const old = this.proc;
    this.proc = null; // its exit is expected, not a crash
    void old?.close();
    this.forkFrom = fork ? this.id : undefined;
    if (sessionId !== this.id) {
      this.config = binderConfig();
      this.fast = this.config.fastMode === true;
    }
    this.id = sessionId;
    this.resume = resume;
    if (cwd) this.dir = cwd;
    if (extraArgs) this.extraArgs = extraArgs;
    this.start();
  }

  // The child moved itself to another directory (set_cwd); later spawns follow.
  movedTo(cwd: string): void {
    this.dir = cwd;
  }

  logLocal(marker: LocalMarker): void {
    appendLocal(this.id, marker);
  }

  // Images are sent with the message but not logged; replay shows the "[Image #n]" text.
  // `context` (bash mode output) goes ahead of the prompt but is not logged as
  // part of it, nor is the text of binder's own follow-up (`auto`). Returns
  // the message uuid, which rewind targets.
  sendPrompt(prompt: string, tabId: number, images: ImageAttachment[] = [], followup = false, context = '', auto?: string): string {
    const uuid = randomUUID();
    appendPrompt(this.id, { prompt, tabId, uuid, ...(followup && { kind: 'followup' as const }), ...(auto !== undefined && { auto: true as const }) });
    const text = auto ?? prompt;
    this.proc?.sendPrompt(context ? `${context}\n\n${text}` : text, images, uuid);
    return uuid;
  }

  // Ctrl+Enter on a running tab: write the follow-up now and ask for it to be
  // read at once. Returns the message uuid its command_lifecycle frames carry.
  steer(prompt: string, tabId: number, images: ImageAttachment[] = []): string {
    const uuid = randomUUID();
    appendPrompt(this.id, { prompt, tabId, kind: 'steer', uuid });
    this.proc?.sendPrompt(prompt, images, uuid);
    this.proc?.sendNow(uuid);
    return uuid;
  }

  interrupt(): void {
    this.proc?.interrupt();
  }

  // AskUserQuestion is answered by allowing the tool with the answers filled
  // into its input; every other tool is simply allowed or denied.
  answerQuestion(req: PermissionRequest, answers: Record<string, string>): void {
    this.proc?.respondControl(req.requestId, { behavior: 'allow', updatedInput: { ...req.input, answers } });
  }

  allow(req: PermissionRequest, updates?: PermissionUpdate[], classification: DecisionClassification = 'user_permanent'): void {
    const always = updates?.length ? { updatedPermissions: updates, decisionClassification: classification } : {};
    this.proc?.respondControl(req.requestId, { behavior: 'allow', updatedInput: req.input, ...always });
  }

  deny(req: PermissionRequest, message = 'Denied by user'): void {
    this.proc?.respondControl(req.requestId, { behavior: 'deny', message });
  }

  // A second `initialize` answers with fast mode's state now (probed on CLI
  // 2.1.331), so a toggle that cannot take effect says why before any turn runs.
  async setFastMode(on: boolean): Promise<FastReport> {
    await this.request('apply_flag_settings', { settings: { fastMode: on } });
    this.fast = on;
    return fastReport(await this.request('initialize').catch(() => ({})));
  }

  async close(): Promise<void> {
    await this.proc?.close();
  }
}
