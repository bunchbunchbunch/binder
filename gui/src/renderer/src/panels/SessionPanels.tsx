import { useEffect, useMemo, useState } from 'react';
import { prLine, type BackgroundTask, type PrStatus, type ToolBlock, type WireBlock, type WireState, type WireTab } from '@shared/wire';
import { baseName, elapsed, firstLine, fmtTokens, modelDisplayName, shortPath } from '../lib/format';
import { errText, getState, openLink, openSession, request, sameComputer, toast, useApp } from '../store';
import { findModel, stepEffort, stepModel } from '../lib/models';
import { Picker, type PickerItem } from '../components/Picker';
import { toolLine } from '../components/Blocks';
import { PERMISSION_MODES } from '../components/StatusBar';
import { resolveFile, tabFiles } from '../lib/files';
import { findingPlace, severityCounts, severityName, type Finding } from '../lib/findings';
import { askToFix } from '../components/FindingsCard';
import { folderRank, recentFolders } from './AppPanels';

// binder's own panels for one session, over its transcript: /model, /effort,
// the permission mode, the folder (/cd), /mcp, /chrome, /rewind, /artifacts
// and /tasks. Each talks to the session's host.

type Common = { conn: string; close: () => void; active: boolean };

type Model = { value: string; resolvedModel?: string; displayName: string; description?: string; supportedEffortLevels?: string[] };

function useModels(conn: string, onError: (msg: string) => void): Model[] | null {
  const [models, setModels] = useState<Model[] | null>(null);
  useEffect(() => {
    request(conn, 'models')
      .then((r) => setModels((r.models as Model[] | undefined) ?? []))
      .catch((e) => onError(errText(e)));
  }, [conn]);
  return models;
}

const CHECK = '#98C379';

export function ModelPanel({ conn, close, active, current }: Common & { current: string | null }) {
  const [error, setError] = useState('');
  const models = useModels(conn, setError);
  const items: PickerItem[] = (models ?? []).map((m) => ({
    key: m.value,
    label: m.displayName,
    description: m.description,
    mark: current && (m.resolvedModel === current || m.value === current) ? '✓' : ' ',
    markColor: CHECK,
  }));
  const pick = (item: PickerItem) => {
    const m = models!.find((x) => x.value === item.key)!;
    request(conn, 'set_model', { model: m.value })
      .then(() => {
        toast(`Model: ${m.displayName}`);
        close();
      })
      .catch((e) => setError(errText(e)));
  };
  return <Picker active={active} title="Model" subtitle={error || (models ? undefined : 'Loading…')} items={items} onSelect={pick} onCancel={close} initial={Math.max(0, items.findIndex((i) => i.mark === '✓'))} />;
}

export function EffortPanel({ conn, close, active, model, current }: Common & { model: string | null; current: string | null }) {
  const [error, setError] = useState('');
  const models = useModels(conn, setError);
  const levels = useMemo(() => {
    const m = models?.find((x) => x.resolvedModel === model || x.value === model) ?? models?.[0];
    return m?.supportedEffortLevels ?? (models ? ['low', 'medium', 'high', 'xhigh', 'max'] : []);
  }, [models, model]);
  const items: PickerItem[] = levels.map((l) => ({ key: l, label: l, mark: l === current ? '✓' : ' ', markColor: CHECK }));
  const pick = (item: PickerItem) => {
    request(conn, 'set_effort', { level: item.key })
      .then(() => {
        toast(`Effort: ${item.key}`);
        close();
      })
      .catch((e) => setError(errText(e)));
  };
  return <Picker active={active} title="Effort" subtitle={error || (models ? `For this session (${modelDisplayName(model) || 'current model'})` : 'Loading…')} items={items} onSelect={pick} onCancel={close} initial={Math.max(0, levels.indexOf(current ?? ''))} />;
}

export function PermissionModePanel({ conn, close, active, current }: Common & { current: string | null }) {
  const [error, setError] = useState('');
  const items: PickerItem[] = Object.entries(PERMISSION_MODES).map(([key, [label, description]]) => ({ key, label, description, mark: key === current ? '✓' : ' ', markColor: CHECK }));
  const pick = (item: PickerItem) => {
    request(conn, 'set_permission_mode', { mode: item.key })
      .then(() => {
        toast(`Permission mode: ${item.label}`);
        close();
      })
      .catch((e) => setError(errText(e)));
  };
  return <Picker active={active} title="Permission mode" subtitle={error || 'For this session, until it restarts'} items={items} onSelect={pick} onCancel={close} initial={Math.max(0, items.findIndex((i) => i.key === current))} />;
}

const TYPED = '?typed';

// The folder to move the session to (/cd): one sessions ran in on its
// computer, a typed path, or (on this Mac) one chosen in Finder.
export function CdPanel({ close, active, cwd, computer, onPick }: Common & { cwd: string; computer?: string; onPick: (dir: string) => void }) {
  const sessions = useApp((s) => s.sessions);
  const [query, setQuery] = useState('');
  // The typed path, once it is known to be a folder there.
  const [typed, setTyped] = useState<string | null>(null);
  useEffect(() => {
    const q = query.trim();
    setTyped(null);
    if (!/^[~/]/.test(q)) return;
    let live = true;
    void window.binder.isDirectory(q, computer).then((ok) => live && ok && setTyped(q));
    return () => {
      live = false;
    };
  }, [query, computer]);
  const q = query.toLowerCase();
  const folders = recentFolders(sessions.filter((s) => sameComputer(s.computer, computer)), null).filter((f) => f.dir !== cwd && (!q || f.dir.toLowerCase().includes(q)));
  if (q) folders.sort((a, b) => folderRank(a.dir, q) - folderRank(b.dir, q));
  const items: PickerItem[] = [
    ...(typed ? [{ key: TYPED, label: `Move to ${typed}` }] : []),
    ...folders.map((f) => ({ key: f.dir, label: baseName(f.dir), description: shortPath(f.dir) })),
  ];
  const pick = (dir: string) => {
    close();
    onPick(dir);
  };
  return (
    <Picker
      active={active}
      title="Move to a folder"
      subtitle={`Claude Code works in ${shortPath(cwd)} until you pick another`}
      items={items}
      search={{ query, onChange: setQuery, placeholder: 'Filter recent folders, or type a path (~/code/app)' }}
      onSelect={(i) => pick(i.key === TYPED ? typed! : i.key)}
      onCancel={close}
      empty={query ? 'No folder matches' : 'No other recent folders'}
      hint={
        <>
          ↑↓ move · ⏎ move there{computer ? '' : <> · <kbd>⌘O</kbd> choose in Finder</>} · esc close
        </>
      }
      onKey={(e) => {
        if (computer || !e.metaKey || e.ctrlKey || e.altKey || e.key !== 'o') return false;
        void window.binder.chooseFolder().then((dir) => dir && pick(dir));
        return true;
      }}
    />
  );
}

// pi's Ctrl+P / Shift+Ctrl+P and Shift+Tab, through the requests every host
// serves. One press at a time: each waits until the session shows where the
// last one landed (the host's patch follows its reply), so a held key steps on.
let stepping: Promise<unknown> = Promise.resolve();
function oneAtATime(fn: () => Promise<string>): Promise<string> {
  const run = stepping.then(fn);
  stepping = run.catch(() => {});
  return run;
}

const sessionState = (conn: string) => getState().conns.find((c) => c.id === conn)?.state ?? null;

async function shown(conn: string, check: (s: WireState) => boolean): Promise<void> {
  for (let waited = 0; waited < 2000; waited += 20) {
    const s = sessionState(conn);
    if (!s || check(s)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

const listModels = async (conn: string) => ((await request(conn, 'models')).models as Model[] | undefined) ?? [];

export const cycleModel = (conn: string, delta: 1 | -1) =>
  oneAtATime(async () => {
    const next = stepModel(await listModels(conn), sessionState(conn)?.model ?? null, delta);
    if (!next) throw new Error('No models to switch to');
    await request(conn, 'set_model', { model: next.value });
    await shown(conn, (s) => s.model === next.resolvedModel || s.model === next.value);
    return `Model: ${modelDisplayName(next.resolvedModel ?? next.value)}`;
  });

export const cycleEffort = (conn: string) =>
  oneAtATime(async () => {
    const s = sessionState(conn);
    const models = await listModels(conn);
    const m = findModel(models, s?.model ?? null) ?? models[0];
    const level = stepEffort(m, s?.effort ?? null);
    if (!level) throw new Error(`${modelDisplayName(m ? m.resolvedModel ?? m.value : s?.model)} has no effort levels`);
    await request(conn, 'set_effort', { level });
    await shown(conn, (st) => st.effort === level);
    return `Effort: ${level}`;
  });

type McpServer = { name: string; status: string; scope?: string; config?: { type?: string }; error?: string };

const MCP_MARK: Record<string, [string, string]> = {
  connected: ['●', '#98C379'],
  failed: ['✗', '#E06C75'],
  'needs-auth': ['!', '#E8C07D'],
  pending: ['…', '#7F848E'],
  disabled: ['○', '#7F848E'],
};

export function McpPanel({ conn, close, active }: Common) {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const refresh = () =>
    request(conn, 'mcp_status')
      .then((r) => setServers((r.servers as McpServer[] | undefined) ?? []))
      .catch((e) => setError(errText(e)));
  useEffect(() => {
    void refresh();
    // Servers connect in the background, and sign-in finishes in the browser.
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [conn]);

  const server = servers?.find((s) => s.name === selected);
  if (server) {
    const remote = server.config?.type && server.config.type !== 'stdio';
    const actions: PickerItem[] = [
      ...(server.status === 'needs-auth' || remote ? [{ key: 'auth', label: 'Authenticate', description: 'Sign in in the browser' }] : []),
      ...(server.status !== 'disabled' ? [{ key: 'reconnect', label: 'Reconnect' }] : []),
      server.status === 'disabled' ? { key: 'enable', label: 'Enable' } : { key: 'disable', label: 'Disable' },
      ...(remote ? [{ key: 'clear', label: 'Clear authentication' }] : []),
    ];
    const act = async (item: PickerItem) => {
      const name = server.name;
      try {
        if (item.key === 'auth') {
          const r = await request(conn, 'mcp_authenticate', { server: name });
          if (typeof r.authUrl === 'string') {
            void window.binder.openExternal(r.authUrl);
            toast(`Finish signing in to ${name} in your browser`);
          }
        } else if (item.key === 'reconnect') {
          await request(conn, 'mcp_reconnect', { server: name });
          toast(`Reconnected ${name}`);
        } else if (item.key === 'enable' || item.key === 'disable') {
          await request(conn, 'mcp_toggle', { server: name, enabled: item.key === 'enable' });
          toast(`${item.key === 'enable' ? 'Enabled' : 'Disabled'} ${name}`);
        } else if (item.key === 'clear') {
          await request(conn, 'mcp_clear_auth', { server: name });
          toast(`Cleared authentication for ${name}`);
        }
        setSelected(null);
        void refresh();
      } catch (e) {
        setError(errText(e));
      }
    };
    return (
      <Picker active={active}
        key={server.name}
        title={server.name}
        subtitle={error || [server.status, server.config?.type, server.scope, server.error].filter(Boolean).join(' · ')}
        items={actions}
        onSelect={(i) => void act(i)}
        onCancel={() => setSelected(null)}
        hint="↑↓ move · ⏎ run · esc back"
      />
    );
  }
  const items: PickerItem[] = (servers ?? []).map((s) => {
    const [mark, color] = MCP_MARK[s.status] ?? ['?', '#7F848E'];
    return { key: s.name, label: s.name, description: [s.status, s.scope].filter(Boolean).join(' · '), mark, markColor: color };
  });
  return (
    <Picker active={active}
      title="MCP servers"
      subtitle={error || (servers ? undefined : 'Loading…')}
      items={items}
      onSelect={(i) => setSelected(i.key)}
      onCancel={close}
      empty="No MCP servers configured"
      hint="↑↓ move · ⏎ actions (authenticate, reconnect, enable or disable) · esc close"
    />
  );
}

type ChromeStatus = { allowed?: boolean; subscriber?: boolean; installed?: boolean; connected?: boolean; paired_browser?: string; enabled_by_default?: boolean; urls?: { install?: string; reconnect?: string; permissions?: string } };

export function ChromePanel({ conn, close, active }: Common) {
  const [d, setD] = useState<ChromeStatus | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    request(conn, 'chrome_status')
      .then((r) => setD(r.status as ChromeStatus))
      .catch((e) => setError(errText(e)));
  }, [conn]);
  const items: PickerItem[] = !d
    ? []
    : [
        d.connected ? { key: 'off', label: 'Disable for this session', description: 'Restarts claude without Claude in Chrome' } : { key: 'on', label: 'Enable for this session', description: 'Restarts claude with --chrome' },
        ...(d.installed ? [] : [{ key: 'install', label: 'Install the extension', description: d.urls?.install }]),
        { key: 'reconnect', label: 'Reconnect the extension', description: d.urls?.reconnect },
        { key: 'permissions', label: 'Manage permissions', description: d.urls?.permissions },
      ];
  const pick = (item: PickerItem) => {
    if (item.key === 'on' || item.key === 'off') {
      request(conn, 'chrome', { on: item.key === 'on' })
        .then((r) => toast(String(r.message ?? 'Restarted claude')))
        .catch((e) => toast(errText(e), true));
      return close();
    }
    const url = d?.urls?.[item.key as 'install' | 'reconnect' | 'permissions'];
    if (url) void window.binder.openExternal(url);
  };
  const yes = (b?: boolean) => (b ? 'yes' : 'no');
  const status = d
    ? d.allowed === false || d.subscriber === false
      ? 'Claude in Chrome needs a claude.ai subscription'
      : `Extension installed: ${yes(d.installed)} · connected: ${d.connected ? (d.paired_browser ?? 'yes') : 'no'} · on by default: ${yes(d.enabled_by_default)}`
    : 'Loading…';
  return <Picker active={active} title="Claude in Chrome" subtitle={error || status} items={items} onSelect={pick} onCancel={close} />;
}

export type RewindMode = 'both' | 'conversation' | 'code';
type Target = { uuid: string; prompt: string; tabId: number };

export function RewindPanel({ conn, close, active, onRewound }: Common & { onRewound: (prefill: string | null) => void }) {
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [files, setFiles] = useState<{ count: number; ok: boolean; reason?: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    request(conn, 'rewind_targets')
      .then((r) => setTargets((r.targets as Target[]) ?? []))
      .catch((e) => setError(errText(e)));
  }, [conn]);
  useEffect(() => {
    if (!target) return;
    setFiles(null);
    request(conn, 'rewind_preview', { uuid: target.uuid })
      .then((r) => setFiles({ count: Number(r.files ?? 0), ok: r.canRewind !== false, reason: (r.error as string | null) ?? undefined }))
      .catch((e) => setFiles({ count: 0, ok: false, reason: errText(e) }));
  }, [target, conn]);

  const rewind = (mode: RewindMode) => {
    const t = target!;
    close();
    request(conn, 'rewind', { uuid: t.uuid, mode })
      .then((r) => {
        if (mode !== 'code') onRewound(typeof r.prefill === 'string' ? r.prefill : t.prompt);
        toast(mode === 'code' ? 'Restored the code' : mode === 'both' ? 'Restored the code and the conversation' : 'Restored the conversation');
      })
      .catch((e) => toast(`Rewind failed: ${errText(e)}`, true));
  };

  if (target) {
    const codeNote = !files ? 'Checking…' : !files.ok ? (files.reason ?? 'No checkpoint') : files.count ? `${files.count} file${files.count === 1 ? '' : 's'}` : 'No file changes';
    const canCode = Boolean(files?.ok && files.count > 0);
    const items: PickerItem[] = [
      ...(canCode ? [{ key: 'both', label: 'Restore code and conversation', description: codeNote }] : []),
      { key: 'conversation', label: 'Restore conversation', description: 'Drop this prompt and everything after it' },
      ...(canCode ? [{ key: 'code', label: 'Restore code', description: codeNote }] : []),
      { key: 'cancel', label: 'Never mind' },
    ];
    return (
      <Picker active={active}
        key={target.uuid}
        title="Rewind"
        subtitle={`To before: ${firstLine(target.prompt)}${canCode ? '' : `  (code: ${codeNote})`}`}
        items={items}
        onSelect={(i) => (i.key === 'cancel' ? setTarget(null) : rewind(i.key as RewindMode))}
        onCancel={() => setTarget(null)}
        hint="↑↓ move · ⏎ select · esc back"
      />
    );
  }
  const items: PickerItem[] = (targets ?? []).map((t) => ({ key: t.uuid, label: firstLine(t.prompt).slice(0, 100), description: `tab ${t.tabId}` }));
  return (
    <Picker active={active}
      title="Rewind to before a prompt"
      subtitle={error || (targets ? undefined : 'Loading…')}
      items={items}
      onSelect={(i) => setTarget(targets!.find((t) => t.uuid === i.key) ?? null)}
      onCancel={close}
      empty="No prompts to rewind to yet"
    />
  );
}

type Artifact = { url: string; title: string; tabId: number };

export const taskKind = (type: string) => (type === 'local_bash' ? 'shell' : type.replace(/^local_/, '').replace(/_/g, ' '));

/** "agent · tab 1 · 12h 3m" */
export function taskMeta(t: BackgroundTask, now: number): string {
  return [taskKind(t.type), t.tabId !== undefined && `tab ${t.tabId}`, t.startedAt !== undefined && elapsed(Math.max(0, now - t.startedAt))].filter(Boolean).join(' · ');
}

/** A command's output as plain lines: escape sequences out, and of a line a progress bar redrew with \r, what shows last. */
export function plainLines(output: string): string[] {
  const lines = output
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .split('\n')
    .map((l) => (l.split('\r').filter(Boolean).pop() ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

function findCall(tabs: WireTab[], id: string): ToolBlock | undefined {
  const find = (blocks: WireBlock[]): ToolBlock | undefined => {
    for (const b of blocks) {
      if (b.kind !== 'tool_use') continue;
      if (b.id === id) return b;
      const hit = find(b.children);
      if (hit) return hit;
    }
    return undefined;
  };
  for (const tab of tabs) for (const turn of [tab, ...tab.earlier]) {
    const hit = find(turn.blocks);
    if (hit) return hit;
  }
  return undefined;
}

const DETAIL_LINES = 14;

// Under the /tasks list: the highlighted task's latest output. A shell's or
// monitor's comes from the host every second; an agent's is its latest steps.
const AGENT_MARK: Record<string, string> = { done: '✓', start: '◐', error: '✗', failed: '✗' };

// A workflow's phases, each with its agents: done, running, or waiting.
function WorkflowDetail({ task, onStop }: { task: BackgroundTask; onStop: () => void }) {
  const run = task.workflow;
  return (
    <div className="task-detail">
      <div className="task-detail-head">
        <span>
          Phases{task.progress && <span className="note"> · {task.progress}</span>}
        </span>
        <button onClick={onStop}>Stop</button>
      </div>
      <div className="wf-progress">
        {run?.phases.length ? (
          run.phases.map((phase) => (
            <div key={phase} className="wf-phase">
              <div className="wf-phase-title">{phase}</div>
              {run.agents
                .filter((a) => a.phase === phase)
                .map((a, i) => (
                  <div key={i} className={`wf-agent ${a.state}`}>
                    <span className="mark">{AGENT_MARK[a.state] ?? '·'}</span> {a.label}
                    <span className="meta">
                      {[a.model?.replace(/^claude-/, ''), a.durationMs !== undefined && `${(a.durationMs / 1000).toFixed(1)}s`, a.result && `→ ${a.result.replace(/\s+/g, ' ').slice(0, 80)}`].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                ))}
            </div>
          ))
        ) : (
          <div className="note">No phase started yet</div>
        )}
      </div>
    </div>
  );
}

function TaskDetail(props: { conn: string; task: BackgroundTask; tabs: WireTab[]; cwd: string; onStop: () => void }) {
  if (props.task.type === 'local_workflow') return <WorkflowDetail task={props.task} onStop={props.onStop} />;
  return <OutputDetail {...props} />;
}

function OutputDetail({ conn, task, tabs, cwd, onStop }: { conn: string; task: BackgroundTask; tabs: WireTab[]; cwd: string; onStop: () => void }) {
  const agent = task.type === 'local_agent';
  const [shell, setShell] = useState<{ lines: string[]; note: string } | null>(null);
  useEffect(() => {
    if (agent) return;
    let live = true;
    const read = () =>
      request(conn, 'task_output', { taskId: task.id })
        .then((r) => live && setShell({ lines: plainLines(String(r.output ?? '')), note: r.truncated ? `last 8 KB of ${Math.round(Number(r.totalBytes) / 1024)} KB` : '' }))
        .catch((e) => live && setShell({ lines: [], note: errText(e) }));
    void read();
    const t = setInterval(read, 1000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [conn, task.id, agent]);

  let lines: string[];
  let note = '';
  if (agent) {
    const call = task.toolUseId ? findCall(tabs, task.toolUseId) : undefined;
    lines = (call?.children ?? []).flatMap((b) => {
      if (b.kind === 'tool_use') return [`⏺ ${toolLine(b, cwd)}`];
      if (b.kind === 'text') return b.text.trim() ? [b.text.trim().split('\n')[0]] : [];
      return [];
    });
    note = task.progress ?? '';
  } else {
    lines = shell?.lines ?? [];
    note = shell ? shell.note : 'Reading its output…';
  }
  const shown = lines.slice(-DETAIL_LINES);
  return (
    <div className="task-detail">
      <div className="task-detail-head">
        <span>
          {agent ? 'Latest steps' : 'Output'}
          {note && <span className="note"> · {note}</span>}
        </span>
        <button onClick={onStop}>Stop</button>
      </div>
      <pre className="task-output">{shown.length ? shown.join('\n') : agent ? 'No steps yet' : shell ? 'No output yet' : ' '}</pre>
    </div>
  );
}

// /tasks: background shells and agents still running, with the highlighted
// one's output under the list. Enter goes to the tab that started it, x stops it.
export function TasksPanel({ conn, close, active, tasks, tabs, cwd, initial, onGoTo }: Common & { tasks: BackgroundTask[]; tabs: WireTab[]; cwd: string; initial?: string; onGoTo: (tabId: number) => void }) {
  const now = Date.now();
  const items: PickerItem[] = tasks.map((t) => ({ key: t.id, label: t.description, description: taskMeta(t, now), mark: '◷' }));
  const find = (item: PickerItem | undefined) => tasks.find((t) => t.id === item?.key);
  const stop = (t: BackgroundTask) =>
    request(conn, 'stop_task', { taskId: t.id })
      .then(() => toast(`Stopped ${t.description}`))
      .catch((e) => toast(errText(e), true));
  return (
    <Picker
      active={active}
      title="Background tasks"
      items={items}
      initial={Math.max(0, tasks.findIndex((t) => t.id === initial))}
      empty="No background tasks running"
      onCancel={close}
      onSelect={(item) => {
        const t = find(item);
        if (t?.tabId === undefined) return;
        onGoTo(t.tabId);
        close();
      }}
      onKey={(e, item) => {
        const t = find(item);
        if (e.key !== 'x' || e.metaKey || e.ctrlKey || !t) return false;
        void stop(t);
        return true;
      }}
      detail={(item) => {
        const t = find(item);
        return t ? <TaskDetail key={t.id} conn={conn} task={t} tabs={tabs} cwd={cwd} onStop={() => void stop(t)} /> : null;
      }}
      hint="↑↓ move · ⏎ go to its tab · x stop it · esc close"
    />
  );
}

type ContextUsage = { categories: { name: string; tokens: number; kind: string }[]; totalTokens: number; maxTokens: number; percentage: number };

/** What the context holds, by category, as Claude Code's /context counts it. */
export function ContextPanel({ conn, close, active }: Common) {
  const [usage, setUsage] = useState<ContextUsage | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    request(conn, 'context_usage')
      .then((r) => setUsage(r as unknown as ContextUsage))
      .catch((e) => setError(errText(e)));
  }, [conn]);
  const share = (n: number) => (usage?.maxTokens ? `${((n / usage.maxTokens) * 100).toFixed(1)}%` : '');
  const items: PickerItem[] = (usage?.categories ?? [])
    .filter((c) => c.tokens > 0)
    .map((c) => ({ key: c.name, label: c.name, description: [`${fmtTokens(c.tokens)} tokens`, c.kind === 'deferred' ? 'loaded when used' : share(c.tokens)].filter(Boolean).join(' · ') }));
  return (
    <Picker active={active}
      title={usage ? `Context: ${fmtTokens(usage.totalTokens)} of ${fmtTokens(usage.maxTokens)} tokens (${usage.percentage}%)` : 'Context'}
      subtitle={error || (usage ? undefined : 'Loading…')}
      items={items}
      onSelect={close}
      onCancel={close}
      empty="Nothing to show until the first turn"
      hint="esc close"
    />
  );
}

type InstalledPlugin = { id: string; version?: string; scope?: string; enabled: boolean };
type AvailablePlugin = { pluginId: string; name: string; description?: string; marketplaceName?: string };
type McpRow = { name: string; status: string; scope?: string };

/** /plugins: the installed plugins (enable or disable, uninstall), the marketplaces to install from (typing filters), and the claude.ai connectors. */
export function PluginsPanel({ conn, close, active }: Common) {
  const [installed, setInstalled] = useState<InstalledPlugin[] | null>(null);
  const [available, setAvailable] = useState<AvailablePlugin[] | null>(null);
  const [view, setView] = useState<'top' | 'browse' | 'connectors'>('top');
  const [picked, setPicked] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState('');
  const [connectors, setConnectors] = useState<McpRow[] | null>(null);
  const load = (withAvailable = false) =>
    request(conn, 'plugins', { available: withAvailable }).then(
      (r) => {
        setInstalled((r.installed as InstalledPlugin[]) ?? []);
        if (r.available) setAvailable(r.available as AvailablePlugin[]);
      },
      (e) => toast(errText(e), true),
    );
  useEffect(() => void load(), [conn]);
  const run = (action: string, plugin: string) => {
    setBusy(`${action === 'install' ? 'Installing' : action === 'uninstall' ? 'Uninstalling' : action === 'enable' ? 'Enabling' : 'Disabling'} ${plugin}…`);
    request(conn, 'plugin_action', { action, plugin }).then(
      (r) => {
        setBusy('');
        toast(String(r.message));
        setPicked(null);
        void load(view === 'browse');
      },
      (e) => {
        setBusy('');
        toast(errText(e), true);
      },
    );
  };
  const list = installed ?? [];
  if (view === 'connectors') {
    return (
      <Picker
        key="connectors"
        active={active}
        title="claude.ai connectors"
        subtitle={connectors ? 'From your claude.ai account · /mcp authenticates, reconnects or turns one off' : 'Asking Claude Code…'}
        items={(connectors ?? []).map((s) => ({ key: s.name, label: s.name.replace(/^claude\.ai /, ''), description: s.status, mark: '●', markColor: s.status === 'connected' ? 'var(--green)' : s.status === 'failed' ? 'var(--red)' : 'var(--gold)' }))}
        empty={connectors ? 'No claude.ai connectors in this session' : 'Asking Claude Code…'}
        onSelect={() => toast('/mcp authenticates, reconnects or turns off a connector')}
        onCancel={() => setView('top')}
      />
    );
  }
  if (view === 'browse') {
    const have = new Set(list.map((p) => p.id));
    const q = query.toLowerCase();
    const rows = (available ?? []).filter((p) => !have.has(p.pluginId) && (!q || `${p.name} ${p.description ?? ''} ${p.marketplaceName ?? ''}`.toLowerCase().includes(q))).slice(0, 300);
    return (
      <Picker
        key="browse"
        active={active}
        title="Install a plugin"
        subtitle={busy || (available ? `${available.length} in your marketplaces · Enter installs it (user scope)` : 'Reading the marketplaces…')}
        items={rows.map((p) => ({ key: p.pluginId, label: p.name, description: `${p.marketplaceName ?? ''}${p.description ? `: ${p.description.replace(/\s+/g, ' ')}` : ''}` }))}
        search={{ query, onChange: setQuery, placeholder: 'Filter by name or description' }}
        empty={available ? 'No plugin matches' : 'Reading the marketplaces…'}
        onSelect={(item) => !busy && run('install', item.key)}
        onCancel={() => setView('top')}
      />
    );
  }
  const plugin = list.find((p) => p.id === picked);
  if (plugin) {
    return (
      <Picker
        key={`plugin:${plugin.id}`}
        active={active}
        title={plugin.id}
        subtitle={busy || `${plugin.enabled ? 'Enabled' : 'Disabled'} · ${plugin.scope ?? 'user'} scope${plugin.version ? ` · ${plugin.version}` : ''}`}
        items={[
          { key: plugin.enabled ? 'disable' : 'enable', label: plugin.enabled ? 'Disable' : 'Enable', description: plugin.enabled ? 'Keeps it installed, off' : 'Turns it on again' },
          { key: 'uninstall', label: 'Uninstall', description: 'Removes it' },
        ]}
        onSelect={(item) => !busy && run(item.key, plugin.id)}
        onCancel={() => setPicked(null)}
      />
    );
  }
  return (
    <Picker
      key="plugins"
      active={active}
      title="Plugins"
      subtitle={busy || (installed ? `${list.length} installed (${list.filter((p) => p.enabled).length} enabled)` : 'Asking Claude Code…')}
      items={[
        { key: '__browse', label: 'Install a plugin…', description: 'From your marketplaces' },
        { key: '__connectors', label: 'claude.ai connectors…', description: 'The ones this session has' },
        ...list.map((p) => ({ key: p.id, label: p.id, description: `${p.enabled ? 'Enabled' : 'Disabled'} · ${p.scope ?? 'user'}${p.version ? ` · ${p.version}` : ''}`, mark: p.enabled ? '●' : '○', markColor: p.enabled ? 'var(--green)' : 'var(--text-dim)' })),
      ]}
      onSelect={(item) => {
        if (item.key === '__browse') {
          setView('browse');
          if (!available) void load(true);
        } else if (item.key === '__connectors') {
          setView('connectors');
          request(conn, 'mcp_status').then(
            (r) => setConnectors(((r.servers as McpRow[]) ?? []).filter((s) => s.scope === 'claudeai')),
            (e) => toast(errText(e), true),
          );
        } else setPicked(item.key);
      }}
      onCancel={close}
    />
  );
}

type Task = { id: string; name: string; prompt: string; cwd: string; when: string; describe: string; next: number | null; paused?: boolean; lastRun: TaskRun | null };
type TaskRun = { scheduleId: string; name: string; at: number; sessionId?: string; error?: string; manual?: boolean };

/** "today 09:00", "Wed 09:00", "Nov 30 09:00" (bindertui's whenText). */
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

/** /schedule: this Mac's scheduled tasks; one opens its actions, and a run opens its session. */
export function SchedulePanel({ close, active }: Common) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [runs, setRuns] = useState<TaskRun[] | null>(null);
  const off = useApp((st) => !st.schedules);
  const load = () => window.binder.schedule(['list']).then((t) => setTasks(t as Task[]), (e) => toast(errText(e), true));
  useEffect(() => void load(), []);
  const task = tasks?.find((t) => t.id === picked);
  if (runs && task) {
    return (
      <Picker
        key={`runs:${task.id}`}
        active={active}
        title={`Runs: ${task.name}`}
        subtitle="Enter opens a run's session"
        items={runs.length ? runs.map((r, i) => ({ key: String(i), label: whenText(r.at), description: r.error ? `Failed: ${r.error}` : `${r.manual ? 'Run by hand · ' : ''}session ${r.sessionId?.slice(0, 8)}`, mark: r.error ? '✗' : '✓', markColor: r.error ? 'var(--red)' : 'var(--green)' })) : [{ key: 'none', label: 'No runs yet' }]}
        onSelect={(item) => {
          const r = runs[Number(item.key)];
          if (!r?.sessionId) return;
          openSession({ sessionId: r.sessionId, cwd: task.cwd, resume: true, title: task.name });
          close();
        }}
        onCancel={() => setRuns(null)}
      />
    );
  }
  if (task) {
    const act = (key: string) => {
      if (key === 'runs') return void window.binder.schedule(['history', task.id]).then((r) => setRuns(r as TaskRun[]), (e) => toast(errText(e), true));
      if (key === 'run') toast(`Starting ${task.name}…`);
      const sub = key === 'pause' ? (task.paused ? 'resume' : 'pause') : key === 'delete' ? 'remove' : 'run';
      window.binder.schedule([sub, task.id]).then(
        (r) => {
          const run = r as TaskRun;
          if (sub === 'run') toast(run.error ? `${task.name} did not start: ${run.error}` : `${task.name} is running (Runs opens it)`, Boolean(run.error));
          else toast(sub === 'remove' ? `Deleted ${task.name}` : `${task.name} ${sub === 'pause' ? 'paused' : 'resumed'}`);
          if (sub === 'remove') setPicked(null);
          void load();
        },
        (e) => toast(errText(e), true),
      );
    };
    return (
      <Picker
        key={`task:${task.id}`}
        active={active}
        title={task.name}
        subtitle={`${task.describe} in ${shortPath(task.cwd)}: ${task.prompt}`}
        items={[
          { key: 'run', label: 'Run it now', description: 'In a fresh session, as on schedule' },
          { key: 'pause', label: task.paused ? 'Resume' : 'Pause', description: task.paused ? 'Runs on schedule again' : 'Skips its runs until resumed' },
          { key: 'runs', label: 'Runs', description: task.lastRun ? `Last ${whenText(task.lastRun.at)}${task.lastRun.error ? ' (failed)' : ''}` : 'None yet' },
          { key: 'delete', label: 'Delete', description: 'Its runs stay as sessions' },
        ]}
        onSelect={(item) => act(item.key)}
        onCancel={() => setPicked(null)}
      />
    );
  }
  return (
    <Picker
      key="tasks"
      active={active}
      title="Scheduled tasks"
      subtitle={off ? 'Off in config.json (schedules): none runs' : 'They run on this Mac while the app (or binder) is open · /schedule <when> <prompt> adds one'}
      items={
        !tasks
          ? []
          : tasks.length
            ? tasks.map((t) => ({ key: t.id, label: t.name, description: `${t.describe} · ${t.paused ? 'paused' : t.next ? `next ${whenText(t.next)}` : 'never'}${t.lastRun ? ` · last ${whenText(t.lastRun.at)}${t.lastRun.error ? ' (failed)' : ''}` : ''}`, mark: t.paused ? '⏸' : '⏲' }))
            : [{ key: 'none', label: 'None yet', description: 'e.g. /schedule weekdays 9:00 Summarize what changed yesterday' }]
      }
      empty="Reading the tasks…"
      onSelect={(item) => item.key !== 'none' && setPicked(item.key)}
      onCancel={close}
    />
  );
}

/** /findings: the latest code review's findings; Enter asks Claude to fix one, or all, in the review's tab. */
export function FindingsPanel({ conn, close, active, review }: Common & { review: { tabId: number; turn: number; findings: Finding[] } | null }) {
  if (!review) return <Picker active={active} title="Findings" subtitle="No code review in this session yet: /code-review runs one" items={[{ key: 'close', label: 'Close' }]} onSelect={close} onCancel={close} />;
  const { findings, tabId, turn } = review;
  const counts = severityCounts(findings);
  const items: PickerItem[] = [
    { key: 'all', label: 'Apply fixes', description: `Ask Claude to fix all ${findings.length} in one prompt` },
    ...findings.map((f, i) => ({ key: String(i), label: findingPlace(f), description: `${f.severity ? `${severityName(f.severity)}: ` : ''}${f.summary.replace(/\s+/g, ' ')}` })),
  ];
  const pick = (item: PickerItem) => {
    void askToFix({ conn, tabId, turn }, item.key === 'all' ? findings : [findings[Number(item.key)]]);
    close();
  };
  return <Picker active={active} title={`Findings: ${findings.length}${counts ? ` (${counts})` : ''}`} subtitle="Enter asks Claude to fix it, in the review's tab" items={items} onSelect={pick} onCancel={close} />;
}

/** /pr: the branch's pull request; open it, fix what failed, merge when ready, or look again. */
export function PrPanel({ conn, close, active, pr }: Common & { pr: PrStatus | null }) {
  const [busy, setBusy] = useState('');
  const run = (t: string, then?: () => void) => {
    setBusy(t === 'pr' ? 'Looking…' : 'Asking…');
    request(conn, t)
      .then((r) => {
        setBusy('');
        if (typeof r.message === 'string') toast(r.message);
        then?.();
      })
      .catch((e) => {
        setBusy('');
        toast(errText(e), true);
      });
  };
  if (!pr) return <Picker active={active} title="Pull request" subtitle={busy || 'No pull request for this branch (or gh cannot see one)'} items={[{ key: 'refresh', label: 'Look again' }]} onSelect={() => run('pr')} onCancel={close} />;
  const failing = pr.checks.failing.length > 0;
  const items: PickerItem[] = [
    { key: 'open', label: 'Open it in the browser', description: pr.url },
    ...(pr.state === 'OPEN' && (failing || pr.changesRequested) ? [{ key: 'fix', label: failing ? 'Fix the failing checks' : 'Address the review', description: failing ? pr.checks.failing.join(', ') : `Changes asked for by ${pr.changesRequested!.by}` }] : []),
    ...(pr.state === 'OPEN' ? [{ key: 'merge', label: 'Merge when ready', description: 'Squash, once its checks pass and it is approved (gh pr merge --auto)' }] : []),
    { key: 'refresh', label: 'Look again', description: 'binder looks every minute, and after each turn' },
  ];
  const pick = (item: PickerItem) => {
    if (item.key === 'open') return void window.binder.openExternal(pr.url);
    if (item.key === 'fix') return run('pr_fix', close);
    if (item.key === 'merge') return run('pr_merge', close);
    run('pr');
  };
  return <Picker active={active} title={`PR #${pr.number}: ${pr.title}`} subtitle={busy || prLine(pr)} items={items} onSelect={pick} onCancel={close} />;
}

/** /files: the files the tab's tool calls named; ⏎ opens one in config.json's editor, f shows it in Finder. */
export function FilesPanel({ close, active, tab, cwd, local }: Common & { tab: WireTab; cwd: string; local: boolean }) {
  const files = useMemo(() => tabFiles(tab), [tab]);
  const items: PickerItem[] = files.map((f) => ({ key: f.path, label: f.path.startsWith(cwd + '/') ? f.path.slice(cwd.length + 1) : f.path, description: `${f.tool}${f.line ? ` · line ${f.line}` : ''}` }));
  const act = (path: string, how: 'edit' | 'reveal') => {
    if (!local) return toast("The files are on the session's computer", true);
    window.binder
      .openPath(path, cwd, how, files.find((f) => f.path === path)?.line)
      .then(() => toast(`${how === 'reveal' ? 'Showed' : 'Opened'} ${path}`))
      .catch((e) => toast(errText(e), true));
  };
  return (
    <Picker
      active={active}
      title="Files in this tab"
      subtitle="⏎ opens in your editor (Settings, ⌘,, changes it)"
      items={items}
      onSelect={(i) => act(i.key, 'edit')}
      onCancel={close}
      empty="No tool call in this tab named a file"
      hint="↑↓ move · ⏎ open · f show in Finder · c copy the path · esc close"
      onKey={(e, item) => {
        if (!item || e.metaKey || e.ctrlKey) return false;
        if (e.key === 'f') return act(item.key, 'reveal'), true;
        if (e.key === 'c') {
          const full = resolveFile(item.key, cwd, window.binder.home);
          return void window.binder.copyText(full), toast(`Copied ${full}`), true;
        }
        return false;
      }}
    />
  );
}

export function ArtifactsPanel({ conn, close, active }: Common) {
  const [list, setList] = useState<Artifact[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    request(conn, 'artifacts')
      .then((r) => setList(((r.artifacts as Artifact[]) ?? []).slice().reverse()))
      .catch((e) => setError(errText(e)));
  }, [conn]);
  const items: PickerItem[] = (list ?? []).map((a) => ({ key: a.url, label: a.title, description: `${a.url} · tab ${a.tabId}` }));
  const open = (url: string) => {
    close();
    void openLink(url);
  };
  return (
    <Picker active={active}
      title="Artifacts in this session"
      subtitle={error || (list ? undefined : 'Loading…')}
      items={items}
      onSelect={(i) => open(i.key)}
      onCancel={close}
      empty="No artifacts published in this session yet"
      hint="↑↓ move · ⏎ or o open · c copy the link · esc close"
      onKey={(e, item) => {
        if (!item || e.metaKey || e.ctrlKey) return false;
        if (e.key === 'o') return open(item.key), true;
        if (e.key === 'c') return void window.binder.copyText(item.key), toast(`Copied ${item.key}`), true;
        return false;
      }}
    />
  );
}

/** Ctrl+]: the newest artifact published in the session. */
export async function openLatestArtifact(conn: string): Promise<void> {
  try {
    const list = ((await request(conn, 'artifacts')).artifacts as Artifact[]) ?? [];
    const latest = list.at(-1);
    if (!latest) return toast('No artifact published in this session yet');
    await openLink(latest.url);
  } catch (e) {
    toast(errText(e), true);
  }
}
