import { useEffect, useMemo, useState } from 'react';
import { firstLine, modelDisplayName } from '../lib/format';
import { errText, request, toast } from '../store';
import { Picker, type PickerItem } from '../components/Picker';

// binder's own panels for one session, over its transcript: /model, /effort,
// /mcp, /chrome, /rewind and /artifacts. Each talks to the session's host.

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
    void window.binder.openExternal(url);
    toast(`Opened ${url}`);
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
    void window.binder.openExternal(latest.url);
    toast(`Opened ${latest.url}`);
  } catch (e) {
    toast(errText(e), true);
  }
}
