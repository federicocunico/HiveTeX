import { verifyRingToken } from '@hivetex/crypto';
import type { DoorbellInfo, RingClaims, TrustedKey } from '@hivetex/protocol';

/**
 * Doorbell (D14). A device keeps one subscription to a free push service (ntfy) for the ring topics of its projects, and
 * no connection to the control plane. A member that needs peers publishes a server-signed ring token to the project's
 * topic; subscribers verify it offline and only then come online for the introduction.
 */

export type PushState = 'off' | 'connecting' | 'subscribed' | 'unavailable';

/** A push service subscription for a set of topics. `close()` ends it for good. */
export interface PushChannel {
  subscribe(topics: string[], onMessage: (topic: string, message: string) => void, onState: (s: PushState) => void): () => void;
  publish(topic: string, message: string): Promise<void>;
}

type FetchLike = typeof fetch;

/**
 * ntfy's JSON stream (`GET <url>/<t1,t2>/json`, one event per line) and publish (`POST <url>/<topic>`, `Cache: no` so a
 * ring reaches only current subscribers). Works with ntfy.sh, a self-hosted ntfy and the dev server's push endpoint.
 * Reconnects with jittered backoff (1 s doubling to 60 s); after `unavailableAfter` failed attempts in a row the state is
 * `unavailable` (still retrying), so callers can fall back to staying reachable while open.
 */
export function ntfyChannel(url: string, o: { fetch?: FetchLike; random?: () => number; unavailableAfter?: number; maxBackoffMs?: number; idleTimeoutMs?: number } = {}): PushChannel {
  const base = url.replace(/\/+$/, '');
  const f: FetchLike = o.fetch ?? ((...a) => fetch(...a));
  return {
    subscribe(topics, onMessage, onState) {
      let closed = false;
      let failures = 0;
      let abort: AbortController | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const watchdog = { t: null as ReturnType<typeof setTimeout> | null };
      // ntfy sends a keepalive every ~45 s: a silent stream is dead even if the socket did not say so.
      const idle = o.idleTimeoutMs ?? 120_000;
      const touch = () => {
        if (watchdog.t) clearTimeout(watchdog.t);
        watchdog.t = setTimeout(() => abort?.abort(), idle);
      };
      const retry = () => {
        if (closed) return;
        failures++;
        onState(failures >= (o.unavailableAfter ?? 3) ? 'unavailable' : 'connecting');
        const wait = Math.min(o.maxBackoffMs ?? 60_000, 1000 * 2 ** Math.min(failures - 1, 10)) * (0.75 + 0.5 * (o.random ?? Math.random)());
        timer = setTimeout(() => void connect(), wait);
      };
      const connect = async () => {
        if (closed) return;
        abort = new AbortController();
        const ctl = abort;
        try {
          const res = await f(`${base}/${topics.map(encodeURIComponent).join(',')}/json`, { signal: ctl.signal, headers: { Accept: 'application/x-ndjson' } });
          if (!res.ok || !res.body) throw new Error(`push subscribe ${res.status}`);
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          touch();
          for (;;) {
            const { value, done } = await reader.read();
            if (done || closed) break;
            touch();
            buf += dec.decode(value, { stream: true });
            if (buf.length > 64 * 1024) throw new Error('push line too long');
            for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
              const line = buf.slice(0, i);
              buf = buf.slice(i + 1);
              let ev: { event?: string; topic?: string; message?: string };
              try {
                ev = JSON.parse(line);
              } catch {
                continue;
              }
              if (ev.event === 'open') {
                failures = 0;
                onState('subscribed');
              } else if (ev.event === 'message' && typeof ev.topic === 'string' && typeof ev.message === 'string' && topics.includes(ev.topic)) {
                onMessage(ev.topic, ev.message);
              }
            }
          }
        } catch {
          /* reconnect below */
        } finally {
          if (watchdog.t) clearTimeout(watchdog.t);
        }
        if (!closed) retry();
      };
      onState('connecting');
      void connect();
      return () => {
        closed = true;
        if (timer) clearTimeout(timer);
        if (watchdog.t) clearTimeout(watchdog.t);
        abort?.abort();
        onState('off');
      };
    },
    async publish(topic, message) {
      const res = await f(`${base}/${encodeURIComponent(topic)}`, { method: 'POST', body: message, headers: { Cache: 'no', 'X-Cache': 'no' } });
      if (!res.ok) throw new Error(`push publish ${res.status}`);
    },
  };
}

export interface DoorbellOptions {
  channel: (url: string) => PushChannel;
  trusted: () => TrustedKey[];
  now?: () => number;
  /** At most one wake per project in this interval (default 10 s) and `maxWakesPerHour` (default 120). */
  minWakeIntervalMs?: number;
  maxWakesPerHour?: number;
}

interface Registration {
  info: DoorbellInfo;
  epoch: number;
  onRing: (claims: RingClaims) => void;
}

/**
 * One per device: multiplexes the topics of every registered project onto one subscription per push service, verifies
 * rings offline and enforces the per-project wake budget. Forged, expired, replayed, wrong-topic and older-epoch rings are
 * dropped here without any network activity.
 */
export class Doorbell {
  private regs = new Map<string, Registration>();
  private subs = new Map<string, () => void>();
  private stateByUrl = new Map<string, PushState>();
  private seen = new Map<string, number>();
  private wakes = new Map<string, number[]>();
  private stateCbs = new Set<() => void>();
  private resubscribe: ReturnType<typeof setTimeout> | null = null;
  private gen = 0;
  readonly stats = { rings: 0, wakes: 0, dropped: 0 };
  /** Rings received and still being verified. */
  private inflight = new Set<Promise<void>>();

  constructor(private o: DoorbellOptions) {}

  private now() {
    return (this.o.now ?? Date.now)();
  }

  /** The push state for a project's service ('off' when the project has no doorbell). */
  state(key: string): PushState {
    const r = this.regs.get(key);
    return r ? (this.stateByUrl.get(r.info.url) ?? 'connecting') : 'off';
  }
  onState(cb: () => void) {
    this.stateCbs.add(cb);
    return () => void this.stateCbs.delete(cb);
  }

  /** Registers (or updates, e.g. after an epoch change) a project's topic. Returns the unregister function. */
  register(key: string, info: DoorbellInfo, epoch: number, onRing: (claims: RingClaims) => void): () => void {
    const prev = this.regs.get(key);
    const reg = { info, epoch: Math.max(epoch, prev?.epoch ?? 0), onRing };
    this.regs.set(key, reg);
    if (!prev || prev.info.topic !== info.topic || prev.info.url !== info.url) this.scheduleResubscribe();
    return () => {
      if (this.regs.get(key) !== reg) return;
      this.regs.delete(key);
      this.scheduleResubscribe();
    };
  }

  /** Publishes a ring token for a project (obtained from the control plane's ring endpoint). */
  async ring(info: DoorbellInfo, token: string) {
    this.stats.rings++;
    // We are subscribed to the same topic: our own ring must not wake us.
    try {
      const c = JSON.parse(atob((token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'))) as Partial<RingClaims>;
      if (typeof c.n === 'string' && typeof c.exp === 'number') this.seen.set(c.n, (c.exp + 60) * 1000);
    } catch {
      /* not a token we can read: the push service will deliver it and verification drops it */
    }
    await this.o.channel(info.url).publish(info.topic, token);
  }

  /** Topic changes come in bursts (several projects open at start): one resubscription for all of them. */
  private scheduleResubscribe() {
    if (this.resubscribe) return;
    this.resubscribe = setTimeout(() => {
      this.resubscribe = null;
      this.applySubscriptions();
    }, 0);
  }

  private applySubscriptions() {
    for (const close of this.subs.values()) close();
    this.subs.clear();
    const byUrl = new Map<string, string[]>();
    for (const r of this.regs.values()) {
      const list = byUrl.get(r.info.url) ?? [];
      if (!list.includes(r.info.topic)) list.push(r.info.topic);
      byUrl.set(r.info.url, list);
    }
    for (const url of [...this.stateByUrl.keys()]) if (!byUrl.has(url)) this.stateByUrl.delete(url);
    const gen = ++this.gen;
    for (const [url, topics] of byUrl) {
      const close = this.o.channel(url).subscribe(
        topics.sort(),
        (topic, message) => {
          const handled = this.onMessage(url, topic, message);
          this.inflight.add(handled);
          void handled.finally(() => this.inflight.delete(handled));
        },
        (s) => {
          // States of a subscription that was replaced (topics changed) are ignored.
          if (gen !== this.gen) return;
          this.stateByUrl.set(url, s);
          for (const cb of this.stateCbs) cb();
        },
      );
      this.subs.set(url, close);
    }
    for (const cb of this.stateCbs) cb();
  }

  /** Resolves once every ring received so far has been verified and handled (tests and diagnostics). */
  async settled() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private async onMessage(url: string, topic: string, token: string) {
    const target = [...this.regs.entries()].filter(([, r]) => r.info.url === url && r.info.topic === topic);
    if (!target.length) return;
    let c: RingClaims;
    try {
      c = await verifyRingToken(token, this.o.trusted(), { now: new Date(this.now()) });
    } catch {
      this.stats.dropped++;
      return;
    }
    const now = this.now();
    for (const [n, exp] of this.seen) if (exp <= now) this.seen.delete(n);
    if (c.topic !== topic || this.seen.has(c.n) || this.seen.size >= 4096) {
      this.stats.dropped++;
      return;
    }
    this.seen.set(c.n, (c.exp + 60) * 1000);
    for (const [key, r] of target) {
      if (c.ep < r.epoch) {
        this.stats.dropped++;
        continue;
      }
      // Wake budget: a leaked token or a chatty member cannot keep this device busy.
      const times = (this.wakes.get(key) ?? []).filter((t) => t > now - 3600_000);
      if ((times.length && now - (times.at(-1) ?? 0) < (this.o.minWakeIntervalMs ?? 10_000)) || times.length >= (this.o.maxWakesPerHour ?? 120)) {
        this.stats.dropped++;
        this.wakes.set(key, times);
        continue;
      }
      times.push(now);
      this.wakes.set(key, times);
      this.stats.wakes++;
      r.onRing(c);
    }
  }

  close() {
    this.gen++;
    if (this.resubscribe) clearTimeout(this.resubscribe);
    this.resubscribe = null;
    for (const close of this.subs.values()) close();
    this.subs.clear();
    this.regs.clear();
  }
}
