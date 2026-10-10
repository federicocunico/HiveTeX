#!/usr/bin/env node
/**
 * Prints fresh server secrets for a deployment and the commands that store them (`make secrets`).
 * Writes nothing to disk: copy the commands you need. Run again to rotate (see docs/deployment.md).
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const kid = process.env.TICKET_KID || 'k1';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const priv = privateKey.export({ format: 'jwk' });
const pub = { ...publicKey.export({ format: 'jwk' }), alg: 'EdDSA', use: 'sig', kid };
const signingJwk = JSON.stringify(priv);
const publicJwks = JSON.stringify([{ kid, jwk: pub }]);

// Self-check: the printed pair signs and verifies (catches a broken Node crypto build before you deploy it).
const msg = Buffer.from('p2platex');
const ok = verify(null, msg, createPublicKey({ key: pub, format: 'jwk' }), sign(null, msg, createPrivateKey({ key: priv, format: 'jwk' })));
if (!ok) {
  console.error('Generated keys failed the sign/verify self-check; not printing them.');
  process.exit(1);
}

const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`; // POSIX shell quoting
const updaterKey = join(homedir(), '.tauri', 'p2platex.key');

console.log(`# Ticket signing key (server). Keep TICKET_SIGNING_JWK secret.
TICKET_SIGNING_JWK=${signingJwk}
TICKET_PUBLIC_JWKS=${publicJwks}
TICKET_KID=${kid}

# Store them in Vercel (production and preview), from a checkout linked with \`npx vercel@latest link\`:
for env in production preview; do
  printf %s ${q(signingJwk)} | npx vercel@latest env add TICKET_SIGNING_JWK $env
  printf %s ${q(publicJwks)} | npx vercel@latest env add TICKET_PUBLIC_JWKS $env
  printf %s ${kid} | npx vercel@latest env add TICKET_KID $env
done

# Desktop releases (GitHub repository secret for signing auto-updates):`);
if (existsSync(updaterKey)) console.log(`gh secret set TAURI_SIGNING_PRIVATE_KEY < ${q(updaterKey)}`);
else
  console.log(`npx @tauri-apps/cli signer generate -w ~/.tauri/p2platex.key   # then put the printed public key in
#   apps/desktop/src-tauri/tauri.conf.json (plugins.updater.pubkey) and run:
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/p2platex.key`);
console.log(`# Optional: default server baked into the installers (testers can change it on the sign-in screen):
gh variable set P2PLATEX_API_BASE --body https://<your-app>.vercel.app`);
