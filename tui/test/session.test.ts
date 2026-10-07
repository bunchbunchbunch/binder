import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/session.js';
import { FAKE_BIN, FIXTURES } from './helpers.js';

describe('Session in plan mode', () => {
  // Interactive Claude Code started in bypass mode does not ask in plan mode,
  // but headless Claude Code asks binder. The fixture's first turn enters plan
  // mode from bypass mode; its second starts in default mode, as a child
  // launched without bypass would, and enters plan mode from there.
  it('allows tools itself after bypass mode, but still asks for safety checks, the plan, and plan mode entered from default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'binder-state-'));
    const inputOut = join(dir, 'input.jsonl');
    process.env.BINDER_STATE_DIR = dir;
    process.env.BINDER_FAKE_FIXTURE = join(FIXTURES, 'plan-after-bypass.jsonl');
    process.env.BINDER_FAKE_INPUT_OUT = inputOut;
    const session = new Session({ sessionId: '00000000-0000-4000-8000-0000000000f1', resume: false, cwd: dir, passthrough: [], bin: FAKE_BIN });
    const asked: string[] = [];
    session.on('permission', (req) => {
      asked.push(req.requestId);
      session.allow(req);
    });
    const result = () => new Promise<void>((resolve) => {
      const onEvent = (e: { type: string }) => {
        if (e.type !== 'result') return;
        session.off('event', onEvent);
        resolve();
      };
      session.on('event', onEvent);
    });

    session.start();
    let done = result();
    session.sendPrompt('plan it', 1);
    await done;
    done = result();
    session.sendPrompt('plan it again', 2);
    await done;
    await session.close();

    expect(asked).toEqual(['perm-rm', 'perm-exit', 'perm-default']);
    const answers = readFileSync(inputOut, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((m) => m.type === 'control_response')
      .map((m) => [m.response.request_id, m.response.response.behavior]);
    expect(answers).toEqual([['perm-read', 'allow'], ['perm-rm', 'allow'], ['perm-exit', 'allow'], ['perm-default', 'allow']]);
  });
});
