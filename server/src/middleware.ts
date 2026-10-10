import type { MiddlewareHandler } from 'hono';
import { AppError } from './errors.js';
import type { Env } from './deps.js';
import { randomId } from './util.js';

export const requestContext: MiddlewareHandler<Env> = async (c, next) => {
  c.set('requestId', c.req.header('x-vercel-id') ?? randomId());
  const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  c.set('ip', fwd ?? c.req.header('x-real-ip') ?? 'unknown');
  await next();
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
};

/**
 * CSRF defense for state-changing requests: a custom header that cross-site forms cannot set,
 * plus an Origin allow-list when the browser sends one.
 */
export const csrfGuard: MiddlewareHandler<Env> = async (c, next) => {
  const m = c.req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
  if (c.req.header('x-requested-with') !== 'hivetex') throw new AppError(403, 'csrf', 'Missing request header');
  const origin = c.req.header('origin');
  if (origin) {
    const { config } = c.get('deps');
    if (origin !== config.appOrigin && !config.extraOrigins.includes(origin)) {
      throw new AppError(403, 'csrf', 'Origin not allowed');
    }
  }
  return next();
};

export const rateLimit =
  (name: string, limit: number, windowSec: number, by: 'ip' = 'ip'): MiddlewareHandler<Env> =>
  async (c, next) => {
    const { limiter } = c.get('deps');
    const key = `${name}:${by === 'ip' ? c.get('ip') : ''}`;
    const r = await limiter.hit(key, limit, windowSec);
    if (!r.ok) throw new AppError(429, 'rate_limited', 'Too many requests', { 'Retry-After': String(r.retryAfter) });
    await next();
  };
