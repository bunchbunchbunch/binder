import { describe, it, expect } from 'vitest';
import { parseControl } from '../src/main/control';

const id = '00000000-0000-4000-8000-0000000000a1';

describe('control requests', () => {
  it('takes open and close as the window handles them', () => {
    expect(parseControl(JSON.stringify({ t: 'open', cwd: '/p', sessionId: id, draft: 'Pay rent', args: ['-n', 'Pay rent'] }))).toEqual({
      t: 'open',
      cwd: '/p',
      sessionId: id,
      resume: false,
      draft: 'Pay rent',
      args: ['-n', 'Pay rent'],
    });
    expect(parseControl(JSON.stringify({ t: 'open', cwd: '/p', sessionId: id, resume: true }))).toMatchObject({ resume: true });
    expect(parseControl(JSON.stringify({ t: 'close', sessionId: id, show: 'Todos' }))).toEqual({ t: 'close', sessionId: id, show: 'Todos' });
  });

  it('says what is wrong with anything else', () => {
    expect(parseControl('{')).toBe('Not JSON');
    expect(parseControl('null')).toBe('Unknown request; send open or close');
    expect(parseControl(JSON.stringify({ t: 'quit' }))).toBe('Unknown request; send open or close');
    expect(parseControl(JSON.stringify({ t: 'open', cwd: '' }))).toBe('open needs cwd');
    expect(parseControl(JSON.stringify({ t: 'open', cwd: '/p', args: '-n x' }))).toBe('args must be strings');
    expect(parseControl(JSON.stringify({ t: 'close' }))).toBe('close needs sessionId');
  });

  it('rejects a non-name flag and a non-UUID session id, so an opener cannot escalate', () => {
    for (const args of [['--dangerously-skip-permissions'], ['--permission-mode', 'bypassPermissions'], ['-n', '-x'], ['-n', 'a', '-n', 'b']]) {
      expect(parseControl(JSON.stringify({ t: 'open', cwd: '/p', args }))).toBe('args may only set the session name (-n <name>)');
    }
    expect(parseControl(JSON.stringify({ t: 'open', cwd: '/p', sessionId: 'not-a-uuid' }))).toBe('sessionId must be a UUID');
    // The name flag and a bare open are still fine.
    expect(parseControl(JSON.stringify({ t: 'open', cwd: '/p', args: ['-n', 'My task'] }))).toMatchObject({ args: ['-n', 'My task'] });
    expect(parseControl(JSON.stringify({ t: 'open', cwd: '/p' }))).toMatchObject({ t: 'open', cwd: '/p' });
  });
});
