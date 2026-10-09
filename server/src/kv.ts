/** Short-lived key/value store (Upstash Redis in production). Used for OAuth state and one-time hand-offs. */
export interface Kv {
  set(key: string, value: string, ttlSec: number): Promise<void>;
  get(key: string): Promise<string | null>;
  /** Atomic read-and-delete: a one-time value can be consumed exactly once. */
  take(key: string): Promise<string | null>;
}

export class MemoryKv implements Kv {
  private m = new Map<string, { v: string; exp: number }>();
  constructor(private now: () => number = Date.now) {}
  async set(key: string, value: string, ttlSec: number) {
    this.m.set(key, { v: value, exp: this.now() + ttlSec * 1000 });
  }
  async get(key: string) {
    const e = this.m.get(key);
    if (!e || e.exp < this.now()) return null;
    return e.v;
  }
  async take(key: string) {
    const v = await this.get(key);
    this.m.delete(key);
    return v;
  }
  /** Test helper: everything currently stored. */
  dump() {
    return JSON.stringify([...this.m.entries()]);
  }
}

export async function createUpstashKv(url: string, token: string): Promise<Kv> {
  const { Redis } = await import('@upstash/redis');
  const redis = new Redis({ url, token });
  return {
    async set(key, value, ttlSec) {
      await redis.set(`kv:${key}`, value, { ex: ttlSec });
    },
    async get(key) {
      return (await redis.get<string>(`kv:${key}`)) ?? null;
    },
    async take(key) {
      return (await redis.getdel<string>(`kv:${key}`)) ?? null;
    },
  };
}
