import { describe, it, expect, beforeEach } from 'vitest';
import { appendFileSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchSessions, sessionText } from '../src/search.js';
import { archivedIds, setArchived } from '../src/archive.js';

const line = (o: object) => JSON.stringify(o) + '\n';

describe('full-text search', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'binder-search-'));
    process.env.BINDER_STATE_DIR = join(dir, 'state');
  });

  it("keeps prompts and Claude's text, not tool output, meta lines or other agents'", () => {
    const raw =
      line({ type: 'user', message: { content: 'fix the PARSER' } }) +
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Found the off-by-one.' }, { type: 'tool_use', name: 'Bash', input: { command: 'secretcmd' } }] } }) +
      line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'tool output zebra' }] } }) +
      line({ type: 'user', isMeta: true, message: { content: 'meta caveat' } }) +
      line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent words' }] } }) +
      line({ type: 'hc_prompt', prompt: 'binder prompt', tabId: 1 });
    expect(sessionText(raw)).toBe('fix the PARSER\nFound the off-by-one.\nbinder prompt');
  });

  it('finds what was said, with the text around it, and reads the cache until the transcript changes', async () => {
    const a = join(dir, 'a.jsonl');
    const b = join(dir, 'b.jsonl');
    writeFileSync(a, line({ type: 'user', message: { content: 'hello' } }) + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'The flamingo migration is done and tested.' }] } }));
    writeFileSync(b, line({ type: 'user', message: { content: 'nothing here' } }));
    const sessions = [{ id: 'a', path: a }, { id: 'b', path: b }];
    expect(await searchSessions(sessions, 'FLAMINGO')).toEqual([{ id: 'a', snippet: 'hello The flamingo migration is done and tested.' }]);
    // A transcript that grows is read again.
    appendFileSync(b, line({ type: 'assistant', message: { content: [{ type: 'text', text: 'a flamingo too' }] } }));
    utimesSync(b, new Date(), new Date(Date.now() + 5000));
    expect((await searchSessions(sessions, 'flamingo')).map((h) => h.id)).toEqual(['a', 'b']);
    expect(await searchSessions(sessions, 'zebra')).toEqual([]);
  });

  it('archives and unarchives a session by id', () => {
    setArchived('s1', true);
    setArchived('s2', true);
    setArchived('s1', false);
    expect([...archivedIds()]).toEqual(['s2']);
  });
});
