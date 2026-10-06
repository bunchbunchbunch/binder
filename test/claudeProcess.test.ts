import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ClaudeProcess, buildArgs } from '../src/claudeProcess.js';
import type { ClaudeEvent } from '../src/events.js';
import { FAKE_BIN, FIXTURES, fakeEnv } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));

function collectUntilExit(proc: ClaudeProcess): Promise<ClaudeEvent[]> {
  const events: ClaudeEvent[] = [];
  return new Promise((resolve) => {
    proc.on('event', (e) => events.push(e));
    proc.on('exit', () => resolve(events));
  });
}

function waitForResult(proc: ClaudeProcess): Promise<ClaudeEvent> {
  return new Promise((resolve) => {
    const handler = (e: ClaudeEvent) => {
      if (e.type === 'result') {
        proc.off('event', handler);
        resolve(e);
      }
    };
    proc.on('event', handler);
  });
}

describe('buildArgs', () => {
  it("uses --session-id for a new session and leaves the permission mode to Claude Code's default", () => {
    const args = buildArgs({ sessionId: 'abc', resume: false, passthrough: [] });
    expect(args).toContain('--session-id');
    expect(args).toContain('abc');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--permission-mode');
    expect(args).toContain('--include-partial-messages');
    expect(args).toContain('--prompt-suggestions');
  });

  it('passes the permission mode from config.json', () => {
    const args = buildArgs({ sessionId: 'abc', resume: false, passthrough: [] }, { permissionMode: 'bypassPermissions' });
    expect(args.slice(-2)).toEqual(['--permission-mode', 'bypassPermissions']);
  });

  it('uses --resume and lets passthrough override the permission mode', () => {
    const args = buildArgs({ sessionId: 'abc', resume: true, passthrough: ['--permission-mode', 'plan'] }, { permissionMode: 'bypassPermissions' });
    expect(args).toContain('--resume');
    expect(args).not.toContain('bypassPermissions');
    expect(args.slice(-2)).toEqual(['--permission-mode', 'plan']);
  });
});

describe('ClaudeProcess with the fake binary', () => {
  it('parses every line of a single-turn fixture in order', async () => {
    const proc = new ClaudeProcess({ bin: FAKE_BIN, args: [], cwd: here, env: fakeEnv('single-turn-partial.jsonl') });
    proc.start();
    const done = collectUntilExit(proc);
    proc.sendPrompt('Reply with just: ok');
    const result = await waitForResult(proc);
    await proc.close();
    const events = await done;

    const expected = readFileSync(join(FIXTURES, 'single-turn-partial.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    expect(events).toEqual(expected);
    expect((result as { result: string }).result).toBe('ok');
  });

  it('handles two turns over one stdin and passes argv through', async () => {
    const argsOut = join(mkdtempSync(join(tmpdir(), 'binder-')), 'args.json');
    const proc = new ClaudeProcess({
      bin: FAKE_BIN,
      args: buildArgs({ sessionId: 'sid', resume: true, passthrough: ['--model', 'haiku'] }),
      cwd: here,
      env: fakeEnv('two-turns-stdin.jsonl', { BINDER_FAKE_ARGS_OUT: argsOut }),
    });
    proc.start();
    const done = collectUntilExit(proc);

    proc.sendPrompt('Reply with just: A');
    const r1 = await waitForResult(proc);
    proc.sendPrompt('What were all my previous messages?');
    const r2 = await waitForResult(proc);
    await proc.close();
    await done;

    expect((r1 as { result: string }).result).toBe('A');
    expect((r2 as { result: string }).result).toMatch(/ok2/);
    expect(JSON.parse(readFileSync(argsOut, 'utf8'))).toEqual(
      buildArgs({ sessionId: 'sid', resume: true, passthrough: ['--model', 'haiku'] }),
    );
  });

  it('reports exit and keeps recent stderr', async () => {
    const proc = new ClaudeProcess({ bin: FAKE_BIN, args: [], cwd: here, env: { ...process.env, BINDER_FAKE_FIXTURE: '' } });
    proc.start();
    const exit = await new Promise<{ code: number | null }>((resolve) => proc.on('exit', resolve));
    expect(exit.code).toBe(2);
    expect(proc.recentStderr.join('\n')).toMatch(/BINDER_FAKE_FIXTURE/);
  });
});
