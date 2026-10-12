import { APPLICATION_RELAY_CAPABILITY, RELAY_SESSION_PREFIX, supportsApplicationRelay, isApplicationRelayMessage } from '@hivetex/protocol';
import { randomBytes } from 'node:crypto';
import { fromB64u, verify } from '@hivetex/crypto';
import { type TicketClaims, type TrustedKey, signalAuthMessage } from '@hivetex/protocol';
import { importJWK, jwtVerify } from 'jose';
import type { Deps } from '../deps.js';

/**
 * Signaling relay. It only ever sees: who is online in which project (from membership tickets),
 * and opaque end-to-end-encrypted envelopes addressed from one device to another. It never
 * parses envelope contents, and nothing is persisted beyond a short-lived presence entry.
 */

export interface SignalBackend {
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, cb: (message: string) => void): Promise<() => void>;
  /**
   * Presence values are `<session id>|<ticket>`: a device's newer session replaces the entry of its older one. Every
   * device has its own lease of `ttlSec` seconds (an entry never keeps another device's entry alive).
   */
  setPresence(projectId: string, deviceId: string, value: string, ttlSec: number): Promise<void>;
  /** Extends the lease only if the live entry still belongs to session `sid` (compare-and-renew). True when renewed. */
  renewPresence(projectId: string, deviceId: string, sid: string, ttlSec: number): Promise<boolean>;
  /**
   * Optional batched compare-and-renew for sessions co-located on one instance: one backend call, one result per entry.
   * Each entry is still renewed only if it belongs to its own session; absent => individual renewPresence calls.
   */
  renewPresenceMany?(entries: PresenceRenewal[], ttlSec: number): Promise<boolean[]>;
  /** Removes the entry only if it still belongs to session `sid` (compare-and-delete). True when removed. */
  removePresence(projectId: string, deviceId: string, sid: string): Promise<boolean>;
  /** The devices whose lease has not expired. */
  getPresence(projectId: string): Promise<Record<string, string>>;
}

export interface PresenceRenewal { projectId: string; deviceId: string; sid: string }

/** Counts backend operations and relay traffic per category for usage reports. Never records content or identities. */
export class UsageMeter {
  readonly counts: Record<string, number> = {};
  add(name: string, n = 1) { this.counts[name] = (this.counts[name] ?? 0) + n; }
  snapshot(): Record<string, number> { return { ...this.counts }; }
  reset() { for (const k of Object.keys(this.counts)) delete this.counts[k]; }
}

/** Wraps a backend so every call is counted as `signal.<operation>`; behaviour is unchanged. */
export function meterSignalBackend(backend: SignalBackend, meter: UsageMeter): SignalBackend {
  const counted = <A extends unknown[], R>(name: string, f: (...a: A) => Promise<R>) => (...a: A) => { meter.add(`signal.${name}`); return f(...a); };
  const many = backend.renewPresenceMany?.bind(backend);
  return {
    publish: counted('publish', backend.publish.bind(backend)),
    subscribe: counted('subscribe', backend.subscribe.bind(backend)),
    setPresence: counted('setPresence', backend.setPresence.bind(backend)),
    renewPresence: counted('renewPresence', backend.renewPresence.bind(backend)),
    ...(many ? { renewPresenceMany: (e: PresenceRenewal[], ttl: number) => { meter.add('signal.renewPresenceMany'); meter.add('signal.renewPresenceMany.entries', e.length); return many(e, ttl); } } : {}),
    removePresence: counted('removePresence', backend.removePresence.bind(backend)),
    getPresence: counted('getPresence', backend.getPresence.bind(backend)),
  };
}

const MAX_RENEW_BATCH = 64;
const renewers = new WeakMap<SignalBackend, (r: PresenceRenewal) => Promise<boolean>>();
/**
 * Coalesces heartbeat renewals of the sessions sharing this backend (one function instance) for at most `flushMs`:
 * a 30 s heartbeat plus the window stays inside the 90 s lease. Distributed sessions still renew independently; nothing extends authorization.
 */
export function presenceRenewer(backend: SignalBackend, flushMs = 0): (r: PresenceRenewal) => Promise<boolean> {
  const existing = renewers.get(backend);
  if (existing) return existing;
  if (flushMs <= 0) return r => backend.renewPresence(r.projectId, r.deviceId, r.sid, PRESENCE_TTL);
  const many = backend.renewPresenceMany?.bind(backend);
  let pending: Array<{ r: PresenceRenewal; done: (ok: boolean) => void; fail: (e: unknown) => void }> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = async () => {
    timer = null;
    const batch = pending.splice(0, MAX_RENEW_BATCH);
    if (pending.length) timer = setTimeout(() => void flush(), 0);
    if (!batch.length) return;
    try {
      const results = many && batch.length > 1 ? await many(batch.map(b => b.r), PRESENCE_TTL) : await Promise.all(batch.map(b => backend.renewPresence(b.r.projectId, b.r.deviceId, b.r.sid, PRESENCE_TTL)));
      batch.forEach((b, i) => { b.done(results[i] === true); });
    } catch (e) { for (const b of batch) b.fail(e); }
  };
  const renew = (r: PresenceRenewal) => new Promise<boolean>((done, fail) => {
    pending.push({ r, done, fail });
    if (pending.length >= MAX_RENEW_BATCH) { if (timer) clearTimeout(timer); void flush(); }
    else timer ??= setTimeout(() => void flush(), flushMs);
  });
  renewers.set(backend, renew);
  return renew;
}

/** Splits a presence value (`sid|ticket`; older entries are a bare ticket). */
export function presenceTicket(value: string): string {
  const i = value.indexOf('|');
  return i >= 0 && !value.slice(0, i).includes('.') ? value.slice(i + 1) : value;
}

/** The session id of a presence value, or undefined for an older bare-ticket entry. */
export function presenceSid(value: string): string | undefined {
  const i = value.indexOf('|');
  return i >= 0 && !value.slice(0, i).includes('.') ? value.slice(0, i) : undefined;
}

export class MemorySignalBackend implements SignalBackend {
  private subs = new Map<string, Set<(m: string) => void>>();
  private presence = new Map<string, Map<string, { value: string; exp: number }>>();
  /** Opt-in bounded test transcript. Normal local/dev forwarding retains no message payload. */
  readonly log: string[] = [];
  private logBytes = 0;

  /** `now` (epoch ms) lets tests move the clock: leases expire like the production backend's. */
  constructor(private o: { now?: () => number; recordMessages?: boolean } = {}) {}
  private now() {
    return (this.o.now ?? Date.now)();
  }
  private live(p: string, d: string) {
    const e = this.presence.get(p)?.get(d);
    if (!e) return undefined;
    if (e.exp <= this.now()) {
      this.presence.get(p)?.delete(d);
      return undefined;
    }
    return e;
  }

  async publish(channel: string, message: string) {
    if (this.o.recordMessages && this.log.length < 4096) {
      const size = Buffer.byteLength(message, 'utf8');
      if (this.logBytes + size <= 4 * 1024 * 1024) { this.log.push(message); this.logBytes += size; }
    }
    for (const cb of this.subs.get(channel) ?? []) queueMicrotask(() => cb(message));
  }
  async subscribe(channel: string, cb: (m: string) => void) {
    const s = this.subs.get(channel) ?? new Set();
    s.add(cb);
    this.subs.set(channel, s);
    return () => void s.delete(cb);
  }
  async setPresence(p: string, d: string, value: string, ttlSec = 90) {
    const m = this.presence.get(p) ?? new Map();
    m.set(d, { value, exp: this.now() + ttlSec * 1000 });
    this.presence.set(p, m);
  }
  async renewPresence(p: string, d: string, sid: string, ttlSec = 90) {
    const e = this.live(p, d);
    if (!e?.value.startsWith(`${sid}|`)) return false;
    e.exp = this.now() + ttlSec * 1000;
    return true;
  }
  async renewPresenceMany(entries: PresenceRenewal[], ttlSec = 90) {
    const out: boolean[] = [];
    for (const e of entries) out.push(await this.renewPresence(e.projectId, e.deviceId, e.sid, ttlSec));
    return out;
  }
  async removePresence(p: string, d: string, sid: string) {
    if (!this.live(p, d)?.value.startsWith(`${sid}|`)) return false;
    this.presence.get(p)?.delete(d);
    return true;
  }
  async getPresence(p: string) {
    const out: Record<string, string> = {};
    for (const d of [...(this.presence.get(p)?.keys() ?? [])]) {
      const e = this.live(p, d);
      if (e) out[d] = e.value;
    }
    return out;
  }
}

/**
 * Redis stores each device lease as a hash field `<expiry ms>;<presence value>`: Redis can only expire a whole hash,
 * so the lease is part of the value and read back by every `getPresence` (which also prunes expired fields).
 */
const LEASE = /^(\d+);([\s\S]*)$/;
export function parseLease(stored: string): { exp: number | null; value: string } {
  const m = LEASE.exec(stored);
  return m ? { exp: Number(m[1]), value: m[2] as string } : { exp: null, value: stored };
}

/** Upstash Redis: pub/sub over REST (SSE) for cross-instance delivery; presence in a TTL'd hash. */
export async function createUpstashSignalBackend(url: string, token: string): Promise<SignalBackend> {
  const { Redis } = await import('@upstash/redis');
  const redis = new Redis({ url, token });
  return {
    async publish(channel, message) {
      await redis.publish(channel, message);
    },
    async subscribe(channel, cb) {
      const sub = redis.subscribe(channel);
      // The SSE subscription becomes active asynchronously: wait for Redis' confirmation, otherwise messages
      // published right after we announce presence (e.g. a peer's offer) are silently lost.
      const ready = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => { void sub.unsubscribe(); reject(new Error('subscription readiness timed out')); }, 5000);
        sub.on('subscribe', () => {
          clearTimeout(t);
          resolve();
        });
      });
      sub.on('message', (d: { message: unknown }) => cb(typeof d.message === 'string' ? d.message : JSON.stringify(d.message)));
      await ready;
      return () => void sub.unsubscribe();
    },
    async setPresence(projectId, deviceId, value, ttlSec) {
      const key = `presence:${projectId}`;
      await redis.hset(key, { [deviceId]: `${Date.now() + ttlSec * 1000};${value}` });
      // Garbage collection of idle projects only: the leases themselves are per field.
      await redis.expire(key, Math.max(ttlSec, 3600));
    },
    async renewPresence(projectId, deviceId, sid, ttlSec) {
      const now = Date.now();
      const renewed = await redis.eval(RENEW_IF_SESSION, [`presence:${projectId}`], [deviceId, `${sid}|`, String(now + ttlSec * 1000), String(now)]);
      return Number(renewed) === 1;
    },
    async renewPresenceMany(entries, ttlSec) {
      const now = Date.now();
      const args = [String(now), String(now + ttlSec * 1000)];
      for (const e of entries) args.push(e.deviceId, `${e.sid}|`);
      const result = await redis.eval(RENEW_MANY_IF_SESSION, entries.map(e => `presence:${e.projectId}`), args);
      if (!Array.isArray(result) || result.length !== entries.length) throw new Error('unexpected batched renewal result');
      return result.map(r => Number(r) === 1);
    },
    async removePresence(projectId, deviceId, sid) {
      // Atomic compare-and-delete: a closing old session must not remove the entry of the device's new session.
      const removed = await redis.eval(REMOVE_IF_SESSION, [`presence:${projectId}`], [deviceId, `${sid}|`]);
      return Number(removed) === 1;
    },
    async getPresence(projectId) {
      const key = `presence:${projectId}`;
      const now = Date.now();
      const out: Record<string, string> = {};
      for (const [dev, stored] of Object.entries((await redis.hgetall<Record<string, string>>(key)) ?? {})) {
        const { exp, value } = parseLease(String(stored));
        if (exp === null || exp > now) out[dev] = value;
        else void redis.eval(PRUNE_IF_UNCHANGED, [key], [dev, String(stored)]).catch(() => {}); // best effort
      }
      return out;
    },
  };
}

/** KEYS[1] presence hash; ARGV[1] device id; ARGV[2] "<sid>|" prefix the entry must still have. */
export const REMOVE_IF_SESSION = `local v = redis.call('HGET', KEYS[1], ARGV[1])
if v then
  local rest = string.match(v, '^%d+;(.*)$') or v
  if string.sub(rest, 1, string.len(ARGV[2])) == ARGV[2] then
    redis.call('HDEL', KEYS[1], ARGV[1])
    return 1
  end
end
return 0`;

/**
 * Compare-and-renew. ARGV[1] device id; ARGV[2] "<sid>|" prefix; ARGV[3] new expiry (ms); ARGV[4] now (ms).
 * An entry that already expired is not renewed (the session re-announces itself instead).
 */
export const RENEW_IF_SESSION = `local v = redis.call('HGET', KEYS[1], ARGV[1])
if not v then return 0 end
local exp, rest = string.match(v, '^(%d+);(.*)$')
if not rest then rest = v end
if string.sub(rest, 1, string.len(ARGV[2])) ~= ARGV[2] then return 0 end
if exp and tonumber(exp) <= tonumber(ARGV[4]) then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3] .. ';' .. rest)
return 1`;

/** Batched RENEW_IF_SESSION: KEYS[i] presence hash of entry i; ARGV[1] now; ARGV[2] new expiry; then device/prefix pairs. */
export const RENEW_MANY_IF_SESSION = `local out = {}
for i, key in ipairs(KEYS) do
  local dev, prefix = ARGV[1 + i * 2], ARGV[2 + i * 2]
  local v = redis.call('HGET', key, dev)
  local ok = 0
  if v then
    local exp, rest = string.match(v, '^(%d+);(.*)$')
    if not rest then rest = v end
    if string.sub(rest, 1, string.len(prefix)) == prefix and not (exp and tonumber(exp) <= tonumber(ARGV[1])) then
      redis.call('HSET', key, dev, ARGV[2] .. ';' .. rest)
      ok = 1
    end
  end
  out[i] = ok
end
return out`;

/** Removes an expired lease unless it changed meanwhile. ARGV[1] device id; ARGV[2] the exact stored value. */
export const PRUNE_IF_UNCHANGED = `if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then
  redis.call('HDEL', KEYS[1], ARGV[1])
  return 1
end
return 0`;

export interface SocketLike {
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

const MAX_MSG = 64 * 1024;
/** A device's presence lease. Clients renew it with a `ping` every 30 s (see ConnectionManager). */
export const PRESENCE_TTL = 90;

export async function verifyServerTicket(deps: Pick<Deps, 'config' | 'now'>, ticket: string): Promise<TicketClaims> {
  const keys: TrustedKey[] = deps.config.ticketPublicJwks;
  const kid = JSON.parse(Buffer.from(ticket.split('.')[0] ?? '', 'base64url').toString() || '{}').kid as string | undefined;
  const k = keys.find((x) => x.kid === kid);
  if (!k) throw new Error('unknown key');
  const pub = await importJWK(k.jwk as never, 'EdDSA');
  const { payload } = await jwtVerify(ticket, pub, { algorithms: ['EdDSA'], currentDate: deps.now(), clockTolerance: 30 });
  return payload as unknown as TicketClaims;
}

/**
 * Drives one WebSocket. Returns handlers the transport adapter wires to the socket's events.
 * Protocol (JSON): server first sends {t:'challenge',nonce}; client {t:'auth',ticket,sig} | {t:'sig',to,env} | {t:'ping'};
 * server {t:'ready',tickets} | {t:'join',ticket,sid} | {t:'leave',dev,sid} | {t:'sig',from,fromTicket,env} | {t:'err',code}.
 * Every socket is a session with a random id `sid`. When a device reconnects quickly (a page reload), the old session's
 * cleanup may run after the new session joined: it then neither removes the new presence entry nor announces a leave,
 * and clients ignore a leave whose sid is not the latest one they saw joining for that device.
 * `sig` is the device's Ed25519 signature of signalAuthMessage(pid, dev, nonce): presence tickets are visible to every
 * member, so the ticket alone must not be enough to appear (or disappear) as that device.
 */
export function createSignalSession(sock: SocketLike, deps: Deps, backend: SignalBackend) {
  const batchMs = deps.presenceBatchMs ?? 0;
  const renewPresence = presenceRenewer(backend, batchMs);
  let renewing: Promise<void> | null = null;
  let claims: TicketClaims | null = null;
  let unsub: (() => void) | null = null;
  let closed = false;
  let expiry: ReturnType<typeof setTimeout> | null = null;
  let ticketStr = '';
  let authenticating = false;
  let relay: Awaited<ReturnType<NonNullable<Deps['applicationRelay']>['attach']>> | null = null;
  const recent: number[] = [];
  const relayRecent: number[] = [];
  let pendingRelayBytes = 0, pendingRelayFrames = 0, lastRelayError = 0;
  const send = (o: unknown) => {
    if (closed) return;
    const raw = JSON.stringify(o);
    const size = Buffer.byteLength(raw, 'utf8');
    const application = (o as { t?: string }).t === 'app-relay';
    const queued = sock.bufferedAmount ?? 0;
    // Reserve 64 KiB for signaling/control even when application delivery stalls.
    if (size > MAX_MSG || queued + size > (application ? 256 * 1024 : 320 * 1024)) {
      if (!application) { void cleanup(); sock.close(1013, 'slow recipient'); }
      return;
    }
    sock.send(raw);
  };
  const nonce = randomBytes(32).toString('base64url');
  let sid = randomBytes(12).toString('base64url');
  send({ t: 'challenge', nonce });

  async function cleanup() {
    if (closed) return;
    closed = true;
    if (expiry) clearTimeout(expiry);
    unsub?.();
    relay?.close();
    if (claims) {
      const removed = await backend.removePresence(claims.pid, claims.dev, sid).catch(() => false);
      // A newer session of this device already took over: announcing a leave would drop its fresh links.
      if (removed) await backend.publish(`sig:${claims.pid}`, JSON.stringify({ t: 'leave', dev: claims.dev, sid })).catch(() => {});
    }
  };

  /**
   * Heartbeat: extend this session's own lease. A lease that already ran out (throttled tab) is announced again, but an
   * entry of another session is never touched: an old session's late ping must not take the device back from its newer one.
   */
  async function renewLease(c: TicketClaims) {
    const renewed = await renewPresence({ projectId: c.pid, deviceId: c.dev, sid }).catch(() => true);
    if (renewed || closed) return;
    const current = await backend.getPresence(c.pid).catch(() => null);
    if (!current || c.dev in current) return;
    await backend.setPresence(c.pid, c.dev, `${sid}|${ticketStr}`, PRESENCE_TTL);
    if (closed) await backend.removePresence(c.pid, c.dev, sid); // closed while re-announcing
  }

  async function onAuth(ticket: string, sig: string, capabilities: unknown) {
    let c: TicketClaims;
    try {
      c = await verifyServerTicket(deps, ticket);
      const proof = await verify(c.devE, new TextEncoder().encode(signalAuthMessage(c.pid, c.dev, nonce)), fromB64u(sig));
      if (!proof) throw new Error('key possession proof failed');
    } catch {
      send({ t: 'err', code: 'bad_ticket' });
      sock.close(4401, 'bad ticket');
      return;
    }
    if (closed) return;
    if (c.exp * 1000 <= deps.now().getTime()) { sock.close(4401, 'ticket expired'); return; }
    if (deps.applicationRelay && supportsApplicationRelay(capabilities)) sid = RELAY_SESSION_PREFIX + sid;
    claims = c;
    ticketStr = ticket;
    // Never outlive the ticket: members must refresh (and thus be re-checked) to stay connected.
    expiry = setTimeout(() => {
      send({ t: 'err', code: 'ticket_expired' });
      sock.close(4401, 'ticket expired');
    }, Math.max(0, c.exp * 1000 - deps.now().getTime()));
    unsub = await backend.subscribe(`sig:${c.pid}`, (raw) => {
      if (closed) return;
      const m = JSON.parse(raw) as { t: string; to?: string; from?: string; dev?: string };
      if (m.t === 'sig') {
        if (m.to === c.dev && m.from !== c.dev) send(m);
      } else if (m.t === 'join' || m.t === 'leave') {
        if (m.dev !== c.dev) send(m);
      }
    });
    if (closed) { unsub?.(); return; }
    if (sid.startsWith(RELAY_SESSION_PREFIX) && deps.applicationRelay) {
      relay = await deps.applicationRelay.attach({ claims: c, sid, send, active: () => !closed && c.exp * 1000 > deps.now().getTime() });
      if (closed) { relay.close(); unsub?.(); return; }
    }
    const presence = await backend.getPresence(c.pid);
    if (closed) return;
    await backend.setPresence(c.pid, c.dev, `${sid}|${ticket}`, PRESENCE_TTL);
    if (closed) { await backend.removePresence(c.pid, c.dev, sid); return; }
    const others = Object.entries(presence).filter(([d]) => d !== c.dev);
    // `sessions` (device -> session id) is additive: clients that only know `tickets` keep working.
    const sessions: Record<string, string> = {};
    for (const [d, v] of others) {
      const s = presenceSid(v);
      if (s) sessions[d] = s;
    }
    send({ t: 'ready', tickets: others.map(([, v]) => presenceTicket(v)), sessions, ...(relay ? { sid, capabilities: [APPLICATION_RELAY_CAPABILITY] } : {}) });
    await backend.publish(`sig:${c.pid}`, JSON.stringify({ t: 'join', dev: c.dev, ticket, sid, ...(relay ? { capabilities: [APPLICATION_RELAY_CAPABILITY] } : {}) }));
  }

  return {
    async onMessage(data: string) {
      if (closed) return;
      if (Buffer.byteLength(data, 'utf8') > MAX_MSG) return void sock.close(1009, 'too large');
      let m: { t?: string; ticket?: string; sig?: string; to?: string; env?: string; capabilities?: unknown };
      try {
        m = JSON.parse(data);
      } catch {
        return void sock.close(1003, 'bad json');
      }
      if (!m || typeof m !== 'object') return void sock.close(1003, 'bad message');
      const now = Date.now();
      const application = m.t === 'app-relay' && relay && !authenticating;
      const rate = application ? relayRecent : recent;
      while (rate.length && (rate[0] ?? now) < now - 10_000) rate.shift();
      if (rate.length >= (application ? 1200 : 60)) {
        if (application) {
          if (now - lastRelayError >= 1000) { lastRelayError = now; send({ t: 'relay-error', code: 'relay_rate_limited', retryAfterMs: 10_000 }); }
        } else { send({ t: 'err', code: 'rate_limited' }); void cleanup(); sock.close(4429, 'rate limited'); }
        return;
      }
      rate.push(now);
      if (!claims || authenticating) {
        if (authenticating) return void sock.close(4401, 'authentication pending');
        if (m.t === 'auth' && typeof m.ticket === 'string' && typeof m.sig === 'string') {
          authenticating = true;
          try { await onAuth(m.ticket, m.sig, m.capabilities); }
          catch { await cleanup(); sock.close(1011, 'session setup failed'); }
          finally { authenticating = false; }
        } else sock.close(4401, 'auth required');
        return;
      }
      if (m.t === 'app-relay') {
        if (!relay) { send({ t: 'err', code: 'relay_unavailable' }); return; }
        if (!isApplicationRelayMessage(m)) { send({ t: 'err', code: 'bad_relay_message' }); return; }
        if (claims.exp * 1000 <= deps.now().getTime()) return void sock.close(4401, 'ticket expired');
        const size = Buffer.byteLength(data, 'utf8');
        if (pendingRelayFrames >= 64 || pendingRelayBytes + size > 1024 * 1024) {
          if (now - lastRelayError >= 1000) { lastRelayError = now; send({ t: 'relay-error', code: 'relay_backpressure', retryAfterMs: 1000 }); }
          return;
        }
        pendingRelayFrames++; pendingRelayBytes += size;
        try { await relay.forward(m); }
        catch { if (!closed && now - lastRelayError >= 1000) { lastRelayError = now; send({ t: 'relay-error', code: 'relay_unavailable', retryAfterMs: 30_000 }); } }
        finally { pendingRelayFrames--; pendingRelayBytes -= size; }
        return;
      }
      if (m.t === 'sig' && typeof m.to === 'string' && typeof m.env === 'string') {
        await backend.publish(
          `sig:${claims.pid}`,
          JSON.stringify({ t: 'sig', from: claims.dev, fromTicket: ticketStr, to: m.to, env: m.env }),
        );
      } else if (m.t === 'ping') {
        // Clients do not wait for the pong; the renewal joins this instance's batch and never overlaps itself.
        send({ t: 'pong' });
        const c = claims;
        renewing ??= renewLease(c).catch(() => {}).finally(() => { renewing = null; });
        if (batchMs === 0) await renewing;
      }
    },
    onClose: cleanup,
  };
}
