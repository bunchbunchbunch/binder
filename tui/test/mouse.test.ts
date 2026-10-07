import { describe, it, expect } from 'vitest';
import { onWheel, takeMouse } from '../src/mouse.js';

describe('mouse reports', () => {
  // SGR reports as iTerm2 sends them with mouse reporting on: button 64/65
  // is the wheel (plus 4/8/16 for Shift/Alt/Ctrl), M a press, m a release.
  it('turns wheel reports into scroll steps and takes every report out of the input', () => {
    const steps: number[] = [];
    const off = onWheel((lines) => steps.push(lines));
    expect(takeMouse('a\x1b[<64;10;5Mb\x1b[<65;10;5M\x1b[<0;3;4M\x1b[<0;3;4mc\x1b[<80;1;1M')).toBe('abc');
    off();
    expect(steps).toEqual([-3, 3, -3]);
  });
});
