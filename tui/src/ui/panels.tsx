import React, { useEffect, useMemo, useState } from 'react';
import type { AgentSession } from '../session.js';
import type { Tab, Turn } from '../store.js';
import { Picker, type PickerItem } from './Picker.js';
import { openExternal, copyText } from '../openUrl.js';
import { sessionArtifacts } from '../artifacts.js';
import { currentBranch, listTranscripts, worktreePaths, type SessionSummary } from '../transcripts.js';
import { logPath } from '../eventLog.js';
import { codexSessions } from '../sessions.js';
import { configPath, readConfig, saveConfig, type BinderConfig } from '../config.js';
import { completePath } from '../complete.js';
import { expandHome } from '../paths.js';
import { MARKDOWN_STYLES, type MarkdownStyle } from './md/theme.js';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

// binder's own panels, shown in place of the transcript: /model, /effort,
// /mcp, /chrome, /rewind, /artifacts, /resume, /settings, and a yes/no confirm.

type Common = { session: AgentSession; flash: (msg: string) => void; close: () => void };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Model = { value: string; resolvedModel?: string; displayName: string; description?: string; supportedEffortLevels?: string[] };

function useModels(session: AgentSession, onError: (msg: string) => void): Model[] | null {
  const [models, setModels] = useState<Model[] | null>(null);
  useEffect(() => {
    session
      .request('list_models')
      .then((r) => setModels((r.models as Model[] | undefined) ?? []))
      .catch((e) => onError(errText(e)));
  }, [session]);
  return models;
}

export function ModelPanel({ session, flash, close, current, onModel }: Common & { current?: string; onModel: (model: string) => void }) {
  const [error, setError] = useState('');
  const models = useModels(session, setError);
  const items: PickerItem[] = (models ?? []).map((m) => ({
    key: m.value,
    label: m.displayName,
    description: m.description,
    mark: current && (m.resolvedModel === current || m.value === current) ? '✓' : ' ',
    markColor: '#98C379',
  }));
  const pick = (item: PickerItem) => {
    const m = models!.find((x) => x.value === item.key)!;
    session
      .request('set_model', { model: m.value })
      .then(() => {
        onModel(m.resolvedModel ?? m.value);
        flash(`Model: ${m.displayName}`);
        close();
      })
      .catch((e) => setError(errText(e)));
  };
  const initial = Math.max(0, items.findIndex((i) => i.mark === '✓'));
  return <Picker title="Model" subtitle={error || (models ? undefined : 'loading…')} items={items} onSelect={pick} onCancel={close} initial={initial} />;
}

export function EffortPanel({ session, flash, close, model, current, onEffort }: Common & { model?: string; current?: string; onEffort: (level: string) => void }) {
  const [error, setError] = useState('');
  const models = useModels(session, setError);
  const levels = useMemo(() => {
    const m = models?.find((x) => x.resolvedModel === model || x.value === model) ?? models?.[0];
    return m?.supportedEffortLevels ?? (models ? ['low', 'medium', 'high', 'xhigh', 'max'] : []);
  }, [models, model]);
  const items: PickerItem[] = levels.map((l) => ({ key: l, label: l, mark: l === current ? '✓' : ' ', markColor: '#98C379' }));
  const pick = (item: PickerItem) => {
    setEffort(session, item.key)
      .then(() => {
        onEffort(item.key);
        flash(`Effort: ${item.key}`);
        close();
      })
      .catch((e) => setError(errText(e)));
  };
  const initial = Math.max(0, levels.indexOf(current ?? ''));
  return <Picker title="Effort" subtitle={error || (models ? 'For this session' : 'loading…')} items={items} onSelect={pick} onCancel={close} initial={initial} />;
}

export function setEffort(session: AgentSession, level: string): Promise<unknown> {
  return session.request('apply_flag_settings', { settings: { effortLevel: level } });
}

type McpServer = { name: string; status: string; scope?: string; source?: string; config?: { type?: string }; error?: string };

const MCP_MARK: Record<string, [string, string]> = {
  connected: ['✔', '#98C379'],
  failed: ['✗', '#E06C75'],
  'needs-auth': ['!', '#E8C07D'],
  pending: ['…', '#7F848E'],
  disabled: ['○', '#7F848E'],
};

export function McpPanel({ session, flash, close }: Common) {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const refresh = () =>
    session
      .request('mcp_status')
      .then((r) => setServers((r.mcpServers as McpServer[] | undefined) ?? []))
      .catch((e) => setError(errText(e)));
  useEffect(() => {
    void refresh();
    // Servers connect in the background and OAuth finishes in the browser.
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [session]);

  const server = servers?.find((s) => s.name === selected);
  if (server) {
    const remote = server.config?.type && server.config.type !== 'stdio';
    const actions: PickerItem[] = [
      ...(server.status === 'needs-auth' || remote ? [{ key: 'auth', label: 'Authenticate', description: 'sign in in the browser' }] : []),
      ...(server.status !== 'disabled' ? [{ key: 'reconnect', label: 'Reconnect' }] : []),
      server.status === 'disabled' ? { key: 'enable', label: 'Enable' } : { key: 'disable', label: 'Disable' },
      ...(remote ? [{ key: 'clear', label: 'Clear authentication' }] : []),
    ];
    const act = async (item: PickerItem) => {
      const serverName = server.name;
      try {
        if (item.key === 'auth') {
          const r = await session.request('mcp_authenticate', { serverName }, 60000);
          if (typeof r.authUrl === 'string') {
            openExternal(r.authUrl);
            flash(`Finish signing in to ${serverName} in your browser`);
          }
        } else if (item.key === 'reconnect') {
          await session.request('mcp_reconnect', { serverName }, 60000);
          flash(`Reconnected ${serverName}`);
        } else if (item.key === 'enable' || item.key === 'disable') {
          await session.request('mcp_toggle', { serverName, enabled: item.key === 'enable' });
          flash(`${item.key === 'enable' ? 'Enabled' : 'Disabled'} ${serverName}`);
        } else if (item.key === 'clear') {
          await session.request('mcp_clear_auth', { serverName });
          flash(`Cleared authentication for ${serverName}`);
        }
        setSelected(null);
        void refresh();
      } catch (e) {
        setError(errText(e));
      }
    };
    return (
      <Picker
        key={server.name}
        title={server.name}
        subtitle={error || `${server.status}${server.config?.type ? ` · ${server.config.type}` : ''}${server.scope ? ` · ${server.scope}` : ''}${server.error ? ` · ${server.error}` : ''}`}
        items={actions}
        onSelect={(i) => void act(i)}
        onCancel={() => setSelected(null)}
        hint="↑↓ move · enter runs · esc back"
      />
    );
  }

  const items: PickerItem[] = (servers ?? []).map((s) => {
    const [mark, color] = MCP_MARK[s.status] ?? ['?', '#7F848E'];
    return { key: s.name, label: s.name, description: `${s.status}${s.scope ? ` · ${s.scope}` : ''}`, mark, markColor: color };
  });
  return (
    <Picker
      title="MCP servers"
      subtitle={error || (servers ? undefined : 'loading…')}
      items={items}
      onSelect={(i) => setSelected(i.key)}
      onCancel={close}
      empty="no MCP servers configured"
      hint="↑↓ move · enter for actions (authenticate, reconnect, enable/disable) · esc closes"
    />
  );
}

type ChromeDialog = {
  allowed?: boolean;
  subscriber?: boolean;
  installed?: boolean;
  connected?: boolean;
  paired_browser?: string;
  enabled_by_default?: boolean;
  urls?: { install?: string; reconnect?: string; permissions?: string };
};

export function ChromePanel({ session, flash, close, onChrome }: Common & { onChrome: (on: boolean) => void }) {
  const [d, setD] = useState<ChromeDialog | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    session
      .request('get_chrome_dialog')
      .then((r) => setD(r as ChromeDialog))
      .catch((e) => setError(errText(e)));
  }, [session]);
  const items: PickerItem[] = !d
    ? []
    : [
        d.connected ? { key: 'off', label: 'Disable for this session', description: 'restarts claude without Claude in Chrome' } : { key: 'on', label: 'Enable for this session', description: 'restarts claude with --chrome' },
        ...(d.installed ? [] : [{ key: 'install', label: 'Install the extension', description: d.urls?.install }]),
        { key: 'reconnect', label: 'Reconnect the extension', description: d.urls?.reconnect },
        { key: 'permissions', label: 'Manage permissions', description: d.urls?.permissions },
      ];
  const pick = (item: PickerItem) => {
    if (item.key === 'on' || item.key === 'off') {
      onChrome(item.key === 'on');
      return close();
    }
    const url = d?.urls?.[item.key as 'install' | 'reconnect' | 'permissions'];
    if (url) {
      openExternal(url);
      flash(`Opened ${url}`);
    }
  };
  const yes = (b?: boolean) => (b ? 'yes' : 'no');
  const status = d
    ? d.allowed === false || d.subscriber === false
      ? 'Claude in Chrome needs a claude.ai subscription'
      : `extension installed: ${yes(d.installed)} · connected: ${d.connected ? d.paired_browser ?? 'yes' : 'no'} · enabled by default: ${yes(d.enabled_by_default)}`
    : 'loading…';
  return <Picker title="Claude in Chrome" subtitle={error || status} items={items} onSelect={pick} onCancel={close} />;
}

type RewindTarget = { uuid: string; prompt: string; tabId: number; seq: number };

export function rewindTargets(tabs: Tab[]): RewindTarget[] {
  const out: RewindTarget[] = [];
  for (const tab of tabs) {
    for (const turn of [...tab.earlier, tab] as Turn[]) {
      if (turn.uuid && turn.seq !== undefined && !turn.bash) out.push({ uuid: turn.uuid, prompt: turn.prompt, tabId: tab.id, seq: turn.seq });
    }
  }
  return out.sort((a, b) => b.seq - a.seq);
}

export type RewindMode = 'both' | 'conversation' | 'code';

export function RewindPanel({ session, close, tabs, onRewind }: Common & { tabs: Tab[]; onRewind: (target: RewindTarget, mode: RewindMode) => void }) {
  const targets = useMemo(() => rewindTargets(tabs), [tabs]);
  const [target, setTarget] = useState<RewindTarget | null>(null);
  const [files, setFiles] = useState<{ count: number; ok: boolean; reason?: string } | null>(null);
  useEffect(() => {
    if (!target) return;
    setFiles(null);
    session
      .request('rewind_files', { user_message_id: target.uuid, dry_run: true })
      .then((r) => setFiles({ count: Array.isArray(r.filesChanged) ? r.filesChanged.length : 0, ok: r.canRewind !== false, reason: r.error as string | undefined }))
      .catch((e) => setFiles({ count: 0, ok: false, reason: errText(e) }));
  }, [target, session]);

  if (target) {
    const codeNote = !files ? 'checking…' : !files.ok ? files.reason ?? 'no checkpoint' : files.count ? `${files.count} file${files.count === 1 ? '' : 's'}` : 'no file changes';
    const canCode = files?.ok && files.count > 0;
    const items: PickerItem[] = [
      ...(canCode ? [{ key: 'both', label: 'Restore code and conversation', description: codeNote }] : []),
      { key: 'conversation', label: 'Restore conversation', description: 'drop this prompt and everything after it' },
      ...(canCode ? [{ key: 'code', label: 'Restore code', description: codeNote }] : []),
      { key: 'cancel', label: 'Never mind' },
    ];
    return (
      <Picker
        key={target.uuid}
        title="Rewind"
        subtitle={`to before: ${target.prompt.split('\n')[0]}${canCode ? '' : `  (code: ${codeNote})`}`}
        items={items}
        onSelect={(i) => (i.key === 'cancel' ? setTarget(null) : onRewind(target, i.key as RewindMode))}
        onCancel={() => setTarget(null)}
        hint="↑↓ move · enter selects · esc back"
      />
    );
  }
  const items: PickerItem[] = targets.map((t) => ({ key: t.uuid, label: t.prompt.split('\n')[0].slice(0, 80), description: `tab ${t.tabId}` }));
  return (
    <Picker
      title="Rewind to before a prompt"
      items={items}
      onSelect={(i) => setTarget(targets.find((t) => t.uuid === i.key) ?? null)}
      onCancel={close}
      empty="no prompts to rewind to"
    />
  );
}

export function ArtifactsPanel({ flash, close, tabs }: Common & { tabs: Tab[] }) {
  const list = useMemo(() => sessionArtifacts(tabs).reverse(), [tabs]);
  const items: PickerItem[] = list.map((a) => ({ key: a.url, label: a.title, description: `${a.url} · tab ${a.tabId}` }));
  const open = (url: string) => {
    openExternal(url);
    flash(`Opened ${url}`);
  };
  return (
    <Picker
      title="Artifacts in this session"
      items={items}
      onSelect={(i) => open(i.key)}
      onCancel={close}
      empty="no artifacts published in this session yet"
      hint="↑↓ move · enter or o opens · c copies the link · esc closes"
      onKey={(input, _key, item) => {
        if (!item) return false;
        if (input === 'o') return open(item.key), true;
        if (input === 'c') return copyText(item.key), flash(`Copied ${item.key}`), true;
        return false;
      }}
    />
  );
}

type Scope = 'folder' | 'worktrees' | 'branch' | 'all';

const SCOPE_TITLE: Record<Scope, string> = { folder: 'this folder', worktrees: "this repo's worktrees", branch: 'this branch', all: 'all projects' };

function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

export function ResumePanel({ session, close, cwd, configDir, currentId, onResume }: Common & { cwd: string; configDir: string; currentId: string; onResume: (s: SessionSummary) => void }) {
  // Sessions someone worked in: interactive Claude Code and binder's own, not
  // other headless runs (scripts, hooks that call `claude -p`). A Codex
  // session lists binder's Codex sessions.
  const all = useMemo(
    () =>
      session.agent === 'codex'
        ? codexSessions().filter((s) => s.id !== currentId)
        : listTranscripts(configDir).filter((s) => s.id !== currentId && (!s.entrypoint?.startsWith('sdk') || existsSync(logPath(s.id)))),
    [session, configDir, currentId],
  );
  const trees = useMemo(() => worktreePaths(cwd), [cwd]);
  const branch = useMemo(() => currentBranch(cwd), [cwd]);
  const [scope, setScope] = useState<Scope>('folder');
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const q = query.toLowerCase();
    return all.filter((s) => {
      if (scope === 'folder' && s.cwd !== cwd) return false;
      if (scope === 'worktrees' && !trees.includes(s.cwd)) return false;
      if (scope === 'branch' && (!branch || s.branch !== branch || !trees.includes(s.cwd))) return false;
      return !q || `${s.prompt} ${s.cwd} ${s.branch ?? ''} ${s.id}`.toLowerCase().includes(q);
    });
  }, [all, scope, query, cwd, trees, branch]);
  const items: PickerItem[] = shown.slice(0, 500).map((s) => ({
    key: s.id,
    label: s.prompt.split('\n')[0].slice(0, 70),
    description: [ago(s.modified), s.branch, scope === 'folder' ? undefined : s.cwd.replace(process.env.HOME ?? '\u0000', '~')].filter(Boolean).join(' · '),
  }));
  const toggle = (s: Scope) => setScope(scope === s ? 'folder' : s);
  return (
    <Picker
      key={scope}
      title={`Resume a session: ${SCOPE_TITLE[scope]}${scope === 'branch' && branch ? ` (${branch})` : ''}`}
      items={items}
      search={{ query, onChange: setQuery }}
      onSelect={(i) => onResume(shown.find((s) => s.id === i.key)!)}
      onCancel={close}
      empty={query ? 'no session matches' : 'no other sessions here'}
      hint="↑↓ move · enter resumes · ctrl+a all projects · ctrl+w worktrees · ctrl+b this branch · esc closes"
      onKey={(input, key) => {
        if (!key.ctrl) return false;
        if (input === 'a') return toggle('all'), true;
        if (input === 'w') return toggle('worktrees'), true;
        if (input === 'b') return toggle('branch'), true;
        return false;
      }}
    />
  );
}

// The modes `claude --permission-mode` takes.
const PERMISSION_MODES: Array<[string, string]> = [
  ['manual', 'ask before edits and commands'],
  ['acceptEdits', 'edit files without asking; ask before commands'],
  ['plan', 'read and plan, no edits'],
  ['auto', "Claude Code's auto mode"],
  ['dontAsk', 'deny anything settings.json does not allow'],
  ['bypassPermissions', 'never ask'],
];

const isDir = (p: string) => {
  try {
    return statSync(expandHome(p)).isDirectory();
  } catch {
    return false;
  }
};

// Folders for a typed path (from ~/ or /): the path itself when it is one, or
// when `allowNew`, then the folders that complete it.
function folderItems(query: string, allowNew: boolean): PickerItem[] {
  if (!/^[~/]/.test(query)) return [];
  const typed = query.length > 1 ? query.replace(/\/+$/, '') : query;
  const exists = isDir(typed);
  const head: PickerItem[] = exists || allowNew ? [{ key: typed, label: typed, description: exists ? undefined : 'does not exist yet' }] : [];
  const more = completePath(query, homedir())
    .filter((p) => p.endsWith('/'))
    .map((p) => p.slice(0, -1))
    .filter((p) => p !== typed);
  return head.concat(more.map((p) => ({ key: p, label: p })));
}

type SettingsView = { kind: 'list' | 'mode' | 'folder' } | { kind: 'dir' | 'mapping'; folder: string };

// /settings: binder's config.json. The view settings apply at once; a running
// binder keeps the permission mode and config dirs it started with.
export function SettingsPanel({ flash, close, onSticky, onMarkdown }: Omit<Common, 'session'> & { onSticky: (on: boolean) => void; onMarkdown: (style: MarkdownStyle) => void }) {
  const [loaded] = useState(() => {
    try {
      return { config: readConfig(), error: '' };
    } catch (e) {
      return { config: {} as BinderConfig, error: errText(e) };
    }
  });
  const [config, setConfig] = useState(loaded.config);
  const [error, setError] = useState(loaded.error);
  const [view, setView] = useState<SettingsView>({ kind: 'list' });
  const [query, setQuery] = useState('');
  // The row last picked, for the cursor on the way back to the list.
  const [last, setLast] = useState('mode');
  const save = (patch: BinderConfig, msg: string): boolean => {
    try {
      setConfig(saveConfig(patch));
      setError('');
      flash(msg);
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    }
  };
  const back = () => setView({ kind: 'list' });
  const dirs = config.configDirs ?? {};
  const style = MARKDOWN_STYLES.find((s) => s === config.markdownStyle) ?? 'vivid';
  const backHint = '↑↓ move · enter selects · esc back';

  if (view.kind === 'mode') {
    const current = config.permissionMode ?? 'unset';
    const modes: PickerItem[] = [
      { key: 'unset', label: "Claude Code's default", description: 'permissions.defaultMode in settings.json' },
      ...PERMISSION_MODES.map(([key, description]) => ({ key, label: key, description })),
    ].map((m) => ({ ...m, mark: m.key === current ? '✓' : ' ', markColor: '#98C379' }));
    return (
      <Picker
        key="mode"
        title="Permission mode"
        subtitle={error || 'For sessions opened from now on; open ones keep the mode they started with'}
        items={modes}
        initial={Math.max(0, modes.findIndex((m) => m.key === current))}
        onSelect={(i) => save({ permissionMode: i.key === 'unset' ? undefined : i.key }, `Permission mode: ${i.label}`) && back()}
        onCancel={back}
        hint={backHint}
      />
    );
  }

  if (view.kind === 'mapping') {
    const { folder } = view;
    const remove = () => {
      const { [folder]: _, ...rest } = dirs;
      return save({ configDirs: Object.keys(rest).length ? rest : undefined }, `Removed the config dir for ${folder}`);
    };
    return (
      <Picker
        key="mapping"
        title={`${folder} → ${dirs[folder]}`}
        subtitle={error || undefined}
        items={[
          { key: 'remove', label: 'Remove', description: `claude in ${folder} goes back to the usual config dir` },
          { key: 'keep', label: 'Keep' },
        ]}
        onSelect={(i) => (i.key === 'keep' || remove()) && back()}
        onCancel={back}
        hint={backHint}
      />
    );
  }

  if (view.kind === 'folder' || view.kind === 'dir') {
    const folder = view.kind === 'dir' ? view.folder : null;
    const pick = (item: PickerItem) => {
      if (folder === null) {
        setQuery('~/.claude');
        return setView({ kind: 'dir', folder: item.key });
      }
      if (save({ configDirs: { ...dirs, [folder]: item.key } }, `claude in ${folder} will use ${item.key}`)) {
        setLast(`dir:${folder}`);
        back();
      }
    };
    return (
      <Picker
        key={view.kind}
        title={folder === null ? 'Add a config dir: the folder' : `Config dir for ${folder}`}
        subtitle={error || (folder === null ? 'claude run in this folder, or below it, uses another config dir' : 'The Claude Code config dir (CLAUDE_CONFIG_DIR) for claude run there')}
        items={folderItems(query, folder !== null)}
        search={{ query, onChange: setQuery }}
        onSelect={pick}
        onCancel={back}
        empty={/^[~/]/.test(query) ? 'no folder here' : 'start with ~/ or /'}
        hint="type a path · tab completes · enter picks · esc back"
        onKey={(_input, key, item) => {
          if (!key.tab || !item) return false;
          setQuery(item.key + '/');
          return true;
        }}
      />
    );
  }

  const items: PickerItem[] = [
    { key: 'mode', label: 'Permission mode', description: config.permissionMode ?? "Claude Code's default" },
    { key: 'sticky', label: 'Sticky prompt', description: config.stickyPrompt !== false ? 'on' : 'off' },
    { key: 'markdown', label: 'Markdown style', description: style },
    ...Object.entries(dirs).map(([folder, dir]) => ({ key: `dir:${folder}`, label: 'Config dir', description: `${folder} → ${dir}` })),
    { key: 'add', label: 'Add a config dir…', description: Object.keys(dirs).length ? undefined : 'for a second account: claude run in a folder you pick uses another config dir' },
  ];
  const pick = (item: PickerItem) => {
    setLast(item.key);
    if (item.key === 'mode') return setView({ kind: 'mode' });
    if (item.key === 'sticky') {
      const on = config.stickyPrompt === false;
      if (save({ stickyPrompt: on }, `Sticky prompt ${on ? 'on' : 'off'}`)) onSticky(on);
      return;
    }
    if (item.key === 'markdown') {
      const next = MARKDOWN_STYLES[(MARKDOWN_STYLES.indexOf(style) + 1) % MARKDOWN_STYLES.length];
      if (save({ markdownStyle: next }, `Markdown: ${next}`)) onMarkdown(next);
      return;
    }
    if (item.key === 'add') {
      setQuery('~/');
      return setView({ kind: 'folder' });
    }
    setView({ kind: 'mapping', folder: item.key.slice('dir:'.length) });
  };
  return (
    <Picker
      key="list"
      title="Settings"
      subtitle={error || `${configPath().replace(homedir(), '~')} · permission mode and config dirs apply to sessions opened from now on`}
      items={items}
      initial={Math.max(0, items.findIndex((i) => i.key === last))}
      onSelect={pick}
      onCancel={close}
      hint="↑↓ move · enter changes · esc closes"
    />
  );
}

export function ConfirmPanel({ title, question, yes, onAnswer }: { title: string; question: string; yes: string; onAnswer: (ok: boolean) => void }) {
  return (
    <Picker
      title={title}
      subtitle={question}
      items={[{ key: 'yes', label: yes }, { key: 'no', label: 'No' }]}
      onSelect={(i) => onAnswer(i.key === 'yes')}
      onCancel={() => onAnswer(false)}
    />
  );
}
