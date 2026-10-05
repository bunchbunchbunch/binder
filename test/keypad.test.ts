import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { filterInput, keypadToText } from '../src/keypad.js';

describe('keypad keys under the kitty keyboard protocol', () => {
  // Bytes iTerm2 3.7 sent for keypad "2", "-", "0" with the protocol on.
  it('turns unmodified keypad codes into the characters they type', () => {
    expect(keypadToText('sleep \x1b[57401u\x1b[57399u; echo A\x1b[57412uB')).toBe('sleep 20; echo A-B');
  });

  it('leaves other kitty sequences alone', () => {
    expect(keypadToText('\x1b[13;5u\x1b[27u\x1b[57401;5u\x1b[57414u')).toBe('\x1b[13;5u\x1b[27u\x1b[57401;5u\x1b[57414u');
  });

  it('applies to what Ink reads through the wrapped stream', () => {
    const raw = new PassThrough();
    raw.setEncoding('utf8');
    const stdin = filterInput(raw, keypadToText);
    raw.write('a\x1b[57403u');
    expect(stdin.read()).toBe('a4');
    expect('setEncoding' in stdin).toBe(true);
  });
});
