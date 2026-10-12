/**
 * One authoritative runtime per (server, account, project) on a device (D2). Editors and background demand attach through
 * leases; the runtime runs while at least one lease exists and stops when the last one is released. Concurrent opens
 * share one initialization; stopping invalidates an initialization still in flight, whose late result is closed rather
 * than exposed. A released lease can never stop an attachment made after it.
 */

export interface RuntimeKey {
  /** Canonical server origin, e.g. https://hivetex.vercel.app */
  server: string;
  account: string;
  project: string;
}
export type DemandKind = 'editor' | 'background';

export interface ManagedRuntime {
  close(): Promise<void>;
  setPaused?(paused: boolean): void;
}

export interface Lease<R> {
  readonly key: RuntimeKey;
  readonly kind: DemandKind;
  /** Resolves with the shared runtime, or rejects with `RuntimeCancelled` if it was stopped before it was ready. */
  readonly runtime: Promise<R>;
  /** Idempotent. The runtime stops when no lease of its generation is left. */
  release(): Promise<void>;
}

export class RuntimeCancelled extends Error {
  constructor() {
    super('runtime stopped before it was ready');
  }
}

interface Entry<R> {
  gen: number;
  ready: Promise<R>;
  runtime: R | null;
  leases: Map<number, DemandKind>;
  paused: boolean;
}

export const runtimeKeyString = (k: RuntimeKey) => JSON.stringify([k.server.replace(/\/+$/, '').toLowerCase(), k.account, k.project]);

export class RuntimeRegistry<R extends ManagedRuntime> {
  private entries = new Map<string, Entry<R>>();
  /** Stops in progress per key: a new attachment waits for the old runtime to be fully closed (one writer). */
  private stopping = new Map<string, Promise<void>>();
  private gen = 0;
  private leaseSeq = 0;

  constructor(private o: { create: (key: RuntimeKey) => Promise<R> }) {}

  /** Keys with a running or starting runtime. */
  keys(): RuntimeKey[] {
    return [...this.entries.keys()].map((k) => {
      const [server, account, project] = JSON.parse(k) as [string, string, string];
      return { server, account, project };
    });
  }

  /** The kinds of demand currently attached to a key (empty when none). */
  demand(key: RuntimeKey): DemandKind[] {
    return [...(this.entries.get(runtimeKeyString(key))?.leases.values() ?? [])];
  }

  /** The ready runtime of a key, if any (never one still initializing). */
  get(key: RuntimeKey): R | null {
    return this.entries.get(runtimeKeyString(key))?.runtime ?? null;
  }

  attach(key: RuntimeKey, kind: DemandKind): Lease<R> {
    const k = runtimeKeyString(key);
    let entry = this.entries.get(k);
    if (!entry) {
      const gen = ++this.gen;
      const pending = this.stopping.get(k) ?? Promise.resolve();
      const created: Entry<R> = { gen, ready: Promise.resolve(null as unknown as R), runtime: null, leases: new Map(), paused: false };
      created.ready = pending.then(async () => {
        if (this.entries.get(k) !== created) throw new RuntimeCancelled();
        const r = await this.o.create(key);
        // Stopped (or replaced) while it was being created: close the late result instead of exposing it.
        if (this.entries.get(k) !== created || created.gen !== gen) {
          await r.close().catch(() => {});
          throw new RuntimeCancelled();
        }
        created.runtime = r;
        if (created.paused) r.setPaused?.(true);
        return r;
      });
      created.ready.catch(() => {}); // observed through leases
      entry = created;
      this.entries.set(k, created);
    }
    const id = ++this.leaseSeq;
    entry.leases.set(id, kind);
    const owner = entry;
    let released = false;
    return {
      key,
      kind,
      runtime: owner.ready,
      release: async () => {
        if (released) return;
        released = true;
        // A lease of an older generation never touches a newer attachment of the same key.
        if (this.entries.get(k) !== owner) return;
        owner.leases.delete(id);
        if (owner.leases.size === 0) await this.stopKey(k, owner);
      },
    };
  }

  /** Pauses or resumes networking of a key (remembered for a runtime that is still starting). */
  setPaused(key: RuntimeKey, paused: boolean) {
    const e = this.entries.get(runtimeKeyString(key));
    if (!e) return;
    e.paused = paused;
    e.runtime?.setPaused?.(paused);
  }

  /** Stops a key regardless of its leases (removal, deletion). Pending initialization is cancelled. */
  async stop(key: RuntimeKey) {
    const k = runtimeKeyString(key);
    const e = this.entries.get(k);
    if (e) await this.stopKey(k, e);
    else await this.stopping.get(k);
  }

  /**
   * Local stop barrier (D5): stops every runtime matching `filter` (an account or server switch, sign-out, local mode)
   * and resolves only once all of them are closed. New attachments made meanwhile get fresh runtimes.
   */
  async stopWhere(filter: (key: RuntimeKey) => boolean) {
    await Promise.all(this.keys().filter(filter).map((key) => this.stop(key)));
  }

  private stopKey(k: string, e: Entry<R>): Promise<void> {
    if (this.entries.get(k) === e) this.entries.delete(k);
    e.gen = -1; // invalidates an initialization in flight
    const done = e.ready.then(
      (r) => r.close(),
      () => {},
    );
    // A later attachment chains on every stop still running for this key.
    const prev = this.stopping.get(k);
    const chained = (prev ? Promise.all([prev, done]).then(() => {}) : done).finally(() => {
      if (this.stopping.get(k) === chained) this.stopping.delete(k);
    });
    this.stopping.set(k, chained);
    return chained;
  }
}
