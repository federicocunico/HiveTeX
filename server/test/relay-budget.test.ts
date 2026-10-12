import { createHash, randomBytes } from 'node:crypto';
import type { TicketClaims } from '@hivetex/protocol';
import { Redis } from '@upstash/redis';
import { describe, expect, it } from 'vitest';
import { createRedisRelayAdmission, type EvalRedis, relayLimitsFromEnv, type RelayBudgetLimits } from '../src/signal/relay-budget.js';

/**
 * The atomic budget script needs a real Redis: it runs when `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` are set
 * (the docker stack provides them, see signal-backend-parity.test.ts). Accounting-failure behaviour runs everywhere.
 */
const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;
const claims = (uid: string, dev: string, ttlS = 600, pid = 'p'): TicketClaims =>
  ({ uid, dev, pid, exp: Math.floor(Date.now() / 1000) + ttlS }) as unknown as TicketClaims;
const sid = () => 'r1_' + randomBytes(12).toString('base64url');
const small: RelayBudgetLimits = {
  bytes: 160 * 1024, envelopes: 40, sessions: 6,
  accountBytes: 96 * 1024, accountEnvelopes: 24, accountSessions: 3, deviceSessions: 2,
  socketSeconds: 1_000_000, accountSocketSeconds: 1_000_000,
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe.skipIf(!(url && token))('relay budget on real Redis', () => {
  const client = new Redis({ url: url ?? '', token: token ?? '' });
  const redis = client as unknown as EvalRedis;
  const namespace = () => 'test-' + randomBytes(8).toString('hex');

  it('competing instances and reconnecting principals cannot exceed the shared allowance', async () => {
    const ns = namespace();
    const instances = [createRedisRelayAdmission(redis, ns, small), createRedisRelayAdmission(redis, ns, small)];
    let ok = 0;
    // Six accounts, alternately served by both instances, each reconnecting (new session, new project) once.
    for (let round = 0; round < 2; round++) {
      const sessions = await Promise.all(Array.from({ length: 6 }, (_, i) =>
        instances[i % 2]!.acquire(claims('user' + i, 'dev' + i, 600, 'project' + round), sid())));
      expect(sessions.every(Boolean)).toBe(true);
      const results = await Promise.all(sessions.flatMap(s => Array.from({ length: 12 }, () => s!.debit(4096))));
      ok += results.filter(r => r === 'ok').length;
      for (const s of sessions) s!.close();
      await sleep(50);
    }
    // Credits are reserved in batches of four 16 KiB envelopes: never more than the deployment cap.
    expect(ok).toBeLessThanOrEqual(small.envelopes);
    expect(ok).toBeGreaterThan(0);
    const prefix = 'relay-budget:{' + createHash('sha256').update(ns).digest('hex') + '}:';
    const usage = await client.hgetall<Record<string, number>>(prefix + 'usage');
    const chargedBytes = Number(usage?.['all:bytes'] ?? 0), chargedEnvelopes = Number(usage?.['all:frames'] ?? 0);
    expect(chargedBytes).toBeLessThanOrEqual(small.bytes);
    expect(chargedEnvelopes).toBeLessThanOrEqual(small.envelopes);
    console.log('[budget acceptance] ' + JSON.stringify({ instances: 2, accounts: 6, reconnectRounds: 2,
      attemptedEnvelopes: 144, acceptedEnvelopes: ok, acceptedBytes: ok * 4096, chargedBytes, chargedEnvelopes,
      overshootBytes: Math.max(0, chargedBytes - small.bytes), overshootEnvelopes: Math.max(0, chargedEnvelopes - small.envelopes) }));
  });

  it('one account cannot take the whole deployment allowance', async () => {
    const ns = namespace();
    const admission = createRedisRelayAdmission(redis, ns, small);
    const greedy = await admission.acquire(claims('greedy', 'g1'), sid());
    const results: string[] = [];
    for (let n = 0; n < 40; n++) results.push(await greedy!.debit(4096));
    expect(results.filter(r => r === 'ok').length).toBe(small.accountEnvelopes);
    expect(results.at(-1)).toBe('limited');
    const other = await admission.acquire(claims('other', 'o1'), sid());
    expect(await other!.debit(4096)).toBe('ok');
  });

  it('enforces aggregate, per-account and per-device concurrent sessions and frees them on close', async () => {
    const ns = namespace();
    const admission = createRedisRelayAdmission(redis, ns, small);
    const a1 = await admission.acquire(claims('u', 'd'), sid());
    const a2 = await admission.acquire(claims('u', 'd'), sid());
    expect(a1 && a2).toBeTruthy();
    expect(await admission.acquire(claims('u', 'd'), sid())).toBeNull(); // device ceiling
    expect(await admission.acquire(claims('u', 'd2'), sid())).toBeTruthy();
    expect(await admission.acquire(claims('u', 'd3'), sid())).toBeNull(); // account ceiling
    const repeated = sid();
    expect(await admission.acquire(claims('x', 'x'), repeated)).toBeTruthy();
    expect(await admission.acquire(claims('x', 'x'), repeated)).toBeNull(); // one grant per socket session
    a1!.close();
    await sleep(100);
    expect(await admission.acquire(claims('u', 'd3'), sid())).toBeTruthy();
  });

  it('rejects expired tickets and stops debiting when the session lease ends', async () => {
    const ns = namespace();
    const admission = createRedisRelayAdmission(redis, ns, small);
    expect(await admission.acquire(claims('u', 'd', -1), sid())).toBeNull();
    const short = await admission.acquire(claims('u', 'd', 2), sid());
    expect(await short!.debit(1024)).toBe('ok');
    await sleep(2200);
    expect(await short!.debit(1024)).toBe('limited');
  });

  it('charges spent grants for a full rolling window, then releases them', async () => {
    const ns = namespace();
    const windowMs = 1500;
    const admission = createRedisRelayAdmission(redis, ns, { ...small, envelopes: 4, accountEnvelopes: 4, windowMs });
    const s = await admission.acquire(claims('u', 'd'), sid());
    for (let n = 0; n < 4; n++) expect(await s!.debit(1024)).toBe('ok');
    expect(await s!.debit(1024)).toBe('limited');
    await sleep(windowMs + 200);
    expect(await s!.debit(1024)).toBe('limited'); // the grant's own credit lifetime is also inside the window
    await sleep(windowMs + 200);
    expect(await s!.debit(1024)).toBe('ok');
  });
});

describe('relay budget without accounting', () => {
  it('refuses new sessions and new grants when Redis is unreachable, but spends valid pre-reserved credit', async () => {
    let failing = false, calls = 0;
    const redis: EvalRedis = {
      async eval(_script, _keys, args) {
        calls++;
        if (failing) throw new Error('unreachable');
        return args[0] === 'acquire' ? [1, 60_000] : [1, 5_000];
      },
    };
    const admission = createRedisRelayAdmission(redis, 'n', small);
    const s = await admission.acquire(claims('u', 'd'), sid());
    expect(await s!.debit(1024)).toBe('ok');
    failing = true;
    for (let n = 0; n < 3; n++) expect(await s!.debit(1024)).toBe('ok'); // the remaining credits of the grant
    expect(await s!.debit(1024)).toBe('unavailable');
    expect(await admission.acquire(claims('u', 'd2'), sid())).toBeNull();
    expect(calls).toBe(4);
  });

  it('rejects oversized and invalid debits without contacting Redis', async () => {
    let calls = 0;
    const redis: EvalRedis = { async eval(_s, _k, args) { calls++; return args[0] === 'acquire' ? [1, 60_000] : [1, 5_000]; } };
    const s = await createRedisRelayAdmission(redis, 'n', small).acquire(claims('u', 'd'), sid());
    expect(await s!.debit(3 * 64 * 1024 + 1)).toBe('limited');
    expect(await s!.debit(0)).toBe('limited');
    expect(await s!.debit(1.5)).toBe('limited');
    expect(calls).toBe(1);
  });

  it('parses deployment limits strictly and refuses a profile above the measured headroom', () => {
    const headroom = { APPLICATION_RELAY: '1', RELAY_PROVIDER_COMMANDS: '500000', RELAY_BASELINE_COMMANDS: '100000' };
    expect(relayLimitsFromEnv({})).toBeNull();
    expect(() => relayLimitsFromEnv({ APPLICATION_RELAY: '1' })).toThrow(/RELAY_PROVIDER_COMMANDS/);
    // The shipped 100,000-envelope cap needs 500,000 commands: it does not fit next to any baseline on a 500k plan.
    expect(() => relayLimitsFromEnv(headroom)).toThrow(/lower RELAY_ENVELOPES/);
    expect(relayLimitsFromEnv({ ...headroom, RELAY_ENVELOPES: '80000', RELAY_BYTES: '2048' })).toMatchObject({ envelopes: 80_000, bytes: 2048 });
    // A shorter window repeats its cap more often per month.
    expect(() => relayLimitsFromEnv({ ...headroom, RELAY_ENVELOPES: '80000', RELAY_WINDOW_MS: String(24 * 3600_000) })).toThrow();
    expect(() => relayLimitsFromEnv({ ...headroom, RELAY_ENVELOPES: '-3' })).toThrow(/RELAY_ENVELOPES/);
    expect(() => relayLimitsFromEnv({ ...headroom, RELAY_SESSIONS: 'lots' })).toThrow();
  });
});

describe.skipIf(!(url && token))('relay socket time on real Redis (3B.5)', () => {
  it('charges each relay session its lease against the deployment and account socket time', async () => {
    const redis = new Redis({ url: url ?? '', token: token ?? '' }) as unknown as EvalRedis;
    const ns = 'sock-' + randomBytes(6).toString('hex');
    const admission = createRedisRelayAdmission(redis, ns, { ...small, sessions: 50, accountSessions: 50, deviceSessions: 50, socketSeconds: 900, accountSocketSeconds: 600 });
    // Each lease is 300 s (tickets last 600 s): two per account, three for the deployment.
    expect(await admission.acquire(claims('u', 'd1'), sid())).toBeTruthy();
    expect(await admission.acquire(claims('u', 'd2'), sid())).toBeTruthy();
    expect(await admission.acquire(claims('u', 'd3'), sid())).toBeNull();
    const v = await admission.acquire(claims('v', 'd1'), sid());
    expect(v).toBeTruthy();
    v?.close(); // closing early refunds nothing
    expect(await admission.acquire(claims('w', 'd1'), sid())).toBeNull();
  });
});
