import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { TicketError, fromB64u, generateDeviceKeys, open, seal, sign, toB64u, verify, verifyTicket } from '../src/index.js';

describe('device keys', () => {
  for (const forceNoble of [false, true]) {
    it(`signs and verifies (${forceNoble ? 'noble' : 'webcrypto'})`, async () => {
      const k = await generateDeviceKeys({ forceNoble });
      const msg = new TextEncoder().encode('hello');
      const sig = await sign(k, msg);
      expect(await verify(k.edPub, msg, sig)).toBe(true);
      expect(await verify(k.edPub, new TextEncoder().encode('hellO'), sig)).toBe(false);
    });
  }
  it('uses non-extractable private keys with WebCrypto', async () => {
    const k = await generateDeviceKeys();
    if (k.kind === 'webcrypto') {
      expect(k.edPriv.extractable).toBe(false);
      expect(k.xPriv.extractable).toBe(false);
    }
  });
  it('base64url round trips', () => {
    const b = new Uint8Array([0, 255, 128, 7, 250]);
    expect(Array.from(fromB64u(toB64u(b)))).toEqual(Array.from(b));
  });
});

describe('E2E envelope', () => {
  it('round trips across implementations (webcrypto <-> noble) and binds AAD', async () => {
    const a = await generateDeviceKeys();
    const b = await generateDeviceKeys({ forceNoble: true });
    const msg = new TextEncoder().encode('{"sdp":"v=0..."}');
    const env = await seal(a, b.xPub, msg, 'p1|a|b');
    expect(new TextDecoder().decode(await open(b, a.xPub, env, 'p1|a|b'))).toBe('{"sdp":"v=0..."}');
    await expect(open(b, a.xPub, env, 'p1|a|c')).rejects.toThrow();
    const c = await generateDeviceKeys();
    await expect(open(c, a.xPub, env, 'p1|a|b')).rejects.toThrow();
    expect(new TextDecoder().decode(env)).not.toContain('sdp');
  });
});

describe('verifyTicket', () => {
  async function setup() {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    const trusted = [{ kid: 'k1', jwk: { ...(await exportJWK(publicKey)), alg: 'EdDSA' } }];
    const mint = (claims: object, o: { kid?: string; exp?: number; iat?: number; key?: CryptoKey } = {}) =>
      new SignJWT({ v: 1, pid: 'p', uid: 'u', uname: 'n', dev: 'd', devX: 'x', devE: 'e', role: 'editor', ep: 1, ...claims })
        .setProtectedHeader({ alg: 'EdDSA', kid: o.kid ?? 'k1', typ: 'p2platex-ticket' })
        .setIssuedAt(o.iat ?? Math.floor(Date.now() / 1000))
        .setExpirationTime(o.exp ?? Math.floor(Date.now() / 1000) + 900)
        .sign(o.key ?? privateKey);
    return { trusted, mint };
  }
  it('accepts a valid ticket', async () => {
    const { trusted, mint } = await setup();
    expect((await verifyTicket(await mint({}), trusted)).role).toBe('editor');
  });
  it('rejects expired, forged and unknown-kid tickets', async () => {
    const { trusted, mint } = await setup();
    const past = Math.floor(Date.now() / 1000) - 3600;
    await expect(verifyTicket(await mint({}, { iat: past - 900, exp: past }), trusted)).rejects.toBeInstanceOf(TicketError);
    const other = await generateKeyPair('EdDSA');
    await expect(verifyTicket(await mint({}, { key: other.privateKey }), trusted)).rejects.toBeInstanceOf(TicketError);
    await expect(verifyTicket(await mint({}, { kid: 'zzz' }), trusted)).rejects.toBeInstanceOf(TicketError);
    const t = await mint({});
    const [h, p, s] = t.split('.');
    const tampered = `${h}.${toB64u(new TextEncoder().encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(fromB64u(p ?? ''))), role: 'owner' })))}.${s}`;
    await expect(verifyTicket(tampered, trusted)).rejects.toBeInstanceOf(TicketError);
  });
});
