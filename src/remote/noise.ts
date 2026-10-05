import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, randomBytes } from 'node:crypto';

// Noise_IK_25519_ChaChaPoly_SHA256 (Noise spec revision 34), built on
// node:crypto. The client is the initiator and knows the computer's static key;
// the computer learns the client's from the first message. Checked against the
// cacophony and snow test vectors in test/noise.test.ts.

export const PROTOCOL_NAME = 'Noise_IK_25519_ChaChaPoly_SHA256';
export const PROLOGUE = Buffer.from('binder-remote/1');

export type KeyPair = { publicKey: Buffer; privateKey: Buffer };

// DER wrappers that turn raw 32-byte X25519 keys into KeyObjects.
const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const privateKeyObject = (raw: Buffer) => createPrivateKey({ key: Buffer.concat([PKCS8, raw]), format: 'der', type: 'pkcs8' });
const publicKeyObject = (raw: Buffer) => createPublicKey({ key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki' });

export function publicKeyOf(privateKey: Buffer): Buffer {
  return Buffer.from(createPublicKey(privateKeyObject(privateKey)).export({ format: 'der', type: 'spki' }).subarray(-32));
}

export function generateKeyPair(): KeyPair {
  const privateKey = randomBytes(32);
  return { privateKey, publicKey: publicKeyOf(privateKey) };
}

function dh(own: KeyPair, theirs: Buffer): Buffer {
  if (theirs.length !== 32) throw new Error('bad public key');
  return diffieHellman({ privateKey: privateKeyObject(own.privateKey), publicKey: publicKeyObject(theirs) });
}

/** First 8 bytes of SHA-256 over the raw public key, hex in groups of four. */
export function fingerprint(publicKey: Buffer): string {
  return createHash('sha256').update(publicKey).digest('hex').slice(0, 16).match(/.{4}/g)!.join(' ');
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest();
const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

function hkdf2(ck: Buffer, ikm: Buffer): [Buffer, Buffer] {
  const temp = hmac(ck, ikm);
  const one = hmac(temp, Buffer.from([1]));
  return [one, hmac(temp, Buffer.concat([one, Buffer.from([2])]))];
}

export class CipherState {
  private n = 0n;

  constructor(private readonly k: Buffer | null = null) {}

  get hasKey(): boolean {
    return this.k !== null;
  }

  // 32 bits of zeros, then the 64-bit counter little-endian.
  private nonce(): Buffer {
    const b = Buffer.alloc(12);
    b.writeBigUInt64LE(this.n, 4);
    return b;
  }

  encrypt(ad: Buffer, plaintext: Buffer): Buffer {
    if (!this.k) return plaintext;
    const c = createCipheriv('chacha20-poly1305', this.k, this.nonce(), { authTagLength: 16 });
    c.setAAD(ad, { plaintextLength: plaintext.length });
    const out = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
    this.n++;
    return out;
  }

  /** Throws when the message was altered or is out of order. */
  decrypt(ad: Buffer, ciphertext: Buffer): Buffer {
    if (!this.k) return ciphertext;
    if (ciphertext.length < 16) throw new Error('message too short');
    const d = createDecipheriv('chacha20-poly1305', this.k, this.nonce(), { authTagLength: 16 });
    d.setAAD(ad, { plaintextLength: ciphertext.length - 16 });
    d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    const out = Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]);
    this.n++;
    return out;
  }
}

class SymmetricState {
  h: Buffer;
  private ck: Buffer;
  private cs = new CipherState();

  constructor(name: string) {
    const n = Buffer.from(name);
    this.h = n.length <= 32 ? Buffer.concat([n, Buffer.alloc(32 - n.length)]) : sha256(n);
    this.ck = this.h;
  }

  mixHash(data: Buffer): void {
    this.h = sha256(Buffer.concat([this.h, data]));
  }

  mixKey(ikm: Buffer): void {
    const [ck, k] = hkdf2(this.ck, ikm);
    this.ck = ck;
    this.cs = new CipherState(k);
  }

  encryptAndHash(plaintext: Buffer): Buffer {
    const c = this.cs.encrypt(this.h, plaintext);
    this.mixHash(c);
    return c;
  }

  decryptAndHash(ciphertext: Buffer): Buffer {
    const p = this.cs.decrypt(this.h, ciphertext);
    this.mixHash(ciphertext);
    return p;
  }

  split(): [CipherState, CipherState] {
    const [a, b] = hkdf2(this.ck, Buffer.alloc(0));
    return [new CipherState(a), new CipherState(b)];
  }
}

export type HandshakeOptions = {
  initiator: boolean;
  s: KeyPair;
  /** The responder's static key; required for the initiator. */
  rs?: Buffer;
  prologue?: Buffer;
  /** Fixed ephemeral key, for test vectors only. */
  e?: KeyPair;
};

/**
 * One IK handshake. The initiator writes message 1 and reads message 2; the
 * responder reads message 1 (then checks `remoteStatic`) and writes message 2.
 * After the second message, `send` and `receive` are the transport ciphers.
 */
export class Handshake {
  private readonly sym = new SymmetricState(PROTOCOL_NAME);
  private e: KeyPair | undefined;
  private re: Buffer | undefined;
  private rs: Buffer | undefined;
  private step = 0;
  send: CipherState | undefined;
  receive: CipherState | undefined;

  constructor(private readonly opts: HandshakeOptions) {
    this.sym.mixHash(opts.prologue ?? PROLOGUE);
    if (opts.initiator) {
      if (!opts.rs) throw new Error('the initiator needs the responder static key');
      this.rs = opts.rs;
      this.sym.mixHash(opts.rs);
    } else {
      this.sym.mixHash(opts.s.publicKey);
    }
  }

  get remoteStatic(): Buffer | undefined {
    return this.rs;
  }

  get complete(): boolean {
    return this.send !== undefined;
  }

  get hash(): Buffer {
    return this.sym.h;
  }

  writeMessage(payload: Buffer = Buffer.alloc(0)): Buffer {
    const { initiator, s } = this.opts;
    if (initiator && this.step === 0) {
      const e = (this.e = this.opts.e ?? generateKeyPair());
      this.sym.mixHash(e.publicKey);
      this.sym.mixKey(dh(e, this.rs!));
      const encS = this.sym.encryptAndHash(s.publicKey);
      this.sym.mixKey(dh(s, this.rs!));
      const body = this.sym.encryptAndHash(payload);
      this.step = 1;
      return Buffer.concat([e.publicKey, encS, body]);
    }
    if (!initiator && this.step === 1) {
      const e = (this.e = this.opts.e ?? generateKeyPair());
      this.sym.mixHash(e.publicKey);
      this.sym.mixKey(dh(e, this.re!));
      this.sym.mixKey(dh(e, this.rs!));
      const body = this.sym.encryptAndHash(payload);
      this.finish();
      return Buffer.concat([e.publicKey, body]);
    }
    throw new Error('handshake message out of order');
  }

  readMessage(message: Buffer): Buffer {
    const { initiator, s } = this.opts;
    if (!initiator && this.step === 0) {
      if (message.length < 32 + 48 + 16) throw new Error('handshake message too short');
      this.re = message.subarray(0, 32);
      this.sym.mixHash(this.re);
      this.sym.mixKey(dh(s, this.re));
      this.rs = this.sym.decryptAndHash(message.subarray(32, 80));
      this.sym.mixKey(dh(s, this.rs));
      const payload = this.sym.decryptAndHash(message.subarray(80));
      this.step = 1;
      return payload;
    }
    if (initiator && this.step === 1) {
      if (message.length < 32 + 16) throw new Error('handshake message too short');
      this.re = message.subarray(0, 32);
      this.sym.mixHash(this.re);
      this.sym.mixKey(dh(this.e!, this.re));
      this.sym.mixKey(dh(s, this.re));
      const payload = this.sym.decryptAndHash(message.subarray(32));
      this.finish();
      return payload;
    }
    throw new Error('handshake message out of order');
  }

  private finish(): void {
    const [c1, c2] = this.sym.split();
    this.send = this.opts.initiator ? c1 : c2;
    this.receive = this.opts.initiator ? c2 : c1;
    this.step = 2;
  }
}

// Application messages ride in chunks: one flag byte (1 last, 0 more) plus up
// to MAX_CHUNK bytes, each sealed as one transport message.
export const MAX_CHUNK = 65535 - 16 - 1;
export const MAX_MESSAGE = 16 * 1024 * 1024;
const EMPTY = Buffer.alloc(0);

export function seal(cipher: CipherState, text: string): Buffer[] {
  const data = Buffer.from(text, 'utf8');
  const out: Buffer[] = [];
  for (let at = 0; at === 0 || at < data.length; at += MAX_CHUNK) {
    const part = data.subarray(at, at + MAX_CHUNK);
    const last = at + MAX_CHUNK >= data.length;
    out.push(cipher.encrypt(EMPTY, Buffer.concat([Buffer.from([last ? 1 : 0]), part])));
  }
  return out;
}

/** Reassembles chunked messages; `open` returns the text once the last chunk arrives. */
export class Opener {
  private parts: Buffer[] = [];
  private size = 0;

  constructor(private readonly cipher: CipherState) {}

  open(ciphertext: Buffer): string | null {
    const plain = this.cipher.decrypt(EMPTY, ciphertext);
    if (plain.length < 1 || plain[0] > 1) throw new Error('bad chunk');
    this.size += plain.length - 1;
    if (this.size > MAX_MESSAGE) throw new Error('message too large');
    this.parts.push(plain.subarray(1));
    if (plain[0] === 0) return null;
    const text = Buffer.concat(this.parts).toString('utf8');
    this.parts = [];
    this.size = 0;
    return text;
  }
}
