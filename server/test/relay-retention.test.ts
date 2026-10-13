import { randomBytes } from 'node:crypto';
import { verifyTicket } from '@hivetex/crypto';
import { Redis } from '@upstash/redis';
import { TestAuthority, identity, waitFor } from '@hivetex/sync/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { createApplicationRelayRouter } from '../src/signal/application-relay.js';
import { createUpstashSignalBackend } from '../src/signal/hub.js';
import { createRedisRelayAdmission, type EvalRedis } from '../src/signal/relay-budget.js';

/**
 * 2.7: after relay traffic the backend holds routing/usage metadata only. Runs against real Redis (docker stack, see
 * signal-backend-parity.test.ts) because the claim is about what Redis retains.
 */
const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;
afterEach(() => { vi.restoreAllMocks(); });

describe.skipIf(!(url && token))('application relay retention on real Redis', () => {
  it('keeps no envelope in Redis keys or logs after forwarding', async () => {
    const redis = new Redis({ url: url ?? '', token: token ?? '' });
    const logged: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    }
    const auth = await TestAuthority.create();
    const backend = await createUpstashSignalBackend(url ?? '', token ?? '');
    const namespace = 'retention-' + randomBytes(6).toString('hex');
    const admission = createRedisRelayAdmission(redis as unknown as EvalRedis, namespace);
    const router = createApplicationRelayRouter({ namespace, backend, admission, deps: { now: () => new Date(), config: { ticketPublicJwks: auth.trusted } as Config } });
    const pid = 'retention-' + randomBytes(6).toString('hex');
    const node = async (name: string) => {
      const id = await identity(name, 'editor');
      const ticket = await auth.mint({ ...id, pid });
      const sid = 'r1_' + randomBytes(12).toString('base64url');
      await backend.setPresence(pid, id.dev, `${sid}|${ticket}`, 90);
      const inbox: Array<Record<string, unknown>> = [];
      const session = await router.attach({ claims: await verifyTicket(ticket, auth.trusted), sid, active: () => true, send: m => { inbox.push(m as Record<string, unknown>); } });
      return { id, sid, inbox, session };
    };
    const a = await node('alice'), b = await node('bob');
    const marker = 'CIPHERTEXTMARKER' + randomBytes(16).toString('hex');
    await a.session.forward({ t: 'app-relay', to: b.id.dev, sid: b.sid, env: marker });
    await waitFor(() => b.inbox.length === 1, 5000);
    expect(b.inbox[0]?.env).toBe(marker);
    a.session.close(); b.session.close();

    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(cursor, { count: 500 });
      cursor = String(next);
      keys.push(...batch);
    } while (cursor !== '0');
    const dump: string[] = [];
    for (const key of keys) {
      const type = await redis.type(key);
      const value = type === 'string' ? await redis.get(key) : type === 'hash' ? await redis.hgetall(key)
        : type === 'zset' ? await redis.zrange(key, 0, -1) : type === 'list' ? await redis.lrange(key, 0, -1)
        : type === 'set' ? await redis.smembers(key) : type;
      dump.push(key, JSON.stringify(value));
    }
    expect(keys.some(k => k.includes('stream') || k.includes('app-relay'))).toBe(false);
    expect(dump.join('\n')).not.toContain(marker);
    expect(logged.join('\n')).not.toContain(marker);
    // Only presence and hashed budget metadata were written for this project and namespace.
    expect(keys.filter(k => k.includes(pid))).toEqual([`presence:${pid}`]);
  }, 20_000);
});
