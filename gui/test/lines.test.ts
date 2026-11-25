import { describe, it, expect, afterEach } from 'vitest';
import { createServer, connect, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { HostConnection, type HostStream } from '../src/main/hostConnection';
import { hostInfo } from '../src/main/binder';
import { listenControl } from '../src/main/control';
import type { HostMessage } from '../src/shared/wire';

// U+2028 and U+2029 are legal, unescaped, inside JSON strings (a web page
// Claude quotes can carry them), and since Node 24 readline ends a line at
// each: a host line holding one must still arrive whole.
const SEPARATED = 'Line one\u2028Line two\u2029end';

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Short: a unix socket path must stay under 104 bytes.
function sockPath(): string {
  const dir = mkdtempSync('/tmp/bl-');
  dirs.push(dir);
  return join(dir, 's.sock');
}

describe('lines from a host', () => {
  it('delivers a snapshot whose text holds U+2028 and U+2029, even cut inside one', async () => {
    const input = new PassThrough();
    const stream: HostStream = { input, write: () => {}, end: () => input.end(), onClose: () => {} };
    const got: HostMessage[] = [];
    const attached = new HostConnection(stream, (m) => got.push(m), () => {}).attach();
    const line = Buffer.from(JSON.stringify({ t: 'snapshot', state: { title: SEPARATED, tabs: [] }, commands: [] }) + '\n');
    const cut = line.indexOf(Buffer.from('\u2028')) + 1;
    input.write(line.subarray(0, cut));
    input.write(line.subarray(cut));
    await attached;
    expect(got).toHaveLength(1);
    expect((got[0] as unknown as { state: { title: string } }).state.title).toBe(SEPARATED);
  });

  it('reads a host info line whose title holds U+2028', async () => {
    const path = sockPath();
    const info = { t: 'info', sessionId: '00000000-0000-4000-8000-0000000000a1', cwd: '/p', title: SEPARATED, running: false, model: 'claude-opus-5-5', pid: 1 };
    const server = createServer((s) => s.write(JSON.stringify(info) + '\n'));
    servers.push(server);
    await new Promise<void>((r) => server.listen(path, r));
    expect(await hostInfo(path)).toEqual(info);
  });

  it('takes a control request whose draft holds U+2028', async () => {
    const path = sockPath();
    const seen: unknown[] = [];
    servers.push(listenControl(path, async (req) => (seen.push(req), { ok: true })));
    await new Promise((r) => setTimeout(r, 50));
    const reply = await new Promise<string>((done, fail) => {
      const s = connect(path);
      let out = '';
      s.on('data', (d) => (out += d));
      s.on('end', () => done(out.trim()));
      s.on('error', fail);
      s.end(JSON.stringify({ t: 'open', cwd: '/p', draft: SEPARATED }) + '\n');
    });
    expect(reply).toBe('{"ok":true}');
    expect(seen).toEqual([{ t: 'open', cwd: '/p', resume: false, draft: SEPARATED }]);
  });
});
