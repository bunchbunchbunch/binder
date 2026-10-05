import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
// @ts-expect-error plain JavaScript, no types
import { startRelay } from '../relay/relay.mjs';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let relay: { port: number; close: () => Promise<void> } | null = null;
const open: WebSocket[] = [];

afterEach(async () => {
  for (const ws of open.splice(0)) ws.terminate();
  await relay?.close();
  relay = null;
});

async function start(secret?: string) {
  relay = await startRelay({ port: 0, host: '127.0.0.1', secret, log: () => {} });
  return relay!.port;
}

function socket(port: number, side: 'mac' | 'phone', headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/relay/${side}`, { headers });
  open.push(ws);
  const frames: Buffer[] = [];
  let closed: number | null = null;
  ws.on('message', (d) => frames.push(Buffer.from(d as Buffer)));
  ws.on('close', (code) => (closed = code));
  ws.on('error', () => {});
  const ready = new Promise<void>((resolve) => {
    ws.on('open', () => resolve());
    ws.on('close', () => resolve());
  });
  return { ws, frames, ready, closed: () => closed };
}

async function until(check: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await sleep(10);
  }
}

describe('relay', () => {
  it('pairs a client with the computer and forwards frames both ways', async () => {
    const port = await start();
    const mac = socket(port, 'mac');
    await mac.ready;
    const phone = socket(port, 'phone');
    await phone.ready;
    await until(() => mac.frames.length === 1);
    const id = mac.frames[0].readUInt32BE(0);
    expect(mac.frames[0][4]).toBe(1); // open

    phone.ws.send(Buffer.from('hello'));
    await until(() => mac.frames.length === 2);
    expect(mac.frames[1].readUInt32BE(0)).toBe(id);
    expect(mac.frames[1][4]).toBe(0);
    expect(mac.frames[1].subarray(5).toString()).toBe('hello');

    const back = Buffer.concat([Buffer.alloc(5), Buffer.from('world')]);
    back.writeUInt32BE(id, 0);
    mac.ws.send(back);
    await until(() => phone.frames.length === 1);
    expect(phone.frames[0].toString()).toBe('world');

    phone.ws.close();
    await until(() => mac.frames.length === 3);
    expect(mac.frames[2][4]).toBe(2); // close
  });

  it('closes a client at once when the computer is offline', async () => {
    const port = await start();
    const phone = socket(port, 'phone');
    await until(() => phone.closed() !== null);
    expect(phone.closed()).toBe(4004);
  });

  it('lets the computer close a client', async () => {
    const port = await start();
    const mac = socket(port, 'mac');
    await mac.ready;
    const phone = socket(port, 'phone');
    await until(() => mac.frames.length === 1);
    const bye = Buffer.alloc(5);
    bye.writeUInt32BE(mac.frames[0].readUInt32BE(0), 0);
    bye[4] = 2;
    mac.ws.send(bye);
    await until(() => phone.closed() !== null);
    expect(phone.closed()).toBe(1000);
  });

  it('replaces an older computer connection and drops its clients', async () => {
    const port = await start();
    const first = socket(port, 'mac');
    await first.ready;
    const phone = socket(port, 'phone');
    await phone.ready;
    const second = socket(port, 'mac');
    await second.ready;
    await until(() => first.closed() !== null && phone.closed() !== null);
    expect(first.closed()).toBe(4000);
    expect(phone.closed()).toBe(4001);
  });

  it('requires the shared secret when one is set', async () => {
    const port = await start('s3cret');
    const without = socket(port, 'mac');
    await until(() => without.closed() !== null);
    const wrong = socket(port, 'mac', { 'X-Relay-Secret': 's3creX' });
    await until(() => wrong.closed() !== null);
    const right = socket(port, 'mac', { 'X-Relay-Secret': 's3cret' });
    await right.ready;
    expect(right.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('refuses frames over the size limit', async () => {
    const port = await start();
    const mac = socket(port, 'mac');
    await mac.ready;
    const phone = socket(port, 'phone');
    await phone.ready;
    phone.ws.send(Buffer.alloc(80000));
    await until(() => phone.closed() !== null);
    expect(phone.closed()).toBe(1009);
  });
});
