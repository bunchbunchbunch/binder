// The binder relay (docs/remote-protocol.md, section 1). Pairs the computer's
// WebSocket (/relay/mac) with client WebSockets (/relay/phone) and forwards
// opaque frames between them. It holds no keys: everything it forwards is
// Noise ciphertext, so it can drop or delay traffic but not read or forge it.
//
//   RELAY_PORT    port to listen on (default 3030)
//   RELAY_HOST    address to bind (default 127.0.0.1; put a TLS proxy in front)
//   RELAY_SECRET  if set, every upgrade must carry it as X-Relay-Secret, so
//                 other users on this machine cannot connect around the proxy
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const DATA = 0;
const OPEN = 1;
const CLOSE = 2;
// One Noise message (at most 65,535 bytes) plus the 5-byte header.
const MAX_FRAME = 70000;
const MAX_CLIENTS = 8;
const PING_MS = 25000;

function sameSecret(given, secret) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Starts the relay; resolves with { port, close } once it listens. */
export function startRelay({ port = Number(process.env.RELAY_PORT ?? 3030), host = process.env.RELAY_HOST ?? '127.0.0.1', secret = process.env.RELAY_SECRET, log = (m) => console.log(`${new Date().toISOString()} ${m}`) } = {}) {
  let mac = null;
  const clients = new Map();
  let nextId = 1;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });

  const toMac = (id, type, payload = Buffer.alloc(0)) => {
    if (!mac || mac.readyState !== WebSocket.OPEN) return;
    const b = Buffer.alloc(5 + payload.length);
    b.writeUInt32BE(id, 0);
    b[4] = type;
    payload.copy(b, 5);
    mac.send(b);
  };

  const watch = (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('error', () => {});
  };

  function onMac(ws) {
    if (mac) mac.close(4000, 'replaced by a new connection');
    // Their Noise sessions lived in the old connection's gateway.
    for (const c of clients.values()) c.close(4001, 'computer reconnected');
    mac = ws;
    watch(ws);
    log('computer connected');
    ws.on('message', (data, isBinary) => {
      if (!isBinary || data.length < 5) return;
      const c = clients.get(data.readUInt32BE(0));
      if (!c) return;
      if (data[4] === DATA) c.send(data.subarray(5));
      else if (data[4] === CLOSE) c.close(1000, 'closed by the computer');
    });
    ws.on('close', () => {
      if (mac !== ws) return;
      mac = null;
      log('computer disconnected');
      for (const c of clients.values()) c.close(4004, 'computer offline');
    });
  }

  function onClient(ws) {
    if (!mac || mac.readyState !== WebSocket.OPEN) return ws.close(4004, 'computer offline');
    if (clients.size >= MAX_CLIENTS) return ws.close(4029, 'too many connections');
    const id = nextId;
    nextId = nextId >= 0xffffffff ? 1 : nextId + 1;
    clients.set(id, ws);
    watch(ws);
    log(`client ${id} connected`);
    toMac(id, OPEN);
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return ws.close(1003, 'binary frames only');
      toMac(id, DATA, data);
    });
    ws.on('close', () => {
      clients.delete(id);
      toMac(id, CLOSE);
      log(`client ${id} closed`);
    });
  }

  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://relay').pathname;
    const side = path.endsWith('/relay/mac') ? 'mac' : path.endsWith('/relay/phone') ? 'phone' : null;
    if (!side || (secret && !sameSecret(req.headers['x-relay-secret'], secret))) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => (side === 'mac' ? onMac(ws) : onClient(ws)));
  });

  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, PING_MS);

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      log(`relay listening on ${host}:${server.address().port}`);
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((done) => {
            clearInterval(pinger);
            for (const ws of wss.clients) ws.terminate();
            server.close(() => done());
          }),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.RELAY_SECRET) console.log('warning: RELAY_SECRET is not set; anyone who can reach the port can connect');
  startRelay();
  process.on('SIGTERM', () => process.exit(0));
}
