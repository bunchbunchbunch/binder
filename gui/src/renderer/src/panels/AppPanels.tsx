import { useEffect, useMemo, useState } from 'react';
import type { Appearance, SessionRow, Settings, SettingsPatch, SidebarConfig } from '@shared/api';
import { ago, baseName, shortPath } from '../lib/format';
import { DEFAULT_SIDEBAR, DEFAULT_STATUS, FIELDS, renderTemplate, sessionFields, sidebarTemplates, sidebarText } from '../lib/sidebarText';
import { errText, openSession, refreshSessions, sameComputer, sessionFacts, setState, toast, useApp } from '../store';
import { Picker, type PickerItem } from '../components/Picker';

// Panels that act on the window rather than one session: picking a session
// to open (⌘K, /resume), starting a new one in a folder (⌘N, ⌘T), and binder's
// settings (⌘,, /settings).

type Scope = 'folder' | 'worktrees' | 'branch' | 'all';
const SCOPE_TITLE: Record<Scope, string> = { folder: 'this folder', worktrees: "this repo's worktrees", branch: 'this branch', all: 'all projects' };

// `cwd` and `computer`: the session on screen, for the scopes other than all projects.
export function SessionSwitcher({ cwd, computer, initialScope, close }: { cwd: string | null; computer?: string; initialScope: Scope; close: () => void }) {
  const sessions = useApp((s) => s.sessions);
  const error = useApp((s) => s.sessionsError);
  const [scope, setScope] = useState<Scope>(cwd ? initialScope : 'all');
  const [query, setQuery] = useState('');
  const [repo, setRepo] = useState<{ worktrees: string[]; branch: string | null } | null>(null);
  // Archived sessions stay out until ⌃D shows them (and only them).
  const [archived, setArchived] = useState(false);
  // What was said in each session, searched once the query is three characters long.
  const [hits, setHits] = useState<{ query: string; found: Map<string, string> } | null>(null);
  useEffect(() => void refreshSessions(), []);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) return setHits(null);
    let live = true;
    const t = setTimeout(() => {
      void window.binder.searchSessions(q).then((found) => live && setHits({ query: q, found: new Map(found.map((h) => [`${h.computer ?? ''}:${h.id}`, h.snippet])) }));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query]);
  useEffect(() => {
    if (cwd) void window.binder.repoInfo(cwd, computer).then(setRepo);
  }, [cwd, computer]);

  const said = hits?.query === query.trim() ? hits.found : null;
  const shown = useMemo(() => {
    const q = query.toLowerCase();
    return sessions.filter((s) => {
      if (Boolean(s.archived) !== archived) return false;
      if (scope !== 'all' && !sameComputer(s.computer, computer)) return false;
      if (scope === 'folder' && s.cwd !== cwd) return false;
      if (scope === 'worktrees' && !repo?.worktrees.includes(s.cwd)) return false;
      if (scope === 'branch' && (!repo?.branch || s.branch !== repo.branch || !repo.worktrees.includes(s.cwd))) return false;
      return !q || `${s.title} ${s.cwd} ${s.branch ?? ''} ${s.id} ${s.computer ?? ''}`.toLowerCase().includes(q) || said?.has(`${s.computer ?? ''}:${s.id}`);
    });
  }, [sessions, scope, query, cwd, computer, repo, archived, said]);

  const key = (s: SessionRow) => `${s.computer ?? ''}:${s.id}`;
  const items: PickerItem[] = shown.map((s) => ({
    key: key(s),
    label: s.title || '(no prompt yet)',
    description: hits?.found.get(key(s)) ?? [s.computer, s.live ? (s.running ? 'running' : 'live') : ago(s.lastUsedAt), s.branch, scope === 'folder' ? undefined : shortPath(s.cwd)].filter(Boolean).join(' · '),
    mark: s.running ? '◐' : s.live ? '●' : ' ',
    markColor: s.running ? '#E8C07D' : '#98C379',
  }));
  const pick = (item: PickerItem) => {
    const s = shown.find((x) => key(x) === item.key)!;
    close();
    openSession({ cwd: s.cwd, sessionId: s.id, resume: true, title: s.title, computer: s.computer });
  };
  const toggle = (s: Scope) => setScope(scope === s ? (cwd ? 'folder' : 'all') : s);
  const archive = (item: PickerItem) => {
    const s = shown.find((x) => key(x) === item.key);
    if (!s) return;
    window.binder
      .archiveSession(s.id, !archived, s.computer)
      .then((said) => {
        // "Archived", or what else happened (a worktree removed, or kept and why).
        toast(said === 'Archived' || said === 'Unarchived' ? `${said} ${s.title || s.id.slice(0, 8)}` : said);
        return refreshSessions();
      })
      .catch((e) => toast(errText(e), true));
  };
  const searching = query.trim().length >= 3 && !said;
  return (
    <Picker
      key={`${scope}:${archived}`}
      title={`${archived ? 'Archived sessions' : 'Open a session'}: ${SCOPE_TITLE[scope]}${scope === 'branch' && repo?.branch ? ` (${repo.branch})` : ''}`}
      subtitle={error ?? (searching ? 'Searching what was said…' : undefined)}
      items={items}
      search={{ query, onChange: setQuery, placeholder: 'Search prompts, folders, branches, and what was said' }}
      onSelect={pick}
      onCancel={close}
      empty={query ? 'No session matches' : archived ? 'No archived sessions here' : 'No sessions here yet'}
      hint={
        <>
          ↑↓ move · ⏎ open · <kbd>⌃X</kbd> {archived ? 'unarchive' : 'archive'} · <kbd>⌃D</kbd> {archived ? 'back' : 'archived'} · <kbd>⌃A</kbd> all projects · <kbd>⌃W</kbd> worktrees · <kbd>⌃B</kbd> this branch · esc close
        </>
      }
      onKey={(e, item) => {
        if (!e.ctrlKey) return false;
        if (e.key === 'a') return toggle('all'), true;
        if (e.key === 'w' && cwd) return toggle('worktrees'), true;
        if (e.key === 'b' && cwd) return toggle('branch'), true;
        if (e.key === 'd') return setArchived(!archived), true;
        if (e.key === 'x' && item) return archive(item), true;
        return false;
      }}
    />
  );
}

// A folder on a computer ('' is this Mac).
type Folder = { dir: string; computer: string };

/** Folders sessions ran in, most recent first. */
export function recentFolders(sessions: SessionRow[], first: Folder | null): Folder[] {
  const seen = new Set<string>();
  const out: Folder[] = [];
  for (const f of [first, ...[...sessions].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt)).map((s) => ({ dir: s.cwd, computer: s.computer ?? '' }))]) {
    const key = f && JSON.stringify([f.computer, f.dir]);
    if (f?.dir && key && !seen.has(key)) {
      seen.add(key);
      out.push(f);
    }
  }
  return out;
}

/** The folders holding `folders`, by computer: a new folder sits beside ones sessions ran in. */
function parentFolders(folders: Folder[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const { dir, computer } of folders) {
    const parent = dir.replace(/\/+[^/]+\/*$/, '') || '/';
    if (!(out[computer] ??= []).includes(parent)) out[computer].push(parent);
  }
  return out;
}

/** How well a folder matches search `q` (lowercase), best first: its own name
 *  is `q`, starts with it, holds it; last, only a parent's name does. */
export function folderRank(dir: string, q: string): number {
  const name = baseName(dir).toLowerCase();
  return name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : 3;
}

// Where a picker row starts a session: " on <computer>", or nothing for this Mac.
const on = (computer: string) => (computer ? ` on ${computer}` : '');

export function NewSessionPanel({ cwd, computer, close }: { cwd: string | null; computer?: string; close: () => void }) {
  const sessions = useApp((s) => s.sessions);
  const computers = useApp((s) => s.computers);
  const defaultComputer = useApp((s) => s.defaultComputer);
  const [query, setQuery] = useState('');
  // A typed path, and the computers where it is a folder: config.json's defaultComputer first, so Enter starts there.
  const [typed, setTyped] = useState<{ path: string; on: string[] } | null>(null);
  useEffect(() => {
    const q = query.trim();
    if (!/^[~/]/.test(q)) return setTyped(null);
    let live = true;
    const order = defaultComputer ? [defaultComputer, '', ...computers.filter((k) => k !== defaultComputer)] : ['', ...computers];
    const checks = order.map((k) => window.binder.isDirectory(q, k || undefined).then((ok) => (ok ? [k] : []), (): string[] => []));
    void Promise.all(checks).then((found) => live && setTyped({ path: q, on: found.flat() }));
    return () => {
      live = false;
    };
  }, [query, computers, defaultComputer]);
  const folders = useMemo(() => recentFolders(sessions, cwd ? { dir: cwd, computer: computer ?? '' } : null), [sessions, cwd, computer]);
  // The folders beside those, read as the panel opens, for a search: no session has run in a new one yet.
  const parents = useMemo(() => JSON.stringify(parentFolders(folders)), [folders]);
  const [nearby, setNearby] = useState<Folder[]>([]);
  useEffect(() => {
    let live = true;
    setNearby([]);
    for (const [k, dirs] of Object.entries(JSON.parse(parents) as Record<string, string[]>)) {
      window.binder.subfolders(dirs, k || undefined).then(
        (found) => live && setNearby((n) => n.concat(found.map((dir) => ({ dir, computer: k })))),
        () => {},
      );
    }
    return () => {
      live = false;
    };
  }, [parents]);
  const q = query.toLowerCase();
  const typedOn = typed?.on ?? [];
  const known = new Set(folders.map((f) => JSON.stringify([f.computer, f.dir])));
  const pool = q ? folders.concat(nearby.filter((f) => !known.has(JSON.stringify([f.computer, f.dir])))) : folders;
  const matches = pool.filter((f) => !q || `${f.dir} ${shortPath(f.dir)} ${f.computer}`.toLowerCase().includes(q));
  if (q) matches.sort((a, b) => folderRank(a.dir, q) - folderRank(b.dir, q));
  const items: PickerItem[] = [
    ...typedOn.map((k) => ({ key: JSON.stringify([k, typed!.path]), label: `Start in ${typed!.path}${on(k)}` })),
    ...matches.map((f) => ({ key: JSON.stringify([f.computer, f.dir]), label: baseName(f.dir), description: shortPath(f.dir) + on(f.computer) })),
  ];
  // `worktree`: in a new git worktree of the folder's repo (⌥⏎).
  const start = (dir: string, k: string, worktree = false) => {
    close();
    // Another computer's ~ is its own home: binder start there reads it so.
    openSession({ ...(k ? { cwd: dir, computer: k } : { cwd: dir.replace(/^~(?=$|\/)/, window.binder.home) }), ...(worktree && { worktree }) });
  };
  const pick = (item: PickerItem) => {
    const [k, dir] = JSON.parse(item.key) as [string, string];
    start(dir, k);
  };
  return (
    <Picker
      title="New session"
      subtitle="Pick the folder Claude Code works in"
      items={items}
      search={{ query, onChange: setQuery, placeholder: 'Filter recent folders, or type a path (~/code/app)' }}
      onSelect={pick}
      onCancel={close}
      empty={query ? 'No folder matches' : 'No recent folders'}
      hint={
        <>
          ↑↓ move · ⏎ start · <kbd>⌥⏎</kbd> start in a new worktree · <kbd>⌘O</kbd> choose in Finder{computers.length ? ' (this Mac)' : ''} · esc close
        </>
      }
      onKey={(e, item) => {
        if (e.altKey && !e.metaKey && !e.ctrlKey && e.key === 'Enter' && item) {
          const [k, dir] = JSON.parse(item.key) as [string, string];
          return start(dir, k, true), true;
        }
        if (!e.metaKey || e.ctrlKey || e.altKey || e.key !== 'o') return false;
        void window.binder.chooseFolder().then((dir) => dir && start(dir, ''));
        return true;
      }}
    />
  );
}

// The modes `claude --permission-mode` takes, as in bindertui's /settings.
const PERMISSION_MODES: Array<[string, string]> = [
  ['manual', 'Ask before edits and commands'],
  ['acceptEdits', 'Edit files without asking; ask before commands'],
  ['plan', 'Read and plan, no edits'],
  ['auto', "Claude Code's auto mode"],
  ['dontAsk', 'Deny anything settings.json does not allow'],
  ['bypassPermissions', 'Never ask'],
];

// config.json's appearance; Auto is the file without the key.
const APPEARANCES: PickerItem[] = [
  { key: 'auto', label: 'Auto', description: 'Light or dark, as macOS is' },
  { key: 'light', label: 'Light' },
  { key: 'dark', label: 'Dark' },
];

/** ~/... for a path in the home folder, as config.json writes them. */
const tildePath = (p: string) => shortPath(p.replace(/\/+$/, '') || p);

/** Whether `path` (typed, so maybe with ~) is a folder; null until known. */
function useIsDirectory(path: string): boolean | null {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    setOk(null);
    if (!/^[~/]/.test(path)) return;
    let live = true;
    void window.binder.isDirectory(path).then((v) => live && setOk(v));
    return () => {
      live = false;
    };
  }, [path]);
  return ok;
}

// The sidebar's lines, and the status bar's context text (config.json statusText), edited alike.
type SidebarLine = 'title' | 'subtitle' | 'script' | 'status';
const SIDEBAR_LABEL: Record<SidebarLine, string> = { title: 'Sidebar title', subtitle: 'Sidebar subtitle', script: 'Sidebar script', status: 'Status bar text' };

// How a file can open (bindertui's EDITOR_PRESETS).
const EDITORS: Array<[string, string]> = [
  ['open', "The file's default app"],
  ['code -g {file}:{line}', 'Visual Studio Code, at the line'],
  ['cursor -g {file}:{line}', 'Cursor, at the line'],
  ['zed {file}:{line}', 'Zed, at the line'],
  ['subl {file}:{line}', 'Sublime Text, at the line'],
  ['idea --line {line} {file}', 'IntelliJ IDEA, at the line'],
];

type SettingsView = { kind: 'list' | 'mode' | 'appearance' | 'folder' | 'editor' } | { kind: 'worktree'; field: 'location' | 'branchPrefix' } | { kind: 'diffBase' } | { kind: 'terminal' } | { kind: 'previewCommand' } | { kind: 'dir' | 'mapping'; folder: string } | { kind: 'sidebar'; line: SidebarLine };

/**
 * binder's config.json: permission mode, sticky prompt, appearance, the
 * sidebar's text, and config dirs. The sticky prompt, appearance and sidebar
 * apply at once; a running session keeps the permission mode and config dir
 * it started with.
 */
export function SettingsPanel({ close }: { close: () => void }) {
  const sessions = useApp((s) => s.sessions);
  const conns = useApp((s) => s.conns);
  const active = useApp((s) => s.active);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<SettingsView>({ kind: 'list' });
  const [query, setQuery] = useState('');
  // The row last picked, for the cursor on the way back to the list.
  const [last, setLast] = useState('mode');
  const typedDir = useIsDirectory(query.trim());
  useEffect(() => {
    void window.binder.loadSettings().then((s) => {
      setSettings(s);
      setError(s.error ?? null);
    });
  }, []);

  const save = async (patch: SettingsPatch, msg: string): Promise<boolean> => {
    try {
      const s = await window.binder.saveSettings(patch);
      setSettings(s);
      setError(null);
      setState({ stickyPrompt: s.stickyPrompt, statusText: s.statusText, sidebar: s.sidebar, restartOnUpdate: s.restartOnUpdate, notifications: s.notifications, showImages: s.showImages, todoPanel: s.todoPanel, findingsCard: s.findingsCard, fileEditing: s.fileEditing, splitView: s.splitView, sideChat: s.sideChat, schedules: s.schedules, previewReload: s.previewReload, simulatorFps: s.simulatorFps });
      toast(msg);
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    }
  };
  const back = () => setView({ kind: 'list' });
  const dirs = settings?.configDirs ?? {};

  if (view.kind === 'mode') {
    const current = settings?.permissionMode ?? 'unset';
    const items: PickerItem[] = [
      { key: 'unset', label: "Claude Code's default", description: 'permissions.defaultMode in settings.json' },
      ...PERMISSION_MODES.map(([key, description]) => ({ key, label: key, description })),
    ].map((m) => ({ ...m, mark: m.key === current ? '✓' : ' ', markColor: '#98C379' }));
    return (
      <Picker
        key="mode"
        title="Permission mode"
        subtitle={error ?? 'For sessions opened from now on; open ones keep the mode they started with'}
        items={items}
        initial={Math.max(0, items.findIndex((m) => m.key === current))}
        onSelect={(i) => void save({ permissionMode: i.key === 'unset' ? null : i.key }, `Permission mode: ${i.label}`).then((ok) => ok && back())}
        onCancel={back}
        hint="↑↓ move · ⏎ select · esc back"
      />
    );
  }

  if (view.kind === 'previewCommand') {
    const typed = query.trim();
    const current = settings?.previewCommand ?? null;
    const items: PickerItem[] = [
      ...(typed ? [{ key: 'save', label: `Save: ${typed}`, description: "Run in the session's folder to serve its preview" }] : []),
      ...(current ? [{ key: 'default', label: 'Use the default', description: "package.json's dev script (or start)" }] : []),
    ];
    return (
      <Picker
        key="previewCommand"
        title="What starts a session's preview (/preview)"
        subtitle={error ?? `Now: ${current ?? "package.json's dev script (or start)"}`}
        items={items}
        search={{ query, onChange: setQuery, placeholder: 'A command, e.g. npm run dev -- --port 5173' }}
        onSelect={(i) => void save({ previewCommand: i.key === 'save' ? typed : null }, `Preview server: ${i.key === 'save' ? typed : "package.json's dev script"}`).then((ok) => ok && (setLast('previewCommand'), back()))}
        onCancel={back}
        empty="Type a command"
        hint="⏎ saves · esc back"
      />
    );
  }

  if (view.kind === 'terminal') {
    const typed = query.trim();
    const current = settings?.terminalCommand ?? null;
    const items: PickerItem[] = [
      ...(typed ? [{ key: 'save', label: `Save: ${typed}`, description: "Run with your shell ($SHELL -c) in the session's folder" }] : []),
      ...(current ? [{ key: 'default', label: 'Use the default', description: 'your login shell' }] : []),
    ];
    return (
      <Picker
        key="terminal"
        title="What a session's terminal (⌃`) runs"
        subtitle={error ?? `Now: ${current ?? 'your login shell'}`}
        items={items}
        search={{ query, onChange: setQuery, placeholder: 'A command, e.g. exec fish -l' }}
        onSelect={(i) => void save({ terminalCommand: i.key === 'save' ? typed : null }, `Terminal: ${i.key === 'save' ? typed : 'your login shell'}`).then((ok) => ok && (setLast('terminal'), back()))}
        onCancel={back}
        empty="Type a command"
        hint="⏎ saves · esc back"
      />
    );
  }

  if (view.kind === 'diffBase') {
    const typed = query.trim();
    const current = settings?.diffBase ?? 'HEAD';
    const items: PickerItem[] = [
      ...(typed && typed !== 'HEAD' ? [{ key: typed, label: `Save: ${typed}`, description: 'A branch (or any ref) to compare against' }] : []),
      { key: 'HEAD', label: 'HEAD', description: 'What is not committed yet (the default)', mark: current === 'HEAD' ? '✓' : ' ', markColor: '#98C379' },
    ];
    return (
      <Picker
        key="diffBase"
        title="What the diff pane compares against"
        subtitle={error ?? `Now: ${current}`}
        items={items}
        search={{ query, onChange: setQuery, placeholder: 'Type a branch' }}
        onSelect={(i) => void save({ diffBase: i.key === 'HEAD' ? null : i.key }, `Diff base: ${i.key}`).then((ok) => ok && (setLast('diffBase'), back()))}
        onCancel={back}
        hint="⏎ saves · esc back"
      />
    );
  }

  if (view.kind === 'worktree') {
    const { field } = view;
    const typed = query.trim();
    const fallback = field === 'location' ? '../{repo}-worktrees' : 'binder/';
    const current = settings?.worktrees[field] ?? fallback;
    const saveField = (v: string) => {
      const next = { ...settings?.worktrees, [field]: v === fallback ? undefined : v };
      const kept = Object.fromEntries(Object.entries(next).filter(([, x]) => x !== undefined));
      void save({ worktrees: Object.keys(kept).length ? kept : null }, `Worktree ${field === 'location' ? 'folder' : 'branch prefix'}: ${v}`).then((ok) => ok && (setLast(`wt:${field}`), back()));
    };
    const items: PickerItem[] = [
      ...(typed ? [{ key: 'save', label: `Save: ${typed}`, description: field === 'location' ? 'Relative to the repo; ~ and {repo} are filled in' : 'Each new branch starts with it' }] : []),
      ...(current !== fallback ? [{ key: 'default', label: 'Use the default', description: fallback }] : []),
    ];
    return (
      <Picker
        key="worktree"
        title={field === 'location' ? 'Where new worktrees go (⌥⏎ in New session)' : "The start of a worktree's branch name"}
        subtitle={error ?? `Now: ${current}`}
        items={items}
        search={{ query, onChange: setQuery, placeholder: 'Type a value' }}
        onSelect={(i) => saveField(i.key === 'save' ? typed : fallback)}
        onCancel={back}
        empty="Type a value"
        hint="⏎ saves · esc back"
      />
    );
  }

  if (view.kind === 'editor') {
    const typed = query.trim();
    const current = settings?.editor ?? 'open';
    const items: PickerItem[] = [
      ...(typed && !EDITORS.some(([c]) => c === typed) ? [{ key: typed, label: `Use: ${typed}`, description: 'A command; {file} and {line} are filled in, or the path goes last' }] : []),
      ...EDITORS.filter(([c]) => !typed || c.includes(typed)).map(([c, about]) => ({ key: c, label: c, description: about, mark: c === current ? '✓' : ' ', markColor: '#98C379' })),
    ];
    return (
      <Picker
        key="editor"
        title="Editor: how a file from a tool call opens"
        subtitle={error ?? `Now: ${current}`}
        items={items}
        search={{ query, onChange: setQuery, placeholder: 'Type a command, or pick one' }}
        onSelect={(i) => void save({ editor: i.key === 'open' ? null : i.key }, `Editor: ${i.key}`).then((ok) => ok && (setLast('editor'), back()))}
        onCancel={back}
        hint="↑↓ move · ⏎ select · esc back"
      />
    );
  }

  if (view.kind === 'appearance') {
    const current = settings?.appearance ?? 'auto';
    const items = APPEARANCES.map((a) => ({ ...a, mark: a.key === current ? '✓' : ' ', markColor: '#98C379' }));
    return (
      <Picker
        key="appearance"
        title="Appearance"
        subtitle={error ?? undefined}
        items={items}
        initial={items.findIndex((a) => a.key === current)}
        onSelect={(i) => void save({ appearance: i.key === 'auto' ? null : (i.key as Appearance) }, `Appearance: ${i.label}`).then((ok) => ok && back())}
        onCancel={back}
        hint="↑↓ move · ⏎ select · esc back"
      />
    );
  }

  if (view.kind === 'sidebar') {
    const { line } = view;
    const label = SIDEBAR_LABEL[line];
    const value = query.trim();
    const fallback = line === 'script' ? '' : line === 'status' ? DEFAULT_STATUS : DEFAULT_SIDEBAR[line];
    const saveLine = (v: string) => {
      let patch: SettingsPatch;
      if (line === 'status') patch = { statusText: v === fallback ? null : v };
      else {
        const next: SidebarConfig = { ...settings?.sidebar };
        if (v === fallback) delete next[line];
        else next[line] = v;
        patch = { sidebar: Object.keys(next).length ? next : null };
      }
      void save(patch, `${label}: ${v || 'none'}`).then((ok) => {
        if (!ok) return;
        setLast(`sidebar:${line}`);
        back();
      });
    };
    // The preview: the session on screen (else the first open one) with the typed template.
    const sample = conns.find((c) => c.id === active) ?? conns[0];
    const facts = sample && sessionFacts(sample);
    const now = Date.now();
    const values = facts ? sessionFields(facts, now) : null;
    const preview = !facts || line === 'script' ? null : line === 'status' ? renderTemplate(value, values!) : sidebarText({ ...sidebarTemplates(settings?.sidebar ?? {}), [line]: value }, facts, now)[line];
    const items: PickerItem[] = [
      { key: 'save', label: 'Save', description: line === 'script' ? 'Its first line is the {script} field' : undefined },
      ...(value !== fallback ? [{ key: 'default', label: line === 'script' ? 'Remove' : 'Use the default', description: fallback || undefined }] : []),
      ...(line === 'script' ? [] : FIELDS.map((f) => ({ key: `field:${f.name}`, label: `{${f.name}}`, description: values?.[f.name] ? `${f.about} · now ${values[f.name]}` : f.about }))),
    ];
    const pick = (item: PickerItem) => {
      if (item.key === 'save') return saveLine(value);
      if (item.key === 'default') return saveLine(fallback);
      setQuery((q) => `${q.trimEnd()}${q.trim() ? ' ' : ''}${item.label}`);
    };
    const about =
      line === 'script'
        ? "A command, run with sh in the session's folder; it reads the session as JSON on stdin"
        : '{field} shows a field, {a|b} the first with a value, and ( ) text only when a field inside has one';
    return (
      <Picker
        key="sidebar"
        title={label}
        subtitle={
          error ?? (
            <>
              {about}
              {preview !== null && <div className="sidebar-preview">Preview: {preview || '(none)'}</div>}
            </>
          )
        }
        items={items}
        search={{ query, onChange: setQuery, placeholder: line === 'script' ? 'cat ~/notes/$(jq -r .session_id).txt' : line === 'title' ? '{status} {title}' : line === 'status' ? '{context}(/{maxTokens})( {percent})( · {cost})' : '{folder}( · {branch})' }}
        onSelect={pick}
        onCancel={back}
        hint="⏎ save · ↑↓ then ⏎ adds a field · esc back"
      />
    );
  }

  if (view.kind === 'mapping') {
    const { folder } = view;
    const remove = () => {
      const { [folder]: _, ...rest } = dirs;
      return save({ configDirs: Object.keys(rest).length ? rest : null }, `Removed the config dir for ${folder}`);
    };
    return (
      <Picker
        key="mapping"
        title={`${folder} → ${dirs[folder]}`}
        subtitle={error ?? undefined}
        items={[
          { key: 'remove', label: 'Remove', description: `Claude in ${folder} goes back to the usual config dir` },
          { key: 'keep', label: 'Keep' },
        ]}
        onSelect={(i) => (i.key === 'keep' ? back() : void remove().then((ok) => ok && back()))}
        onCancel={back}
        hint="↑↓ move · ⏎ select · esc back"
      />
    );
  }

  if (view.kind === 'folder' || view.kind === 'dir') {
    const folder = view.kind === 'dir' ? view.folder : null;
    const typed = query.trim().replace(/(.)\/+$/, '$1');
    // A folder must be there; a config dir may be one Claude Code has not made yet.
    const typedItem: PickerItem[] = /^[~/]/.test(typed) && (typedDir || (folder !== null && typedDir === false)) ? [{ key: `path:${typed}`, label: typed, description: typedDir ? undefined : 'Does not exist yet' }] : [];
    // Suggestions: the folders sessions ran in, or the config dirs in use.
    const known = folder === null ? sessions.map((s) => tildePath(s.cwd)) : ['~/.claude', ...Object.values(dirs)];
    const q = query.trim().toLowerCase();
    const suggestions = [...new Set(known)].filter((p) => p !== typed && !(folder === null && p in dirs) && (!q || p.toLowerCase().includes(q)));
    const items: PickerItem[] = [
      ...typedItem,
      { key: 'choose', label: 'Choose in Finder…' },
      ...suggestions.map((p) => ({ key: `path:${p}`, label: p })),
    ];
    const use = (path: string) => {
      if (folder === null) {
        setQuery('');
        return setView({ kind: 'dir', folder: path });
      }
      void save({ configDirs: { ...dirs, [folder]: path } }, `Claude in ${folder} will use ${path}`).then((ok) => {
        if (!ok) return;
        setLast(`dir:${folder}`);
        back();
      });
    };
    const pick = (item: PickerItem) => {
      if (item.key !== 'choose') return use(item.key.slice('path:'.length));
      void window.binder.chooseFolder({ buttonLabel: folder === null ? 'Use this folder' : 'Use this config dir', hidden: folder !== null }).then((p) => p && use(tildePath(p)));
    };
    return (
      <Picker
        key={view.kind}
        title={folder === null ? 'Add a config dir: the folder' : `Config dir for ${folder}`}
        subtitle={error ?? (folder === null ? 'Claude run in this folder, or below it, uses another config dir' : 'The Claude Code config dir (CLAUDE_CONFIG_DIR) for Claude run there')}
        items={items}
        search={{ query, onChange: setQuery, placeholder: folder === null ? 'Type a folder (~/work), or pick one' : 'Type a config dir (~/.claude-work), or pick one' }}
        onSelect={pick}
        onCancel={back}
        hint="↑↓ move · ⏎ select · esc back"
      />
    );
  }

  const items: PickerItem[] = settings
    ? [
        { key: 'mode', label: 'Permission mode', description: settings.permissionMode ?? "Claude Code's default" },
        { key: 'sticky', label: 'Sticky prompt', description: settings.stickyPrompt ? 'On' : 'Off' },
        { key: 'artifacts', label: 'Artifacts', description: settings.artifacts ? 'On: Claude can publish live pages to claude.ai' : 'Off' },
        { key: 'fast', label: 'Fast mode', description: settings.fastMode ? 'On when a session starts (⌥O turns it off)' : 'Off when a session starts (⌥O turns it on)' },
        { key: 'always', label: 'Always allow', description: settings.alwaysAllow ? 'On: permission prompts offer the rules Claude suggests' : 'Off: permission prompts offer allow and deny only' },
        { key: 'links', label: 'claude.ai links', description: settings.claudeLinks === 'pane' ? 'Open beside the session (docs, sheets, artifacts); ⌃\\ closes the pane' : 'Open in the browser' },
        { key: 'prWatch', label: 'Pull request', description: settings.prWatch ? "On: the branch's PR and its checks in the status bar (gh)" : 'Off' },
        { key: 'prAutoFix', label: 'PR auto-fix', description: settings.prAutoFix ? 'On: failing checks and reviews asking for changes go to Claude' : 'Off: /pr fixes them when you ask' },
        { key: 'terminal', label: 'Session terminal', description: settings.terminalCommand ?? 'Your login shell, in the session\'s folder (⌃`)' },
        { key: 'diffBase', label: 'Diff base', description: settings.diffBase === 'HEAD' ? 'HEAD: the diff pane (/diff) shows what is not committed' : settings.diffBase },
        { key: 'wt:location', label: 'Worktree folder', description: settings.worktrees.location ?? '../{repo}-worktrees (⌥⏎ in New session)' },
        { key: 'wt:branchPrefix', label: 'Worktree branch prefix', description: settings.worktrees.branchPrefix ?? 'binder/' },
        { key: 'workflow', label: 'Workflow card', description: settings.workflowCard ? "On: a workflow asks with its phases, and can be allowed from then on" : 'Off: a workflow asks allow or deny' },
        { key: 'pinned', label: 'Todo and plan panel', description: settings.todoPanel ? 'On: the latest todos and plan stay above the prompt (⌃T opens them)' : 'Off: only in the transcript' },
        { key: 'editor', label: 'Editor', description: settings.editor === 'open' ? "open: the file's default app" : settings.editor },
        { key: 'images', label: 'Images', description: settings.showImages ? "On: a tool's images, ones you send, and markdown images on this Mac show in the transcript" : 'Off: a caption' },
        { key: 'notify', label: 'Notifications', description: settings.notifications ? 'On: a turn that finishes, or a question, in a session you are not looking at' : 'Off' },
        { key: 'plan', label: 'Plan approval', description: settings.planApproval ? 'On: a plan shows in full with approve choices that set the mode' : 'Off: a plan asks allow or deny' },
        { key: 'findings', label: 'Findings card', description: settings.findingsCard ? 'On: a code review (/code-review) shows its findings as a card to fix from, and the diff pane marks them' : 'Off: a review is plain text' },
        { key: 'fileEditing', label: 'File editing', description: settings.fileEditing ? 'On: the file pane (⌘P) can edit and save files' : 'Off: the file pane only shows them' },
        { key: 'previewReload', label: 'Preview reload', description: settings.previewReload ? "On: a session's preview (/preview) reloads when its turn ends" : 'Off: ↻ reloads it' },
        { key: 'previewCommand', label: 'Preview server', description: settings.previewCommand ?? "package.json's dev script (or start), unless /preview names one" },
        { key: 'simulatorFps', label: 'Simulator refresh', description: `${settings.simulatorFps} a second: how often the simulator pane (/simulator) captures the screen (Enter: 1, 2 or 4)` },
        { key: 'pluginReload', label: 'Plugin changes', description: settings.pluginReload ? 'On: one made in /plugins loads into the running session at once' : "Off: they load at claude's next start" },
        { key: 'schedules', label: 'Scheduled tasks', description: settings.schedules ? 'On: /schedule tasks run while the app is open' : 'Off: none runs' },
        { key: 'sideChat', label: 'Side chat', description: settings.sideChat ? 'On: /btw asks a side question, answered from the session and kept out of its transcript' : 'Off: /btw goes to Claude Code as typed' },
        { key: 'splitView', label: 'Split view and windows', description: settings.splitView ? 'On: ⌘\\ shows two sessions side by side; /window moves one to a window of its own' : 'Off: one session at a time' },
        { key: 'restart', label: 'Restart on a new build', description: settings.restartOnUpdate ? "On: after binder is rebuilt, an idle session's binder restarts on the new build" : 'Off: a session keeps the binder it started with until it ends' },
        { key: 'appearance', label: 'Appearance', description: APPEARANCES.find((a) => a.key === settings.appearance)!.label },
        { key: 'sidebar:title', label: SIDEBAR_LABEL.title, description: sidebarTemplates(settings.sidebar).title },
        { key: 'sidebar:subtitle', label: SIDEBAR_LABEL.subtitle, description: sidebarTemplates(settings.sidebar).subtitle || 'None' },
        { key: 'sidebar:script', label: SIDEBAR_LABEL.script, description: settings.sidebar.script ?? 'None: a command whose output is the {script} field' },
        { key: 'sidebar:status', label: SIDEBAR_LABEL.status, description: settings.statusText ?? DEFAULT_STATUS },
        ...Object.entries(dirs).map(([f, d]) => ({ key: `dir:${f}`, label: `Config dir for ${f}`, description: d })),
        { key: 'add', label: 'Add a config dir…', description: Object.keys(dirs).length ? undefined : 'For a second account: Claude in a folder you pick uses another config dir' },
      ]
    : [];
  const pick = (item: PickerItem) => {
    setLast(item.key);
    if (item.key === 'mode') return setView({ kind: 'mode' });
    if (item.key === 'appearance') return setView({ kind: 'appearance' });
    if (item.key.startsWith('sidebar:')) {
      const line = item.key.slice('sidebar:'.length) as SidebarLine;
      setQuery(line === 'script' ? (settings!.sidebar.script ?? '') : line === 'status' ? (settings!.statusText ?? DEFAULT_STATUS) : sidebarTemplates(settings!.sidebar)[line]);
      return setView({ kind: 'sidebar', line });
    }
    if (item.key === 'sticky') {
      const on = !settings!.stickyPrompt;
      return void save({ stickyPrompt: on ? null : false }, `Sticky prompt ${on ? 'on' : 'off'}`);
    }
    if (item.key === 'artifacts') {
      const on = !settings!.artifacts;
      return void save({ artifacts: on ? null : false }, `Artifacts ${on ? 'on' : 'off'} for sessions opened from now on`);
    }
    if (item.key === 'fast') {
      const on = !settings!.fastMode;
      return void save({ fastMode: on || null }, `Fast mode ${on ? 'on' : 'off'} at the start of sessions opened from now on`);
    }
    if (item.key === 'links') {
      const pane = settings!.claudeLinks !== 'pane';
      return void save({ claudeLinks: pane ? null : 'browser' }, `claude.ai links open ${pane ? 'beside the session' : 'in the browser'}`);
    }
    if (item.key === 'prWatch') {
      const on = !settings!.prWatch;
      return void save({ prWatch: on ? null : false }, `Pull request watching ${on ? 'on' : 'off'} for sessions opened from now on`);
    }
    if (item.key === 'prAutoFix') {
      const on = !settings!.prAutoFix;
      return void save({ prAutoFix: on || null }, `PR auto-fix ${on ? 'on' : 'off'} for sessions opened from now on`);
    }
    if (item.key === 'terminal') {
      setQuery(settings!.terminalCommand ?? '');
      return setView({ kind: 'terminal' });
    }
    if (item.key === 'diffBase') {
      setQuery('');
      return setView({ kind: 'diffBase' });
    }
    if (item.key.startsWith('wt:')) {
      const field = item.key.slice(3) as 'location' | 'branchPrefix';
      setQuery(settings!.worktrees[field] ?? '');
      return setView({ kind: 'worktree', field });
    }
    if (item.key === 'workflow') {
      const on = !settings!.workflowCard;
      return void save({ workflowCard: on ? null : false }, `Workflow card ${on ? 'on' : 'off'} for sessions opened from now on`);
    }
    if (item.key === 'pinned') {
      const on = !settings!.todoPanel;
      return void save({ todoPanel: on ? null : false }, `Todo and plan panel ${on ? 'on' : 'off'}`);
    }
    if (item.key === 'editor') {
      setQuery('');
      return setView({ kind: 'editor' });
    }
    if (item.key === 'images') {
      const on = !settings!.showImages;
      return void save({ showImages: on ? null : false }, `Images ${on ? 'on' : 'off'}`);
    }
    if (item.key === 'notify') {
      const on = !settings!.notifications;
      return void save({ notifications: on ? null : false }, `Notifications ${on ? 'on' : 'off'}`);
    }
    if (item.key === 'plan') {
      const on = !settings!.planApproval;
      return void save({ planApproval: on ? null : false }, `Plan approval ${on ? 'on' : 'off'} for sessions opened from now on`);
    }
    if (item.key === 'findings') {
      const on = !settings!.findingsCard;
      return void save({ findingsCard: on ? null : false }, `Findings card ${on ? 'on' : 'off'}`);
    }
    if (item.key === 'fileEditing') {
      const on = !settings!.fileEditing;
      return void save({ fileEditing: on ? null : false }, `File editing ${on ? 'on' : 'off'}`);
    }
    if (item.key === 'previewReload') {
      const on = !settings!.previewReload;
      return void save({ previewReload: on ? null : false }, `Preview reload ${on ? 'on' : 'off'}`);
    }
    if (item.key === 'previewCommand') {
      setQuery(settings!.previewCommand ?? '');
      return setView({ kind: 'previewCommand' });
    }
    if (item.key === 'simulatorFps') {
      const next = settings!.simulatorFps === 1 ? 2 : settings!.simulatorFps === 2 ? 4 : 1;
      return void save({ simulatorFps: next === 1 ? null : next }, `Simulator refresh: ${next} a second`);
    }
    if (item.key === 'pluginReload') {
      const on = !settings!.pluginReload;
      return void save({ pluginReload: on ? null : false }, `Plugin changes ${on ? 'load at once' : "load at claude's next start"}`);
    }
    if (item.key === 'schedules') {
      const on = !settings!.schedules;
      return void save({ schedules: on ? null : false }, `Scheduled tasks ${on ? 'on' : 'off'}`);
    }
    if (item.key === 'sideChat') {
      const on = !settings!.sideChat;
      return void save({ sideChat: on ? null : false }, `Side chat ${on ? 'on' : 'off'}`);
    }
    if (item.key === 'splitView') {
      const on = !settings!.splitView;
      if (!on) setState({ split: null });
      return void save({ splitView: on ? null : false }, `Split view and windows ${on ? 'on' : 'off'}`);
    }
    if (item.key === 'restart') {
      const on = !settings!.restartOnUpdate;
      return void save({ restartOnUpdate: on ? null : false }, `Restart on a new build ${on ? 'on' : 'off'}`);
    }
    if (item.key === 'always') {
      const on = !settings!.alwaysAllow;
      return void save({ alwaysAllow: on ? null : false }, `"Always allow" choices ${on ? 'on' : 'off'} for sessions opened from now on`);
    }
    if (item.key === 'add') {
      setQuery('');
      return setView({ kind: 'folder' });
    }
    setView({ kind: 'mapping', folder: item.key.slice('dir:'.length) });
  };
  return (
    <Picker
      key="list"
      title="Settings"
      subtitle={error ?? (settings ? `${shortPath(settings.path)} · permission mode, artifacts, fast mode, always allow, plan approval and config dirs apply to sessions opened from now on` : 'Loading…')}
      items={items}
      initial={Math.max(0, items.findIndex((i) => i.key === last))}
      onSelect={pick}
      onCancel={close}
      hint="↑↓ move · ⏎ change · esc close"
    />
  );
}
