import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const FAKE_BIN = join(here, 'fakeClaude.mjs');
export const FAKE_CODEX = join(here, 'fakeCodex.mjs');
export const FIXTURES = join(here, '..', 'fixtures');

export function fakeEnv(fixture: string, extra: Record<string, string> = {}) {
  return { ...process.env, BINDER_FAKE_FIXTURE: join(FIXTURES, fixture), ...extra };
}

// The 24-bit foreground color (as #RRGGBB) of each visible character in an
// ANSI string, for checking per-letter colors.
export function colorsOf(s: string): { ch: string; fg?: string }[] {
  const out: { ch: string; fg?: string }[] = [];
  let fg: string | undefined;
  for (const m of s.matchAll(/\x1b\[([0-9;]*)m|([^\x1b])/g)) {
    if (m[2] !== undefined) {
      out.push({ ch: m[2], fg });
      continue;
    }
    const p = m[1].split(';');
    if (p[0] === '38' && p[1] === '2') fg = '#' + p.slice(2, 5).map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase();
    else if (p[0] === '39') fg = undefined;
  }
  return out;
}

// The colors of the characters of `word` where it first appears in `s`.
export function wordColors(s: string, word: string): (string | undefined)[] {
  const chars = colorsOf(s);
  const at = chars.map((c) => c.ch).join('').indexOf(word);
  return at < 0 ? [] : chars.slice(at, at + word.length).map((c) => c.fg);
}
