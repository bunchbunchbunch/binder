import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import type { AgentSession } from '../session.js';
import { findCall, type BackgroundTask, type Tab, type Turn } from '../store.js';
import { Picker, type PickerItem } from './Picker.js';
import { taskMeta } from './BackgroundTasks.js';
import { toolSummary } from './toolSummary.js';
import { clean } from './md/text.js';
import { openExternal, copyText } from '../openUrl.js';
import { sessionArtifacts } from '../artifacts.js';
import { currentBranch, listTranscripts, worktreePaths, type SessionSummary } from '../transcripts.js';
import { logPath } from '../eventLog.js';
import { codexSessions } from '../sessions.js';
import { binderConfig, configPath, readConfig, saveConfig, type BinderConfig } from '../config.js';
import { completePath } from '../complete.js';
import { expandHome } from '../paths.js';
import { MARKDOWN_STYLES, type MarkdownStyle } from './md/theme.js';
import { DEFAULT_STATUS, STATUS_FIELDS, statusText } from './tabLayout.js';
import { PERMISSION_MODES as LIVE_MODES } from '../permissions.js';
import { EDITOR_PRESETS, openInEditor, resolveFile, revealFile, tabFiles } from '../openFile.js';
import { archiveSession, archivedIds } from '../archive.js';
import { prLine, type PrStatus } from '../pr.js';
import type { AvailablePlugin, InstalledPlugin } from '../host.js';
import { describeWhen, loadSchedules, nextFor, pauseSchedule, removeSchedule, runNow } from '../schedule.js';
import { findingPlace, fixAllPrompt, fixPrompt, severityCounts, severityName, type Finding } from '../findings.js';
import { DEFAULT_LOCATION, DEFAULT_PREFIX } from '../worktree.js';
import { searchSessions } from '../search.js';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

// binder's own panels, shown in place of the transcript: /model, /effort, /permission-mode,
// /mcp, /chrome, /rewind, /artifacts, /tasks, /resume, /settings, and a yes/no confirm.

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

// /permission-mode: the running session's permission mode (Claude Code reports "manual" as "default").
export function ModePanel({ close, current, onMode }: { close: () => void; current?: string; onMode: (mode: string) => void }) {
  const mode = current === 'manual' ? 'default' : current;
  const items: PickerItem[] = Object.entries(LIVE_MODES).map(([key, [label, description]]) => ({ key, label, description, mark: key === mode ? '✓' : ' ', markColor: '#98C379' }));
  return (
    <Picker
      title="Permission mode"
      subtitle="For this session, until it restarts · Alt+M steps to the next"
      items={items}
      onSelect={(i) => onMode(i.key)}
      onCancel={close}
      initial={Math.max(0, items.findIndex((i) => i.key === mode))}
    />
  );
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

export type TaskOutput = { output: string; totalBytes: number; truncated: boolean };

const DETAIL_ROWS = 8;

// A command's output as plain lines: escape sequences out, and of a line a
// progress bar redrew with \r, what shows last.
export function plainLines(output: string): string[] {
  const lines = output
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .split('\n')
    .map((l) => (l.split('\r').filter(Boolean).pop() ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

// Under the /tasks list: the highlighted task's latest output. A shell's or
// monitor's comes from the child every second; an agent's is its latest steps.
function TaskDetail({ task, tabs, output }: { task: BackgroundTask; tabs: Tab[]; output: (taskId: string) => Promise<TaskOutput> }) {
  if (task.type === 'local_workflow') return <WorkflowDetail task={task} />;
  return <OutputDetail task={task} tabs={tabs} output={output} />;
}

const AGENT_MARK: Record<string, [string, string]> = { done: ['✓', '#98C379'], start: ['◐', '#E8C07D'], error: ['✗', '#E06C75'], failed: ['✗', '#E06C75'] };

// A workflow's phases, each with its agents: done, running, or waiting.
function WorkflowDetail({ task }: { task: BackgroundTask }) {
  const run = task.workflow;
  const rows: React.ReactNode[] = [];
  for (const phase of run?.phases ?? []) {
    rows.push(<Text key={`p${phase}`} bold>{clean(phase)}</Text>);
    for (const [i, a] of (run?.agents ?? []).filter((x) => x.phase === phase).entries()) {
      const [mark, color] = AGENT_MARK[a.state] ?? ['·', '#7F848E'];
      const meta = [a.model?.replace(/^claude-/, ''), a.durationMs !== undefined && `${(a.durationMs / 1000).toFixed(1)}s`, a.result && `→ ${a.result.replace(/\s+/g, ' ').slice(0, 60)}`].filter(Boolean).join(' · ');
      rows.push(
        <Text key={`a${phase}${i}`} wrap="truncate-end">
          <Text color={color}>{`  ${mark} `}</Text>
          {clean(a.label)}
          {meta ? <Text dimColor>{`  ${clean(meta)}`}</Text> : null}
        </Text>,
      );
    }
  }
  const shown = rows.slice(-DETAIL_ROWS);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor wrap="truncate-end">{`── phases${task.progress ? ` · ${task.progress}` : ''}`}</Text>
      {shown.length ? shown : <Text dimColor>no phase started yet</Text>}
    </Box>
  );
}

function OutputDetail({ task, tabs, output }: { task: BackgroundTask; tabs: Tab[]; output: (taskId: string) => Promise<TaskOutput> }) {
  const agent = task.type === 'local_agent';
  const [shell, setShell] = useState<{ lines: string[]; note: string } | null>(null);
  useEffect(() => {
    if (agent) return;
    let live = true;
    const read = () =>
      output(task.id)
        .then((r) => live && setShell({ lines: plainLines(r.output), note: r.truncated ? `last 8 KB of ${Math.round(r.totalBytes / 1024)} KB` : '' }))
        .catch((e) => live && setShell({ lines: [], note: errText(e) }));
    void read();
    const t = setInterval(read, 1000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [task.id, agent]);

  let lines: string[];
  let note = '';
  if (agent) {
    const call = task.toolUseId ? findCall(tabs, task.toolUseId) : undefined;
    lines = (call?.children ?? []).flatMap((b) => {
      if (b.kind === 'tool_use') return [`⏺ ${toolSummary(b.name, b.input, b.inputJson)}`];
      if (b.kind === 'text') return b.text.trim() ? [b.text.trim().split('\n')[0]] : [];
      return [];
    });
    if (task.progress) note = task.progress;
  } else {
    lines = shell?.lines ?? [];
    note = shell ? shell.note : 'reading its output…';
  }
  const shown = lines.slice(-DETAIL_ROWS);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor wrap="truncate-end">{`── ${agent ? 'latest steps' : 'output'}${note ? ` · ${note}` : ''}`}</Text>
      {shown.length ? shown.map((l, i) => <Text key={i} wrap="truncate-end">{l || ' '}</Text>) : <Text dimColor>{agent ? 'no steps yet' : shell ? 'no output yet' : ' '}</Text>}
    </Box>
  );
}

// /tasks: background shells and agents still running, with the highlighted
// one's output under the list. Enter goes to the tab that started it, x stops it.
export function TasksPanel({ flash, close, tasks, tabs, output, onStop, onGoTo }: Common & {
  tasks: BackgroundTask[];
  tabs: Tab[];
  output: (taskId: string) => Promise<TaskOutput>;
  onStop: (taskId: string) => Promise<void>;
  onGoTo: (tabId: number) => void;
}) {
  const now = Date.now();
  const items: PickerItem[] = tasks.map((t) => ({ key: t.id, label: t.description, description: taskMeta(t, now), mark: '◷', markColor: '#7CC4FF' }));
  const find = (item: PickerItem | undefined) => tasks.find((t) => t.id === item?.key);
  return (
    <Picker
      title="Background tasks"
      items={items}
      rows={5}
      empty="no background tasks running"
      onCancel={close}
      onSelect={(item) => {
        const t = find(item);
        if (t?.tabId === undefined) return;
        onGoTo(t.tabId);
        close();
      }}
      onKey={(input, _key, item) => {
        const t = find(item);
        if (input !== 'x' || !t) return false;
        onStop(t.id).then(
          () => flash(`Stopped ${t.description}`),
          (e) => flash(errText(e)),
        );
        return true;
      }}
      detail={(item) => {
        const t = find(item);
        return t ? <TaskDetail key={t.id} task={t} tabs={tabs} output={output} /> : null;
      }}
      hint="↑↓ move · enter goes to its tab · x stops it · esc closes"
    />
  );
}

// /plugins: the installed plugins (Enter: enable or disable, uninstall), the
// marketplaces to install from (typing filters), and the claude.ai connectors.
type Plugins = { installed: InstalledPlugin[]; available?: AvailablePlugin[] };
export function PluginsPanel({ session, flash, close, list, act }: Common & { list: (available: boolean) => Promise<Plugins>; act: (action: string, plugin: string) => Promise<string> }) {
  const [data, setData] = useState<Plugins | null>(null);
  const [view, setView] = useState<'top' | 'browse' | 'connectors'>('top');
  const [picked, setPicked] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState('');
  const [connectors, setConnectors] = useState<McpServer[] | null>(null);
  const load = (available = false) =>
    list(available).then(
      (d) => setData((old) => ({ installed: d.installed, available: d.available ?? old?.available })),
      (e) => flash(errText(e)),
    );
  useEffect(() => void load(), []);
  const run = (action: string, plugin: string) => {
    setBusy(`${action === 'install' ? 'Installing' : action === 'uninstall' ? 'Uninstalling' : action === 'enable' ? 'Enabling' : 'Disabling'} ${plugin}…`);
    act(action, plugin).then(
      (m) => {
        setBusy('');
        flash(m);
        setPicked(null);
        void load(view === 'browse');
      },
      (e) => {
        setBusy('');
        flash(errText(e));
      },
    );
  };
  const installed = data?.installed ?? [];
  if (view === 'connectors') {
    return (
      <Picker
        key="connectors"
        title="claude.ai connectors"
        subtitle={connectors ? 'From your claude.ai account · /mcp authenticates, reconnects or turns one off' : 'Asking Claude Code…'}
        items={(connectors ?? []).map((s) => ({ key: s.name, label: s.name.replace(/^claude\.ai /, ''), description: s.status, mark: '●', markColor: s.status === 'connected' ? '#98C379' : s.status === 'failed' ? '#E06C75' : '#E8C07D' }))}
        empty={connectors ? 'No claude.ai connectors in this session' : 'Asking Claude Code…'}
        onSelect={() => flash('/mcp authenticates, reconnects or turns off a connector')}
        onCancel={() => setView('top')}
      />
    );
  }
  if (view === 'browse') {
    const have = new Set(installed.map((p) => p.id));
    const q = query.toLowerCase();
    const rows = (data?.available ?? []).filter((p) => !have.has(p.pluginId) && (!q || `${p.name} ${p.description ?? ''} ${p.marketplaceName ?? ''}`.toLowerCase().includes(q))).slice(0, 300);
    return (
      <Picker
        key="browse"
        title="Install a plugin"
        subtitle={busy || (data?.available ? `${data.available.length} in your marketplaces · typing filters · Enter installs (user scope)` : 'Reading the marketplaces…')}
        items={rows.map((p) => ({ key: p.pluginId, label: p.name, description: `${p.marketplaceName ?? ''}${p.description ? `: ${clean(p.description).replace(/\s+/g, ' ')}` : ''}` }))}
        search={{ query, onChange: setQuery }}
        empty={data?.available ? 'No plugin matches' : 'Reading the marketplaces…'}
        onSelect={(item) => !busy && run('install', item.key)}
        onCancel={() => setView('top')}
      />
    );
  }
  const plugin = installed.find((p) => p.id === picked);
  if (plugin) {
    return (
      <Picker
        key={`plugin:${plugin.id}`}
        title={plugin.id}
        subtitle={busy || `${plugin.enabled ? 'enabled' : 'disabled'} · ${plugin.scope ?? 'user'} scope${plugin.version ? ` · ${plugin.version}` : ''}`}
        items={[
          { key: plugin.enabled ? 'disable' : 'enable', label: plugin.enabled ? 'Disable' : 'Enable', description: plugin.enabled ? 'keeps it installed, off' : 'turns it on again' },
          { key: 'uninstall', label: 'Uninstall', description: 'removes it' },
        ]}
        onSelect={(item) => !busy && run(item.key, plugin.id)}
        onCancel={() => setPicked(null)}
      />
    );
  }
  return (
    <Picker
      key="plugins"
      title="Plugins"
      subtitle={busy || (data ? `${installed.length} installed (${installed.filter((p) => p.enabled).length} enabled)` : 'Asking Claude Code…')}
      items={[
        { key: '__browse', label: 'Install a plugin…', description: 'from your marketplaces' },
        { key: '__connectors', label: 'claude.ai connectors…', description: 'the ones this session has' },
        ...installed.map((p) => ({ key: p.id, label: p.id, description: `${p.enabled ? 'enabled' : 'disabled'} · ${p.scope ?? 'user'}${p.version ? ` · ${p.version}` : ''}`, mark: p.enabled ? '●' : '○', markColor: p.enabled ? '#98C379' : '#7F848E' })),
      ]}
      onSelect={(item) => {
        if (item.key === '__browse') {
          setView('browse');
          if (!data?.available) void load(true);
        } else if (item.key === '__connectors') {
          setView('connectors');
          session.request('mcp_status').then(
            (r) => setConnectors(((r.mcpServers as McpServer[] | undefined) ?? []).filter((s) => s.scope === 'claudeai')),
            (e) => flash(errText(e)),
          );
        } else setPicked(item.key);
      }}
      onCancel={close}
    />
  );
}

// When a task runs next, or ran: "today 09:00", "Wed 09:00", "Nov 30 09:00".
export function whenText(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(new Date(now))) / 86_400_000);
  if (days === 0) return `today ${hm}`;
  if (days === 1) return `tomorrow ${hm}`;
  if (days === -1) return `yesterday ${hm}`;
  if (Math.abs(days) < 7) return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${hm}`;
  return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()} ${hm}`;
}

// /schedule: the scheduled tasks; one opens its actions (run now, pause or
// resume, delete, its runs), and a run opens its session.
export function SchedulePanel({ flash, close, onOpenRun }: Omit<Common, 'session'> & { onOpenRun: (sessionId: string) => void }) {
  const [saved, setSaved] = useState(() => loadSchedules());
  const [picked, setPicked] = useState<string | null>(null);
  const [runsOf, setRunsOf] = useState<string | null>(null);
  const reload = () => setSaved(loadSchedules());
  const last = (id: string) => [...saved.runs].reverse().find((r) => r.scheduleId === id);
  if (runsOf) {
    const runs = [...saved.runs].reverse().filter((r) => r.scheduleId === runsOf);
    return (
      <Picker
        key={`runs:${runsOf}`}
        title={`Runs: ${saved.schedules.find((s) => s.id === runsOf)?.name ?? runsOf}`}
        subtitle="Enter opens a run's session (once it has finished)"
        items={runs.length ? runs.map((r, i) => ({ key: String(i), label: whenText(r.at), description: r.error ? `failed: ${r.error}` : `session ${r.sessionId?.slice(0, 8)}${r.manual ? ' · run by hand' : ''}`, mark: r.error ? '✗' : '✓', markColor: r.error ? '#E06C75' : '#98C379' })) : [{ key: 'none', label: 'No runs yet' }]}
        onSelect={(item) => {
          const r = runs[Number(item.key)];
          if (r?.sessionId) onOpenRun(r.sessionId);
        }}
        onCancel={() => setRunsOf(null)}
      />
    );
  }
  const task = saved.schedules.find((s) => s.id === picked);
  if (task) {
    const act = (key: string) => {
      try {
        if (key === 'run') {
          flash(`Running ${task.name}…`);
          void runNow(task.id).then((r) => {
            reload();
            flash(r.error ? `${task.name} did not start: ${r.error}` : `${task.name} is running in session ${r.sessionId?.slice(0, 8)} (Runs opens it once done)`);
          });
        } else if (key === 'pause') {
          pauseSchedule(task.id, !task.paused);
          flash(`${task.name} ${task.paused ? 'resumed' : 'paused'}`);
        } else if (key === 'delete') {
          removeSchedule(task.id);
          flash(`Deleted ${task.name}`);
          setPicked(null);
        } else if (key === 'runs') return setRunsOf(task.id);
        reload();
      } catch (e) {
        flash(errText(e));
      }
    };
    return (
      <Picker
        key={`task:${task.id}`}
        title={task.name}
        subtitle={`${describeWhen(task.when)} in ${clean(task.cwd)}: ${clean(task.prompt).replace(/\s+/g, ' ')}`}
        items={[
          { key: 'run', label: 'Run it now', description: 'in a fresh session, as on schedule' },
          { key: 'pause', label: task.paused ? 'Resume' : 'Pause', description: task.paused ? 'runs on schedule again' : 'skips its runs until resumed' },
          { key: 'runs', label: 'Runs', description: `${saved.runs.filter((r) => r.scheduleId === task.id).length} so far` },
          { key: 'delete', label: 'Delete', description: 'its runs stay as sessions' },
        ]}
        onSelect={(item) => act(item.key)}
        onCancel={() => setPicked(null)}
      />
    );
  }
  const off = binderConfig().schedules === false;
  return (
    <Picker
      key="tasks"
      title="Scheduled tasks"
      subtitle={off ? 'Off in config.json (schedules): none runs' : 'They run while binder or the Mac app is open · /schedule <when> <prompt> adds one'}
      items={
        saved.schedules.length
          ? saved.schedules.map((s) => {
              const next = nextFor(s);
              const r = last(s.id);
              return { key: s.id, label: s.name, description: `${describeWhen(s.when)} · ${s.paused ? 'paused' : next ? `next ${whenText(next.getTime())}` : 'never'}${r ? ` · last ${whenText(r.at)}${r.error ? ' (failed)' : ''}` : ''}`, mark: s.paused ? '⏸' : '⏲' };
            })
          : [{ key: 'none', label: 'None yet', description: 'e.g. /schedule weekdays 9:00 Summarize what changed yesterday' }]
      }
      onSelect={(item) => item.key !== 'none' && setPicked(item.key)}
      onCancel={close}
    />
  );
}

// /findings: the latest code review's findings; Enter asks Claude to fix one, or all.
export function FindingsPanel({ flash, close, review, onSend }: Omit<Common, 'session'> & { review: { tabId: number; findings: Finding[] } | null; onSend: (text: string, tabId: number) => void }) {
  if (!review) return <Picker title="Findings" subtitle="No code review in this session yet: /code-review runs one" items={[{ key: 'close', label: 'Close' }]} onSelect={close} onCancel={close} />;
  const { findings, tabId } = review;
  const items: PickerItem[] = [
    { key: 'all', label: 'Apply fixes', description: `asks Claude to fix all ${findings.length} in one prompt` },
    ...findings.map((f, i) => ({ key: String(i), label: clean(findingPlace(f)), description: `${f.severity ? `${severityName(f.severity)}: ` : ''}${clean(f.summary).replace(/\s+/g, ' ')}`, mark: '●', markColor: f.severity === 'important' ? '#E06C75' : f.severity === 'pre_existing' ? '#C9A0FF' : f.severity === 'nit' ? '#E8C07D' : undefined })),
  ];
  const pick = (item: PickerItem) => {
    try {
      if (item.key === 'all') {
        onSend(fixAllPrompt(findings), tabId);
        flash(`Asked Claude to fix ${findings.length} finding${findings.length === 1 ? '' : 's'}`);
      } else {
        const f = findings[Number(item.key)];
        onSend(fixPrompt(f), tabId);
        flash(`Asked Claude to fix ${findingPlace(f)}`);
      }
    } catch (e) {
      flash(errText(e));
    }
    close();
  };
  const counts = severityCounts(findings);
  return <Picker title={`Findings: ${findings.length}${counts ? ` (${counts})` : ''}`} subtitle="Enter asks Claude to fix it, in the review's tab" items={items} onSelect={pick} onCancel={close} />;
}

// /pr: the branch's pull request, and what to do about it.
export function PrPanel({ flash, close, pr, onFix, onMerge, onRefresh }: Omit<Common, 'session'> & { pr: PrStatus | undefined; onFix: () => string; onMerge: () => Promise<string>; onRefresh: () => Promise<void> }) {
  const [busy, setBusy] = useState('');
  if (!pr) {
    return <Picker title="Pull request" subtitle="No pull request for this branch (or gh cannot see one)" items={[{ key: 'refresh', label: 'Look again' }]} onSelect={() => void onRefresh().then(() => flash('Looked again'))} onCancel={close} />;
  }
  const failing = pr.checks.failing.length > 0;
  const items: PickerItem[] = [
    { key: 'open', label: 'Open it in the browser', description: pr.url },
    ...(pr.state === 'OPEN' && (failing || pr.changesRequested) ? [{ key: 'fix', label: failing ? 'Fix the failing checks' : 'Address the review', description: failing ? pr.checks.failing.join(', ') : `changes asked for by ${pr.changesRequested!.by}` }] : []),
    ...(pr.state === 'OPEN' ? [{ key: 'merge', label: 'Merge when ready', description: 'squash, once its checks pass and it is approved (gh pr merge --auto)' }] : []),
    { key: 'refresh', label: 'Look again', description: 'binder looks every minute, and after each turn' },
  ];
  const act = async (item: PickerItem) => {
    try {
      if (item.key === 'open') {
        openExternal(pr.url);
        flash(`Opened ${pr.url}`);
      } else if (item.key === 'fix') {
        flash(onFix());
        close();
      } else if (item.key === 'merge') {
        setBusy('asking GitHub…');
        flash(await onMerge());
        close();
      } else {
        setBusy('looking…');
        await onRefresh();
        setBusy('');
      }
    } catch (e) {
      setBusy('');
      flash(errText(e));
    }
  };
  return <Picker title={`PR #${pr.number}: ${clean(pr.title)}`} subtitle={busy || prLine(pr)} items={items} onSelect={(i) => void act(i)} onCancel={close} />;
}

// /files: what the tab's tool calls read, edited and wrote, the latest first.
export function FilesPanel({ flash, close, tab, cwd }: Omit<Common, 'session'> & { tab: Tab; cwd: string }) {
  const files = useMemo(() => tabFiles(tab), [tab]);
  const editor = readConfigSafe().editor ?? 'open';
  const items: PickerItem[] = files.map((f) => ({ key: f.path, label: f.path.replace(cwd + '/', ''), description: `${f.tool}${f.line ? ` · line ${f.line}` : ''}` }));
  const act = (path: string, how: 'open' | 'reveal') => {
    const file = resolveFile(path, cwd);
    try {
      if (how === 'reveal') revealFile(file);
      else openInEditor(file, editor, files.find((f) => f.path === path)?.line);
      flash(`${how === 'reveal' ? 'Showed' : 'Opened'} ${file}`);
    } catch (e) {
      flash(errText(e));
    }
  };
  return (
    <Picker
      title="Files in this tab"
      subtitle={`enter opens with ${editor} (/settings changes it)`}
      items={items}
      onSelect={(i) => act(i.key, 'open')}
      onCancel={close}
      empty="no tool call in this tab named a file"
      hint="↑↓ move · enter opens · f shows in Finder · c copies the path · esc closes"
      onKey={(input, _key, item) => {
        if (!item) return false;
        if (input === 'f') return act(item.key, 'reveal'), true;
        if (input === 'c') return copyText(resolveFile(item.key, cwd)), flash(`Copied ${resolveFile(item.key, cwd)}`), true;
        return false;
      }}
    />
  );
}

function readConfigSafe(): BinderConfig {
  try {
    return readConfig();
  } catch {
    return {};
  }
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

export function ResumePanel({ session, flash, close, cwd, configDir, currentId, onResume }: Common & { cwd: string; configDir: string; currentId: string; onResume: (s: SessionSummary) => void }) {
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
  // Archived sessions stay out of the list until Ctrl+D shows them (and only them).
  const [archived, setArchivedIds] = useState(() => archivedIds());
  const [showArchived, setShowArchived] = useState(false);
  // What was said in each session, searched once the query is three characters long.
  const [hits, setHits] = useState<{ query: string; found: Map<string, string> } | null>(null);
  const inScope = useMemo(
    () =>
      all.filter((s) => {
        if (archived.has(s.id) !== showArchived) return false;
        if (scope === 'folder' && s.cwd !== cwd) return false;
        if (scope === 'worktrees' && !trees.includes(s.cwd)) return false;
        if (scope === 'branch' && (!branch || s.branch !== branch || !trees.includes(s.cwd))) return false;
        return true;
      }),
    [all, scope, cwd, trees, branch, archived, showArchived],
  );
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) return setHits(null);
    let live = true;
    const t = setTimeout(() => {
      void searchSessions(inScope, q).then((found) => live && setHits({ query: q, found: new Map(found.map((h) => [h.id, h.snippet])) }));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, inScope]);
  const shown = useMemo(() => {
    const q = query.toLowerCase();
    const said = hits?.query === query.trim() ? hits.found : null;
    return inScope.filter((s) => !q || `${s.title ?? ''} ${s.prompt} ${s.cwd} ${s.branch ?? ''} ${s.id}`.toLowerCase().includes(q) || said?.has(s.id));
  }, [inScope, query, hits]);
  const items: PickerItem[] = shown.slice(0, 500).map((s) => {
    const snippet = hits?.found.get(s.id);
    return {
      key: s.id,
      label: (s.title ?? s.prompt.split('\n')[0]).slice(0, 70),
      description: snippet ?? [ago(s.modified), s.branch, scope === 'folder' ? undefined : s.cwd.replace(process.env.HOME ?? '\u0000', '~')].filter(Boolean).join(' · '),
    };
  });
  const toggle = (s: Scope) => setScope(scope === s ? 'folder' : s);
  const searching = query.trim().length >= 3 && hits?.query !== query.trim();
  return (
    <Picker
      key={`${scope}:${showArchived}`}
      title={`${showArchived ? 'Archived sessions' : 'Resume a session'}: ${SCOPE_TITLE[scope]}${scope === 'branch' && branch ? ` (${branch})` : ''}`}
      subtitle={searching ? 'searching what was said…' : undefined}
      items={items}
      search={{ query, onChange: setQuery }}
      onSelect={(i) => onResume(shown.find((s) => s.id === i.key)!)}
      onCancel={close}
      empty={query ? 'no session matches' : showArchived ? 'no archived sessions here' : 'no other sessions here'}
      hint={`↑↓ move · enter resumes · ctrl+x ${showArchived ? 'unarchives' : 'archives'} · ctrl+d ${showArchived ? 'back' : 'archived'} · ctrl+a all projects · ctrl+w worktrees · ctrl+b this branch · esc closes`}
      onKey={(input, key, item) => {
        if (!key.ctrl) return false;
        if (input === 'a') return toggle('all'), true;
        if (input === 'w') return toggle('worktrees'), true;
        if (input === 'b') return toggle('branch'), true;
        if (input === 'd') return setShowArchived(!showArchived), true;
        if (input === 'x' && item) {
          // Archiving also removes the worktree binder made for it, when nothing would be lost.
          const said = archiveSession(item.key, !showArchived);
          setArchivedIds(archivedIds());
          flash(said.startsWith(showArchived ? 'Unarchived.' : 'Archived.') ? said : `${said} ${item.label}`);
          return true;
        }
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

type SettingsView = { kind: 'list' | 'mode' | 'folder' | 'status' | 'editor' } | { kind: 'dir' | 'mapping'; folder: string } | { kind: 'worktree'; field: 'location' | 'branchPrefix' } | { kind: 'diffBase' };

// /settings: binder's config.json. The view settings apply at once; an open
// session keeps the ones for sessions opened from now on as it started.
export function SettingsPanel({ flash, close, onSticky, onStatusText, onMarkdown, onBell, onImages, onTodoPanel }: Omit<Common, 'session'> & { onSticky: (on: boolean) => void; onStatusText: (template: string | undefined) => void; onMarkdown: (style: MarkdownStyle) => void; onBell: (on: boolean) => void; onImages: (on: boolean) => void; onTodoPanel: (on: boolean) => void }) {
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

  if (view.kind === 'diffBase') {
    const typed = query.trim();
    const current = config.diffBase ?? 'HEAD';
    const items: PickerItem[] = [
      ...(typed && typed !== 'HEAD' ? [{ key: typed, label: `Save: ${typed}`, description: 'a branch (or any ref) to compare against' }] : []),
      { key: 'HEAD', label: 'HEAD', description: 'what is not committed yet (the default)', mark: current === 'HEAD' ? '✓' : ' ', markColor: '#98C379' },
    ];
    return (
      <Picker
        key="diffBase"
        title="What /diff compares the session's folder against"
        subtitle={error || `now: ${current}`}
        items={items}
        search={{ query, onChange: setQuery }}
        onSelect={(i) => save({ diffBase: i.key === 'HEAD' ? undefined : i.key }, `Diff base: ${i.key}`) && (setLast('diffBase'), back())}
        onCancel={back}
        hint="type a branch · enter saves · esc back"
      />
    );
  }

  if (view.kind === 'worktree') {
    const { field } = view;
    const typed = query.trim();
    const fallback = field === 'location' ? DEFAULT_LOCATION : DEFAULT_PREFIX;
    const current = config.worktrees?.[field] ?? fallback;
    const saveField = (v: string) => {
      const next = { ...config.worktrees, [field]: v === fallback ? undefined : v };
      const kept = Object.fromEntries(Object.entries(next).filter(([, x]) => x !== undefined));
      if (save({ worktrees: Object.keys(kept).length ? kept : undefined }, `Worktree ${field === 'location' ? 'folder' : 'branch prefix'}: ${v}`)) {
        setLast(`wt:${field}`);
        back();
      }
    };
    const items: PickerItem[] = [
      ...(typed ? [{ key: 'save', label: `Save: ${typed}`, description: field === 'location' ? 'relative to the repo; ~ and {repo} are filled in' : 'each new branch starts with it' }] : []),
      ...(current !== fallback ? [{ key: 'default', label: 'Use the default', description: fallback }] : []),
    ];
    return (
      <Picker
        key="worktree"
        title={field === 'location' ? 'Where binder --worktree makes worktrees' : "The start of a worktree's branch name"}
        subtitle={error || `now: ${current}`}
        items={items}
        search={{ query, onChange: setQuery }}
        onSelect={(i) => saveField(i.key === 'save' ? typed : fallback)}
        onCancel={back}
        empty="type a value"
        hint="type · enter saves · esc back"
      />
    );
  }

  if (view.kind === 'editor') {
    const typed = query.trim();
    const current = config.editor ?? 'open';
    const items: PickerItem[] = [
      ...(typed && !EDITOR_PRESETS.some(([c]) => c === typed) ? [{ key: typed, label: `Use: ${typed}`, description: 'a command; {file} and {line} are filled in, or the path goes last' }] : []),
      ...EDITOR_PRESETS.filter(([c]) => !typed || c.includes(typed)).map(([c, about]) => ({ key: c, label: c, description: about, mark: c === current ? '✓' : ' ', markColor: '#98C379' })),
    ];
    return (
      <Picker
        key="editor"
        title="Editor: how /files and the Mac app open a file"
        subtitle={error || `now: ${current}`}
        items={items}
        search={{ query, onChange: setQuery }}
        onSelect={(i) => {
          if (save({ editor: i.key === 'open' ? undefined : i.key }, `Editor: ${i.key}`)) {
            setLast('editor');
            back();
          }
        }}
        onCancel={back}
        hint="type a command or pick one · enter saves · esc back"
      />
    );
  }

  if (view.kind === 'status') {
    const value = query.trim();
    const saveText = (v: string) => {
      const template = v === DEFAULT_STATUS ? undefined : v;
      if (!save({ statusText: template }, `Status text: ${v || 'none'}`)) return;
      onStatusText(template);
      setLast('status');
      back();
    };
    const sample = statusText(value, { contextTokens: 36_900, contextWindow: 1_000_000, costUsd: 0.42 });
    const items: PickerItem[] = [
      { key: 'save', label: 'Save', description: `shows ${sample ? `"${sample}"` : 'nothing'} for a session at 36.9k of 1M tokens that cost $0.42` },
      ...(value !== DEFAULT_STATUS ? [{ key: 'default', label: 'Use the default', description: DEFAULT_STATUS }] : []),
      ...STATUS_FIELDS.map((f) => ({ key: `field:${f.name}`, label: `{${f.name}}`, description: f.about })),
    ];
    return (
      <Picker
        key="status"
        title="Status text: the right end of the row above the prompt"
        subtitle={error || '{field} shows a field, ( ) text only when a field inside it has one'}
        items={items}
        search={{ query, onChange: setQuery }}
        onSelect={(i) => {
          if (i.key === 'save') return saveText(value);
          if (i.key === 'default') return saveText(DEFAULT_STATUS);
          setQuery(`${query.trimEnd()}${query.trim() ? ' ' : ''}${i.label}`);
        }}
        onCancel={back}
        hint="type to edit · enter on Save saves · enter on a field adds it · esc back"
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
    { key: 'status', label: 'Status text', description: config.statusText ?? DEFAULT_STATUS },
    { key: 'artifacts', label: 'Artifacts', description: config.artifacts !== false ? 'on: Claude can publish live pages to claude.ai' : 'off' },
    { key: 'fast', label: 'Fast mode', description: config.fastMode === true ? 'on when a session starts (Alt+O turns it off)' : 'off when a session starts (Alt+O turns it on)' },
    { key: 'always', label: 'Always allow', description: config.alwaysAllow !== false ? "on: permission prompts offer the rules Claude suggests" : 'off: permission prompts offer allow and deny only' },
    { key: 'prWatch', label: 'Pull request', description: config.prWatch !== false ? "on: the branch's PR, its checks and reviews, under the status row (gh)" : 'off' },
    { key: 'prAutoFix', label: 'PR auto-fix', description: config.prAutoFix === true ? 'on: failing checks and reviews asking for changes go to Claude' : 'off: /pr fixes them when you ask' },
    { key: 'diffBase', label: 'Diff base', description: config.diffBase ?? 'HEAD: what /diff shows is what is not committed' },
    { key: 'wt:location', label: 'Worktree folder', description: config.worktrees?.location ?? `${DEFAULT_LOCATION} (binder --worktree)` },
    { key: 'wt:branchPrefix', label: 'Worktree branch prefix', description: config.worktrees?.branchPrefix ?? DEFAULT_PREFIX },
    { key: 'workflow', label: 'Workflow card', description: config.workflowCard !== false ? 'on: a workflow asks with its phases, and can be allowed from then on' : 'off: a workflow asks allow or deny' },
    { key: 'pinned', label: 'Todo and plan panel', description: config.todoPanel !== false ? 'on: the latest todos and plan stay above the prompt (Ctrl+T opens them)' : 'off: only in the transcript' },
    { key: 'editor', label: 'Editor', description: config.editor ?? "open: the file's default app" },
    { key: 'images', label: 'Images', description: config.showImages !== false ? 'on: drawn in the transcript (iTerm2), a caption elsewhere' : 'off: a caption' },
    { key: 'bell', label: 'Bell', description: config.bell !== false ? 'on: rings when a turn ends or a question arrives while the terminal is in the background' : 'off' },
    { key: 'plan', label: 'Plan approval', description: config.planApproval !== false ? 'on: a plan shows in full, with approve choices that set the mode' : 'off: a plan asks allow or deny' },
    ...Object.entries(dirs).map(([folder, dir]) => ({ key: `dir:${folder}`, label: 'Config dir', description: `${folder} → ${dir}` })),
    { key: 'findings', label: 'Findings card', description: config.findingsCard !== false ? 'on: a code review lists its findings to fix (/findings) and /diff marks them' : 'off: a review is plain text' },
    { key: 'pluginReload', label: 'Plugin changes', description: config.pluginReload !== false ? 'on: one made in /plugins loads into the running session at once' : "off: they load at claude's next start" },
    { key: 'schedules', label: 'Scheduled tasks', description: config.schedules !== false ? 'on: /schedule tasks run while binder or the Mac app is open' : 'off: none runs' },
    { key: 'sideChat', label: 'Side chat', description: config.sideChat !== false ? "on: /btw asks a side question, answered from the session and kept out of its transcript" : "off: /btw goes to Claude Code as typed" },
    { key: 'add', label: 'Add a config dir…', description: Object.keys(dirs).length ? undefined : 'for a second account: claude run in a folder you pick uses another config dir' },
  ];
  const pick = (item: PickerItem) => {
    setLast(item.key);
    if (item.key === 'mode') return setView({ kind: 'mode' });
    if (item.key === 'sticky') {
      const on = config.stickyPrompt === false;
      if (save({ stickyPrompt: on ? undefined : false }, `Sticky prompt ${on ? 'on' : 'off'}`)) onSticky(on);
      return;
    }
    if (item.key === 'markdown') {
      const next = MARKDOWN_STYLES[(MARKDOWN_STYLES.indexOf(style) + 1) % MARKDOWN_STYLES.length];
      if (save({ markdownStyle: next }, `Markdown: ${next}`)) onMarkdown(next);
      return;
    }
    if (item.key === 'status') {
      setQuery(config.statusText ?? DEFAULT_STATUS);
      return setView({ kind: 'status' });
    }
    if (item.key === 'artifacts') {
      const on = config.artifacts === false;
      save({ artifacts: on ? undefined : false }, `Artifacts ${on ? 'on' : 'off'} for sessions opened from now on`);
      return;
    }
    if (item.key === 'fast') {
      const on = config.fastMode !== true;
      save({ fastMode: on || undefined }, `Fast mode ${on ? 'on' : 'off'} at the start of sessions opened from now on`);
      return;
    }
    if (item.key === 'pluginReload') {
      const on = config.pluginReload === false;
      save({ pluginReload: on ? undefined : false }, `Plugin changes ${on ? 'load at once' : "load at claude's next start"}`);
      return;
    }
    if (item.key === 'schedules') {
      const on = config.schedules === false;
      save({ schedules: on ? undefined : false }, `Scheduled tasks ${on ? 'on' : 'off'}`);
      return;
    }
    if (item.key === 'sideChat') {
      const on = config.sideChat === false;
      save({ sideChat: on ? undefined : false }, `Side chat ${on ? 'on' : 'off'} for sessions opened from now on`);
      return;
    }
    if (item.key === 'findings') {
      const on = config.findingsCard === false;
      save({ findingsCard: on ? undefined : false }, `Findings card ${on ? 'on' : 'off'} for sessions opened from now on`);
      return;
    }
    if (item.key === 'prWatch') {
      const on = config.prWatch === false;
      save({ prWatch: on ? undefined : false }, `Pull request watching ${on ? 'on' : 'off'} for sessions opened from now on`);
      return;
    }
    if (item.key === 'prAutoFix') {
      const on = config.prAutoFix !== true;
      save({ prAutoFix: on || undefined }, `PR auto-fix ${on ? 'on' : 'off'} for sessions opened from now on`);
      return;
    }
    if (item.key === 'diffBase') {
      setQuery('');
      return setView({ kind: 'diffBase' });
    }
    if (item.key.startsWith('wt:')) {
      const field = item.key.slice(3) as 'location' | 'branchPrefix';
      setQuery(config.worktrees?.[field] ?? '');
      return setView({ kind: 'worktree', field });
    }
    if (item.key === 'workflow') {
      const on = config.workflowCard === false;
      save({ workflowCard: on ? undefined : false }, `Workflow card ${on ? 'on' : 'off'} for sessions opened from now on`);
      return;
    }
    if (item.key === 'pinned') {
      const on = config.todoPanel === false;
      if (save({ todoPanel: on ? undefined : false }, `Todo and plan panel ${on ? 'on' : 'off'}`)) onTodoPanel(on);
      return;
    }
    if (item.key === 'editor') {
      setQuery('');
      return setView({ kind: 'editor' });
    }
    if (item.key === 'images') {
      const on = config.showImages === false;
      if (save({ showImages: on ? undefined : false }, `Images ${on ? 'on' : 'off'}`)) onImages(on);
      return;
    }
    if (item.key === 'bell') {
      const on = config.bell === false;
      if (save({ bell: on ? undefined : false }, `Bell ${on ? 'on' : 'off'}`)) onBell(on);
      return;
    }
    if (item.key === 'plan') {
      const on = config.planApproval === false;
      save({ planApproval: on ? undefined : false }, `Plan approval ${on ? 'on' : 'off'} for sessions opened from now on`);
      return;
    }
    if (item.key === 'always') {
      const on = config.alwaysAllow === false;
      save({ alwaysAllow: on ? undefined : false }, `"Always allow" choices ${on ? 'on' : 'off'} for sessions opened from now on`);
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
      subtitle={error || `${configPath().replace(homedir(), '~')} · permission mode, artifacts, fast mode, always allow, plan approval and config dirs apply to sessions opened from now on`}
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
