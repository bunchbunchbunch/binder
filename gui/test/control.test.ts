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
});
