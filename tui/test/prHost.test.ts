import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/session.js';
import { SessionHost } from '../src/host.js';
import { initialState } from '../src/store.js';
import { FAKE_BIN, FIXTURES } from './helpers.js';

// Its own file: binderConfig() is read once per process, and this one turns auto-fix on.
const dir = mkdtempSync(join(tmpdir(), 'binder-prhost-'));
writeFileSync(join(dir, 'config.json'), JSON.stringify({ prAutoFix: true }));
const input = join(dir, 'input.jsonl');
const log = join(dir, 'gh.log');
Object.assign(process.env, {
  BINDER_CONFIG: join(dir, 'config.json'),
  BINDER_GH: join(FIXTURES, '..', 'test', 'fakeGh.mjs'),
  BINDER_FAKE_GH_STATE: join(FIXTURES, 'gh-pr.json'),
  BINDER_FAKE_GH_LOG: log,
  BINDER_STATE_DIR: join(dir, 'state'),
  BINDER_CLAUDE_BIN: FAKE_BIN,
  BINDER_FAKE_FIXTURE: join(FIXTURES, 'two-turns-stdin.jsonl'),
  BINDER_FAKE_INPUT_OUT: input,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 8000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await sleep(25);
  }
}
const prompts = () => (existsSync(input) ? readFileSync(input, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.type === 'user').map((m) => String(m.message.content)) : []);

describe('PR auto-fix', () => {
  it('asks Claude once to fix the failing checks, and merges when ready through gh', async () => {
    const id = '00000000-0000-4000-8000-0000000000c1';
    const session = new Session({ sessionId: id, resume: false, cwd: dir, passthrough: [] });
    session.start();
    const host = new SessionHost(session, initialState(id), dir, join(dir, 'claude'));
    await until(() => prompts().length === 1);
    expect(prompts()[0]).toMatch(/^\[binder\] CI checks failed on PR #12 \(lint, test\)/);
    expect(host.state.pr?.checks.failing).toEqual(['lint', 'test']);
    // The same failure on the same commit is not asked about again.
    await until(() => host.state.running === null && host.state.tabs.length === 1);
    await host.refreshPr();
    await sleep(200);
    expect(prompts()).toHaveLength(1);
    expect(await host.mergePr()).toBe('PR #12 merges (squash) once its checks pass and it is approved');
    expect(readFileSync(log, 'utf8')).toContain(JSON.stringify(['pr', 'merge', '12', '--auto', '--squash']));
    await host.close();
  });
});
