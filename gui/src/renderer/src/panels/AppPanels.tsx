import { useEffect, useMemo, useState } from 'react';
import type { Appearance, SessionRow, Settings, SettingsPatch, SidebarConfig } from '@shared/api';
import { ago, baseName, shortPath } from '../lib/format';
import { DEFAULT_SIDEBAR, FIELDS, sessionFields, sidebarTemplates, sidebarText } from '../lib/sidebarText';
import { errText, openSession, refreshSessions, sessionFacts, setState, toast, useApp } from '../store';
import { Picker, type PickerItem } from '../components/Picker';

// Panels that act on the window rather than one session: picking a session
// to open (⌘K, /resume), starting a new one in a folder (⌘N), and binder's
// settings (⌘,, /settings).

type Scope = 'folder' | 'worktrees' | 'branch' | 'all';
const SCOPE_TITLE: Record<Scope, string> = { folder: 'this folder', worktrees: "this repo's worktrees", branch: 'this branch', all: 'all projects' };

export function SessionSwitcher({ cwd, initialScope, close }: { cwd: string | null; initialScope: Scope; close: () => void }) {
  const sessions = useApp((s) => s.sessions);
  const error = useApp((s) => s.sessionsError);
  const [scope, setScope] = useState<Scope>(cwd ? initialScope : 'all');
  const [query, setQuery] = useState('');
  const [repo, setRepo] = useState<{ worktrees: string[]; branch: string | null } | null>(null);
  useEffect(() => void refreshSessions(), []);
  useEffect(() => {
    if (cwd) void window.binder.repoInfo(cwd).then(setRepo);
  }, [cwd]);

  const shown = useMemo(() => {
    const q = query.toLowerCase();
    return sessions.filter((s) => {
      if (scope === 'folder' && s.cwd !== cwd) return false;
      if (scope === 'worktrees' && !repo?.worktrees.includes(s.cwd)) return false;
      if (scope === 'branch' && (!repo?.branch || s.branch !== repo.branch || !repo.worktrees.includes(s.cwd))) return false;
      return !q || `${s.title} ${s.cwd} ${s.branch ?? ''} ${s.id}`.toLowerCase().includes(q);
    });
  }, [sessions, scope, query, cwd, repo]);

  const items: PickerItem[] = shown.map((s) => ({
    key: s.id,
    label: s.title || '(no prompt yet)',
    description: [s.live ? (s.running ? 'running' : 'live') : ago(s.lastUsedAt), s.branch, scope === 'folder' ? undefined : shortPath(s.cwd)].filter(Boolean).join(' · '),
    mark: s.running ? '◐' : s.live ? '●' : ' ',
    markColor: s.running ? '#E8C07D' : '#98C379',
  }));
  const pick = (item: PickerItem) => {
    const s = shown.find((x) => x.id === item.key)!;
    close();
    openSession({ cwd: s.cwd, sessionId: s.id, resume: true, title: s.title });
  };
  const toggle = (s: Scope) => setScope(scope === s ? (cwd ? 'folder' : 'all') : s);
  return (
    <Picker
      key={scope}
      title={`Open a session: ${SCOPE_TITLE[scope]}${scope === 'branch' && repo?.branch ? ` (${repo.branch})` : ''}`}
      subtitle={error ?? undefined}
      items={items}
      search={{ query, onChange: setQuery, placeholder: 'Search prompts, folders, branches' }}
      onSelect={pick}
      onCancel={close}
      empty={query ? 'No session matches' : 'No sessions here yet'}
      hint={
        <>
          ↑↓ move · ⏎ open · <kbd>⌃A</kbd> all projects · <kbd>⌃W</kbd> worktrees · <kbd>⌃B</kbd> this branch · esc close
        </>
      }
      onKey={(e) => {
        if (!e.ctrlKey) return false;
        if (e.key === 'a') return toggle('all'), true;
        if (e.key === 'w' && cwd) return toggle('worktrees'), true;
        if (e.key === 'b' && cwd) return toggle('branch'), true;
        return false;
      }}
    />
  );
}

/** Folders sessions ran in, most recent first. */
function recentFolders(sessions: SessionRow[], first: string | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of [first, ...[...sessions].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt)).map((s) => s.cwd)]) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      out.push(dir);
    }
  }
  return out;
}

export function NewSessionPanel({ cwd, close }: { cwd: string | null; close: () => void }) {
  const sessions = useApp((s) => s.sessions);
  const [query, setQuery] = useState('');
  // A typed path that is a folder.
  const [typed, setTyped] = useState<string | null>(null);
  useEffect(() => {
    const q = query.trim();
    if (!/^[~/]/.test(q)) return setTyped(null);
    let live = true;
    void window.binder.isDirectory(q).then((ok) => live && setTyped(ok ? q : null));
    return () => {
      live = false;
    };
  }, [query]);
  const folders = useMemo(() => recentFolders(sessions, cwd), [sessions, cwd]);
  const q = query.toLowerCase();
  const items: PickerItem[] = [
    ...(typed ? [{ key: `path:${typed}`, label: `Start in ${typed}` }] : []),
    { key: 'choose', label: 'Choose a folder…', description: 'Finder dialog' },
    ...folders.filter((f) => !q || f.toLowerCase().includes(q)).map((f) => ({ key: `path:${f}`, label: baseName(f), description: shortPath(f) })),
  ];
  const start = (dir: string) => {
    close();
    openSession({ cwd: dir.replace(/^~(?=$|\/)/, window.binder.home) });
  };
  const pick = (item: PickerItem) => {
    if (item.key === 'choose') {
      void window.binder.chooseFolder().then((dir) => dir && start(dir));
      return;
    }
    start(item.key.slice('path:'.length));
  };
  return (
    <Picker
      title="New session"
      subtitle="Pick the folder Claude Code works in"
      items={items}
      search={{ query, onChange: setQuery, placeholder: 'Filter recent folders, or type a path (~/code/app)' }}
      onSelect={pick}
      onCancel={close}
      initial={typed ? 0 : folders.length ? 1 : 0}
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

type SidebarLine = 'title' | 'subtitle' | 'script';
const SIDEBAR_LABEL: Record<SidebarLine, string> = { title: 'Sidebar title', subtitle: 'Sidebar subtitle', script: 'Sidebar script' };

type SettingsView = { kind: 'list' | 'mode' | 'appearance' | 'folder' } | { kind: 'dir' | 'mapping'; folder: string } | { kind: 'sidebar'; line: SidebarLine };

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
      setState({ stickyPrompt: s.stickyPrompt, sidebar: s.sidebar });
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
    const fallback = line === 'script' ? '' : DEFAULT_SIDEBAR[line];
    const saveLine = (v: string) => {
      const next: SidebarConfig = { ...settings?.sidebar };
      if (v === fallback) delete next[line];
      else next[line] = v;
      void save({ sidebar: Object.keys(next).length ? next : null }, `${label}: ${v || 'none'}`).then((ok) => {
        if (!ok) return;
        setLast(`sidebar:${line}`);
        back();
      });
    };
    // The preview: the session on screen (else the first open one) with the typed template.
    const sample = conns.find((c) => c.id === active) ?? conns[0];
    const facts = sample && sessionFacts(sample);
    const now = Date.now();
    const preview = facts && line !== 'script' ? sidebarText({ ...sidebarTemplates(settings?.sidebar ?? {}), [line]: value }, facts, now)[line] : null;
    const values = facts ? sessionFields(facts, now) : null;
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
        search={{ query, onChange: setQuery, placeholder: line === 'script' ? 'cat ~/notes/$(jq -r .session_id).txt' : line === 'title' ? '{status} {title}' : '{folder}( · {branch})' }}
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
        { key: 'appearance', label: 'Appearance', description: APPEARANCES.find((a) => a.key === settings.appearance)!.label },
        { key: 'sidebar:title', label: SIDEBAR_LABEL.title, description: sidebarTemplates(settings.sidebar).title },
        { key: 'sidebar:subtitle', label: SIDEBAR_LABEL.subtitle, description: sidebarTemplates(settings.sidebar).subtitle || 'None' },
        { key: 'sidebar:script', label: SIDEBAR_LABEL.script, description: settings.sidebar.script ?? 'None: a command whose output is the {script} field' },
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
      setQuery(line === 'script' ? (settings!.sidebar.script ?? '') : sidebarTemplates(settings!.sidebar)[line]);
      return setView({ kind: 'sidebar', line });
    }
    if (item.key === 'sticky') {
      const on = !settings!.stickyPrompt;
      return void save({ stickyPrompt: on }, `Sticky prompt ${on ? 'on' : 'off'}`);
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
      subtitle={error ?? (settings ? `${shortPath(settings.path)} · permission mode and config dirs apply to sessions opened from now on` : 'Loading…')}
      items={items}
      initial={Math.max(0, items.findIndex((i) => i.key === last))}
      onSelect={pick}
      onCancel={close}
      hint="↑↓ move · ⏎ change · esc close"
    />
  );
}
