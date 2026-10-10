import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, existsSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { SessionHost } from '../host.js';
import type { Block, Tab } from '../store.js';
import type { ImageAttachment } from '../claudeProcess.js';
import { addHistory, loadHistory } from '../history.js';
import { completeCommand, completePath } from '../complete.js';
import { sessionArtifacts } from '../artifacts.js';
import { diff, wireBlock, wireState, type Source } from './wire.js';
import { liveElsewhere, lockPath, socketPath } from './sockets.js';

// Serves one session host on its unix socket (docs/remote-protocol.md). A
// connection starts with a hello: `info` answers one line and closes;
// `attach` gets a snapshot, then patches, and may send session requests.
// `roots` (set by the gateway) confines what that viewer may reach.

const PATCH_MS = 120;
const MAX_LINE = 32 * 1024 * 1024;

type Viewer = { socket: Socket; roots?: string[]; attached: boolean };
type Msg = Record<string, unknown> & { t?: string; id?: number };

export const within = (dir: string, root: string) => dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep);

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function insideRoots(dir: string, roots: string[] | undefined): boolean {
  if (!roots) return true;
  const d = real(dir);
  return roots.some((r) => within(d, r));
}

function findBlock(blocks: Block[], id: string): Block | undefined {
  for (const b of blocks) {
    if (b.kind !== 'tool_use') continue;
    if (b.id === id) return b;
    const hit = findBlock(b.children, id);
    if (hit) return hit;
  }
  return undefined;
}

function rewindTargets(tabs: Tab[]) {
  const out: { uuid: string; prompt: string; tabId: number; seq: number }[] = [];
  for (const tab of tabs) {
    for (const turn of [...tab.earlier, tab]) {
      if (turn.uuid && turn.seq !== undefined && !turn.bash) out.push({ uuid: turn.uuid, prompt: turn.prompt, tabId: tab.id, seq: turn.seq });
    }
  }
  return out.sort((a, b) => b.seq - a.seq).map(({ seq: _seq, ...t }) => t);
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new Error(`${name} must be a string`);
  return v;
};

function images(v: unknown): ImageAttachment[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error('images must be a list');
  return v.map((i) => {
    const { mediaType, data } = (i ?? {}) as Record<string, unknown>;
    if (typeof mediaType !== 'string' || !/^image\/(png|jpeg|gif|webp)$/.test(mediaType) || typeof data !== 'string') throw new Error('bad image');
    return { mediaType, data };
  });
}

export class HostServer {
  private server: Server | null = null;
  private listeningId: string | null = null;
  private viewers = new Set<Viewer>();
  private prev: Source | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly host: SessionHost) {
    host.on('change', this.schedule);
    host.on('cwd', this.schedule);
    host.on('effort', this.schedule);
    host.on('commands', (commands) => this.broadcast({ t: 'commands', commands }));
    host.on('session', () => {
      this.release();
      this.listen().catch(() => {});
      this.resync();
    });
  }

  private source(): Source {
    return { state: this.host.state, cwd: this.host.cwd, effort: this.host.effort, runningSince: this.host.runningSince };
  }

  /** Starts serving the host's current session. Throws if another live binder holds it. */
  async listen(): Promise<void> {
    if (this.closed) return;
    const id = this.host.sessionId;
    const other = liveElsewhere(id);
    if (other) throw new Error(`Session ${id} is open in another binder (pid ${other})`);
    const path = socketPath(id);
    if (existsSync(path)) unlinkSync(path); // left by a binder that crashed
    const server = createServer((socket) => this.accept(socket));
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(path, () => {
        server.off('error', fail);
        done();
      });
    });
    chmodSync(path, 0o600);
    writeFileSync(lockPath(id), String(process.pid), { mode: 0o600 });
    if (this.host.sessionId !== id || this.closed) {
      // The host moved on (or closed) while this was starting.
      server.close();
      this.removeFiles(id);
      return;
    }
    this.server = server;
    this.listeningId = id;
  }

  private removeFiles(id: string): void {
    for (const p of [socketPath(id), lockPath(id)]) {
      try {
        unlinkSync(p);
      } catch {
        // already gone
      }
    }
  }

  private release(): void {
    const { server, listeningId } = this;
    this.server = null;
    this.listeningId = null;
    server?.close();
    if (listeningId) this.removeFiles(listeningId);
  }

  get viewerCount(): number {
    return [...this.viewers].filter((v) => v.attached).length;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.broadcast({ t: 'ended' });
    for (const v of this.viewers) v.socket.end();
    this.viewers.clear();
    this.release();
  }

  private write(v: Viewer, msg: unknown): void {
    if (!v.socket.destroyed) v.socket.write(JSON.stringify(msg) + '\n');
  }

  private broadcast(msg: unknown): void {
    const line = JSON.stringify(msg) + '\n';
    for (const v of this.viewers) if (v.attached && !v.socket.destroyed) v.socket.write(line);
  }

  private schedule = (): void => {
    if (this.timer || !this.viewerCount) return;
    this.timer = setTimeout(this.tick, PATCH_MS);
  };

  private tick = (): void => {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const next = this.source();
    const patch = this.prev ? diff(this.prev, next) : null;
    this.prev = next;
    if (patch) this.broadcast(patch);
  };

  private snapshot(): unknown {
    return { t: 'snapshot', state: wireState(this.source()), commands: this.host.commands, effort: this.host.effort ?? null };
  }

  // After a session switch every viewer starts over from a snapshot.
  private resync(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.prev = this.source();
    if (this.viewerCount) this.broadcast(this.snapshot());
  }

  private accept(socket: Socket): void {
    const viewer: Viewer = { socket, attached: false };
    this.viewers.add(viewer);
    socket.on('error', () => {});
    socket.on('close', () => this.viewers.delete(viewer));
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    // readline re-emits the socket's errors (EPIPE when a viewer vanished mid-write).
    lines.on('error', () => {});
    let first = true;
    lines.on('line', (line) => {
      if (line.length > MAX_LINE) return socket.destroy();
      let msg: Msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return socket.destroy();
      }
      if (first) {
        first = false;
        this.hello(viewer, msg);
      } else if (viewer.attached) {
        void this.handle(viewer, msg);
      }
    });
  }

  private hello(v: Viewer, msg: Msg): void {
    if (msg.t !== 'hello') return void v.socket.destroy();
    const s = this.host.state;
    if (msg.want === 'info') {
      this.write(v, {
        t: 'info',
        sessionId: this.host.sessionId,
        cwd: this.host.cwd,
        title: this.host.title,
        running: this.host.busy,
        model: s.model ?? null,
        pid: process.pid,
      });
      return void v.socket.end();
    }
    if (msg.want !== 'attach') return void v.socket.destroy();
    if (Array.isArray(msg.roots)) v.roots = msg.roots.filter((r): r is string => typeof r === 'string');
    if (!insideRoots(this.host.cwd, v.roots)) {
      this.write(v, { t: 'error', error: 'This session is outside the allowed folders' });
      return void v.socket.end();
    }
    // Existing viewers catch up first, so the snapshot and later patches line up.
    if (this.prev && this.viewerCount) this.tick();
    else this.prev = this.source();
    v.attached = true;
    this.write(v, this.snapshot());
  }

  private async handle(v: Viewer, msg: Msg): Promise<void> {
    const id = typeof msg.id === 'number' ? msg.id : undefined;
    try {
      const result = (await this.run(v, msg)) ?? {};
      if (id !== undefined) this.write(v, { t: 'reply', id, ok: true, result });
    } catch (e) {
      if (id !== undefined) this.write(v, { t: 'reply', id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async run(v: Viewer, m: Msg): Promise<Record<string, unknown> | void> {
    const host = this.host;
    switch (m.t) {
      case 'send': {
        const text = str(m.text, 'text');
        if (!text.trim()) throw new Error('Nothing to send');
        addHistory(host.cwd, text);
        return { tabId: host.send(text, images(m.images), typeof m.tabId === 'number' ? m.tabId : undefined) };
      }
      case 'edit_queued': {
        const text = str(m.text, 'text');
        host.editQueued(Number(m.tabId), str(m.prompt, 'prompt'), text);
        if (text.trim()) addHistory(host.cwd, text);
        return;
      }
      case 'interrupt':
        return host.interrupt();
      case 'stop_bash':
        return host.stopBash(Number(m.tabId));
      case 'stop_task':
        return void (await host.stopTask(str(m.taskId, 'taskId')));
      case 'task_output':
        return await host.taskOutput(str(m.taskId, 'taskId'));
      case 'background':
        return void (await host.background());
      case 'answer':
        return host.answer(str(m.requestId, 'requestId'), (m.answers ?? {}) as Record<string, string>);
      case 'allow':
        return host.allow(str(m.requestId, 'requestId'));
      case 'deny':
        return host.deny(str(m.requestId, 'requestId'));
      case 'rewind_targets':
        return { targets: rewindTargets(host.state.tabs) };
      case 'rewind': {
        const mode = m.mode === 'code' || m.mode === 'conversation' ? m.mode : 'both';
        return await host.rewind(str(m.uuid, 'uuid'), mode);
      }
      case 'clear':
        return { message: host.clear(), sessionId: host.sessionId };
      case 'fork':
        return { message: host.fork(typeof m.title === 'string' ? m.title : ''), sessionId: host.sessionId };
      case 'resume': {
        const found = host.findSession(str(m.id, 'id'));
        if (!found) throw new Error(`No session ${String(m.id)}`);
        if (v.roots && !(found.cwd && insideRoots(found.cwd, v.roots))) throw new Error('That session is outside the allowed folders');
        return { message: host.resume(found), sessionId: host.sessionId };
      }
      case 'cd': {
        const path = str(m.path, 'path');
        const target = resolve(host.cwd, path.replace(/^~(?=$|\/)/, homedir()));
        if (!insideRoots(target, v.roots)) return { status: 'rejected', message: `${target} is outside the allowed folders` };
        return await host.changeDir(path, typeof m.trust === 'string' ? m.trust : undefined);
      }
      case 'models': {
        const r = await host.session.request('list_models');
        return { models: r.models ?? [] };
      }
      case 'set_model':
        return void (await host.setModel(str(m.model, 'model')));
      case 'set_effort':
        return void (await host.setEffort(str(m.level, 'level')));
      case 'mcp_status': {
        const r = await host.session.request('mcp_status');
        return { servers: r.mcpServers ?? [] };
      }
      case 'mcp_toggle':
        return void (await host.session.request('mcp_toggle', { serverName: str(m.server, 'server'), enabled: Boolean(m.enabled) }));
      case 'mcp_reconnect':
        return void (await host.session.request('mcp_reconnect', { serverName: str(m.server, 'server') }, 60000));
      case 'mcp_authenticate': {
        const r = await host.session.request('mcp_authenticate', { serverName: str(m.server, 'server') }, 60000);
        return { authUrl: typeof r.authUrl === 'string' ? r.authUrl : null };
      }
      case 'mcp_clear_auth':
        return void (await host.session.request('mcp_clear_auth', { serverName: str(m.server, 'server') }));
      case 'chrome_status':
        return { status: await host.session.request('get_chrome_dialog') };
      case 'rewind_preview': {
        const r = await host.session.request('rewind_files', { user_message_id: str(m.uuid, 'uuid'), dry_run: true });
        return { canRewind: r.canRewind !== false, files: Array.isArray(r.filesChanged) ? r.filesChanged.length : 0, error: typeof r.error === 'string' ? r.error : null };
      }
      case 'chrome':
        return { message: host.setChrome(Boolean(m.on)) };
      case 'artifacts':
        return { artifacts: sessionArtifacts(host.state.tabs) };
      case 'history':
        return { prompts: loadHistory(host.cwd, 200) };
      case 'complete': {
        const partial = str(m.partial, 'partial');
        return { items: m.command ? completeCommand(partial, 50) : completePath(partial, host.cwd, 50) };
      }
      case 'tool_detail': {
        const tab = host.state.tabs.find((t) => t.id === m.tabId);
        const toolId = str(m.toolUseId, 'toolUseId');
        const block = tab && [...tab.earlier, tab].map((turn) => findBlock(turn.blocks, toolId)).find(Boolean);
        if (!block) throw new Error('No such tool call');
        return { block: wireBlock(block, true) };
      }
      case 'restart':
        return host.restart();
      default:
        throw new Error(`Unknown request: ${String(m.t)}`);
    }
  }
}
