import type { PreviewEvent } from '@shared/api';
import { previewTarget, serverUrl } from '@shared/preview';
import { errText, getState, request, setState, toast, type Conn } from '../store';

// The preview pane's state (/preview), per session: its page and what its
// console said, and the dev server binder started for it. The page is drawn by
// the main process (main/preview.ts); components/PreviewPane.tsx holds its place.

export type PreviewState = {
  url: string | null;
  title: string | null;
  error: string | null;
  loading: boolean;
  console: { level: string; message: string; source: string }[];
  server: { command: string; status: 'running' | 'exited'; output: string; code?: number } | null;
};

const CONSOLE_KEPT = 50;
const OUTPUT_KEPT = 64 * 1024;

function update(conn: string, fn: (p: PreviewState) => PreviewState): void {
  setState((s) => {
    const p = s.previews[conn];
    return p ? { previews: { ...s.previews, [conn]: fn(p) } } : {};
  });
}

const fresh = (): PreviewState => ({ url: null, title: null, error: null, loading: false, console: [], server: null });

function load(conn: string, url: string): void {
  update(conn, (p) => ({ ...p, url, error: null, console: [] }));
  window.binder.previewOpen(conn, url).catch((e) => update(conn, (p) => ({ ...p, error: errText(e) })));
}

/** /preview [url | port | command]: the session's page beside it, starting its dev server when given (or found) a command. */
export async function openPreview(c: Conn, arg: string): Promise<void> {
  if (c.computer) return toast('The preview runs on this Mac: open it from a session here', true);
  const cwd = c.state?.cwd ?? c.cwd;
  let target = previewTarget(arg);
  const open = getState().previews[c.id];
  if (!target && open) return; // already beside the session
  if (!target) {
    const command = await window.binder.previewCommand(cwd);
    if (!command) return toast('No dev script in package.json: /preview <url, port or command>', true);
    target = { command };
  }
  setState((s) => ({ previews: { ...s.previews, [c.id]: s.previews[c.id] ?? fresh() } }));
  if ('url' in target) return load(c.id, target.url);
  window.binder.previewServerStop(c.id);
  const command = target.command;
  update(c.id, (p) => ({ ...p, url: null, server: { command, status: 'running', output: '' } }));
  try {
    const before = await window.binder.previewServerStart(c.id, cwd, command, 120, 30);
    if (before) serverOutput(c.id, before);
  } catch (e) {
    update(c.id, (p) => ({ ...p, server: { command, status: 'exited', output: errText(e) } }));
  }
}

// The server's output: kept for its log, and read for the address to open.
function serverOutput(conn: string, data: string): void {
  const p = getState().previews[conn];
  if (!p?.server) return;
  const output = (p.server.output + data).slice(-OUTPUT_KEPT);
  update(conn, (x) => ({ ...x, server: x.server && { ...x.server, output } }));
  const url = p.url ? null : serverUrl(output);
  if (url) load(conn, url);
}

export function closePreviewOf(conn: string): void {
  window.binder.previewServerStop(conn);
  window.binder.previewClose(conn);
  setState((s) => {
    const { [conn]: _gone, ...rest } = s.previews;
    return { previews: rest };
  });
}

/** "Show Claude": the page as it looks now, and what its console said, into the session's current tab. */
export async function showClaude(c: Conn): Promise<void> {
  const p = getState().previews[c.id];
  if (!p?.url) return toast('Nothing in the preview yet', true);
  try {
    const shot = await window.binder.previewCapture(c.id);
    const errors = p.console.filter((m) => m.level === 'error');
    const lines = errors.slice(-10).map((m) => `- ${m.message}${m.source ? ` (${m.source})` : ''}`);
    const text = `Here is the preview of ${p.url} as it looks now (${shot.width}×${shot.height})${lines.length ? `. Its console logged ${errors.length} error${errors.length === 1 ? '' : 's'}:\n${lines.join('\n')}` : ', with no console errors'}.\n\nCheck that it shows what you changed, and fix anything that is wrong.`;
    const tabId = c.activeTab ?? c.state?.tabs.at(-1)?.id;
    await request(c.id, 'send', { text, images: [{ mediaType: 'image/png', data: shot.data }], ...(tabId !== undefined && { tabId }) });
    toast('Sent the preview to Claude');
  } catch (e) {
    toast(errText(e), true);
  }
}

window.binder.onPreview((conn: string, e: PreviewEvent) => {
  if (e.t === 'url') update(conn, (p) => ({ ...p, url: e.url, error: null }));
  else if (e.t === 'title') update(conn, (p) => ({ ...p, title: e.title, loading: false }));
  // Each load starts its console afresh.
  else if (e.t === 'loading') update(conn, (p) => ({ ...p, loading: true, console: [] }));
  else if (e.t === 'failed') update(conn, (p) => ({ ...p, error: e.error, loading: false }));
  else update(conn, (p) => ({ ...p, console: [...p.console, { level: e.level, message: e.message, source: e.source }].slice(-CONSOLE_KEPT) }));
});

window.binder.onPane((name, e) => {
  if (!name.startsWith('preview:')) return;
  const conn = name.slice(8);
  if (e.t === 'data') serverOutput(conn, e.data);
  else update(conn, (p) => ({ ...p, server: p.server && { ...p.server, status: 'exited', code: e.code } }));
});
