import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Handshake, Opener, generateKeyPair, publicKeyOf, seal, fingerprint, MAX_CHUNK, PROLOGUE } from '../src/remote/noise.js';
import { FIXTURES } from './helpers.js';

type Vector = {
  source: string;
  init_prologue: string;
  init_static: string;
  init_ephemeral: string;
  init_remote_static: string;
  resp_prologue: string;
  resp_static: string;
  resp_ephemeral: string;
  handshake_hash?: string;
  messages: { payload: string; ciphertext: string }[];
};

const hex = (s: string) => Buffer.from(s, 'hex');
const pair = (priv: string) => ({ privateKey: hex(priv), publicKey: publicKeyOf(hex(priv)) });
const vectors = (JSON.parse(readFileSync(join(FIXTURES, 'noise-ik-vectors.json'), 'utf8')) as { vectors: Vector[] }).vectors;

describe('Noise IK', () => {
  it('has the vectors', () => expect(vectors.length).toBe(2));

  for (const v of vectors) {
    it(`matches the ${v.source} test vector`, () => {
      const init = new Handshake({ initiator: true, s: pair(v.init_static), e: pair(v.init_ephemeral), rs: hex(v.init_remote_static), prologue: hex(v.init_prologue) });
      const resp = new Handshake({ initiator: false, s: pair(v.resp_static), e: pair(v.resp_ephemeral), prologue: hex(v.resp_prologue) });
      const [m1, m2, ...transport] = v.messages;
      expect(init.writeMessage(hex(m1.payload)).toString('hex')).toBe(m1.ciphertext);
      expect(resp.readMessage(hex(m1.ciphertext)).toString('hex')).toBe(m1.payload);
      expect(resp.remoteStatic!.equals(publicKeyOf(hex(v.init_static)))).toBe(true);
      expect(resp.writeMessage(hex(m2.payload)).toString('hex')).toBe(m2.ciphertext);
      expect(init.readMessage(hex(m2.ciphertext)).toString('hex')).toBe(m2.payload);
      if (v.handshake_hash) {
        expect(init.hash.toString('hex')).toBe(v.handshake_hash);
        expect(resp.hash.toString('hex')).toBe(v.handshake_hash);
      }
      transport.forEach((m, i) => {
        // After the handshake the initiator sends first, then they alternate.
        const [from, to] = i % 2 === 0 ? [init, resp] : [resp, init];
        expect(from.send!.encrypt(Buffer.alloc(0), hex(m.payload)).toString('hex')).toBe(m.ciphertext);
        expect(to.receive!.decrypt(Buffer.alloc(0), hex(m.ciphertext)).toString('hex')).toBe(m.payload);
      });
    });
  }

  function connect() {
    const phone = generateKeyPair();
    const mac = generateKeyPair();
    const init = new Handshake({ initiator: true, s: phone, rs: mac.publicKey });
    const resp = new Handshake({ initiator: false, s: mac });
    resp.readMessage(init.writeMessage(Buffer.from('{"v":1}')));
    init.readMessage(resp.writeMessage(Buffer.from('{"v":1}')));
    return { init, resp, phone, mac };
  }

  it('tells the responder who connected', () => {
    const { resp, phone } = connect();
    expect(resp.remoteStatic!.equals(phone.publicKey)).toBe(true);
  });

  it('fails the handshake when the client has the wrong computer key', () => {
    const resp = new Handshake({ initiator: false, s: generateKeyPair() });
    const init = new Handshake({ initiator: true, s: generateKeyPair(), rs: generateKeyPair().publicKey });
    expect(() => resp.readMessage(init.writeMessage(Buffer.from('{"v":1}')))).toThrow();
  });

  it('carries large messages in chunks and rejects tampering and replays', () => {
    const { init, resp } = connect();
    const big = JSON.stringify({ text: 'x'.repeat(MAX_CHUNK * 2 + 10) });
    const chunks = seal(init.send!, big);
    expect(chunks.length).toBe(3);
    const opener = new Opener(resp.receive!);
    expect(opener.open(chunks[0])).toBeNull();
    expect(opener.open(chunks[1])).toBeNull();
    expect(opener.open(chunks[2])).toBe(big);

    const [one] = seal(resp.send!, '{"t":"reply"}');
    const back = new Opener(init.receive!);
    expect(back.open(one)).toBe('{"t":"reply"}');
    // The same message again is out of order now.
    expect(() => back.open(one)).toThrow();

    const [two] = seal(resp.send!, '{"t":"ok"}');
    two[5] ^= 1;
    expect(() => back.open(two)).toThrow();
  });

  it('seals an empty message as one chunk', () => {
    const { init, resp } = connect();
    expect(new Opener(resp.receive!).open(seal(init.send!, '')[0])).toBe('');
  });

  it('prints fingerprints like the phone does', () => {
    expect(fingerprint(Buffer.alloc(32))).toMatch(/^[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}$/);
  });

  it('matches the interop fixture the Swift tests replay', () => {
    const f = JSON.parse(readFileSync(join(FIXTURES, 'noise-interop.json'), 'utf8'));
    const init = new Handshake({ initiator: true, s: pair(f.phoneStatic), e: pair(f.phoneEphemeral), rs: hex(f.macPublic), prologue: PROLOGUE });
    const resp = new Handshake({ initiator: false, s: pair(f.macStatic), e: pair(f.macEphemeral), prologue: PROLOGUE });
    expect(init.writeMessage(Buffer.from(f.payload1)).toString('hex')).toBe(f.message1);
    expect(resp.readMessage(hex(f.message1)).toString()).toBe(f.payload1);
    expect(resp.writeMessage(Buffer.from(f.payload2)).toString('hex')).toBe(f.message2);
    expect(init.readMessage(hex(f.message2)).toString()).toBe(f.payload2);
    const opener = new Opener(init.receive!);
    let text: string | null = null;
    for (const c of f.macToPhone) text = opener.open(hex(c)) ?? text;
    expect(text).toBe(f.macToPhoneText);
    const phoneOpener = new Opener(resp.receive!);
    expect(phoneOpener.open(hex(f.phoneToMac[0]))).toBe(f.phoneToMacText);
  });
});
