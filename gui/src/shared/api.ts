import type { KeyDesc } from './keys';
import type { HostMessage } from './wire';

// What the window can ask of the main process (src/preload/index.ts exposes
// it as `window.binder`).

/** A row of `binder sessions`: live hosts first, then what /resume offers. */
export type SessionRow = { id: string; cwd: string; title: string; live: boolean; running: boolean; lastUsedAt: string; branch?: string };

export type OpenRequest = {
  cwd: string;
  // Omitted: a new session with a fresh id.
  sessionId?: string;
  // Resume `sessionId` (vs start a new session with that id).
  resume?: boolean;
  // Flags for claude (binder's `-- <claude args>`) when this starts the session.
  args?: string[];
};

// What another program asks over the control socket (BINDER_GUI_SOCKET): one
// JSON line in, one reply line out.
// open: show the session, opening it if the window does not have it; `draft`
// goes in the prompt of a session the window opens.
// close: let the session go from the window, as ⌘W does; if it was on screen,
// show pane `show` instead.
export type ControlRequest =
  | { t: 'open'; cwd: string; sessionId?: string; resume?: boolean; draft?: string; args?: string[] }
  | { t: 'close'; sessionId: string; show?: string };

// `closed`: the window had the session open.
export type ControlReply = { ok: true; closed?: boolean } | { ok: false; error: string };

// A pane's program printed something, or exited.
export type PaneEvent = { t: 'data'; data: string } | { t: 'exit'; code: number };

// A pane in config.json; `web`: it shows a page (its `url`) rather than running a program.
export type PaneInfo = { name: string; web: boolean };

// A web pane's page failed to load (why), or loaded after failing.
export type WebPaneEvent = { t: 'failed'; error: string } | { t: 'loaded' };

// A box in the window, in CSS pixels.
export type Rect = { x: number; y: number; width: number; height: number };

/**
 * What a web pane's page gets as `window.binderPane` (src/preload/pane.ts).
 * The page comes from a server, so the main process checks every call
 * (src/main/paneBridge.ts).
 */
export interface BinderPane {
  /** The user's home directory, absolute. */
  home(): Promise<string>;
  /**
   * Open a session in the app, as the control socket's `open` does (switching to it if the
   * app has it open already). Fresh session: resume false/absent, a new uuid sessionId, the
   * draft left unsent in the prompt, and name -> args ["-n", name]. Resume: resume true.
   */
  open(req: { cwd: string; sessionId: string; resume?: boolean; draft?: string; name?: string }): Promise<void>;
  /**
   * Shell-style folder completion, like a terminal's tab: `~/` and relative paths are read
   * from home. One match completes with a trailing slash; several extend to their common
   * prefix and come back in `options` (folder names, sorted). Dot-folders only once a "."
   * is typed. Symlinks to folders count. Unreadable = no matches.
   */
  completeFolder(input: string): Promise<{ value: string; options: string[] }>;
  /** The absolute path a folder field names when nothing exists there yet, else null (blank or exists). `~` is home, relative is under home. */
  missingFolder(input: string): Promise<string | null>;
  /** Create the folder and any missing parents. */
  makeFolder(path: string): Promise<void>;
  /**
   * Calls `cb` each time the pane comes on screen. A hidden view's page stays "visible" and
   * focused as far as it can tell, so this is how it knows to refresh. Returns an unsubscribe.
   */
  onShow(cb: () => void): () => void;
}

export type ImageAttachment = { mediaType: string; data: string };

// The app's light or dark look; auto follows macOS.
export type Appearance = 'auto' | 'light' | 'dark';

// config.json's sidebar: templates for an open session's two lines (the
// renderer's lib/sidebarText.ts has the defaults), and a command whose output
// is their {script} field.
export type SidebarConfig = { title?: string; subtitle?: string; script?: string };

// What sidebar.script reads on stdin, as JSON.
export type SidebarScriptInput = { session_id: string; cwd: string; model: { id: string; display_name: string }; status: string; title: string; prompt: string };

// binder's config.json, as the settings panel shows it (binder host reads it too).
// `error`: the file does not parse; the rest are defaults then.
export type Settings = { path: string; permissionMode: string | null; stickyPrompt: boolean; appearance: Appearance; configDirs: Record<string, string>; sidebar: SidebarConfig; error?: string };

// Keys to set; null removes one.
export type SettingsPatch = { permissionMode?: string | null; stickyPrompt?: boolean; appearance?: Appearance | null; configDirs?: Record<string, string> | null; sidebar?: SidebarConfig | null };

// Remembered between launches.
// `fresh`: no prompt yet, so there is no conversation to resume.
// `active`: a session id, or pane:<name>.
export type SavedLayout = { open: { sessionId: string; cwd: string; fresh?: boolean }[]; active: string | null };

export type BinderApi = {
  /** The user's home folder, for showing paths as ~/... */
  home: string;
  listSessions(): Promise<SessionRow[]>;
  /**
   * Attaches to a session as connection `conn` (the window names it first, so
   * it knows the snapshot that arrives before this resolves), starting a host
   * for the session when it is not live.
   */
  open(conn: string, req: OpenRequest): Promise<void>;
  /** A session request (docs/remote-protocol.md section 3); rejects with the host's error message. */
  request(conn: string, t: string, fields?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(conn: string): Promise<void>;
  onMessage(cb: (conn: string, msg: HostMessage) => void): () => void;
  /** The checkouts of the repo `cwd` is in, and its branch, for the resume picker's scopes. */
  repoInfo(cwd: string): Promise<{ worktrees: string[]; branch: string | null }>;
  /** The first line config.json's sidebar.script prints for a session; empty without one, or when it fails. */
  sidebarScript(input: SidebarScriptInput): Promise<string>;
  isDirectory(path: string): Promise<boolean>;
  /** A Finder dialog; `hidden` shows hidden folders (config dirs are). */
  chooseFolder(opts?: { buttonLabel?: string; hidden?: boolean }): Promise<string | null>;
  /** Where a file dropped on the window lives. */
  pathForFile(file: File): string;
  clipboardImage(): Promise<ImageAttachment | null>;
  clipboardText(): Promise<string>;
  copyText(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  loadLayout(): Promise<SavedLayout>;
  loadSettings(): Promise<Settings>;
  /** Writes config.json in place, keeping keys it does not know; rejects when the file does not parse. */
  saveSettings(patch: SettingsPatch): Promise<Settings>;
  /** Binder > Settings… (⌘,) in the menu bar. */
  onOpenSettings(cb: () => void): () => void;
  /** Help > Binder Guide (⌘/) in the menu bar. */
  onOpenGuide(cb: () => void): () => void;
  saveLayout(layout: SavedLayout): Promise<void>;
  /** config.json's panes, in order. */
  panes(): Promise<PaneInfo[]>;
  /** Starts pane `name`'s program at this size, unless it runs; resolves with what it has printed so far. */
  paneStart(name: string, cols: number, rows: number): Promise<string>;
  paneInput(name: string, data: string): void;
  paneResize(name: string, cols: number, rows: number): void;
  onPane(cb: (name: string, e: PaneEvent) => void): () => void;
  /** Loads web pane `name`'s page in a view over the window, unless it has one; resolves with why the page did not load, or null. */
  webPaneStart(name: string): Promise<string | null>;
  /** Where web pane `name`'s box is, and whether its page shows there (on screen, under no panel); showing it gives it the keyboard. */
  webPaneLayout(name: string, box: Rect, show: boolean): void;
  /** Loads web pane `name`'s page again; with `url` (a sign-in link on its origin), that first and the page once it has loaded. */
  webPaneLoad(name: string, url?: string): Promise<void>;
  onWebPane(cb: (name: string, e: WebPaneEvent) => void): () => void;
  /** A window-wide ⌘ key (@shared/keys) pressed while a web pane's page had the keyboard. */
  onAppKey(cb: (k: KeyDesc) => void): () => void;
  /** Requests on the control socket; what `cb` returns is the reply. */
  onControl(cb: (req: ControlRequest) => ControlReply): () => void;
  /** Sessions waiting on a question, and ones with a turn running or queued: the Dock badge and the quit warning. */
  setStatus(status: { waiting: number; working: number }): void;
  /** A question arrived: bounce the Dock icon if the app is in the background. */
  attention(): void;
  quit(): void;
};
