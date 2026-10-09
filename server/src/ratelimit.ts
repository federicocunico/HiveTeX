export interface RateLimiter {
  /** Records a hit; ok=false when the key exceeded `limit` hits within `windowSec`. */
  hit(key: string, limit: number, windowSec: number): Promise<{ ok: boolean; retryAfter: number; count: number }>;
  /** Current hit count in the window, without recording a hit. */
  peek(key: string, windowSec: number): Promise<number>;
  reset(key: string): Promise<void>;
}

export class MemoryRateLimiter implements RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private now: () => number = Date.now) {}

  async hit(key: string, limit: number, windowSec: number) {
    const t = this.now();
    const cutoff = t - windowSec * 1000;
    const arr = (this.hits.get(key) ?? []).filter((x) => x > cutoff);
    if (arr.length >= limit) {
      this.hits.set(key, arr);
      const oldest = arr[0] ?? t;
      return { ok: false, retryAfter: Math.max(1, Math.ceil((oldest + windowSec * 1000 - t) / 1000)), count: arr.length + 1 };
    }
    arr.push(t);
    this.hits.set(key, arr);
    return { ok: true, retryAfter: 0, count: arr.length };
  }

  async peek(key: string, windowSec: number) {
    const cutoff = this.now() - windowSec * 1000;
    return (this.hits.get(key) ?? []).filter((x) => x > cutoff).length;
  }

  async reset(key: string) {
    this.hits.delete(key);
  }
}

/** Sliding-window limiter on Upstash Redis (REST, serverless-friendly). */
export async function createUpstashLimiter(url: string, token: string): Promise<RateLimiter> {
  const { Redis } = await import('@upstash/redis');
  const redis = new Redis({ url, token });
  return {
    async hit(key, limit, windowSec) {
      const k = `rl:${key}`;
      const n = await redis.incr(k);
      if (n === 1) await redis.expire(k, windowSec);
      if (n > limit) {
        const ttl = await redis.ttl(k);
        return { ok: false, retryAfter: Math.max(1, ttl), count: n };
      }
      return { ok: true, retryAfter: 0, count: n };
    },
    async peek(key) {
      return Number((await redis.get(`rl:${key}`)) ?? 0);
    },
    async reset(key) {
      await redis.del(`rl:${key}`);
    },
  };
}

/** Never limits. Only for end-to-end test servers that register many users from one address. */
export class UnlimitedRateLimiter implements RateLimiter {
  async hit() {
    return { ok: true, retryAfter: 0, count: 1 };
  }
  async peek() {
    return 0;
  }
  async reset() {}
}
