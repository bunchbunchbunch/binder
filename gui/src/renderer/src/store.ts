import { useSyncExternalStore } from 'react';
import type { ControlReply, ControlRequest, OpenRequest, SessionRow, SidebarConfig, SidebarScriptInput } from '@shared/api';
import { applyPatch, type HostMessage, type SlashCommand, type WireState } from '@shared/wire';
import { sessionFields, sessionStatus, sidebarTemplates, usesField, type SessionFacts } from './lib/sidebarText';

// The window's state: the sessions it shows (one host connection each), the
// panes, the session list for the sidebar, and a few app-wide toggles. Session state
// itself comes from the hosts as a snapshot plus patches.

export type ConnStatus = 'opening' | 'attached' | 'detached' | 'failed';

export type Conn = {
  id: string;
  // What it was opened as, until the snapshot says (it changes on /clear and /fork).
  sessionId: string | null;
  cwd: string;
  // Shown before the snapshot arrives.
  title: string;
  status: ConnStatus;
  error?: string;
  state: WireState | null;
  commands: SlashCommand[];
  // The tab on screen (a tab id), chosen per viewer: the protocol has no "active tab".
  activeTab: number | null;
  // Text for the prompt when it first shows (a session opened with a draft).
  draft?: string;
  // For the turn clock and the sidebar's fields (lib/sidebarText.ts): when
  // the running turn started, how long the last one took, whether one ended while you were
  // elsewhere, and what the main process supplies.
  runningSince: number | null;
  lastTurnMs: number | null;
  unseen: boolean;
  branch?: string;
  script?: string;
};

export type Toast = { id: number; text: string; error?: boolean };

export type AppState = {
  conns: Conn[];
  // config.json's panes, by name; they come before the sessions (⌘1-9 count them first).
  panes: string[];
  // What is on screen: a connection id, or a pane's paneId().
  active: string | null;
  sessions: SessionRow[];
  sessionsError: string | null;
  // Ctrl+O: full tool output, thinking and subagent detail, app-wide as in the TUI.
  detail: boolean;
  // config.json stickyPrompt: the tab's latest prompt stays under the tabs (on unless false).
  stickyPrompt: boolean;
  // config.json sidebar: what an open session's row says.
  sidebar: SidebarConfig;
  toast: Toast | null;
};

let state: AppState = { conns: [], panes: [], active: null, sessions: [], sessionsError: null, detail: false, stickyPrompt: true, sidebar: {}, toast: null };
const listeners = new Set<() => void>();

export const getState = () => state;

export function setState(update: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  state = { ...state, ...(typeof update === 'function' ? update(state) : update) };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** A slice of the state; select fields as they are (no new objects), so unchanged slices skip renders. */
export function useApp<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

export const paneId = (name: string) => `pane:${name}`;
/** The pane `active` names, if it names one. */
export const paneName = (active: string | null) => (active?.startsWith('pane:') ? active.slice(5) : null);

export const useConn = (id: string | null) => useApp((s) => s.conns.find((c) => c.id === id) ?? null);

export function updateConn(id: string, fn: (c: Conn) => Conn): void {
  setState((s) => ({ conns: s.conns.map((c) => (c.id === id ? fn(c) : c)) }));
}

let toastSeq = 0;
export function toast(text: string, error = false): void {
  const t = { id: ++toastSeq, text, error };
  setState({ toast: t });
  setTimeout(() => setState((s) => (s.toast?.id === t.id ? { toast: null } : {})), error ? 6000 : 4000);
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// The active tab stays put while it exists; otherwise the newest one.
function keepTab(activeTab: number | null, s: WireState): number | null {
  if (activeTab !== null && s.tabs.some((t) => t.id === activeTab)) return activeTab;
  return s.tabs.at(-1)?.id ?? null;
}

// The turn clock and ✅: a turn that starts resets the clock, and one that
// ends records its length and, unless you are looking at it, stays unseen
// until you do. The host says when its turn started, so the clock keeps
// counting across a relaunch; with an older host it starts when the app sees
// the turn.
function turnClock(c: Conn, s: WireState): Partial<Conn> {
  const since = (now: number) => (s.running === null ? null : s.runningSince ?? now);
  if (!c.state) return { runningSince: since(Date.now()), lastTurnMs: s.tabs.at(-1)?.result?.durationMs ?? null };
  const was = c.state.running;
  if (s.running === was) return {};
  const now = Date.now();
  const out: Partial<Conn> = { runningSince: since(now), unseen: false };
  if (was !== null) out.lastTurnMs = s.tabs.find((t) => t.id === was)?.result?.durationMs ?? (c.runningSince === null ? null : now - c.runningSince);
  if (was !== null && s.running === null) out.unseen = !(state.active === c.id && document.hasFocus());
  return out;
}

export function handleMessage(id: string, msg: HostMessage): void {
  // A connection the window already let go.
  if (!state.conns.some((c) => c.id === id)) return;
  if (msg.t === 'notice') return toast(msg.text);
  updateConn(id, (c) => {
    switch (msg.t) {
      case 'snapshot': {
        const s = { ...msg.state, effort: msg.effort ?? msg.state.effort };
        return { ...c, state: s, commands: msg.commands, status: 'attached', error: undefined, sessionId: s.sessionId, cwd: s.cwd, activeTab: keepTab(c.sessionId === s.sessionId ? c.activeTab : null, s), ...turnClock(c, s) };
      }
      case 'patch': {
        if (!c.state) return c;
        const s = applyPatch(c.state, msg);
        return { ...c, state: s, sessionId: s.sessionId, cwd: s.cwd, activeTab: keepTab(c.activeTab, s), ...turnClock(c, s) };
      }
      case 'commands':
        return { ...c, commands: msg.commands };
      case 'ended':
      case 'detached':
        return { ...c, status: 'detached', error: msg.t === 'detached' ? msg.reason : 'The session ended' };
    }
  });
}

export function request(conn: string, t: string, fields?: Record<string, unknown>): Promise<Record<string, unknown>> {
  return window.binder.request(conn, t, fields);
}

export async function refreshSessions(): Promise<void> {
  try {
    setState({ sessions: await window.binder.listSessions(), sessionsError: null });
  } catch (e) {
    setState({ sessionsError: errText(e) });
  }
}

async function attach(id: string, req: OpenRequest): Promise<void> {
  try {
    await window.binder.open(id, req);
  } catch (e) {
    updateConn(id, (c) => ({ ...c, status: 'failed', error: errText(e) }));
  }
  void refreshSessions();
}

/** Shows a session: the open one with that id, else a new connection (starting its host if needed). */
export function openSession(req: OpenRequest & { title?: string; draft?: string }): void {
  const open = req.sessionId && state.conns.find((c) => c.sessionId === req.sessionId);
  if (open) {
    setState({ active: open.id });
    if (open.status === 'detached' || open.status === 'failed') reopen(open.id);
    return;
  }
  const id = crypto.randomUUID();
  const conn: Conn = { id, sessionId: req.sessionId ?? null, cwd: req.cwd, title: req.title ?? 'New session', status: 'opening', state: null, commands: [], activeTab: null, draft: req.draft, runningSince: null, lastTurnMs: null, unseen: false };
  setState((s) => ({ conns: [...s.conns, conn], active: id }));
  void attach(id, { cwd: req.cwd, sessionId: req.sessionId, resume: req.resume, args: req.args });
}

// A session that never got a prompt has no conversation for claude to resume.
const fresh = (c: Conn) => c.state !== null && c.state.tabs.length === 0;

/** Attaches again to a session whose host went away, resuming it (starting it again under its id if it never had a prompt). */
export function reopen(id: string): void {
  const c = state.conns.find((x) => x.id === id);
  if (!c) return;
  updateConn(id, (x) => ({ ...x, status: 'opening', error: undefined }));
  void attach(id, c.sessionId ? { cwd: c.cwd, sessionId: c.sessionId, resume: !fresh(c) } : { cwd: c.cwd });
}

/** Lets a session go from the window; its host keeps running until it is idle. */
export function closeConn(id: string): void {
  void window.binder.close(id);
  setState((s) => {
    const i = s.conns.findIndex((c) => c.id === id);
    const conns = s.conns.filter((c) => c.id !== id);
    const active = s.active === id ? (conns[Math.min(i, conns.length - 1)]?.id ?? null) : s.active;
    return { conns, active };
  });
  void refreshSessions();
}

/** A request on the control socket (ControlRequest in @shared/api). */
export function handleControl(req: ControlRequest): ControlReply {
  if (req.t === 'open') {
    openSession({ cwd: req.cwd, sessionId: req.sessionId, resume: req.resume, args: req.args, draft: req.draft });
    return { ok: true };
  }
  const c = state.conns.find((x) => x.sessionId === req.sessionId);
  if (!c) return { ok: true, closed: false };
  if (state.active === c.id && req.show !== undefined && state.panes.includes(req.show)) setState({ active: paneId(req.show) });
  closeConn(c.id);
  return { ok: true, closed: true };
}

export function setActiveTab(id: string, tabId: number | null): void {
  updateConn(id, (c) => ({ ...c, activeTab: tabId }));
}

export function sessionTitle(c: Conn): string {
  const first = c.state?.tabs[0];
  const prompt = first ? (first.earlier[0] ?? first).prompt : '';
  return prompt.split('\n').find((l) => l.trim())?.trim() || c.title;
}

/** What the sidebar's templates read about an open session. */
export function sessionFacts(c: Conn): SessionFacts {
  const problem = c.status === 'detached' || c.status === 'failed' || !!c.state?.childExit;
  return { state: c.state, cwd: c.state?.cwd ?? c.cwd, title: sessionTitle(c), problem, unseen: c.unseen, runningSince: c.runningSince, lastTurnMs: c.lastTurnMs, branch: c.branch, script: c.script };
}

// A session you look at is seen: on screen while the window has focus. Coming
// back to the window also picks up config.json's sidebar, if you edited it.
function markSeen(): void {
  const c = state.conns.find((x) => x.id === state.active);
  if (c?.unseen && document.hasFocus()) updateConn(c.id, (x) => ({ ...x, unseen: false }));
}
subscribe(markSeen);
window.addEventListener('focus', () => {
  markSeen();
  void window.binder.loadSettings().then((s) => JSON.stringify(s.sidebar) !== JSON.stringify(state.sidebar) && setState({ sidebar: s.sidebar }));
});

// The sidebar's {script} and {branch} come from the main process. They are
// asked for again when a session's state changes, and every 10 seconds, since
// a script may read files that change on their own (a hook's summary).
const EXTRAS_EVERY_MS = 10000;
const EXTRAS_SETTLE_MS = 300;
const extrasKeys = new Map<string, string>();
const extrasPending = new Map<string, ReturnType<typeof setTimeout>>();
let extrasTimer: ReturnType<typeof setInterval> | undefined;
let wanted: { for: SidebarConfig | null; script: boolean; branch: boolean } = { for: null, script: false, branch: false };

function extrasWanted(): { script: boolean; branch: boolean } {
  if (wanted.for !== state.sidebar) {
    const t = sidebarTemplates(state.sidebar);
    const uses = (field: string) => usesField(t.title, field) || usesField(t.subtitle, field);
    wanted = { for: state.sidebar, script: !!state.sidebar.script && uses('script'), branch: uses('branch') };
  }
  return wanted;
}

function scriptInput(c: Conn): SidebarScriptInput {
  const f = sessionFacts(c);
  const fields = sessionFields(f, Date.now());
  return { session_id: c.sessionId!, cwd: f.cwd, model: { id: c.state?.model ?? '', display_name: fields.model }, status: sessionStatus(f) || 'idle', title: f.title, prompt: fields.prompt };
}

async function refreshExtras(id: string): Promise<void> {
  const c = state.conns.find((x) => x.id === id);
  if (!c?.sessionId) return;
  const want = extrasWanted();
  const [script, branch] = await Promise.all([
    want.script ? window.binder.sidebarScript(scriptInput(c)).catch(() => '') : undefined,
    want.branch ? window.binder.repoInfo(c.state?.cwd ?? c.cwd).then((r) => r.branch ?? '', () => '') : undefined,
  ]);
  const now = state.conns.find((x) => x.id === id);
  if (now && (now.script !== script || now.branch !== branch)) updateConn(id, (x) => ({ ...x, script, branch }));
}

subscribe(() => {
  const want = extrasWanted();
  if (!want.script && !want.branch) {
    clearInterval(extrasTimer);
    extrasTimer = undefined;
    return;
  }
  extrasTimer ??= setInterval(() => state.conns.forEach((c) => void refreshExtras(c.id)), EXTRAS_EVERY_MS);
  for (const c of state.conns) {
    const s = c.state;
    const key = [c.sessionId, s?.cwd ?? c.cwd, sessionStatus(sessionFacts(c)), s?.model, s?.tabs.length, s?.running, state.sidebar.script, want.script, want.branch].join('|');
    if (extrasKeys.get(c.id) === key) continue;
    extrasKeys.set(c.id, key);
    clearTimeout(extrasPending.get(c.id));
    extrasPending.set(c.id, setTimeout(() => (extrasPending.delete(c.id), void refreshExtras(c.id)), EXTRAS_SETTLE_MS));
  }
});

// The open sessions and the active one, saved for the next launch as soon as
// they change (only opening, closing or switching sessions changes them).
let lastSaved = '';
subscribe(() => {
  const layout = {
    open: state.conns.filter((c) => c.sessionId).map((c) => ({ sessionId: c.sessionId!, cwd: c.cwd, ...(fresh(c) && { fresh: true }) })),
    active: paneName(state.active) !== null ? state.active : (state.conns.find((c) => c.id === state.active)?.sessionId ?? null),
  };
  const json = JSON.stringify(layout);
  if (json === lastSaved) return;
  lastSaved = json;
  void window.binder.saveLayout(layout);
});

// What shows outside the window: the Dock badge counts sessions waiting on
// you, a new question bounces the Dock icon while you are in another app, and
// quitting while turns run asks first.
let lastStatus = '';
const seenQuestions = new Map<string, string>();
subscribe(() => {
  const waiting = state.conns.filter((c) => c.state?.question).length;
  const working = state.conns.filter((c) => c.state && (c.state.running !== null || c.state.queue.length > 0)).length;
  const status = `${waiting}/${working}`;
  if (status !== lastStatus) {
    lastStatus = status;
    window.binder.setStatus({ waiting, working });
  }
  for (const c of state.conns) {
    const q = c.state?.question?.requestId;
    if (q && seenQuestions.get(c.id) !== q) {
      seenQuestions.set(c.id, q);
      window.binder.attention();
    }
  }
});

/**
 * At launch: the sessions open last time that are still live come back, and
 * the active one is resumed. A pane that was on screen is again, and so is the
 * first pane when no session is.
 */
export async function restoreLayout(): Promise<void> {
  const [layout, panes] = await Promise.all([window.binder.loadLayout(), window.binder.panes().catch((): string[] => []), refreshSessions()]);
  setState({ panes });
  const live = new Set(state.sessions.filter((r) => r.live).map((r) => r.id));
  for (const o of layout.open) {
    if (o.sessionId !== layout.active && !live.has(o.sessionId)) continue;
    const row = state.sessions.find((r) => r.id === o.sessionId);
    openSession({ cwd: o.cwd, sessionId: o.sessionId, resume: live.has(o.sessionId) || !o.fresh, title: row?.title });
  }
  const active = state.conns.find((c) => c.sessionId === layout.active);
  const pane = paneName(layout.active);
  if (pane !== null && panes.includes(pane)) setState({ active: paneId(pane) });
  else if (active) setState({ active: active.id });
  else if (!state.active && panes.length) setState({ active: paneId(panes[0]) });
}
