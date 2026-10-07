import type { Block, Tab } from './store.js';

// Artifacts the model published in this session (the Artifact tool's links),
// for /artifacts and Ctrl+].

export type ArtifactRef = { url: string; title: string; tabId: number };

const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+/g;

function titleOf(input: unknown): string {
  const i = (input ?? {}) as { title?: unknown; file_path?: unknown };
  if (typeof i.title === 'string' && i.title) return i.title;
  if (typeof i.file_path === 'string' && i.file_path) return i.file_path.split('/').pop() ?? i.file_path;
  return 'artifact';
}

function scan(blocks: Block[], tabId: number, out: ArtifactRef[]): void {
  for (const b of blocks) {
    if (b.kind === 'tool_use') {
      if (b.result) for (const url of b.result.content.match(ARTIFACT_URL) ?? []) out.push({ url, title: titleOf(b.input), tabId });
      scan(b.children, tabId, out);
    } else if (b.kind === 'text') {
      for (const url of b.text.match(ARTIFACT_URL) ?? []) out.push({ url, title: 'artifact', tabId });
    }
  }
}

// Oldest first, one entry per link (the first mention names it).
export function sessionArtifacts(tabs: Tab[]): ArtifactRef[] {
  const all: ArtifactRef[] = [];
  for (const tab of tabs) for (const turn of [...tab.earlier, tab]) scan(turn.blocks, tab.id, all);
  const seen = new Map<string, ArtifactRef>();
  for (const a of all) if (!seen.has(a.url)) seen.set(a.url, a);
  return [...seen.values()];
}
