import { randomBytes } from 'node:crypto';
import { fromB64u, verify } from '@p2platex/crypto';
import { type TicketClaims, type TrustedKey, signalAuthMessage } from '@p2platex/protocol';
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
  /** Presence values are `<session id>|<ticket>`: a device's newer session replaces the entry of its older one. */
  setPresence(projectId: string, deviceId: string, value: string, ttlSec: number): Promise<void>;
  /** Removes the entry only if it still belongs to session `sid` (compare-and-delete). True when removed. */
  removePresence(projectId: string, deviceId: string, sid: string): Promise<boolean>;
  getPresence(projectId: string): Promise<Record<string, string>>;
}

/** Splits a presence value (`sid|ticket`; older entries are a bare ticket). */
export function presenceTicket(value: string): string {
  const i = value.indexOf('|');
  return i >= 0 && !value.slice(0, i).includes('.') ? value.slice(i + 1) : value;
}

export class MemorySignalBackend implements SignalBackend {
  private subs = new Map<string, Set<(m: string) => void>>();
  private presence = new Map<string, Map<string, string>>();
  /** Everything ever published, so tests can assert the server only saw ciphertext. */
  readonly log: string[] = [];

  async publish(channel: string, message: string) {
    this.log.push(message);
    for (const cb of this.subs.get(channel) ?? []) queueMicrotask(() => cb(message));
  }
  async subscribe(channel: string, cb: (m: string) => void) {
    const s = this.subs.get(channel) ?? new Set();
    s.add(cb);
    this.subs.set(channel, s);
    return () => void s.delete(cb);
  }
  async setPresence(p: string, d: string, value: string, _ttlSec?: number) {
    const m = this.presence.get(p) ?? new Map();
    m.set(d, value);
    this.presence.set(p, m);
  }
  async removePresence(p: string, d: string, sid: string) {
    const m = this.presence.get(p);
    if (!m?.get(d)?.startsWith(`${sid}|`)) return false;
    m.delete(d);
    return true;
  }
  async getPresence(p: string) {
    return Object.fromEntries(this.presence.get(p) ?? []);
  }
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
      const ready = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 5000);
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
      await redis.hset(key, { [deviceId]: value });
      await redis.expire(key, ttlSec);
    },
    async removePresence(projectId, deviceId, sid) {
      // Atomic compare-and-delete: a closing old session must not remove the entry of the device's new session.
      const removed = await redis.eval(REMOVE_IF_SESSION, [`presence:${projectId}`], [deviceId, `${sid}|`]);
      return Number(removed) === 1;
    },
    async getPresence(projectId) {
      return (await redis.hgetall<Record<string, string>>(`presence:${projectId}`)) ?? {};
    },
  };
}

/** KEYS[1] presence hash; ARGV[1] device id; ARGV[2] "<sid>|" prefix the entry must still have. */
export const REMOVE_IF_SESSION = `local v = redis.call('HGET', KEYS[1], ARGV[1])
if v and string.sub(v, 1, string.len(ARGV[2])) == ARGV[2] then
  redis.call('HDEL', KEYS[1], ARGV[1])
  return 1
end
return 0`;

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

const MAX_MSG = 64 * 1024;
const PRESENCE_TTL = 90;

export async function verifyServerTicket(deps: Deps, ticket: string): Promise<TicketClaims> {
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
  let claims: TicketClaims | null = null;
  let unsub: (() => void) | null = null;
  let closed = false;
  let expiry: ReturnType<typeof setTimeout> | null = null;
  let ticketStr = '';
  const recent: number[] = [];
  const send = (o: unknown) => {
    if (!closed) sock.send(JSON.stringify(o));
  };
  const nonce = randomBytes(32).toString('base64url');
  const sid = randomBytes(12).toString('base64url');
  send({ t: 'challenge', nonce });

  const cleanup = async () => {
    if (closed) return;
    closed = true;
    if (expiry) clearTimeout(expiry);
    unsub?.();
    if (claims) {
      const removed = await backend.removePresence(claims.pid, claims.dev, sid).catch(() => false);
      // A newer session of this device already took over: announcing a leave would drop its fresh links.
      if (removed) await backend.publish(`sig:${claims.pid}`, JSON.stringify({ t: 'leave', dev: claims.dev, sid })).catch(() => {});
    }
  };

  async function onAuth(ticket: string, sig: string) {
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
    const presence = await backend.getPresence(c.pid);
    await backend.setPresence(c.pid, c.dev, `${sid}|${ticket}`, PRESENCE_TTL);
    send({ t: 'ready', tickets: Object.entries(presence).filter(([d]) => d !== c.dev).map(([, v]) => presenceTicket(v)) });
    await backend.publish(`sig:${c.pid}`, JSON.stringify({ t: 'join', dev: c.dev, ticket, sid }));
  }

  return {
    async onMessage(data: string) {
      if (closed) return;
      if (data.length > MAX_MSG) return void sock.close(1009, 'too large');
      const now = Date.now();
      while (recent.length && recent[0] !== undefined && recent[0] < now - 10_000) recent.shift();
      recent.push(now);
      if (recent.length > 60) {
        send({ t: 'err', code: 'rate_limited' });
        return void sock.close(4429, 'rate limited');
      }
      let m: { t?: string; ticket?: string; sig?: string; to?: string; env?: string };
      try {
        m = JSON.parse(data);
      } catch {
        return void sock.close(1003, 'bad json');
      }
      if (!claims) {
        if (m.t === 'auth' && typeof m.ticket === 'string' && typeof m.sig === 'string') await onAuth(m.ticket, m.sig);
        else sock.close(4401, 'auth required');
        return;
      }
      if (m.t === 'sig' && typeof m.to === 'string' && typeof m.env === 'string') {
        await backend.publish(
          `sig:${claims.pid}`,
          JSON.stringify({ t: 'sig', from: claims.dev, fromTicket: ticketStr, to: m.to, env: m.env }),
        );
      } else if (m.t === 'ping') {
        await backend.setPresence(claims.pid, claims.dev, `${sid}|${ticketStr}`, PRESENCE_TTL);
        send({ t: 'pong' });
      }
    },
    onClose: cleanup,
  };
}
