// The terminal bell when a turn finishes or a question arrives while you are
// in another window (config.json `bell`). Focus reporting makes the terminal
// say when its window gains or loses focus; without it binder assumes you are
// looking and stays quiet.
export const FOCUS_ON = '\x1b[?1004h';
export const FOCUS_OFF = '\x1b[?1004l';

let focused = true;
let write: (s: string) => void = (s) => void process.stdout.write(s);

/** Takes the focus reports (ESC [ I, ESC [ O) out of terminal input. */
export function takeFocus(chunk: string): string {
  return chunk.replace(/\x1b\[([IO])/g, (_, f: string) => {
    focused = f === 'I';
    return '';
  });
}

/** Rings the bell, unless the terminal's window has focus. */
export function ring(): void {
  if (!focused) write('\x07');
}

// For tests.
export function setFocused(on: boolean): void {
  focused = on;
}

export function setBellWriter(fn: (s: string) => void): void {
  write = fn;
}
