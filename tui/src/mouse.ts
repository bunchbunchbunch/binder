import { EventEmitter } from 'node:events';

// Mouse reporting (button events, SGR encoding) makes the terminal send the
// wheel to binder, which scrolls the tab, instead of turning it into arrow
// keys. While it is on, iTerm2 selects text with the mouse only while Option
// is held.
export const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
export const MOUSE_OFF = '\x1b[?1000l\x1b[?1006l';

// Lines per wheel step.
const STEP = 3;
const wheel = new EventEmitter();

// Takes the mouse reports out of terminal input: wheel steps go to the
// onWheel listeners (negative is up), clicks are dropped.
export function takeMouse(chunk: string): string {
  return chunk.replace(/\x1b\[<(\d+);\d+;\d+[Mm]/g, (_, code: string) => {
    const button = Number(code) & ~(4 | 8 | 16); // without Shift, Alt, Ctrl
    if (button === 64) wheel.emit('wheel', -STEP);
    else if (button === 65) wheel.emit('wheel', STEP);
    return '';
  });
}

export function onWheel(listener: (lines: number) => void): () => void {
  wheel.on('wheel', listener);
  return () => {
    wheel.off('wheel', listener);
  };
}
