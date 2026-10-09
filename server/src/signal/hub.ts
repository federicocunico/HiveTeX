import { type TicketClaims, type TrustedKey } from '@p2platex/protocol';
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
  setPresence(projectId: string, deviceId: string, ticket: string, ttlSec: number): Promise<void>;
  removePresence(projectId: string, deviceId: string): Promise<void>;
  getPresence(projectId: string): Promise<Record<string, string>>;
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
  async setPresence(p: string, d: string, ticket: string) {
    const m = this.presence.get(p) ?? new Map();
    m.set(d, ticket);
    this.presence.set(p, m);
  }
  async removePresence(p: string, d: string) {
    this.presence.get(p)?.delete(d);
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
    async setPresence(projectId, deviceId, ticket, ttlSec) {
      const key = `presence:${projectId}`;
      await redis.hset(key, { [deviceId]: ticket });
      await redis.expire(key, ttlSec);
    },
    async removePresence(projectId, deviceId) {
      await redis.hdel(`presence:${projectId}`, deviceId);
    },
    async getPresence(projectId) {
      return (await redis.hgetall<Record<string, string>>(`presence:${projectId}`)) ?? {};
    },
  };
}

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
 * Protocol (JSON): client {t:'auth',ticket} | {t:'sig',to,env} | {t:'ping'};
 * server {t:'ready',tickets} | {t:'join',ticket} | {t:'leave',dev} | {t:'sig',from,fromTicket,env} | {t:'err',code}.
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

  const cleanup = async () => {
    if (closed) return;
    closed = true;
    if (expiry) clearTimeout(expiry);
    unsub?.();
    if (claims) {
      await backend.removePresence(claims.pid, claims.dev).catch(() => {});
      await backend.publish(`sig:${claims.pid}`, JSON.stringify({ t: 'leave', dev: claims.dev })).catch(() => {});
    }
  };

  async function onAuth(ticket: string) {
    let c: TicketClaims;
    try {
      c = await verifyServerTicket(deps, ticket);
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
    await backend.setPresence(c.pid, c.dev, ticket, PRESENCE_TTL);
    send({ t: 'ready', tickets: Object.entries(presence).filter(([d]) => d !== c.dev).map(([, t]) => t) });
    await backend.publish(`sig:${c.pid}`, JSON.stringify({ t: 'join', dev: c.dev, ticket }));
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
      let m: { t?: string; ticket?: string; to?: string; env?: string };
      try {
        m = JSON.parse(data);
      } catch {
        return void sock.close(1003, 'bad json');
      }
      if (!claims) {
        if (m.t === 'auth' && typeof m.ticket === 'string') await onAuth(m.ticket);
        else sock.close(4401, 'auth required');
        return;
      }
      if (m.t === 'sig' && typeof m.to === 'string' && typeof m.env === 'string') {
        await backend.publish(
          `sig:${claims.pid}`,
          JSON.stringify({ t: 'sig', from: claims.dev, fromTicket: ticketStr, to: m.to, env: m.env }),
        );
      } else if (m.t === 'ping') {
        await backend.setPresence(claims.pid, claims.dev, ticketStr, PRESENCE_TTL);
        send({ t: 'pong' });
      }
    },
    onClose: cleanup,
  };
}
