import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { parseEventLine, type ClaudeEvent } from './events.js';
import { binderConfig, type BinderConfig } from './config.js';

export type ImageAttachment = { mediaType: string; data: string };

export type SpawnOptions = {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stderrPath?: string;
};

export type BuildArgsOptions = {
  sessionId: string;
  resume: boolean;
  passthrough: string[];
  // Start sessionId as a fork of this session (--fork-session).
  forkFrom?: string;
};

// Flags for one long-lived headless session. The user's passthrough args come
// last so they can override anything here (for example --permission-mode).
export function buildArgs({ sessionId, resume, passthrough, forkFrom }: BuildArgsOptions, config: BinderConfig = binderConfig()): string[] {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    // Routes permission prompts (and AskUserQuestion, which is otherwise
    // unavailable headless) to us as can_use_tool control requests.
    '--permission-prompt-tool', 'stdio',
    // A prompt_suggestion line after each turn: the next prompt Claude Code
    // predicts, shown in the empty prompt as in Claude Code.
    '--prompt-suggestions',
    ...(forkFrom ? ['--resume', forkFrom, '--fork-session', '--session-id', sessionId] : [resume ? '--resume' : '--session-id', sessionId]),
  ];
  // Without one, Claude Code's own default mode applies.
  if (config.permissionMode && !passthrough.includes('--permission-mode')) {
    args.push('--permission-mode', config.permissionMode);
  }
  return args.concat(passthrough);
}

export type ProcessEvents = {
  event: [ClaudeEvent];
  raw: [string];
  stderr: [string];
  exit: [{ code: number | null; signal: NodeJS.Signals | null }];
  error: [Error];
};

export class ClaudeProcess extends EventEmitter<ProcessEvents> {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stderrLog: WriteStream | null = null;
  readonly recentStderr: string[] = [];
  exited = false;

  constructor(private readonly opts: SpawnOptions) {
    super();
  }

  start(): void {
    if (this.opts.stderrPath) {
      mkdirSync(dirname(this.opts.stderrPath), { recursive: true });
      this.stderrLog = createWriteStream(this.opts.stderrPath, { flags: 'a' });
    }
    const child = spawn(this.opts.bin, this.opts.args, {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    const out = createInterface({ input: child.stdout });
    out.on('line', (line) => {
      this.emit('raw', line);
      const event = parseEventLine(line);
      if (event) this.emit('event', event);
    });

    const err = createInterface({ input: child.stderr });
    err.on('line', (line) => {
      this.stderrLog?.write(line + '\n');
      this.recentStderr.push(line);
      if (this.recentStderr.length > 20) this.recentStderr.shift();
      this.emit('stderr', line);
    });

    child.on('error', (e) => this.emit('error', e));
    child.on('exit', (code, signal) => {
      this.exited = true;
      this.stderrLog?.end();
      this.emit('exit', { code, signal });
    });
  }

  send(message: object): void {
    if (!this.child || this.exited) return;
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  // A uuid lets the child report the message's progress (command_lifecycle)
  // and lets sendNow() name it.
  sendPrompt(text: string, images: ImageAttachment[] = [], uuid?: string): void {
    const content = images.length
      ? [{ type: 'text', text }, ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } }))]
      : text;
    this.send({ type: 'user', message: { role: 'user', content }, ...(uuid && { uuid }) });
  }

  // Claude Code's "send now" (Ctrl+Enter): the waiting message reaches the
  // model at once, either taken into the running turn or by stopping it.
  sendNow(messageUuid: string): void {
    this.send({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt', send_now: true, message_uuid: messageUuid } });
  }

  // Asks the running turn to stop. Returns the request id so the caller can
  // match the control_response.
  interrupt(): string {
    const requestId = randomUUID();
    this.send({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } });
    return requestId;
  }

  respondControl(requestId: string, response: object): void {
    this.send({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    });
  }

  respondControlError(requestId: string, error: string): void {
    this.send({
      type: 'control_response',
      response: { subtype: 'error', request_id: requestId, error },
    });
  }

  // Closes stdin so the child finishes and exits; SIGTERM after a grace period.
  async close(graceMs = 3000): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.stdin.end();
    const timer = setTimeout(() => {
      if (!this.exited) child.kill('SIGTERM');
    }, graceMs);
    await exited;
    clearTimeout(timer);
  }

  kill(): void {
    if (this.child && !this.exited) this.child.kill('SIGKILL');
  }
}
