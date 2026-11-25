import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { onLines } from '../src/lines.js';

function feed(chunks: (string | Buffer)[]): Promise<string[]> {
  const input = new PassThrough();
  const got: string[] = [];
  onLines(input, (l) => got.push(l));
  return new Promise((done) => {
    input.on('end', () => setImmediate(() => done(got)));
    for (const c of chunks) input.write(c);
    input.end();
  });
}

describe('lines from a stream', () => {
  it('ends a line only at \\n: U+2028 and U+2029 stay inside it', async () => {
    expect(await feed(['{"a":"x\u2028y\u2029z"}\n{"b":1}\n'])).toEqual(['{"a":"x\u2028y\u2029z"}', '{"b":1}']);
  });

  it('drops the \\r of a \\r\\n, and gives the last line though no \\n ends it', async () => {
    expect(await feed(['one\r\ntwo\nthree'])).toEqual(['one', 'two', 'three']);
    expect(await feed(['', 'a\n', '\n'])).toEqual(['a', '']);
  });

  it('joins a line cut across chunks, even inside a multibyte character', async () => {
    const line = Buffer.from('café \u2028 ✓ end\n');
    const at = line.indexOf(Buffer.from('\u2028')) + 1;
    expect(await feed([line.subarray(0, at), line.subarray(at)])).toEqual(['café \u2028 ✓ end']);
    expect(await feed(['ab', 'c', 'd\ne', 'f\n'])).toEqual(['abcd', 'ef']);
  });

  it('reads a long line in many chunks without rescanning it', async () => {
    const big = 'x'.repeat(8 * 1024 * 1024);
    const chunks: string[] = [];
    for (let i = 0; i < big.length; i += 16384) chunks.push(big.slice(i, i + 16384));
    const start = Date.now();
    const got = await feed([...chunks, '\nnext\n']);
    expect(got.map((l) => l.length)).toEqual([big.length, 4]);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
