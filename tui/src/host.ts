import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { AgentSession, PermissionRequest, SwitchOptions } from './session.js';
import type { ClaudeEvent } from './events.js';
import type { ImageAttachment } from './claudeProcess.js';
import { firstPrompt, initialState as emptyState, nextToSend, reduce, type Action, type QueuedPrompt, type Question, type State } from './store.js';
import { codexSessions, upsertSession } from './sessions.js';
import { appendLocal, logPath, replay } from './eventLog.js';
import { CODEX_UNSUPPORTED, mergeCommands, type SlashCommand } from './slashCommands.js';
import { runBash } from './bash.js';
import { listTranscripts, replayTranscript, type SessionSummary } from './transcripts.js';
import { childEnv, configDir as configDirFor } from './paths.js';
import { modelDisplayName, saveCachedUsage } from './statusline.js';
import { liveElsewhere } from './remote/sockets.js';
import { binderConfig, type BinderConfig } from './config.js';
import { workflowMeta, type WorkflowMeta } from './workflow.js';
import { fetchPr, fixPrompt, mergeWhenReady } from './pr.js';
import { alwaysChoices, checkMode, KEEP_PLANNING, MODE_CYCLE, modeLabel, PLAN_FEEDBACK, planChoices, type AlwaysChoice } from './permissions.js';

// Stream deltas arrive hundreds per second; they are applied in batches so
// viewers render at most ~60 times a second instead of once per delta.
const EVENT_BATCH_MS = 16;

type HostEvents = {
  change: [];
  // The slash commands the child runs, merged with binder's own.
  commands: [SlashCommand[]];
  // The folder claude is in changed (/cd, a resume into another folder, or claude's own cd).
  cwd: [string];
  // The host moved to another session id (/clear, /fork, /resume).
  session: [string];
  effort: [string];
  plan: [string];
};

// Why fast mode cannot serve (fast_mode_disabled_reason), in Claude Code's words where it has them.
const FAST_UNAVAILABLE: Record<string, string> = {
  free: 'Fast mode requires a paid subscription',
  preference: 'Fast mode has been disabled by your organization',
  extra_usage_disabled: 'Fast mode requires usage credits: turn on extra usage for your account',
  network_error: 'Fast mode is unavailable: Claude Code could not reach the server',
  not_first_party: 'Fast mode is not available on this provider',
  model_not_allowed: "Fast mode's model is not in your organization's allowed models",
};

// "Always" on a workflow: a rule allowing the Workflow tool in this project.
const WORKFLOW_ALWAYS: AlwaysChoice[] = [
  {
    label: 'Always allow workflows',
    description: 'in this project, saved in .claude/settings.local.json',
    updates: [{ type: 'addRules', rules: [{ toolName: 'Workflow' }], behavior: 'allow', destination: 'localSettings' }],
  },
];

// A workflow's card: what its script's meta says, else (one re-run by name or
// script path) its name and what the request says it does.
function workflowCard(req: PermissionRequest): WorkflowMeta {
  const meta = workflowMeta(req.input.script);
  const name = meta.name ?? (typeof req.input.name === 'string' && req.input.name ? req.input.name : undefined);
  const description = meta.description ?? req.description;
  return { ...(name && { name }), ...(description && { description }), phases: meta.phases };
}

// What Claude reads when the plan is turned down without a word on what to change.
const KEEP_PLANNING_MESSAGE = 'The user does not want to proceed with this plan yet. Stay in plan mode and ask what they would like to change.';

const PLUGIN_ACTIONS = ['install', 'uninstall', 'enable', 'disable'];
export type InstalledPlugin = { id: string; version?: string; scope?: string; enabled: boolean; projectEnabled?: boolean };
export type AvailablePlugin = { pluginId: string; name: string; description?: string; marketplaceName?: string };

// How long a side question (/btw) may take.
const SIDE_QUESTION_MS = 180_000;
// What a side question shows when Claude gives no answer: binder's words, not history to send back.
const NO_SIDE_ANSWER = 'No answer for this side question. Try again, or ask in the conversation.';

// How often an open PR is asked about.
const PR_POLL_MS = 60_000;

// An entry of the child's `list_models`.
type ModelInfo = { value: string; resolvedModel?: string; supportedEffortLevels?: string[] };

export type CdResult = { status: 'ok'; cwd: string } | { status: 'needs_trust'; directory: string } | { status: 'rejected'; message: string };
export type RewindMode = 'both' | 'conversation' | 'code';

/**
 * One session: the claude child, the tabs reduced from its events, the prompt
 * queue, bash mode, questions, and the commands that move the session
 * (/clear, /resume, /fork, /rewind, /cd, /model, /effort, /chrome). The TUI
 * is one viewer of it; remote viewers attach through hostServer.ts.
 * Commands throw an Error with a message meant for the user when they cannot run.
 */
export class SessionHost extends EventEmitter<HostEvents> {
  private current: State;
  commands: SlashCommand[];
  effort: string | undefined;
  // The account's plan, e.g. "Claude Max".
  plan: string | undefined;
  // When the running turn started (ms), so a viewer that attaches mid-turn
  // shows how long it has really run.
  runningSince: number | undefined;
  private dir: string;
  private pending: PermissionRequest | null = null;
  // The open permission prompt's "always allow" choices, by label.
  private always: AlwaysChoice[] = [];
  private lastSent: QueuedPrompt | null = null;
  private bashRuns = new Map<number, () => void>();
  private batch: ClaudeEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private cycling: Promise<unknown> = Promise.resolve();
  // PR watching (pr.ts): the last refresh, the poll while a PR is open, and the
  // auto-fix asks already made (one per head commit and failure, or review).
  private prBusy = false;
  private prTimer: NodeJS.Timeout | null = null;
  private prAsked = new Set<string>();
  private prFix: string | null = null;
  // A plugin change waiting for the turn to end before it loads.
  private pluginReloadWaiting = false;
  // config.json as this session started (/clear, /resume and /fork start
  // another): the settings for sessions opened from now on stay as they were.
  config: BinderConfig = binderConfig();

  constructor(
    readonly session: AgentSession,
    initial: State,
    cwd: string,
    readonly configDir: string,
  ) {
    super();
    this.setMaxListeners(50);
    this.current = initial;
    this.dir = cwd;
    this.commands = mergeCommands([], this.unsupported);
    session.on('event', (e) => {
      this.batch.push(e);
      this.flushTimer ??= setTimeout(this.flush, EVENT_BATCH_MS);
    });
    session.on('permission', (req) => {
      this.flush();
      this.pending = req;
      const config = this.config;
      const plan = req.toolName === 'ExitPlanMode' && config.planApproval !== false && typeof req.input.plan === 'string' ? req.input.plan : undefined;
      const workflow = req.toolName === 'Workflow' && config.workflowCard !== false ? workflowCard(req) : undefined;
      const workflowAlways = config.alwaysAllow === false ? [] : WORKFLOW_ALWAYS;
      this.always = plan !== undefined ? planChoices(req.returnMode) : workflow ? workflowAlways : config.alwaysAllow === false ? [] : alwaysChoices(req.suggestions);
      const question: Question =
        workflow
          ? {
              requestId: req.requestId,
              toolName: req.toolName,
              toolInput: req.input,
              workflow,
              questions: [
                {
                  question: `Run the workflow${workflow.name ? ` ${workflow.name}` : ''}?`,
                  header: 'Workflow',
                  options: [{ label: 'Run once' }, ...workflowAlways.map(({ label, description }) => ({ label, description })), { label: 'Deny' }],
                },
              ],
            }
          : req.toolName === 'AskUserQuestion'
          ? { requestId: req.requestId, toolUseId: req.toolUseId, toolName: req.toolName, questions: (req.input.questions as Question['questions']) ?? [] }
          : plan !== undefined
          ? {
              requestId: req.requestId,
              toolName: req.toolName,
              toolInput: req.input,
              plan,
              questions: [
                {
                  question: 'Ready to code?',
                  header: 'Plan',
                  options: [...this.always.map(({ label, description }) => ({ label, description })), { label: KEEP_PLANNING, description: 'stays in plan mode' }],
                },
              ],
            }
          : {
              requestId: req.requestId,
              toolName: req.toolName,
              toolInput: req.input,
              reason: req.reason,
              questions: [
                {
                  question: `Allow ${req.toolName}?`,
                  header: 'Permission',
                  options: [{ label: 'Allow' }, ...this.always.map(({ label, description }) => ({ label, description })), { label: 'Deny' }],
                },
              ],
            };
      this.dispatch({ type: 'question', question });
    });
    session.on('exit', (e) => {
      this.flush(); // the last events before the exit belong to the turn that died
      this.dispatch({ type: 'child_exit', code: e.code, stderr: e.stderr });
    });
    session.on('commands', (list) => {
      this.commands = mergeCommands(list, this.unsupported);
      this.emit('commands', this.commands);
    });
    session.on('plan', (plan) => {
      this.plan = plan;
      this.emit('plan', plan);
    });
    // Known before the first turn's init, so the welcome header can show them.
    session.on('applied', ({ model, effort }) => {
      if (model) this.dispatch({ type: 'model', model });
      if (effort) this.noteEffort(effort);
    });
    session.on('fast', ({ state }) => {
      if (state) this.dispatch({ type: 'fast_mode', state });
    });
    this.watchPr();
  }

  // The session's PR: now, after each turn, and every minute while one is open.
  private watchPr(): void {
    this.prTimer = setInterval(() => {
      if (this.config.prWatch !== false && this.current.pr?.state === 'OPEN') void this.refreshPr();
    }, PR_POLL_MS);
    this.prTimer.unref();
    if (this.config.prWatch !== false) void this.refreshPr();
  }

  /** Asks gh about the session's PR now; with prAutoFix, a new failure or review becomes a prompt. */
  async refreshPr(): Promise<void> {
    if (this.prBusy) return;
    this.prBusy = true;
    try {
      const pr = await fetchPr(this.dir);
      this.dispatch({ type: 'pr', pr });
      const fix = pr && this.config.prAutoFix === true ? fixPrompt(pr) : null;
      if (fix && !this.prAsked.has(fix.key)) {
        this.prAsked.add(fix.key);
        this.prFix = fix.text;
        this.sendPrFix();
      }
    } finally {
      this.prBusy = false;
    }
  }

  // An auto-fix waits for the session to be idle, then opens a tab of its own.
  private sendPrFix(): void {
    if (!this.prFix || this.busy || this.current.question || this.current.childExit) return;
    const text = this.prFix;
    this.prFix = null;
    this.send(text);
  }

  /** /pr's "fix": the failing checks or the review, asked now. */
  fixPr(): string {
    const pr = this.current.pr;
    const fix = pr ? fixPrompt(pr) : null;
    if (!fix) throw new Error(pr ? `PR #${pr.number} has no failing check or review asking for changes` : 'No pull request for this branch');
    this.prAsked.add(fix.key);
    this.send(fix.text);
    return 'Asked Claude to fix it';
  }

  /** /pr's "merge when ready" (gh pr merge --auto --squash). */
  async mergePr(): Promise<string> {
    const pr = this.current.pr;
    if (!pr) throw new Error('No pull request for this branch');
    return mergeWhenReady(this.dir, pr.number);
  }

  get state(): State {
    return this.current;
  }

  get cwd(): string {
    return this.dir;
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  // For useSyncExternalStore.
  getState = (): State => this.current;
  subscribe = (fn: () => void): (() => void) => {
    this.on('change', fn);
    return () => this.off('change', fn);
  };

  // Binder's commands this session's agent cannot run.
  private get unsupported() {
    return this.session.agent === 'codex' ? CODEX_UNSUPPORTED : [];
  }

  get busy(): boolean {
    const s = this.current;
    return s.running !== null || s.queue.length > 0 || s.steer !== undefined || s.unstarted !== undefined;
  }

  /** The session's name, or else its first prompt's first line. */
  get title(): string {
    const name = this.current.title?.trim();
    if (name) return name.slice(0, 80);
    return this.current.tabs[0] ? firstPrompt(this.current.tabs[0]).split('\n')[0].trim().slice(0, 80) : '';
  }

  dispatch(action: Action): void {
    const prev = this.current;
    const next = reduce(prev, action);
    if (next === prev) return;
    this.current = next;
    // Before pump(): a queued prompt it sends starts a turn of its own.
    if (next.running !== prev.running) this.runningSince = next.running === null ? undefined : Date.now();
    // A turn that ends may have pushed: look at the PR again, and send an auto-fix that waited.
    if (prev.running !== null && next.running === null) queueMicrotask(() => {
      // Not if a queued prompt has started the next turn already: then after that one.
      if (this.pluginReloadWaiting && this.current.running === null) void this.reloadPlugins().catch(() => {});
      this.sendPrFix();
      if (this.config.prWatch !== false) void this.refreshPr();
    });
    if (next.usage && next.usage !== prev.usage) saveCachedUsage(this.configDir, next.usage);
    // Kept in binder's index too: Codex sessions have no transcript to read it from.
    if (next.title && next.title !== prev.title) upsertSession({ id: this.sessionId, cwd: this.session.cwd, configDir: this.configDir, title: next.title });
    this.pump();
    this.emit('change');
  }

  private flush = (): void => {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const events = this.batch;
    this.batch = [];
    if (!events.length) return;
    const was = this.current.cwd;
    this.dispatch({ type: 'events', events });
    // Claude moved itself (a cd in Bash, a worktree): each turn's init names its
    // folder. The session's own folder (session.cwd), where history, the session
    // index and respawns live, stays put, as it does in Claude Code.
    const cwd = this.current.cwd;
    if (cwd && cwd !== was && cwd !== this.dir) this.moveTo(cwd);
  };

  // Send the next queued prompt whenever the child is idle, with any bash
  // mode output the model has not seen yet ahead of it.
  private pump(): void {
    const next = nextToSend(this.current);
    if (!next || this.lastSent === next) return;
    this.lastSent = next;
    const uuid = this.session.sendPrompt(next.prompt, next.tabId, next.images, next.followup, this.current.bashContext.join('\n'), next.auto?.text);
    this.dispatch({ type: 'sent', tabId: next.tabId, uuid, auto: Boolean(next.auto) });
    upsertSession({ id: this.sessionId, cwd: this.session.cwd, configDir: this.configDir, firstPrompt: next.prompt });
  }

  private nextTabId(): number {
    return this.current.tabs.length ? Math.max(...this.current.tabs.map((t) => t.id)) + 1 : 1;
  }

  /**
   * A prompt: a new tab, or into tab `intoTabId` (sent at once on its running
   * turn when the child supports it, otherwise after it). `!command` runs in
   * bash mode. Returns the tab it went to.
   */
  send(text: string, images: ImageAttachment[] = [], intoTabId?: number): number {
    if (/^!\s*\S/.test(text)) return this.runBash(text.replace(/^!\s*/, ''));
    if (this.session.agent === 'codex' && images.some((a) => a.mediaType === 'application/pdf')) throw new Error('Codex reads images and text files, not PDFs');
    const target = intoTabId === undefined ? undefined : this.current.tabs.find((t) => t.id === intoTabId && !t.bash);
    if (!target) {
      const tabId = this.nextTabId();
      this.dispatch({ type: 'submit', prompt: text, images, tabId });
      return tabId;
    }
    const s = this.current;
    if (s.running === target.id && s.canSteer && !s.steer) {
      const uuid = this.session.steer(text, target.id, images);
      this.dispatch({ type: 'steer', tabId: target.id, prompt: text, uuid });
    } else {
      this.dispatch({ type: 'followup', tabId: target.id, prompt: text, images });
    }
    return target.id;
  }

  /**
   * Changes a prompt still queued for tab `tabId`, found by its text. Empty
   * text removes it; for the prompt that opens a new tab, the tab goes too.
   */
  editQueued(tabId: number, prompt: string, text: string): void {
    if (!this.current.queue.some((q) => q.tabId === tabId && q.prompt === prompt)) throw new Error('That prompt is no longer queued');
    this.dispatch({ type: 'edit_queued', tabId, prompt, text: text.trim() ? text : '' });
  }

  // Bash mode: run it here, show it in its own tab, and hand the output to the model with the next prompt.
  runBash(command: string): number {
    const sid = this.sessionId;
    const tabId = this.nextTabId();
    this.dispatch({ type: 'bash_start', command, tabId });
    appendLocal(sid, { type: 'hc_bash', tabId, command });
    const run = runBash(command, this.dir);
    this.bashRuns.set(tabId, run.kill);
    void run.done.then(({ output, exitCode }) => {
      this.bashRuns.delete(tabId);
      appendLocal(sid, { type: 'hc_bash_done', tabId, output, exitCode });
      if (this.sessionId === sid) this.dispatch({ type: 'bash_done', tabId, output, exitCode });
    });
    return tabId;
  }

  stopBash(tabId: number): void {
    this.bashRuns.get(tabId)?.();
  }

  interrupt(): void {
    if (this.current.running === null) return;
    this.dispatch({ type: 'interrupt_requested' });
    this.session.interrupt();
  }

  /** Stops a background shell or agent (stop_task). Its end then needs no follow-up. */
  async stopTask(taskId: string): Promise<void> {
    this.dispatch({ type: 'task_stopping', taskId });
    this.session.logLocal({ type: 'hc_stop_task', taskId });
    await this.session.request('stop_task', { task_id: taskId });
  }

  /** The end of a background shell's or monitor's output, at most its last 8 KiB (get_task_output). */
  async taskOutput(taskId: string): Promise<{ output: string; totalBytes: number; truncated: boolean }> {
    const r = await this.session.request('get_task_output', { task_id: taskId });
    return { output: String(r.output ?? ''), totalBytes: Number(r.total_bytes ?? 0), truncated: r.truncated === true };
  }

  /** Ctrl+B: the running turn's foreground commands and agents carry on in the background (background_tasks). */
  async background(): Promise<void> {
    if (this.current.running === null) return;
    await this.session.request('background_tasks');
  }

  private openQuestion(requestId: string): PermissionRequest {
    const p = this.pending;
    if (!p || p.requestId !== requestId) throw new Error('That question is no longer open');
    return p;
  }

  /**
   * AskUserQuestion answers; a permission prompt answered with "Allow", "Deny"
   * or an "always allow" choice's label; or a plan answered with one of its
   * choices, "No, keep planning", or what to change (any other text).
   */
  answer(requestId: string, answers: Record<string, string>): void {
    const p = this.openQuestion(requestId);
    const label = Object.values(answers)[0];
    const choice = this.always.find((c) => c.label === label);
    const question = this.current.question;
    const planning = question?.plan !== undefined;
    // A permission prompt allows only on one of its own choices.
    if (p.toolName !== 'AskUserQuestion' && !planning && !question?.questions[0]?.options.some((o) => o.label === label)) {
      throw new Error(`Not a choice on this prompt: ${label ?? '(none)'}`);
    }
    if (p.toolName === 'AskUserQuestion') this.session.answerQuestion(p, answers);
    else if (planning && !choice) this.session.deny(p, [KEEP_PLANNING, PLAN_FEEDBACK, 'Deny'].includes(label) || !label?.trim() ? KEEP_PLANNING_MESSAGE : `The user wants changes to the plan before you start: ${label}`);
    else if (label === 'Deny') this.session.deny(p);
    // A plan's choice switches the mode for this session only: allowed once, as Claude Code sees it.
    else this.session.allow(p, choice?.updates, planning ? 'user_temporary' : undefined);
    this.closeQuestion();
  }

  allow(requestId: string): void {
    this.session.allow(this.openQuestion(requestId));
    this.closeQuestion();
  }

  deny(requestId: string): void {
    const p = this.openQuestion(requestId);
    if (this.current.question?.plan !== undefined) this.session.deny(p, KEEP_PLANNING_MESSAGE);
    else this.session.deny(p);
    this.closeQuestion();
  }

  private closeQuestion(): void {
    this.pending = null;
    this.always = [];
    this.dispatch({ type: 'question_answered' });
  }

  private requireIdle(what: string): void {
    if (this.busy) throw new Error(`Wait for the running turn to finish (or interrupt it) before ${what}`);
  }

  // Whether claude run in `dir` would use the same account (config dir) as here.
  // Codex has one account (CODEX_HOME), not one per folder.
  private sameAccount(dir: string): boolean {
    if (this.session.agent === 'codex') return true;
    return configDirFor(childEnv(dir)) === configDirFor(childEnv(this.session.cwd));
  }

  private moveTo(cwd: string): void {
    this.dir = cwd;
    this.emit('cwd', cwd);
  }

  // /clear, /resume, /fork: the child moves to another session and `next`'s tabs replace these.
  private switchSession(id: string, opts: SwitchOptions, next: State): void {
    const pid = liveElsewhere(id);
    if (pid) throw new Error(`Session ${id.slice(0, 8)} is open in another binder (pid ${pid})`);
    this.flush();
    this.pending = null;
    this.always = [];
    this.lastSent = null;
    this.config = binderConfig();
    this.session.switchTo(id, opts);
    this.dispatch({ type: 'reset', state: next });
    // The new child starts in the session's folder, wherever the old one had moved to.
    if (this.session.cwd !== this.dir) this.moveTo(this.session.cwd);
    upsertSession({ id, cwd: this.session.cwd, configDir: this.configDir, agent: this.session.agent });
    this.emit('session', id);
  }

  clear(): string {
    this.requireIdle('/clear');
    const previous = this.sessionId;
    const id = randomUUID();
    this.switchSession(id, { resume: false }, emptyState(id));
    return `New session. /resume ${previous.slice(0, 8)} brings the previous one back.`;
  }

  resume(s: SessionSummary): string {
    this.requireIdle('/resume');
    const next = existsSync(logPath(s.id)) ? replay(s.id) : replayTranscript(s.id, s.path);
    // Follow the session to its folder when it is another one this account can run in.
    const dir = s.cwd && s.cwd !== this.session.cwd && existsSync(s.cwd) && this.sameAccount(s.cwd) ? s.cwd : undefined;
    this.switchSession(s.id, { resume: true, cwd: dir }, next);
    return `Resumed ${s.id.slice(0, 8)}${dir ? ` in ${dir}` : ''}`;
  }

  /** The session (by id or id prefix) /resume would pick, from Claude Code's transcripts or binder's Codex sessions. */
  findSession(prefix: string): SessionSummary | undefined {
    const all = this.session.agent === 'codex' ? codexSessions() : listTranscripts(this.configDir);
    return all.find((s) => s.id.startsWith(prefix) && s.id !== this.sessionId);
  }

  fork(title: string): string {
    this.requireIdle('/fork');
    const s = this.current;
    if (!s.tabs.length) throw new Error('Nothing to fork yet');
    const from = this.sessionId;
    const id = randomUUID();
    if (existsSync(logPath(from))) copyFileSync(logPath(from), logPath(id));
    this.switchSession(id, { resume: true, fork: true }, existsSync(logPath(id)) ? replay(id) : { ...s, sessionId: id });
    upsertSession({ id, cwd: this.session.cwd, configDir: this.configDir, firstPrompt: firstPrompt(s.tabs[0]) });
    if (title) this.session.request('rename_session', { title, source: 'host' }).catch(() => {});
    return `Forked into ${id.slice(0, 8)}. /resume ${from.slice(0, 8)} goes back to the original.`;
  }

  /** /rename: the child keeps the name and reports it (session_title_changed), tidied, into state.title. */
  async rename(title: string): Promise<void> {
    if (!title.trim()) throw new Error('Give the session a title: /rename <title>');
    await this.session.request('rename_session', { title });
  }

  /** Restores code and/or conversation to just before the prompt sent as `uuid`; returns the prompt to put back. */
  async rewind(uuid: string, mode: RewindMode): Promise<{ prefill?: string; message: string }> {
    this.requireIdle('/rewind');
    let prefill: string | undefined;
    if (mode !== 'conversation') await this.session.request('rewind_files', { user_message_id: uuid }, 60000);
    if (mode !== 'code') {
      const target = this.current.tabs.flatMap((t) => [...t.earlier, t]).find((turn) => turn.uuid === uuid);
      const r = await this.session.request('rewind_conversation', { target_message_uuid: uuid });
      this.dispatch({ type: 'rewind', uuid });
      this.session.logLocal({ type: 'hc_rewind', uuid });
      prefill = typeof r.prefillText === 'string' ? r.prefillText : target?.prompt;
    }
    const message = mode === 'code' ? 'Restored the code' : mode === 'both' ? 'Restored the code and the conversation' : 'Restored the conversation';
    return { prefill, message };
  }

  /** /cd: `trust` repeats the request once the user agreed to trust the folder claude named. */
  async changeDir(arg: string, trust?: string): Promise<CdResult> {
    this.requireIdle('/cd');
    const target = resolve(this.dir, arg.replace(/^~(?=$|\/)/, homedir()));
    if (!existsSync(target) || !statSync(target).isDirectory()) return { status: 'rejected', message: `Not a directory: ${target}` };
    if (!this.sameAccount(target)) return { status: 'rejected', message: `${target} uses another Claude account; start binder there instead` };
    const r = await this.session.request('set_cwd', trust ? { path: target, trust_accepted: true, trusted_directory: trust } : { path: target });
    if (r.status === 'needs_trust') return { status: 'needs_trust', directory: String(r.directory ?? target) };
    if (r.status === 'rejected') return { status: 'rejected', message: String(r.message ?? 'claude refused the directory') };
    this.session.movedTo(target);
    this.moveTo(target);
    upsertSession({ id: this.sessionId, cwd: target, configDir: this.configDir });
    return { status: 'ok', cwd: target };
  }

  async setModel(model: string): Promise<void> {
    await this.session.request('set_model', { model });
    // An alias ("default", "opus") is kept as the model it stands for, as the next turn's init names it.
    const entry = (await this.models().catch(() => [])).find((m) => m.value === model);
    this.dispatch({ type: 'model', model: entry?.resolvedModel ?? model });
  }

  async setPermissionMode(mode: string): Promise<void> {
    checkMode(mode);
    const r = await this.session.request('set_permission_mode', { mode });
    // Claude Code answers with the mode in effect ("manual" comes back as "default").
    this.dispatch({ type: 'permission_mode', mode: typeof r.mode === 'string' ? r.mode : mode });
  }

  /** Alt+M, as Shift+Tab in Claude Code: the next permission mode the child accepts. */
  cycleMode(): Promise<string> {
    return this.oneAtATime(async () => {
      const mode = this.current.permissionMode === 'manual' ? 'default' : this.current.permissionMode ?? 'default';
      const i = MODE_CYCLE.indexOf(mode);
      // bypassPermissions needs a child started in it, and auto mode an account that has it: skip what is refused.
      let refused: unknown;
      for (const next of [...MODE_CYCLE.slice(i + 1), ...MODE_CYCLE.slice(0, Math.max(0, i))]) {
        try {
          await this.setPermissionMode(next);
          return `Permission mode: ${modeLabel(this.current.permissionMode ?? next)}`;
        } catch (e) {
          refused = e;
        }
      }
      throw refused instanceof Error ? refused : new Error('No other permission mode to switch to');
    });
  }

  /**
   * /fast and Alt+O: asks for fast mode, or stops (no argument flips it).
   * Returns what to tell the user. When fast mode cannot serve, binder stops
   * asking for it, so the next press tries again rather than turning it "off".
   */
  /** /plugins: the installed plugins (claude plugin list), and with `available` the marketplaces' too. */
  async plugins(available = false): Promise<{ installed: InstalledPlugin[]; available?: AvailablePlugin[] }> {
    if (this.session.agent === 'codex') throw new Error('Plugins are not available in a Codex session');
    const d = JSON.parse(await this.session.cli(['plugin', 'list', '--json', ...(available ? ['--available'] : [])]));
    return Array.isArray(d) ? { installed: d } : { installed: d.installed ?? [], ...(available && { available: d.available ?? [] }) };
  }

  /** Installs, uninstalls, enables or disables a plugin (claude plugin ...), then loads the change into this session (config.json pluginReload). */
  async pluginAction(action: string, plugin: string, scope?: string): Promise<string> {
    if (!PLUGIN_ACTIONS.includes(action)) throw new Error(`Not a plugin action: ${action}`);
    if (this.session.agent === 'codex') throw new Error('Plugins are not available in a Codex session');
    const out = await this.session.cli(['plugin', action, plugin, '--json', ...(scope ? ['--scope', scope] : [])]);
    const line = out
      .trim()
      .split('\n')
      .reverse()
      .find((l: string) => l.startsWith('{'));
    const r = line ? (JSON.parse(line) as { outcome?: string; message?: string }) : null;
    if (!r || r.outcome !== 'ok') throw new Error(r?.message ?? `claude plugin ${action} said nothing`);
    if (binderConfig().pluginReload === false) return `${r.message} (loads when claude next starts)`;
    // Not into a running turn: once it ends.
    if (this.current.running !== null) {
      this.pluginReloadWaiting = true;
      return `${r.message}. It loads when this turn ends`;
    }
    try {
      return `${r.message}. ${await this.reloadPlugins()}`;
    } catch (e) {
      // A turn is running: once it ends.
      this.pluginReloadWaiting = true;
      return `${r.message}. It loads when this turn ends (${(e as Error).message})`;
    }
  }

  /** Loads the plugins as they now are into the running claude, and takes its new commands. */
  async reloadPlugins(): Promise<string> {
    this.pluginReloadWaiting = false;
    const r = await this.session.request('reload_plugins', { refuse_if_busy: true }, 60_000);
    if (Array.isArray(r.commands)) {
      this.commands = mergeCommands(r.commands as SlashCommand[], this.unsupported);
      this.emit('commands', this.commands);
    }
    const n = (k: string) => (Array.isArray(r[k]) ? (r[k] as unknown[]).length : 0);
    return `Loaded ${n('plugins')} plugin${n('plugins') === 1 ? '' : 's'} with ${n('commands')} commands${Number(r.error_count) > 0 ? `, ${r.error_count} with errors` : ''}`;
  }

  /** /btw: a side question, answered from the conversation so far (and earlier side questions, `history`) without tools, kept out of the transcript. */
  async sideQuestion(question: string, history: Array<{ question: string; response: string }> = []): Promise<{ response: string; synthetic: boolean }> {
    if (this.session.agent === 'codex') throw new Error('Side questions are not available in a Codex session');
    if (!question.trim()) throw new Error('Ask a question');
    const asked = history.filter((h) => h.response !== NO_SIDE_ANSWER);
    const r = await this.session.request('side_question', { question, ...(asked.length && { history: asked }) }, SIDE_QUESTION_MS);
    const response = typeof r.response === 'string' ? r.response : null;
    return { response: response ?? NO_SIDE_ANSWER, synthetic: r.synthetic === true || response === null };
  }

  async setFastMode(on = !this.session.fastMode): Promise<string> {
    const r = await this.session.setFastMode(on);
    if (r.state) this.dispatch({ type: 'fast_mode', state: r.state });
    if (!on) return 'Fast mode off';
    if (r.state === 'cooldown') return 'Fast mode on, paused after a rate limit';
    // Unknown (an older CLI) or still being checked: the next turn's init will say.
    if (r.state !== 'off' || r.reason === 'pending') return 'Fast mode on';
    await this.session.setFastMode(false).catch(() => {});
    return r.reason ? (FAST_UNAVAILABLE[r.reason] ?? 'Fast mode is not available right now') : `${modelDisplayName(this.current.model) || 'This model'} has no fast mode`;
  }

  async setEffort(level: string): Promise<void> {
    await this.session.request('apply_flag_settings', { settings: { effortLevel: level } });
    this.noteEffort(level);
  }

  /** The effort level changed (also when the TUI's panel set it). */
  noteEffort(level: string): void {
    this.effort = level;
    this.emit('effort', level);
  }

  /** Ctrl+P / Shift+Ctrl+P, as in pi: the next or previous model the agent offers. */
  cycleModel(delta: 1 | -1): Promise<string> {
    return this.oneAtATime(async () => {
      const models = await this.models();
      // Once per model: Claude Code lists "default" and its alias for the same one.
      const ids = [...new Set(models.map((m) => m.resolvedModel ?? m.value))];
      if (!ids.length) throw new Error('No models to switch to');
      const current = this.modelEntry(models);
      const i = current ? ids.indexOf(current.resolvedModel ?? current.value) : -1;
      const id = ids[i < 0 ? (delta > 0 ? 0 : ids.length - 1) : (i + delta + ids.length) % ids.length];
      await this.session.request('set_model', { model: models.find((m) => (m.resolvedModel ?? m.value) === id)!.value });
      this.dispatch({ type: 'model', model: id });
      return `Model: ${modelDisplayName(id)}`;
    });
  }

  /** Shift+Tab, as in pi: the next effort level the current model supports. */
  cycleEffort(): Promise<string> {
    return this.oneAtATime(async () => {
      const models = await this.models();
      const m = this.modelEntry(models) ?? models[0];
      const levels = m?.supportedEffortLevels ?? [];
      if (!levels.length) throw new Error(`${modelDisplayName(m?.resolvedModel ?? m?.value ?? this.current.model)} has no effort levels`);
      const level = levels[(levels.indexOf(this.effort ?? '') + 1) % levels.length];
      await this.setEffort(level);
      return `Effort: ${level}`;
    });
  }

  private async models(): Promise<ModelInfo[]> {
    return ((await this.session.request('list_models')).models as ModelInfo[] | undefined) ?? [];
  }

  private modelEntry(models: ModelInfo[]): ModelInfo | undefined {
    const model = this.current.model;
    return models.find((m) => m.resolvedModel === model || m.value === model);
  }

  // A key held down cycles one step per press: each waits for the last to land.
  private oneAtATime(fn: () => Promise<string>): Promise<string> {
    const run = this.cycling.then(fn);
    this.cycling = run.catch(() => {});
    return run;
  }

  // Claude in Chrome is decided when claude starts, so this restarts it on the same session.
  setChrome(on: boolean): string {
    if (this.session.agent === 'codex') throw new Error('/chrome is not available in a Codex session');
    this.requireIdle('/chrome');
    this.lastSent = null;
    this.session.switchTo(this.sessionId, { resume: true, extraArgs: [on ? '--chrome' : '--no-chrome'] });
    return on ? 'Restarted claude with Claude in Chrome' : 'Restarted claude without Claude in Chrome';
  }

  /** After the child exited: start it again on the same session. */
  restart(): void {
    if (!this.current.childExit) return;
    this.lastSent = null;
    this.session.respawn();
    // Queued prompts go to the new child.
    this.dispatch({ type: 'child_restarted' });
  }

  async close(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.prTimer) clearInterval(this.prTimer);
    for (const kill of this.bashRuns.values()) kill();
    await this.session.close();
  }
}
