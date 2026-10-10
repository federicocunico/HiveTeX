import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { TICKET_TYP, type TicketClaims, type TrustedKey } from '@hivetex/protocol';
import { type JWK, importJWK, jwtVerify } from 'jose';

const enc = new TextEncoder();
const subtle = globalThis.crypto.subtle;
const bs = (u: Uint8Array) => u as unknown as BufferSource;

export const toB64u = (b: Uint8Array): string => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const fromB64u = (s: string): Uint8Array => {
  const p = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(p);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

// ---------------------------------------------------------------------------------------------
// Device keys: Ed25519 (signing) + X25519 (key agreement).
// Preferred: WebCrypto with NON-extractable private keys (storable in IndexedDB by structured
// clone, or by the OS keychain on desktop). Fallback: @noble/curves with raw key bytes.
// ---------------------------------------------------------------------------------------------

export type StoredDeviceKeys =
  | { kind: 'webcrypto'; edPriv: CryptoKey; xPriv: CryptoKey; edPub: string; xPub: string }
  | { kind: 'noble'; edSeed: Uint8Array; xSeed: Uint8Array; edPub: string; xPub: string };

async function webcryptoSupported(): Promise<boolean> {
  try {
    await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    return true;
  } catch {
    return false;
  }
}

export async function generateDeviceKeys(opts: { forceNoble?: boolean } = {}): Promise<StoredDeviceKeys> {
  if (!opts.forceNoble && (await webcryptoSupported())) {
    const ed = (await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const x = (await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
    const edPub = new Uint8Array(await subtle.exportKey('raw', ed.publicKey));
    const xPub = new Uint8Array(await subtle.exportKey('raw', x.publicKey));
    // Re-import the private keys as non-extractable so scripts (XSS) cannot read the key bytes.
    const edJwk = await subtle.exportKey('jwk', ed.privateKey);
    const xJwk = await subtle.exportKey('jwk', x.privateKey);
    const edPriv = await subtle.importKey('jwk', edJwk, { name: 'Ed25519' }, false, ['sign']);
    const xPriv = await subtle.importKey('jwk', xJwk, { name: 'X25519' }, false, ['deriveBits']);
    return { kind: 'webcrypto', edPriv, xPriv, edPub: toB64u(edPub), xPub: toB64u(xPub) };
  }
  const edSeed = ed25519.utils.randomSecretKey();
  const xSeed = x25519.utils.randomSecretKey();
  return {
    kind: 'noble',
    edSeed,
    xSeed,
    edPub: toB64u(ed25519.getPublicKey(edSeed)),
    xPub: toB64u(x25519.getPublicKey(xSeed)),
  };
}

export async function sign(keys: StoredDeviceKeys, msg: Uint8Array): Promise<Uint8Array> {
  if (keys.kind === 'webcrypto') return new Uint8Array(await subtle.sign({ name: 'Ed25519' }, keys.edPriv, bs(msg)));
  return ed25519.sign(msg, keys.edSeed);
}

export async function verify(edPubB64: string, msg: Uint8Array, sig: Uint8Array): Promise<boolean> {
  try {
    return ed25519.verify(sig, msg, fromB64u(edPubB64));
  } catch {
    return false;
  }
}

async function sharedSecret(keys: StoredDeviceKeys, peerXPub: Uint8Array): Promise<Uint8Array> {
  if (keys.kind === 'webcrypto') {
    const peer = await subtle.importKey('raw', bs(peerXPub), { name: 'X25519' }, false, []);
    return new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: peer }, keys.xPriv, 256));
  }
  return x25519.getSharedSecret(keys.xSeed, peerXPub);
}

async function aesKey(secret: Uint8Array, info: string, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  const ikm = await subtle.importKey('raw', bs(secret), 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(info) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

const ENVELOPE_INFO = 'hivetex/envelope/v1';

/**
 * Seals a message for a peer device (X25519 -> HKDF -> AES-256-GCM). `aad` binds the envelope to
 * its context (e.g. project id and both device ids) so it cannot be replayed elsewhere.
 * Output: 12-byte nonce || ciphertext+tag.
 */
export async function seal(
  keys: StoredDeviceKeys,
  peerXPubB64: string,
  plaintext: Uint8Array,
  aad: string,
): Promise<Uint8Array> {
  const key = await aesKey(await sharedSecret(keys, fromB64u(peerXPubB64)), ENVELOPE_INFO, 'encrypt');
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: enc.encode(aad) }, key, bs(plaintext)));
  return concat(nonce, ct);
}

export async function open(
  keys: StoredDeviceKeys,
  peerXPubB64: string,
  envelope: Uint8Array,
  aad: string,
): Promise<Uint8Array> {
  const key = await aesKey(await sharedSecret(keys, fromB64u(peerXPubB64)), ENVELOPE_INFO, 'decrypt');
  return new Uint8Array(
    await subtle.decrypt(
      { name: 'AES-GCM', iv: envelope.slice(0, 12), additionalData: enc.encode(aad) },
      key,
      bs(envelope.slice(12)),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------------------------

export class TicketError extends Error {}

/** Verifies a membership ticket offline against pinned control-plane public keys. */
export async function verifyTicket(
  token: string,
  trusted: TrustedKey[],
  opts: { now?: Date; clockToleranceSec?: number } = {},
): Promise<TicketClaims> {
  const header = JSON.parse(new TextDecoder().decode(fromB64u(token.split('.')[0] ?? '')) || '{}') as {
    kid?: string;
    typ?: string;
    alg?: string;
  };
  if (header.alg !== 'EdDSA' || header.typ !== TICKET_TYP) throw new TicketError('bad ticket header');
  const k = trusted.find((t) => t.kid === header.kid);
  if (!k) throw new TicketError('unknown ticket key');
  try {
    const pub = await importJWK(k.jwk as JWK, 'EdDSA');
    const { payload } = await jwtVerify(token, pub, {
      algorithms: ['EdDSA'],
      currentDate: opts.now ?? new Date(),
      clockTolerance: opts.clockToleranceSec ?? 30,
    });
    const c = payload as unknown as TicketClaims;
    if (c.v !== 1 || !c.pid || !c.dev || !c.devE || !c.devX) throw new TicketError('malformed claims');
    return c;
  } catch (e) {
    if (e instanceof TicketError) throw e;
    throw new TicketError('ticket verification failed');
  }
}
