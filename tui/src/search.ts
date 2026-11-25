import { mkdirSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stateDir, STATE_FILE_MODE } from './paths.js';
import { promptText } from './transcripts.js';

// Full-text search over sessions: what was said in each (the prompts and
// Claude's replies, not tool output, which is most of a transcript), kept as
// plain text in binder's state dir and made again only when the transcript
// changes, so a search after the first reads little.

export type Searchable = { id: string; path: string };
export type Hit = { id: string; snippet: string };

type Entry = { path: string; mtimeMs: number; size: number };

const dir = () => join(stateDir(), 'search');
const indexFile = () => join(dir(), 'index.json');

// The text of one transcript line: a prompt (Claude Code's, or binder's
// hc_prompt in its own event log) or Claude's text.
function lineText(line: string): string {
  if (!line.includes('"text"') && !line.includes('"hc_prompt"') && !line.includes('"content":"')) return '';
  let e: { type?: string; isMeta?: boolean; isSidechain?: boolean; prompt?: unknown; message?: { content?: unknown } };
  try {
    e = JSON.parse(line);
  } catch {
    return '';
  }
  if (e.type === 'hc_prompt' && typeof e.prompt === 'string') return e.prompt;
  if (e.isMeta || e.isSidechain) return '';
  if (e.type === 'user') return promptText(e.message?.content) ?? '';
  if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
    return (e.message.content as Array<{ type?: string; text?: unknown }>).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n');
  }
  return '';
}

export function sessionText(raw: string): string {
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const t = lineText(line);
    if (t.trim()) out.push(t);
  }
  return out.join('\n');
}

async function readIndex(): Promise<Record<string, Entry>> {
  try {
    return JSON.parse(await readFile(indexFile(), 'utf8'));
  } catch {
    return {};
  }
}

// A session's searchable text, made again when its transcript changed.
async function textOf(s: Searchable, index: Record<string, Entry>): Promise<{ text: string; changed: boolean } | null> {
  let st;
  try {
    st = await stat(s.path);
  } catch {
    return null;
  }
  const cached = join(dir(), `${s.id}.txt`);
  const known = index[s.id];
  if (known && known.path === s.path && known.mtimeMs === st.mtimeMs && known.size === st.size) {
    try {
      return { text: await readFile(cached, 'utf8'), changed: false };
    } catch {
      // gone: made again below
    }
  }
  const text = sessionText(await readFile(s.path, 'utf8'));
  await writeFile(cached, text, { mode: STATE_FILE_MODE });
  index[s.id] = { path: s.path, mtimeMs: st.mtimeMs, size: st.size };
  return { text, changed: true };
}

function snippet(text: string, at: number, length: number): string {
  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, at + length + 60);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

/** The sessions whose prompts or replies contain `query` (case aside), in the order given, at most `limit`. */
export async function searchSessions(sessions: Searchable[], query: string, limit = 50): Promise<Hit[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const index = await readIndex();
  const hits: Hit[] = [];
  let changed = false;
  for (const s of sessions) {
    if (hits.length >= limit) break;
    const t = await textOf(s, index);
    if (!t) continue;
    changed ||= t.changed;
    const at = t.text.toLowerCase().indexOf(q);
    if (at >= 0) hits.push({ id: s.id, snippet: snippet(t.text, at, q.length) });
  }
  if (changed) await writeFile(indexFile(), JSON.stringify(index), { mode: STATE_FILE_MODE });
  return hits;
}
