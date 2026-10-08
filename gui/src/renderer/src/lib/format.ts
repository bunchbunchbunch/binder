// Small text helpers shared by the views.

const home = () => (typeof window !== 'undefined' && window.binder?.home) || '';

/** A path relative to `cwd` when inside it, else with ~ for the home folder. */
export function shortPath(p: string, cwd?: string): string {
  if (cwd && p.startsWith(cwd + '/')) return p.slice(cwd.length + 1);
  const h = home();
  return h && (p === h || p.startsWith(h + '/')) ? '~' + p.slice(h.length) : p;
}

export const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

export function ago(when: string | number): string {
  const ms = typeof when === 'number' ? when : Date.parse(when);
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

// "claude-opus-5-5" -> "Opus 5.5", as bindertui's status line names it.
export function modelDisplayName(modelId: string | null | undefined): string {
  if (!modelId) return '';
  const parts = modelId.replace(/^claude-/, '').split('-');
  const family = parts.shift() ?? '';
  const version = parts.filter((p) => /^\d{1,2}$/.test(p)).join('.');
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return version ? `${name} ${version}` : name || modelId;
}

export function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
}

export function fmtDuration(ms: number): string {
  return ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
}

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n);
}

export const firstLine = (s: string) => s.split('\n').find((l) => l.trim())?.trim() ?? '';

export function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}
