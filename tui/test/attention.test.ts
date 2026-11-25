import { describe, it, expect, afterEach } from 'vitest';
import { ring, setBellWriter, setFocused, takeFocus } from '../src/attention.js';

describe('the bell', () => {
  const written: string[] = [];
  setBellWriter((s) => written.push(s));
  afterEach(() => {
    written.length = 0;
    setFocused(true);
  });

  it('takes focus reports out of the input and rings only while the window is in the background', () => {
    ring();
    expect(written).toEqual([]);
    expect(takeFocus('a\x1b[Ob')).toBe('ab');
    ring();
    expect(written).toEqual(['\x07']);
    expect(takeFocus('\x1b[I')).toBe('');
    ring();
    expect(written).toEqual(['\x07']);
  });
});
