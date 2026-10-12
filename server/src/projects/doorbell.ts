import { createHash, createHmac, randomBytes } from 'node:crypto';
import { type DoorbellInfo, RING_TTL_SEC, RING_TYP } from '@hivetex/protocol';
import { SignJWT, importJWK } from 'jose';
import type { Config } from '../config.js';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(bytes: Uint8Array) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * The project's ring topic for one membership epoch (D14): HMAC of project and epoch under a key derived from the ticket
 * signing key, so no new secret is needed and an epoch change (removal, demotion) moves every device to a topic the removed
 * member never learns. 128 bits, base32, prefixed: reveals neither project nor user.
 */
export function ringTopic(cfg: Config, projectId: string, epoch: number) {
  const key = createHash('sha256').update('hivetex/ring-topic/v1\0').update(cfg.ticketPrivateJwk).digest();
  const mac = createHmac('sha256', key).update(`${projectId}\0${epoch}`).digest();
  return `ht${base32(mac.subarray(0, 16)).slice(0, 26)}`;
}

export function doorbellInfo(cfg: Config, projectId: string, epoch: number): DoorbellInfo | null {
  return cfg.doorbellUrl ? { url: cfg.doorbellUrl, topic: ringTopic(cfg, projectId, epoch) } : null;
}

/** A short-lived ring token: proof that a current member asked, carrying only topic, epoch, times and a nonce. */
export async function signRingToken(cfg: Config, topic: string, epoch: number, nowSec: number) {
  const key = await importJWK(JSON.parse(cfg.ticketPrivateJwk), 'EdDSA');
  return new SignJWT({ v: 1, topic, ep: epoch, n: randomBytes(16).toString('base64url') })
    .setProtectedHeader({ alg: 'EdDSA', kid: cfg.ticketKid, typ: RING_TYP })
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + RING_TTL_SEC)
    .sign(key);
}
