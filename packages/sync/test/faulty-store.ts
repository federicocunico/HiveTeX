import { MemoryPersistence, type StoreOp } from '../src/persistence.js';

type Kind = 'append' | 'compact' | 'transact';

export interface Deferred {
  release(): void;
  fail(e?: Error): void;
  /** Resolves once a call is waiting on this deferral. */
  reached: Promise<void>;
}

/** MemoryPersistence whose writes can be made to fail or to wait, for storage-failure tests. */
export class FaultyPersistence extends MemoryPersistence {
  failAppend = 0;
  failCompact = 0;
  failTransact = 0;
  appendCalls = 0;
  compactCalls = 0;
  transactCalls = 0;
  private holds: Array<{ kind: Kind; wait: Promise<void>; reached: () => void }> = [];

  /** The next call of this kind waits until the returned handle is released (or failed). */
  hold(kind: Kind): Deferred {
    let release!: () => void;
    let fail!: (e?: Error) => void;
    let reached!: () => void;
    const wait = new Promise<void>((res, rej) => {
      release = res;
      fail = (e = new Error('held write failed')) => rej(e);
    });
    wait.catch(() => {});
    const reachedP = new Promise<void>((r) => {
      reached = r;
    });
    this.holds.push({ kind, wait, reached });
    return { release, fail, reached: reachedP };
  }

  private async gate(kind: Kind) {
    const i = this.holds.findIndex((h) => h.kind === kind);
    if (i < 0) return;
    const h = this.holds.splice(i, 1)[0] as { wait: Promise<void>; reached: () => void };
    h.reached();
    await h.wait;
  }

  override async append(docId: string, updates: Uint8Array[]) {
    this.appendCalls++;
    await this.gate('append');
    if (this.failAppend > 0) {
      this.failAppend--;
      throw new Error('append failed');
    }
    return super.append(docId, updates);
  }

  override async compact(docId: string, state: Uint8Array) {
    this.compactCalls++;
    await this.gate('compact');
    if (this.failCompact > 0) {
      this.failCompact--;
      throw new Error('compact failed');
    }
    return super.compact(docId, state);
  }

  override async transact(ops: StoreOp[]) {
    this.transactCalls++;
    await this.gate('transact');
    if (this.failTransact > 0 && !ops.some((o) => o.op === 'meta' && o.key.startsWith('operation:record:'))) {
      this.failTransact--;
      throw new Error('transact failed');
    }
    // Journaled appends are one transaction in production. Keep the append fault controls meaningful for the
    // durability suite, injecting before any part of that transaction is visible.
    if (ops.some((o) => o.op === 'meta' && o.key.startsWith('operation:record:'))) {
      this.appendCalls++;
      await this.gate('append');
      if (this.failAppend > 0) { this.failAppend--; throw new Error('append failed'); }
    }
    // Applied directly (not through append/compact above) so that one transition is one fault point, like a real transaction.
    for (const o of ops) {
      if (o.op === 'append') await MemoryPersistence.prototype.append.call(this, o.docId, o.updates);
      else if (o.op === 'compact') await MemoryPersistence.prototype.compact.call(this, o.docId, o.state);
      else if (o.value === undefined) this.meta.delete(o.key);
      else this.meta.set(o.key, o.value);
    }
  }
}
