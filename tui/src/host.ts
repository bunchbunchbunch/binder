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

// Stream deltas arrive hundreds per second; they are applied in batches so
// viewers render at most ~60 times a second instead of once per delta.
const EVENT_BATCH_MS = 16;

type HostEvents = {
  change: [];
  // The slash commands the child runs, merged with binder's own.
  commands: [SlashCommand[]];
  // The working directory changed (/cd, or a resume into another folder).
  cwd: [string];
  // The host moved to another session id (/clear, /fork, /resume).
  session: [string];
  effort: [string];
  plan: [string];
};

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
  private lastSent: QueuedPrompt | null = null;
  private bashRuns = new Map<number, () => void>();
  private batch: ClaudeEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private cycling: Promise<unknown> = Promise.resolve();

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
      const question: Question =
        req.toolName === 'AskUserQuestion'
          ? { requestId: req.requestId, toolUseId: req.toolUseId, toolName: req.toolName, questions: (req.input.questions as Question['questions']) ?? [] }
          : {
              requestId: req.requestId,
              toolName: req.toolName,
              toolInput: req.input,
              reason: req.reason,
              questions: [{ question: `Allow ${req.toolName}?`, header: 'Permission', options: [{ label: 'Allow' }, { label: 'Deny' }] }],
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

  get title(): string {
    return this.current.tabs[0] ? firstPrompt(this.current.tabs[0]).split('\n')[0].trim().slice(0, 80) : '';
  }

  dispatch(action: Action): void {
    const prev = this.current;
    const next = reduce(prev, action);
    if (next === prev) return;
    this.current = next;
    // Before pump(): a queued prompt it sends starts a turn of its own.
    if (next.running !== prev.running) this.runningSince = next.running === null ? undefined : Date.now();
    if (next.usage && next.usage !== prev.usage) saveCachedUsage(this.configDir, next.usage);
    this.pump();
    this.emit('change');
  }

  private flush = (): void => {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const events = this.batch;
    this.batch = [];
    if (events.length) this.dispatch({ type: 'events', events });
  };

  // Send the next queued prompt whenever the child is idle, with any bash
  // mode output the model has not seen yet ahead of it.
  private pump(): void {
    const next = nextToSend(this.current);
    if (!next || this.lastSent === next) return;
    this.lastSent = next;
    const uuid = this.session.sendPrompt(next.prompt, next.tabId, next.images, next.followup, this.current.bashContext.join('\n'), next.auto?.text);
    this.dispatch({ type: 'sent', tabId: next.tabId, uuid, auto: Boolean(next.auto) });
    upsertSession({ id: this.sessionId, cwd: this.dir, configDir: this.configDir, firstPrompt: next.prompt });
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

  /** AskUserQuestion answers, or a permission prompt answered with the label "Allow" or "Deny". */
  answer(requestId: string, answers: Record<string, string>): void {
    const p = this.openQuestion(requestId);
    if (p.toolName === 'AskUserQuestion') this.session.answerQuestion(p, answers);
    else if (Object.values(answers)[0] === 'Deny') this.session.deny(p);
    else this.session.allow(p);
    this.closeQuestion();
  }

  allow(requestId: string): void {
    this.session.allow(this.openQuestion(requestId));
    this.closeQuestion();
  }

  deny(requestId: string): void {
    this.session.deny(this.openQuestion(requestId));
    this.closeQuestion();
  }

  private closeQuestion(): void {
    this.pending = null;
    this.dispatch({ type: 'question_answered' });
  }

  private requireIdle(what: string): void {
    if (this.busy) throw new Error(`Wait for the running turn to finish (or interrupt it) before ${what}`);
  }

  // Whether claude run in `dir` would use the same account (config dir) as here.
  // Codex has one account (CODEX_HOME), not one per folder.
  private sameAccount(dir: string): boolean {
    if (this.session.agent === 'codex') return true;
    return configDirFor(childEnv(dir)) === configDirFor(childEnv(this.dir));
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
    this.lastSent = null;
    this.session.switchTo(id, opts);
    this.dispatch({ type: 'reset', state: next });
    if (opts.cwd) this.moveTo(opts.cwd);
    upsertSession({ id, cwd: opts.cwd ?? this.dir, configDir: this.configDir, agent: this.session.agent });
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
    const dir = s.cwd && s.cwd !== this.dir && existsSync(s.cwd) && this.sameAccount(s.cwd) ? s.cwd : undefined;
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
    upsertSession({ id, cwd: this.dir, configDir: this.configDir, firstPrompt: firstPrompt(s.tabs[0]) });
    if (title) this.session.request('rename_session', { title, source: 'host' }).catch(() => {});
    return `Forked into ${id.slice(0, 8)}. /resume ${from.slice(0, 8)} goes back to the original.`;
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
    for (const kill of this.bashRuns.values()) kill();
    await this.session.close();
  }
}
