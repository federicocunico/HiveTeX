import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as v from 'valibot';
import type { Context } from 'hono';
import { AppError } from './errors.js';
import type { Env } from './deps.js';

export const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const randomId = () => randomBytes(16).toString('hex');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function parseBody<T extends v.GenericSchema>(c: Context<Env>, schema: T): Promise<v.InferOutput<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError(400, 'bad_json', 'Invalid JSON body');
  }
  const r = v.safeParse(schema, raw);
  if (!r.success) throw new AppError(422, 'validation', r.issues[0]?.message ?? 'Invalid input');
  return r.output;
}
