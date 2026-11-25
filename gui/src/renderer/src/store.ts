import { useSyncExternalStore } from 'react';
import { windowSession } from './lib/window';
import type { PreviewState } from './lib/preview';
import type { ControlReply, ControlRequest, OpenRequest, PaneInfo, SessionRow, SidebarConfig, SidebarScriptInput } from '@shared/api';
import { applyPatch, type HostMessage, type SlashCommand, type WireQuestion, type WireState } from '@shared/wire';
import { addHome, firstLine } from './lib/format';
import { sessionFields, sessionStatus, sidebarTemplates, usesField, type SessionFacts } from './lib/sidebarText';

// The window's state: the sessions it shows (one host connection each), the
// panes, the session list for the sidebar (this Mac's, and config.json's
// computers'), and a few app-wide toggles. Session state itself comes from the
// hosts as a snapshot plus patches.

export type ConnStatus = 'opening' | 'attached' | 'detached' | 'failed';

export type Conn = {
  id: string;
  // What it was opened as, until the snapshot says (it changes on /clear and /fork).
  sessionId: string | null;
  cwd: string;
  // Where it runs: a name from config.json's computers; absent for this Mac.
  computer?: string;
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
  // Restarting its host on a newer binder (restartHost): the modes to put back once it is up.
  restarting?: { mode: string | null; fast: boolean };
};

export type Toast = { id: number; text: string; error?: boolean };

export type AppState = {
  conns: Conn[];
  // config.json's panes, by name; they come before the sessions (⌘1-9 count them first).
  panes: string[];
  // The panes that show a web page rather than run a program.
  webPanes: string[];
  // What is on screen: a connection id, or a pane's paneId().
  active: string | null;
  // Split view (⌘\): the two sessions side by side, left and right; `active` is the one with the keyboard.
  split: [string, string] | null;
  // config.json's computers: the other computers whose sessions show here.
  computers: string[];
  // config.json's defaultComputer: where new sessions start; null for this Mac.
  defaultComputer: string | null;
  // Every computer's sessions, live ones first, then the most recent.
  sessions: SessionRow[];
  // Why a computer's sessions could not be listed, one line each.
  sessionsError: string | null;
  // Ctrl+O: full tool output, thinking and subagent detail, app-wide as in the TUI.
  detail: boolean;
  // config.json stickyPrompt: the tab's latest prompt stays under the tabs (on unless false).
  stickyPrompt: boolean;
  // config.json statusText: the status bar's context template; null is the default.
  statusText: string | null;
  // config.json sidebar: what an open session's row says.
  sidebar: SidebarConfig;
  // config.json restartOnUpdate: an idle session whose host is outdated restarts it (on unless false).
  restartOnUpdate: boolean;
  // config.json notifications: macOS notifications for sessions you are not looking at (on unless false).
  notifications: boolean;
  // config.json showImages: images drawn in the transcript (on unless false).
  showImages: boolean;
  // config.json todoPanel: the latest todos and plan pinned above the prompt (on unless false).
  todoPanel: boolean;
  // config.json findingsCard: a code review's findings as a card to fix from (on unless false).
  findingsCard: boolean;
  // config.json fileEditing: the file pane can edit and save (on unless false).
  fileEditing: boolean;
  // config.json splitView: ⌘\ shows two sessions side by side, and /window moves one to a window of its own (on unless false).
  splitView: boolean;
  // config.json sideChat: /btw asks side questions in the side chat (on unless false).
  sideChat: boolean;
  // config.json schedules: scheduled tasks run while the app is open (on unless false).
  schedules: boolean;
  // config.json previewReload: a session's preview reloads when its turn ends (on unless false).
  previewReload: boolean;
  // The simulator pane (/simulator), open beside the sessions; config.json simulatorFps its refreshes a second.
  simulator: boolean;
  simulatorFps: number;
  // Each session's preview (/preview), by connection.
  previews: Record<string, PreviewState>;
  // The claude.ai page open beside the sessions (a doc, sheet or artifact), its title once loaded, or why it failed.
  sidePane: { url: string; title: string | null; error: string | null } | null;
  toast: Toast | null;
};

let state: AppState = { conns: [], panes: [], webPanes: [], active: null, split: null, computers: [], defaultComputer: null, sessions: [], sessionsError: null, detail: false, stickyPrompt: true, statusText: null, sidebar: {}, restartOnUpdate: true, notifications: true, showImages: true, todoPanel: true, findingsCard: true, fileEditing: true, splitView: true, sideChat: true, schedules: true, previewReload: true, simulator: false, simulatorFps: 1, previews: {}, sidePane: null, toast: null };
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

// A session on screen: the active one, or either half of split view.
const onScreen = (id: string) => state.active === id || Boolean(state.split?.includes(id));

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
  if (was !== null && s.running === null) out.unseen = !(onScreen(c.id) && document.hasFocus());
  return out;
}

export function handleMessage(id: string, msg: HostMessage): void {
  // A connection the window already let go.
  const was = state.conns.find((c) => c.id === id);
  if (!was) return;
  if (msg.t === 'notice') return toast(msg.text);
  // A host restarting on a newer binder: reopen the session once the old line
  // has closed, and put back its modes once the new host answers.
  if (was.restarting && (msg.t === 'ended' || msg.t === 'detached')) {
    if (msg.t === 'detached') reopen(id);
    return;
  }
  if (was.restarting && msg.t === 'snapshot') {
    const { mode, fast } = was.restarting;
    updateConn(id, (c) => ({ ...c, restarting: undefined }));
    if (mode) void request(id, 'set_permission_mode', { mode }).catch(() => {});
    if (fast) void request(id, 'set_fast_mode', { on: true }).catch(() => {});
    if (state.active === id) toast('Restarted this session on the new build of binder');
  }
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

// The last list from each computer ('' is this Mac), and why one failed.
const listed = new Map<string, SessionRow[]>();
const listErrors = new Map<string, string>();

/** Lists one computer's sessions; the others' stay as they were. */
async function refreshComputer(computer: string): Promise<void> {
  try {
    const list = await window.binder.listSessions(computer || undefined);
    if (computer) addHome(list.home);
    listed.set(computer, list.sessions);
    listErrors.delete(computer);
  } catch (e) {
    listed.delete(computer);
    listErrors.set(computer, errText(e));
  }
  const sessions = [...listed.values()].flat().sort((a, b) => Number(b.live) - Number(a.live) || b.lastUsedAt.localeCompare(a.lastUsedAt));
  setState({ sessions, sessionsError: [...listErrors.values()].join('\n') || null });
}

/** Lists every computer's sessions; a slow one does not hold up the others. */
export async function refreshSessions(): Promise<void> {
  await Promise.all(['', ...state.computers].map(refreshComputer));
}

/** Whether two computer fields name the same computer (absent is this Mac). */
export const sameComputer = (a: string | undefined, b: string | undefined) => (a ?? '') === (b ?? '');

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
  const open = req.sessionId && state.conns.find((c) => c.sessionId === req.sessionId && sameComputer(c.computer, req.computer));
  if (open) {
    setState({ active: open.id });
    if (open.status === 'detached' || open.status === 'failed') reopen(open.id);
    return;
  }
  const id = crypto.randomUUID();
  const conn: Conn = { id, sessionId: req.sessionId ?? null, cwd: req.cwd, ...(req.computer && { computer: req.computer }), title: req.title ?? 'New session', status: 'opening', state: null, commands: [], activeTab: null, draft: req.draft, runningSince: null, lastTurnMs: null, unseen: false };
  setState((s) => ({ conns: [...s.conns, conn], active: id }));
  void attach(id, { cwd: req.cwd, sessionId: req.sessionId, resume: req.resume, args: req.args, computer: req.computer, ...(req.worktree && { worktree: true }) });
}

// A session that never got a prompt has no conversation for claude to resume.
const fresh = (c: Conn) => c.state !== null && c.state.tabs.length === 0;

/** Attaches again to a session whose host went away, resuming it (starting it again under its id if it never had a prompt). */
export function reopen(id: string): void {
  const c = state.conns.find((x) => x.id === id);
  if (!c) return;
  updateConn(id, (x) => ({ ...x, status: 'opening', error: undefined }));
  void attach(id, c.sessionId ? { cwd: c.cwd, sessionId: c.sessionId, resume: !fresh(c), computer: c.computer } : { cwd: c.cwd, computer: c.computer });
}

/**
 * Restarts a session's host on the binder now installed, for a host that says
 * it is outdated: the host ends (it refuses unless the session is idle) and
 * handleMessage reopens the session, resumed, with the modes it had.
 */
export function restartHost(id: string): void {
  const c = state.conns.find((x) => x.id === id);
  if (!c?.state || c.restarting || c.status !== 'attached') return;
  const keep = { mode: c.state.permissionMode, fast: c.state.fastMode === 'on' || c.state.fastMode === 'cooldown' };
  updateConn(id, (x) => ({ ...x, restarting: keep }));
  request(id, 'restart_host').catch(() => updateConn(id, (x) => ({ ...x, restarting: undefined })));
}

// The side pane's page, kept when it closes so ⌃\ opens it again.
let lastSide: string | null = null;

/** Opens a link from a response or a panel: a claude.ai page beside the session (config.json claudeLinks), anything else in the browser. */
export async function openLink(url: string): Promise<void> {
  const where = await window.binder.openLink(url);
  if (where === 'pane') {
    lastSide = url;
    setState({ sidePane: { url, title: null, error: null } });
  } else toast(`Opened ${url}`);
}

/** ⌃\: closes the side pane, or opens its last page again. */
export function toggleSidePane(): void {
  if (state.sidePane) return setState({ sidePane: null });
  if (lastSide) void openLink(lastSide);
}

window.binder.onSidePane((e) => {
  const side = state.sidePane;
  if (!side) return;
  if (e.t === 'title') setState({ sidePane: { ...side, title: e.title } });
  else if (e.t === 'url') {
    // The page it moved to is the one ⌃\ brings back.
    lastSide = e.url;
    setState({ sidePane: { ...side, url: e.url, error: null } });
  } else setState({ sidePane: { ...side, error: e.error } });
});

/** Lets a session go from the window; its host keeps running until it is idle. */
export function closeConn(id: string): void {
  void window.binder.close(id);
  // Its preview, and the dev server it started, go with it.
  if (state.previews[id]) {
    window.binder.previewServerStop(id);
    window.binder.previewClose(id);
    const { [id]: _gone, ...previews } = state.previews;
    setState({ previews });
  }
  setState((s) => {
    const i = s.conns.findIndex((c) => c.id === id);
    const conns = s.conns.filter((c) => c.id !== id);
    const active = s.active === id ? (conns[Math.min(i, conns.length - 1)]?.id ?? null) : s.active;
    return { conns, active };
  });
  void refreshSessions();
}

/** A folder in this Mac's home as ~/..., which another computer reads as its own home. */
export function homeRelative(path: string): string {
  const home = window.binder.home;
  return path === home ? '~' : path.startsWith(home + '/') ? '~' + path.slice(home.length) : path;
}

/**
 * A request on the control socket (ControlRequest in @shared/api). A session
 * the window knows opens where it runs; any other starts on config.json's
 * defaultComputer, in the same folder under that computer's home.
 */
export function handleControl(req: ControlRequest): ControlReply {
  if (req.t === 'open') {
    const known = req.sessionId ? state.sessions.find((r) => r.id === req.sessionId) : undefined;
    const computer = known ? known.computer : (state.defaultComputer ?? undefined);
    const cwd = known ? known.cwd : computer ? homeRelative(req.cwd) : req.cwd;
    openSession({ cwd, sessionId: req.sessionId, resume: req.resume, args: req.args, draft: req.draft, computer });
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

/** The session's name (/rename), or else its first prompt's first line. */
export function sessionTitle(c: Conn): string {
  const name = c.state?.title?.trim();
  if (name) return name;
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
// back to the window also picks up config.json's sidebar and statusText, if you edited them.
function markSeen(): void {
  const c = state.conns.find((x) => x.id === state.active);
  if (c?.unseen && document.hasFocus()) updateConn(c.id, (x) => ({ ...x, unseen: false }));
}
subscribe(markSeen);
window.addEventListener('focus', () => {
  markSeen();
  void window.binder.loadSettings().then((s) => {
    if (JSON.stringify(s.sidebar) !== JSON.stringify(state.sidebar)) setState({ sidebar: s.sidebar });
    if (s.statusText !== state.statusText) setState({ statusText: s.statusText });
  });
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
    want.script ? window.binder.sidebarScript(scriptInput(c), c.computer).catch(() => '') : undefined,
    want.branch ? window.binder.repoInfo(c.state?.cwd ?? c.cwd, c.computer).then((r) => r.branch ?? '', () => '') : undefined,
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

// Split view follows the keyboard: a session picked while two show (⌘1-9, the
// sidebar) takes the place of the one that had it; a pane, or a session
// closing, ends the split.
let splitFrom: string | null = null;
subscribe(() => {
  const { split, active, conns } = state;
  const was = splitFrom;
  splitFrom = active;
  if (!split || !active || split.includes(active)) return;
  const live = split.every((id) => conns.some((c) => c.id === id));
  if (paneName(active) !== null || !conns.some((c) => c.id === active) || !live) return setState({ split: null });
  const at = split.indexOf(was ?? '');
  const next: [string, string] = at === 1 ? [split[0], active] : [active, split[1]];
  setState({ split: next[0] === next[1] ? null : next });
});

/** ⌘\: two sessions side by side (the active one and the next), or one again. */
export function toggleSplit(): void {
  if (state.split) return setState({ split: null });
  const at = state.conns.findIndex((c) => c.id === state.active);
  if (at < 0 || state.conns.length < 2) return toast(state.conns.length < 2 ? 'Split view needs two open sessions' : 'Split view shows sessions, not panes');
  setState({ split: [state.conns[at].id, state.conns[(at + 1) % state.conns.length].id] });
}

/** /window: the session moves to a window of its own. */
export function moveToWindow(id: string): void {
  const c = state.conns.find((x) => x.id === id);
  const sessionId = c?.sessionId ?? c?.state?.sessionId;
  if (!c || !sessionId) return toast('The session has not started yet', true);
  window.binder.newWindow({ sessionId, cwd: c.state?.cwd ?? c.cwd, ...(c.computer && { computer: c.computer }), title: sessionTitle(c), ...(fresh(c) && { fresh: true }) }).then(
    () => closeConn(id),
    (e) => toast(errText(e), true),
  );
}

// The open sessions and the active one, saved for the next launch as soon as
// they change (only opening, closing or switching sessions changes them). A
// session's own window keeps no layout.
let lastSaved = '';
subscribe(() => {
  if (windowSession) return;
  const layout = {
    open: state.conns.filter((c) => c.sessionId).map((c) => ({ sessionId: c.sessionId!, cwd: c.cwd, ...(fresh(c) && { fresh: true }), ...(c.computer && { computer: c.computer }) })),
    active: paneName(state.active) !== null ? state.active : (state.conns.find((c) => c.id === state.active)?.sessionId ?? null),
  };
  const json = JSON.stringify(layout);
  if (json === lastSaved) return;
  lastSaved = json;
  void window.binder.saveLayout(layout);
});

// What a notification says: for a question, what is asked; for a finished
// turn, the first line of its answer.
function questionNote(q: WireQuestion): string {
  if (q.plan !== undefined) return 'A plan is ready for your approval';
  if (q.kind === 'permission') {
    const input = q.toolInput as { command?: unknown; file_path?: unknown } | undefined;
    const what = typeof input?.command === 'string' ? input.command : typeof input?.file_path === 'string' ? input.file_path : '';
    return `Allow ${q.toolName}?${what ? ` ${firstLine(what)}` : ''}`;
  }
  return q.questions[0]?.question ?? 'Claude has a question';
}

function finishedNote(s: WireState): string {
  const tab = [...s.tabs].reverse().find((t) => t.result);
  if (!tab) return 'Finished';
  if (tab.status === 'error') return 'Stopped with an error';
  const text = [...tab.blocks].reverse().find((b) => b.kind === 'text' && b.text.trim());
  return text && text.kind === 'text' ? firstLine(text.text) : 'Finished';
}

// What shows outside the window: the Dock badge counts sessions waiting on
// you, a new question bounces the Dock icon while you are in another app, a
// question or a finished turn in a session you are not looking at posts a
// notification, and quitting while turns run asks first.
let lastStatus = '';
const seenQuestions = new Map<string, string>();
const seenUnseen = new Map<string, boolean>();
subscribe(() => {
  const waiting = state.conns.filter((c) => c.state?.question).length;
  const working = state.conns.filter((c) => c.state && (c.state.running !== null || c.state.queue.length > 0)).length;
  const status = `${waiting}/${working}`;
  if (status !== lastStatus) {
    lastStatus = status;
    window.binder.setStatus({ waiting, working });
  }
  const away = (c: Conn) => !onScreen(c.id) || !document.hasFocus();
  for (const c of state.conns) {
    const q = c.state?.question;
    if (q && seenQuestions.get(c.id) !== q.requestId) {
      seenQuestions.set(c.id, q.requestId);
      window.binder.attention();
      if (state.notifications && away(c)) window.binder.notify({ title: sessionTitle(c), body: questionNote(q), conn: c.id });
    }
    // turnClock marks a turn that ends while you are elsewhere unseen.
    if (c.unseen && !seenUnseen.get(c.id) && c.state && state.notifications) window.binder.notify({ title: sessionTitle(c), body: finishedNote(c.state), conn: c.id });
    seenUnseen.set(c.id, c.unseen);
  }
});

/**
 * At launch: the sessions open last time that are still live come back, and
 * the active one is resumed. A pane that was on screen is again, and so is the
 * first pane when no session is. Each computer's come back once it has listed
 * them, so one that is slow or asleep holds up only its own.
 */
export async function restoreLayout(): Promise<void> {
  const [layout, infos, config] = await Promise.all([window.binder.loadLayout(), window.binder.panes().catch((): PaneInfo[] => []), window.binder.computers().catch(() => ({ computers: [], defaultComputer: null }))]);
  const { computers, defaultComputer } = config;
  const panes = infos.map((p) => p.name);
  setState({ panes, webPanes: infos.filter((p) => p.web).map((p) => p.name), computers, defaultComputer });
  const restore = (computer: string) => {
    const rows = listed.get(computer) ?? [];
    const live = new Set(rows.filter((r) => r.live).map((r) => r.id));
    for (const o of layout.open) {
      if (!sameComputer(o.computer, computer) || (o.sessionId !== layout.active && !live.has(o.sessionId))) continue;
      const row = rows.find((r) => r.id === o.sessionId);
      openSession({ cwd: o.cwd, sessionId: o.sessionId, resume: live.has(o.sessionId) || !o.fresh, title: row?.title, computer: o.computer });
    }
  };
  await Promise.all(['', ...computers].map((k) => refreshComputer(k).then(() => restore(k))));
  const active = state.conns.find((c) => c.sessionId === layout.active);
  const pane = paneName(layout.active);
  if (pane !== null && panes.includes(pane)) setState({ active: paneId(pane) });
  else if (active) setState({ active: active.id });
  else if (!state.active && panes.length) setState({ active: paneId(panes[0]) });
}
