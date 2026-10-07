import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fingerprint, generateKeyPair, publicKeyOf, type KeyPair } from './noise.js';

// ~/.config/binder/remote.json: this computer's key, the enrolled clients, the
// relay to dial, and what remote clients may reach. Mode 600. Everything about
// one person's setup lives here, never in code.

export type RawConfig = {
  privateKey: string;
  devices: { name: string; publicKey: string; added: string }[];
  relay: { url: string; token?: string; tokenFile?: string; tokenKey?: string };
  allowedRoots: string[];
  paused?: boolean;
  notify?: boolean;
  launcher?: 'headless' | 'iterm';
};

export type Device = { name: string; publicKey: Buffer; fingerprint: string };

export type RemoteConfig = {
  path: string;
  keyPair: KeyPair;
  devices: Device[];
  relayUrl: string;
  token?: string;
  roots: string[];
  paused: boolean;
  notify: boolean;
  launcher: 'headless' | 'iterm';
};

export const configPath = () => process.env.BINDER_REMOTE_CONFIG || join(homedir(), '.config', 'binder', 'remote.json');
export const logPathFor = (config: string) => join(dirname(config), 'remote.log');

export const expandHome = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

function key(base64: string, what: string): Buffer {
  const b = Buffer.from(base64, 'base64');
  if (b.length !== 32) throw new Error(`${what} must be 32 bytes, base64`);
  return b;
}

export function readRaw(path = configPath()): RawConfig {
  if (!existsSync(path)) throw new Error(`No ${path}; run: binder remote init --relay <wss url>`);
  return JSON.parse(readFileSync(path, 'utf8')) as RawConfig;
}

export function writeRaw(raw: RawConfig, path = configPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

// A KEY=value line from a shell-style file, or the whole file.
function readToken(file: string, keyName?: string): string {
  const text = readFileSync(expandHome(file), 'utf8');
  if (!keyName) return text.trim();
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m && m[1] === keyName) return m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  throw new Error(`${file} has no ${keyName}=`);
}

/** Reads and checks the config. Throws on anything invalid, so a bad edit stops the gateway rather than loosening it. */
export function loadConfig(path = configPath()): RemoteConfig {
  const raw = readRaw(path);
  const privateKey = key(raw.privateKey, 'privateKey');
  const devices = (raw.devices ?? []).map((d) => {
    const publicKey = key(d.publicKey, `device ${d.name}`);
    return { name: d.name, publicKey, fingerprint: fingerprint(publicKey) };
  });
  if (typeof raw.relay?.url !== 'string' || !/^wss?:\/\//.test(raw.relay.url)) throw new Error('relay.url must be a ws:// or wss:// URL');
  const token = raw.relay.token ?? (raw.relay.tokenFile ? readToken(raw.relay.tokenFile, raw.relay.tokenKey) : undefined);
  const roots = (raw.allowedRoots ?? []).map((r) => {
    const dir = expandHome(r);
    if (!isAbsolute(dir) || !existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`allowedRoots: ${r} is not a directory`);
    return realpathSync(dir);
  });
  if (!roots.length) throw new Error('allowedRoots is empty: remote clients could reach nothing');
  const launcher = raw.launcher ?? 'headless';
  if (launcher !== 'headless' && launcher !== 'iterm') throw new Error('launcher must be "headless" or "iterm"');
  return {
    path,
    keyPair: { privateKey, publicKey: publicKeyOf(privateKey) },
    devices,
    relayUrl: raw.relay.url,
    token,
    roots,
    paused: raw.paused === true,
    notify: raw.notify !== false,
    launcher,
  };
}

const USAGE = `binder remote: set up remote control of this computer's binder sessions

  binder remote init --relay <wss url> [--token-file <file> [--token-key <NAME>]] [--root <dir>]...
                                 create the config and this computer's key
  binder remote key              this computer's public key (paste it into the client)
  binder remote enroll <key> [name]
                                 let a client (its public key, base64) connect
  binder remote revoke <name or fingerprint>
  binder remote pause | unpause  refuse every client until unpaused
  binder remote status           key, clients, relay, roots, recent log
`;

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

export function remoteCommand(argv: string[], path = configPath()): void {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'init': {
      const raw: RawConfig = existsSync(path)
        ? readRaw(path)
        : { privateKey: '', devices: [], relay: { url: '' }, allowedRoots: [], notify: true, launcher: 'headless', paused: false };
      if (!raw.privateKey) raw.privateKey = generateKeyPair().privateKey.toString('base64');
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const v = args[++i];
        if (v === undefined) throw new Error(`${a} needs a value`);
        if (a === '--relay') raw.relay.url = v;
        else if (a === '--token-file') raw.relay.tokenFile = v;
        else if (a === '--token-key') raw.relay.tokenKey = v;
        else if (a === '--root') raw.allowedRoots = [...new Set([...(raw.allowedRoots ?? []), v])];
        else if (a === '--launcher') raw.launcher = v as RawConfig['launcher'];
        else throw new Error(`Unknown option ${a}\n\n${USAGE}`);
      }
      writeRaw(raw, path);
      const pub = publicKeyOf(Buffer.from(raw.privateKey, 'base64'));
      return out(`Wrote ${path}\nComputer key: ${pub.toString('base64')}\nFingerprint:  ${fingerprint(pub)}`);
    }
    case 'key': {
      const pub = publicKeyOf(key(readRaw(path).privateKey, 'privateKey'));
      return out(`${pub.toString('base64')}\nFingerprint: ${fingerprint(pub)}`);
    }
    case 'enroll': {
      if (!args[0]) throw new Error('usage: binder remote enroll <base64 public key> [name]');
      const publicKey = key(args[0].trim(), 'The public key');
      const raw = readRaw(path);
      const name = args[1] ?? `device-${raw.devices.length + 1}`;
      raw.devices = raw.devices.filter((d) => d.name !== name && d.publicKey !== publicKey.toString('base64'));
      raw.devices.push({ name, publicKey: publicKey.toString('base64'), added: new Date().toISOString() });
      writeRaw(raw, path);
      return out(`Enrolled ${name}: ${fingerprint(publicKey)}. Check it matches the fingerprint the client shows.`);
    }
    case 'revoke': {
      const which = args.join(' ').trim();
      const raw = readRaw(path);
      const keep = raw.devices.filter((d) => d.name !== which && fingerprint(Buffer.from(d.publicKey, 'base64')) !== which);
      if (keep.length === raw.devices.length) throw new Error(`No client named ${which}`);
      raw.devices = keep;
      writeRaw(raw, path);
      return out(`Revoked ${which}. Its open connections end when it next sends anything.`);
    }
    case 'pause':
    case 'unpause': {
      const raw = readRaw(path);
      raw.paused = cmd === 'pause';
      writeRaw(raw, path);
      return out(cmd === 'pause' ? 'Paused: every client is refused.' : 'Unpaused.');
    }
    case 'status': {
      let cfg: RemoteConfig;
      try {
        cfg = loadConfig(path);
      } catch (e) {
        return out(`Config problem: ${(e as Error).message}`);
      }
      let log = '';
      try {
        log = readFileSync(logPathFor(path), 'utf8').trimEnd();
      } catch {
        // no log yet
      }
      return out(
        [
          `Computer key: ${fingerprint(cfg.keyPair.publicKey)}`,
          `Relay:        ${cfg.relayUrl}${cfg.token ? ' (with token)' : ''}`,
          `Paused:       ${cfg.paused ? 'yes' : 'no'}`,
          `Launcher:     ${cfg.launcher}`,
          `Roots:        ${cfg.roots.join(', ')}`,
          'Clients:',
          ...(cfg.devices.length ? cfg.devices.map((d) => `  ${d.name}: ${d.fingerprint}`) : ['  (none enrolled)']),
          'Recent log:',
          ...(log ? log.split('\n').slice(-10).map((l) => `  ${l}`) : ['  (none yet)']),
        ].join('\n'),
      );
    }
    default:
      return out(USAGE);
  }
}
