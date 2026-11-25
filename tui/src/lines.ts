import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

/**
 * Calls `onLine` with each line `input` carries: split at "\n" only (a "\r"
 * before it is dropped), the last one even if no "\n" ends it.
 *
 * Not readline: since Node 24 it also ends a line at U+2028 and U+2029, which
 * JSON leaves unescaped inside strings (a web page Claude quotes can hold
 * them), so a JSON line with one arrives cut into pieces that do not parse.
 * Errors on `input` are left to its owner's own handlers, as readline's were.
 */
export function onLines(input: Readable, onLine: (line: string) => void): void {
  const decoder = new StringDecoder('utf8');
  // The line so far, in pieces: only new text is searched for "\n", so a long
  // line read in many chunks costs no more than its length.
  let parts: string[] = [];
  const emit = (line: string) => onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  input.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let start = 0;
    let nl: number;
    while ((nl = text.indexOf('\n', start)) !== -1) {
      // A handler that destroyed the stream (a refused viewer) wants no more.
      if (input.destroyed) return;
      parts.push(text.slice(start, nl));
      const line = parts.join('');
      parts = [];
      start = nl + 1;
      emit(line);
    }
    if (start < text.length) parts.push(text.slice(start));
  });
  input.on('end', () => {
    parts.push(decoder.end());
    const rest = parts.join('');
    parts = [];
    if (rest) emit(rest);
  });
  input.on('error', () => {});
}
