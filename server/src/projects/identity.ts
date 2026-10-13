import { randomBytes } from 'node:crypto';
import * as v from 'valibot';

/** Prefix input is separate from the broad legacy ID validator used for joining. */
export const ProjectPrefix = v.pipe(
  v.string(),
  v.trim(),
  v.toLowerCase(),
  v.regex(/^[a-z0-9-]{1,48}$/, 'Name must be 1–48 characters of a–z, 0–9 or -'),
  v.transform((s) => s.replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 31).replace(/-$/, '')),
  v.minLength(1, 'Enter a project name containing a letter or number'),
);

/** Ten random bytes encode exactly 80 bits, without truncating or hashing a name. */
export function projectSuffix(bytes: Uint8Array = randomBytes(10)): string {
  if (bytes.length !== 10) throw new Error('A project suffix needs 10 random bytes');
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

export function projectShareId(prefix = 'project', suffix: () => string = projectSuffix): string {
  return `${v.parse(ProjectPrefix, prefix)}-${suffix()}`;
}
