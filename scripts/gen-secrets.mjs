#!/usr/bin/env node
/**
 * Ticket-signing key pair for the control plane. `make secrets` stores fresh keys through scripts/setup.mjs; running
 * this file directly (`node scripts/gen-secrets.mjs`) prints a pair for manual setups (docs/deployment.md).
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** A fresh Ed25519 pair as the server expects it, self-checked (signs and verifies). */
export function generateTicketKeys(kid = process.env.TICKET_KID || 'k1') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'jwk' });
  const pub = { ...publicKey.export({ format: 'jwk' }), alg: 'EdDSA', use: 'sig', kid };
  const msg = Buffer.from('hivetex');
  const ok = verify(null, msg, createPublicKey({ key: pub, format: 'jwk' }), sign(null, msg, createPrivateKey({ key: priv, format: 'jwk' })));
  if (!ok) throw new Error('generated ticket keys failed the sign/verify self-check');
  return { signingJwk: JSON.stringify(priv), publicJwks: JSON.stringify([{ kid, jwk: pub }]), kid };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const k = generateTicketKeys();
  console.log(`# Keep TICKET_SIGNING_JWK secret. To store keys automatically instead, run: make secrets
TICKET_SIGNING_JWK=${k.signingJwk}
TICKET_PUBLIC_JWKS=${k.publicJwks}
TICKET_KID=${k.kid}`);
}
