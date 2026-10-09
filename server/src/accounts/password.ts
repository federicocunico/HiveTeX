import { createHash } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { Config } from '../config.js';
import { COMMON_PASSWORDS } from '../data/common-passwords.js';

const ARGON2ID = 2;

export const hashPassword = (pw: string, cfg: Config['argon']) =>
  hash(pw, { algorithm: ARGON2ID, memoryCost: cfg.memoryCost, timeCost: cfg.timeCost, parallelism: cfg.parallelism });

export async function verifyPassword(stored: string, pw: string): Promise<boolean> {
  try {
    return await verify(stored, pw);
  } catch {
    return false;
  }
}

export const MIN_PASSWORD = 12;

/** Offline fallback list check, then HIBP range API (only a 5-char SHA-1 prefix leaves the server). */
export async function isBreached(
  pw: string,
  opts: { online: boolean; fetchFn?: typeof fetch } = { online: true },
): Promise<boolean> {
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) return true;
  if (!opts.online) return false;
  const sha = createHash('sha1').update(pw).digest('hex').toUpperCase();
  const prefix = sha.slice(0, 5);
  const suffix = sha.slice(5);
  try {
    const res = await (opts.fetchFn ?? fetch)(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true' },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return false;
    const body = await res.text();
    return body.split('\n').some((l) => {
      const [s, n] = l.trim().split(':');
      return s === suffix && Number(n) > 0;
    });
  } catch {
    return false; // fail open: offline list already applied
  }
}
