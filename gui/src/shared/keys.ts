// The window-wide ⌘ keys: ⌘N, ⌘K, ⌘,, ⌘/, ⌘W, ⌘1-9, ⌘⇧[ ], ⌃⌘S. The window
// acts on them (components/App.tsx). A web pane's page gets the keys while it
// has focus, so the main process takes these from it and passes them on
// (main/webPanes.ts).

/** A key press, as a DOM keydown and Electron's before-input-event both give it. */
export type KeyDesc = { code: string; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean };

// A number is ⌘1-9.
export type AppKey = 'sidebar' | 'new' | 'switcher' | 'settings' | 'guide' | 'close' | 'prev' | 'next' | number;

const PLAIN: Record<string, AppKey> = { KeyN: 'new', KeyK: 'switcher', Comma: 'settings', Slash: 'guide', KeyW: 'close' };

/** What `k` does window-wide, or null when it is not one of the window's keys. */
export function appKey(k: KeyDesc): AppKey | null {
  if (k.meta && k.ctrl && !k.alt && k.code === 'KeyS') return 'sidebar';
  if (!k.meta || k.ctrl || k.alt) return null;
  if (k.shift) return k.code === 'BracketLeft' ? 'prev' : k.code === 'BracketRight' ? 'next' : null;
  if (/^Digit[1-9]$/.test(k.code)) return Number(k.code.slice(5));
  return PLAIN[k.code] ?? null;
}
