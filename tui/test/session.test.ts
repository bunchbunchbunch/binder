import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('Session resuming a session Claude Code has no transcript for', () => {
  // A session linked to a todo but never used, or one Claude Code has cleaned
  // up: `claude --resume` would exit with "No conversation found".
  it('starts it fresh under the same id, and resumes it once the transcript exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'binder-state-'));
    const argsOut = join(dir, 'args.json');
    const config = join(dir, 'claude');
    process.env.BINDER_STATE_DIR = dir;
    process.env.CLAUDE_CONFIG_DIR = config;
    process.env.BINDER_FAKE_FIXTURE = join(FIXTURES, 'two-turns-stdin.jsonl');
    process.env.BINDER_FAKE_ARGS_OUT = argsOut;
    const id = '00000000-0000-4000-8000-0000000000f2';
    const launched = async () => {
      const session = new Session({ sessionId: id, resume: true, cwd: dir, passthrough: [], bin: FAKE_BIN });
      session.start();
      for (let waited = 0; !existsSync(argsOut); waited += 20) {
        if (waited > 5000) throw new Error('claude did not start');
        await new Promise((r) => setTimeout(r, 20));
      }
      await session.close();
      const args: string[] = JSON.parse(readFileSync(argsOut, 'utf8'));
      rmSync(argsOut);
      return args;
    };
    try {
      const fresh = await launched();
      expect(fresh).not.toContain('--resume');
      expect(fresh[fresh.indexOf('--session-id') + 1]).toBe(id);

      mkdirSync(join(config, 'projects', 'some-project'), { recursive: true });
      writeFileSync(join(config, 'projects', 'some-project', `${id}.jsonl`), '');
      const resumed = await launched();
      expect(resumed[resumed.indexOf('--resume') + 1]).toBe(id);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
      delete process.env.BINDER_FAKE_ARGS_OUT;
    }
  });
});
