import type { Mesh, PeerInfo } from '@p2platex/sync';
import { type CapabilityRecord, type TexEngine, score } from './capability.js';

export const HEARTBEAT_MS = 2000;
export const MISSED_BEATS = 3;
/** The sitting leader keeps the job unless someone is at least this much better (prevents flapping). */
export const HYSTERESIS = 1.15;

export interface Clock {
  now(): number;
}

interface Remote {
  rec: CapabilityRecord;
  lastSeen: number;
  beat: number;
}

interface Beat {
  dev: string;
  n: number;
}

/**
 * Deterministic compile-leader election. Every peer broadcasts a capability record when it changes and
 * a heartbeat every 2 s; both are relayed across the mesh (deduplicated by stamp / counter), so peers
 * that are not directly linked still converge. Every peer computes the same argmax over the devices it
 * currently sees, so no voting round is needed. A device silent for 3 beats is excluded (failover well
 * under 10 s); a closed connection removes a direct peer immediately.
 */
export class Election {
  private remotes = new Map<string, Remote>();
  private self: CapabilityRecord;
  private current: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private changeCbs = new Set<(leader: string | null) => void>();
  private beatN = 0;

  constructor(
    private mesh: Mesh,
    selfRecord: Omit<CapabilityRecord, 'stamp'>,
    private opts: {
      engine: () => TexEngine;
      /** Viewers can never lead (their results would not be accepted). */
      selfRole?: 'owner' | 'editor' | 'viewer' | (() => 'owner' | 'editor' | 'viewer');
      clock?: Clock;
      intervalMs?: number;
    },
  ) {
    this.self = { ...selfRecord, stamp: 1 };
    mesh.onApp('cap', (from, body) => this.onCap(from, body as CapabilityRecord));
    mesh.onApp('beat', (from, body) => this.onBeat(from, body as Beat));
    mesh.onPeerJoin((p) => {
      void mesh.sendApp(p.deviceId, 'cap', this.self);
      // Share what we know about devices the newcomer cannot see directly.
      for (const r of this.remotes.values()) void mesh.sendApp(p.deviceId, 'cap', r.rec);
      this.recompute();
    });
    mesh.onPeerLeave((p) => {
      this.remotes.delete(p.deviceId);
      this.recompute();
    });
  }

  private now() {
    return (this.opts.clock ?? Date).now();
  }

  start() {
    this.mesh.broadcastApp('cap', this.self);
    this.recompute();
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs ?? HEARTBEAT_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Update our own capability (power state, load, opt-out...). Propagates to peers immediately. */
  update(patch: Partial<Omit<CapabilityRecord, 'dev' | 'stamp'>>) {
    this.self = { ...this.self, ...patch, stamp: this.self.stamp + 1 };
    this.mesh.broadcastApp('cap', this.self);
    this.recompute();
  }

  get selfRecord() {
    return this.self;
  }

  /** One heartbeat + liveness sweep. Public so tests (and low-power timers) can drive it. */
  tick() {
    this.mesh.broadcastApp('beat', { dev: this.self.dev, n: ++this.beatN } satisfies Beat);
    const limit = (this.opts.intervalMs ?? HEARTBEAT_MS) * MISSED_BEATS;
    const t = this.now();
    for (const [dev, r] of this.remotes) if (t - r.lastSeen > limit) this.remotes.delete(dev);
    this.recompute();
  }

  private forward(except: string, topic: string, body: unknown) {
    for (const p of this.mesh.peers) if (p.deviceId !== except) void this.mesh.sendApp(p.deviceId, topic, body);
  }

  private onCap(from: PeerInfo, rec: CapabilityRecord) {
    // Records from viewers are ignored: they cannot publish compile results, so they never lead.
    if (from.claims.role === 'viewer') return;
    if (!rec || typeof rec.dev !== 'string' || rec.dev === this.self.dev) return;
    const old = this.remotes.get(rec.dev);
    if (old && old.rec.stamp >= rec.stamp) return;
    this.remotes.set(rec.dev, { rec, lastSeen: this.now(), beat: old?.beat ?? 0 });
    this.forward(from.deviceId, 'cap', rec);
    this.recompute();
  }

  private onBeat(from: PeerInfo, b: Beat) {
    if (from.claims.role === 'viewer' || !b || b.dev === this.self.dev) return;
    const r = this.remotes.get(b.dev);
    if (!r) {
      // Unknown device: ask the sender (or the device itself) to introduce it.
      void this.mesh.sendApp(from.deviceId, 'cap', this.self);
      return;
    }
    if (b.n <= r.beat) return;
    r.beat = b.n;
    r.lastSeen = this.now();
    this.forward(from.deviceId, 'beat', b);
  }

  /** Current leader device id among the devices we can see (may be ourselves), or null if nobody can compile. */
  leader(): string | null {
    return this.current;
  }

  isLeader() {
    return this.current === this.self.dev;
  }

  onLeaderChange(cb: (leader: string | null) => void) {
    this.changeCbs.add(cb);
  }

  scoreOf(dev: string): number {
    const rec = dev === this.self.dev ? this.self : this.remotes.get(dev)?.rec;
    return rec ? score(rec, this.opts.engine()) : 0;
  }

  private recompute() {
    const eng = this.opts.engine();
    let best: string | null = null;
    let bestScore = 0;
    const consider = (rec: CapabilityRecord) => {
      let s = score(rec, eng);
      if (rec.dev === this.current) s *= HYSTERESIS;
      if (s > bestScore || (s === bestScore && s > 0 && best !== null && rec.dev < best)) {
        best = rec.dev;
        bestScore = s;
      }
    };
    const selfRole = typeof this.opts.selfRole === 'function' ? this.opts.selfRole() : this.opts.selfRole;
    if (selfRole !== 'viewer') consider(this.self);
    for (const r of this.remotes.values()) consider(r.rec);
    if (best !== this.current) {
      this.current = best;
      for (const cb of this.changeCbs) cb(best);
    }
  }
}
