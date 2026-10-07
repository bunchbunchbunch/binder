// With the kitty keyboard protocol on (see renderOptions.ts), terminals report
// numeric keypad keys as CSI u codes, which Ink drops as non-printable. Turn
// the unmodified ones back into the characters they type before Ink reads them.
const KEYPAD: Record<string, string> = {
  57399: '0', 57400: '1', 57401: '2', 57402: '3', 57403: '4',
  57404: '5', 57405: '6', 57406: '7', 57407: '8', 57408: '9',
  57409: '.', 57410: '/', 57411: '*', 57412: '-', 57413: '+', 57415: '=',
};

export function keypadToText(chunk: string): string {
  return chunk.replace(/\x1b\[(57\d{3})u/g, (seq, code: string) => KEYPAD[code] ?? seq);
}

// `stdin` with `filter` applied to everything Ink reads from it.
export function filterInput<T extends NodeJS.ReadableStream>(stdin: T, filter: (chunk: string) => string): T {
  return new Proxy(stdin, {
    get(target, prop) {
      if (prop === 'read') {
        return (size?: number) => {
          const chunk = target.read(size);
          return typeof chunk === 'string' ? filter(chunk) : chunk;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
