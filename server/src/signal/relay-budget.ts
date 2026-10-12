import { createHash, randomBytes } from 'node:crypto';
import type { TicketClaims } from '@hivetex/protocol';
import type { RelayAdmission, RelayDebit } from './application-relay.js';

export interface RelayBudgetLimits {
  bytes: number;
  envelopes: number;
  sessions: number;
  accountBytes: number;
  accountEnvelopes: number;
  accountSessions: number;
  deviceSessions: number;
  /**
   * Relay socket time per window, deployment-wide and per account (seconds). On Vercel an open socket keeps provisioned
   * memory billed (D13/D14), so relay sessions are charged their lease up front like the byte credits.
   */
  socketSeconds: number;
  accountSocketSeconds: number;
  /** Defaults to a rolling thirty days; configurable for local acceptance runs. */
  windowMs?: number;
}
export const DEFAULT_RELAY_LIMITS: RelayBudgetLimits = {
  bytes: 1024 ** 3, envelopes: 100_000, sessions: 64,
  accountBytes: 256 * 1024 ** 2, accountEnvelopes: 25_000, accountSessions: 8, deviceSessions: 4,
  // 50 h of relay sockets per 30 days (~100 GB-h at 2 GB), 10 h per account.
  socketSeconds: 180_000, accountSocketSeconds: 36_000,
};
export interface EvalRedis { eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>; }

/**
 * All counters and rolling-window reclamation happen in one Redis script, so competing instances share one allowance.
 * Each caller passes its own configured limits: during a rollout an instance never exceeds its own ceiling against the
 * shared counters. Metadata contains hashed principals and sizes only, never content.
 */
export const RELAY_BUDGET_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local op = ARGV[1]
local member = ARGV[2]
local identity = cjson.decode(member)
local user = identity[2]
local device = identity[3]
local window = tonumber(ARGV[3])
local function dec(key, field, by)
  if redis.call('HINCRBY', key, field, -by) <= 0 then redis.call('HDEL', key, field) end
end
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, 128)
for _, m in ipairs(expired) do
  local id = cjson.decode(m)
  redis.call('ZREM', KEYS[1], m)
  dec(KEYS[2], id[2], 1)
  dec(KEYS[2], id[3], 1)
end
local old = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now - window, 'LIMIT', 0, 128)
for _, m in ipairs(old) do
  local grant = cjson.decode(m)
  redis.call('ZREM', KEYS[3], m)
  for _, p in ipairs({'all', grant[4]}) do
    dec(KEYS[4], p .. ':bytes', grant[2])
    dec(KEYS[4], p .. ':frames', grant[3])
    if grant[5] then dec(KEYS[4], p .. ':seconds', grant[5]) end
  end
end
local function count(key, field) return tonumber(redis.call('HGET', key, field) or '0') end
if op == 'close' then
  if redis.call('ZREM', KEYS[1], member) == 1 then
    dec(KEYS[2], user, 1)
    dec(KEYS[2], device, 1)
  end
  return {1, 0}
end
local limits = cjson.decode(ARGV[4])
if op == 'acquire' then
  if redis.call('ZSCORE', KEYS[1], member) then return {0, 0} end
  if redis.call('ZCARD', KEYS[1]) >= limits.sessions or count(KEYS[2], user) >= limits.accountSessions or count(KEYS[2], device) >= limits.deviceSessions then return {0, 0} end
  local expiry = math.min(now + 300000, tonumber(ARGV[5]))
  if expiry <= now then return {0, 0} end
  local seconds = math.ceil((expiry - now) / 1000)
  if count(KEYS[4], 'all:seconds') + seconds > limits.socketSeconds or count(KEYS[4], user .. ':seconds') + seconds > limits.accountSocketSeconds then return {0, 0} end
  for _, p in ipairs({'all', user}) do redis.call('HINCRBY', KEYS[4], p .. ':seconds', seconds) end
  redis.call('ZADD', KEYS[3], expiry, cjson.encode({ARGV[7], 0, 0, user, seconds}))
  redis.call('PEXPIRE', KEYS[3], window + 301000)
  redis.call('PEXPIRE', KEYS[4], window + 301000)
  redis.call('ZADD', KEYS[1], expiry, member)
  redis.call('HINCRBY', KEYS[2], user, 1)
  redis.call('HINCRBY', KEYS[2], device, 1)
  redis.call('PEXPIRE', KEYS[1], 301000)
  redis.call('PEXPIRE', KEYS[2], 301000)
  return {1, expiry - now}
end
local expiry = tonumber(redis.call('ZSCORE', KEYS[1], member) or '0')
if expiry <= now then return {0, 0} end
local requestedBytes = tonumber(ARGV[5])
local frames = tonumber(ARGV[6])
if count(KEYS[4], 'all:bytes') + requestedBytes > limits.bytes or count(KEYS[4], 'all:frames') + frames > limits.envelopes or count(KEYS[4], user .. ':bytes') + requestedBytes > limits.accountBytes or count(KEYS[4], user .. ':frames') + frames > limits.accountEnvelopes then return {0, 0} end
for _, p in ipairs({'all', user}) do
  redis.call('HINCRBY', KEYS[4], p .. ':bytes', requestedBytes)
  redis.call('HINCRBY', KEYS[4], p .. ':frames', frames)
end
local creditTTL = math.min(5000, window, expiry - now)
-- Keep the charge for a full rolling window after its last possible use.
redis.call('ZADD', KEYS[3], now + creditTTL, cjson.encode({ARGV[7], requestedBytes, frames, user}))
redis.call('PEXPIRE', KEYS[3], window + 301000)
redis.call('PEXPIRE', KEYS[4], window + 301000)
return {1, creditTTL}
`;

const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const positive = (v: number) => Number.isSafeInteger(v) && v > 0;
/** Credits are charged once, up front; abandoned or crashed grants are intentionally never refunded. */
export function createRedisRelayAdmission(redis: EvalRedis, namespace: string, given: Partial<RelayBudgetLimits> = DEFAULT_RELAY_LIMITS): RelayAdmission {
  const limits: RelayBudgetLimits = { ...DEFAULT_RELAY_LIMITS, ...given };
  for (const value of Object.values(limits)) if (!positive(value)) throw new Error('invalid relay budget');
  const windowMs = limits.windowMs ?? 30 * 24 * 3600_000;
  const policy = JSON.stringify({ ...limits, windowMs });
  const prefix = 'relay-budget:{' + digest(namespace) + '}:';
  const keys = ['sessions', 'session-counts', 'grants', 'usage'].map(s => prefix + s);
  const run = async (op: string, member: string, value = 0, frames = 0) => {
    const result = await redis.eval(RELAY_BUDGET_SCRIPT, keys, [op, member, windowMs, policy, value, frames, randomBytes(16).toString('hex')]);
    if (!Array.isArray(result) || Number(result[0]) !== 1) return null;
    return Number(result[1]);
  };
  return {
    async acquire(claims: TicketClaims, sid: string) {
      const member = JSON.stringify([sid, 'u:' + digest(claims.uid), 'd:' + digest(JSON.stringify([claims.uid, claims.dev]))]);
      const started = performance.now();
      let lease: number | null;
      try { lease = await run('acquire', member, claims.exp * 1000); } catch { return null; }
      if (lease === null) return null;
      const expires = started + lease;
      let closed = false, frames = 0, bytes = 0, creditExpiry = 0;
      let chain: Promise<unknown> = Promise.resolve();
      const live = () => !closed && performance.now() < expires;
      const close = () => { if (closed) return; closed = true; frames = bytes = 0; void run('close', member).catch(() => {}); };
      return {
        close,
        debit(size: number) {
          const request = chain.then(async (): Promise<RelayDebit> => {
            if (!live() || !Number.isSafeInteger(size) || size <= 0 || size > 3 * 64 * 1024) return 'limited';
            if (performance.now() >= creditExpiry) frames = bytes = 0;
            if (frames < 1 || bytes < size) {
              const requestedBytes = Math.max(size, Math.min(16 * 1024, limits.bytes, limits.accountBytes));
              const requestedFrames = Math.min(4, limits.envelopes, limits.accountEnvelopes);
              const at = performance.now();
              let ttl: number | null;
              try { ttl = await run('grant', member, requestedBytes, requestedFrames); } catch { return 'unavailable'; }
              if (ttl === null || !live()) return 'limited';
              creditExpiry = at + ttl;
              bytes = requestedBytes; frames = requestedFrames;
              if (performance.now() >= creditExpiry) { frames = bytes = 0; return 'limited'; }
            }
            frames--; bytes -= size;
            return 'ok';
          });
          chain = request.catch(() => {});
          return request;
        },
      };
    },
  };
}

/** Measured by scripts/usage-report.ts (4.63 per data or ACK envelope), rounded up. */
export const RELAY_COMMANDS_PER_ENVELOPE = 5;

/**
 * Relay forwarding is opt-in per deployment (`APPLICATION_RELAY=1`) and only after the operator has measured headroom
 * (docs/deployment.md): `RELAY_PROVIDER_COMMANDS` is the monthly Redis command allowance the deployment may use and
 * `RELAY_BASELINE_COMMANDS` the measured monthly usage without relay traffic. Startup refuses a profile whose envelope cap
 * does not fit the remaining headroom. Every `RELAY_*` value must be a positive integer; anything else refuses to start.
 */
export function relayLimitsFromEnv(env: NodeJS.ProcessEnv): RelayBudgetLimits | null {
  if (env.APPLICATION_RELAY !== '1') return null;
  const required = (name: string) => {
    const value = Number(env[name]);
    if (!env[name] || !positive(value)) throw new Error(`${name} must be set to a positive integer to enable APPLICATION_RELAY`);
    return value;
  };
  const provider = required('RELAY_PROVIDER_COMMANDS'), baseline = required('RELAY_BASELINE_COMMANDS');
  const names: Record<keyof RelayBudgetLimits, string> = {
    bytes: 'RELAY_BYTES', envelopes: 'RELAY_ENVELOPES', sessions: 'RELAY_SESSIONS',
    accountBytes: 'RELAY_ACCOUNT_BYTES', accountEnvelopes: 'RELAY_ACCOUNT_ENVELOPES', accountSessions: 'RELAY_ACCOUNT_SESSIONS',
    deviceSessions: 'RELAY_DEVICE_SESSIONS', windowMs: 'RELAY_WINDOW_MS',
    socketSeconds: 'RELAY_SOCKET_SECONDS', accountSocketSeconds: 'RELAY_ACCOUNT_SOCKET_SECONDS',
  };
  const limits: RelayBudgetLimits = { ...DEFAULT_RELAY_LIMITS };
  for (const [key, name] of Object.entries(names) as [keyof RelayBudgetLimits, string][]) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (!positive(value)) throw new Error(`${name} must be a positive integer`);
    limits[key] = value;
  }
  // Envelope caps are per rolling window; scale the reserved load to a 30-day month.
  const months = (30 * 24 * 3600_000) / (limits.windowMs ?? 30 * 24 * 3600_000);
  const reserved = Math.ceil(limits.envelopes * months * RELAY_COMMANDS_PER_ENVELOPE);
  if (baseline + reserved > provider) {
    throw new Error(`relay profile needs ${reserved} commands/month on top of a ${baseline} baseline, above RELAY_PROVIDER_COMMANDS=${provider}; lower RELAY_ENVELOPES`);
  }
  return limits;
}

/**
 * Single-process admission with the same session and window limits, for the local dev server and its browser tests
 * (`APPLICATION_RELAY=1 pnpm --filter @hivetex/server dev`). Not for deployments: counters do not span instances.
 */
export function createMemoryRelayAdmission(given: Partial<RelayBudgetLimits> = DEFAULT_RELAY_LIMITS, now = () => Date.now()): RelayAdmission {
  const limits: RelayBudgetLimits = { ...DEFAULT_RELAY_LIMITS, ...given };
  const windowMs = limits.windowMs ?? 30 * 24 * 3600_000;
  const sessions = new Map<string, { user: string; device: string }>();
  const grants: Array<{ at: number; bytes: number; user: string; seconds?: number }> = [];
  const count = (k: 'user' | 'device', v: string) => [...sessions.values()].filter(s => s[k] === v).length;
  return {
    async acquire(claims, sid) {
      const user = claims.uid, device = `${claims.uid}/${claims.dev}`;
      if (sessions.has(sid) || sessions.size >= limits.sessions || count('user', user) >= limits.accountSessions || count('device', device) >= limits.deviceSessions) return null;
      if (claims.exp * 1000 <= now()) return null;
      while (grants.length && (grants[0]?.at ?? 0) <= now() - windowMs) grants.shift();
      const seconds = Math.ceil((Math.min(now() + 300_000, claims.exp * 1000) - now()) / 1000);
      const used = (f: (g: (typeof grants)[number]) => boolean) => grants.filter(f).reduce((a, g) => a + (g.seconds ?? 0), 0);
      if (used(() => true) + seconds > limits.socketSeconds || used((g) => g.user === user) + seconds > limits.accountSocketSeconds) return null;
      grants.push({ at: now(), bytes: 0, user, seconds });
      sessions.set(sid, { user, device });
      let closed = false;
      return {
        close() { closed = true; sessions.delete(sid); },
        async debit(size: number): Promise<RelayDebit> {
          if (closed || claims.exp * 1000 <= now() || !Number.isSafeInteger(size) || size <= 0) return 'limited';
          while (grants.length && (grants[0]?.at ?? 0) <= now() - windowMs) grants.shift();
          const data = grants.filter(g => !g.seconds);
          const all = data.reduce((a, g) => a + g.bytes, 0), mine = data.filter(g => g.user === user);
          if (data.length + 1 > limits.envelopes || all + size > limits.bytes || mine.length + 1 > limits.accountEnvelopes || mine.reduce((a, g) => a + g.bytes, 0) + size > limits.accountBytes) return 'limited';
          grants.push({ at: now(), bytes: size, user });
          return 'ok';
        },
      };
    },
  };
}
