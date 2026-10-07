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

export type ImageAttachment = { mediaType: string; data: string };

// The app's light or dark look; auto follows macOS.
export type Appearance = 'auto' | 'light' | 'dark';

// binder's config.json, as the settings panel shows it (binder host reads it too).
// `error`: the file does not parse; the rest are defaults then.
export type Settings = { path: string; permissionMode: string | null; stickyPrompt: boolean; appearance: Appearance; configDirs: Record<string, string>; error?: string };

// Keys to set; null removes one.
export type SettingsPatch = { permissionMode?: string | null; stickyPrompt?: boolean; appearance?: Appearance | null; configDirs?: Record<string, string> | null };

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
  saveLayout(layout: SavedLayout): Promise<void>;
  /** The names of config.json's panes, in order. */
  panes(): Promise<string[]>;
  /** Starts pane `name`'s program at this size, unless it runs; resolves with what it has printed so far. */
  paneStart(name: string, cols: number, rows: number): Promise<string>;
  paneInput(name: string, data: string): void;
  paneResize(name: string, cols: number, rows: number): void;
  onPane(cb: (name: string, e: PaneEvent) => void): () => void;
  /** Requests on the control socket; what `cb` returns is the reply. */
  onControl(cb: (req: ControlRequest) => ControlReply): () => void;
  /** Sessions waiting on a question, and ones with a turn running or queued: the Dock badge and the quit warning. */
  setStatus(status: { waiting: number; working: number }): void;
  /** A question arrived: bounce the Dock icon if the app is in the background. */
  attention(): void;
  quit(): void;
};
