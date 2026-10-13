/**
 * Background transfer budgets of one device (D8, 8.6), shared by every runtime in the worker:
 *
 * - concurrency: at most `global` background blob transfers at once and `perProject` per project; foreground
 *   (editor-attached) projects take a free slot before any background project and are never limited per project;
 * - fairness: waiting projects are served round robin, so a large project cannot starve the others;
 * - receive buffer: each transfer reserves its declared size from `receiveBytes` (32 MiB) before it starts;
 * - bandwidth: completed background bytes are paced to `bytesPerSecond` (5 MiB/s);
 * - storage: retained background content may not exceed `retainedBudget` (2 GiB), and a transfer that would leave
 *   less than `reserveBytes` (128 MiB) free waits. Both defer with a visible reason; nothing already stored, unsaved
 *   or kept for recovery is ever evicted to make room.
 */

export type DeferReason = 'storage-budget' | 'storage-full' | 'too-large';

export class TransferDeferred extends Error {
  constructor(readonly reason: DeferReason) {
    super(`transfer deferred: ${reason}`);
  }
}

export interface TransferLimits {
  global: number;
  perProject: number;
  receiveBytes: number;
  bytesPerSecond: number;
  retainedBudget: number;
  reserveBytes: number;
}
export const DEFAULT_TRANSFER_LIMITS: TransferLimits = {
  global: 2,
  perProject: 1,
  receiveBytes: 32 * 1024 * 1024,
  bytesPerSecond: 5 * 1024 * 1024,
  retainedBudget: 2 * 1024 * 1024 * 1024,
  reserveBytes: 128 * 1024 * 1024,
};

interface Waiter {
  project: string;
  size: number;
  foreground: boolean;
  resolve: (release: () => void) => void;
}

export class TransferScheduler {
  private active = 0;
  private perProject = new Map<string, number>();
  private reserved = 0;
  private waiting: Waiter[] = [];
  /** Round-robin cursor: the project served last goes to the back. */
  private lastServed: string[] = [];
  private nextAllowedAt = 0;
  private limits: TransferLimits;
  readonly stats = { started: 0, deferred: 0, maxActive: 0, maxReserved: 0 };

  constructor(
    limits: Partial<TransferLimits> = {},
    private o: {
      /** Free bytes on the volume holding the stores (native side); unknown → no disk check. */
      freeBytes?: () => Promise<number | null>;
      /** Background content currently retained by all seeds. */
      retainedBytes?: () => Promise<number>;
      now?: () => number;
    } = {},
  ) {
    this.limits = { ...DEFAULT_TRANSFER_LIMITS, ...limits };
  }

  private now() {
    return (this.o.now ?? Date.now)();
  }

  /**
   * Waits for a slot, the receive-buffer reservation and the pacing, or throws TransferDeferred when storage limits
   * forbid the transfer for now. The returned function releases everything; call it once the transfer ended.
   */
  async acquire(project: string, size: number, foreground = false): Promise<() => void> {
    const s = Math.max(0, size);
    if (!foreground) await this.checkStorage(s);
    const release = await new Promise<() => void>((resolve) => {
      this.waiting.push({ project, size: s, foreground, resolve });
      this.pump();
    });
    if (!foreground) {
      const wait = this.nextAllowedAt - this.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    return release;
  }

  private async checkStorage(size: number) {
    const [free, retained] = await Promise.all([this.o.freeBytes?.() ?? null, this.o.retainedBytes?.() ?? 0]);
    if (retained + size > this.limits.retainedBudget) {
      this.stats.deferred++;
      throw new TransferDeferred('storage-budget');
    }
    if (free !== null && free - size < this.limits.reserveBytes) {
      this.stats.deferred++;
      throw new TransferDeferred('storage-full');
    }
  }

  private fits(w: Waiter) {
    if (this.active >= this.limits.global) return false;
    if (!w.foreground && (this.perProject.get(w.project) ?? 0) >= this.limits.perProject) return false;
    // The receive budget is shared; a transfer larger than all of it runs only when nothing else is reserved.
    return this.reserved === 0 || this.reserved + w.size <= this.limits.receiveBytes;
  }

  private pump() {
    for (;;) {
      const candidates = this.waiting.filter((w) => this.fits(w));
      if (!candidates.length) return;
      // Foreground first; then the project served least recently (round robin), then arrival order.
      const rank = (w: Waiter) => (w.foreground ? -1 : this.lastServed.indexOf(w.project));
      candidates.sort((a, b) => rank(a) - rank(b));
      const w = candidates[0] as Waiter;
      this.waiting.splice(this.waiting.indexOf(w), 1);
      this.lastServed = [...this.lastServed.filter((p) => p !== w.project), w.project];
      this.active++;
      this.perProject.set(w.project, (this.perProject.get(w.project) ?? 0) + 1);
      this.reserved += w.size;
      this.stats.started++;
      this.stats.maxActive = Math.max(this.stats.maxActive, this.active);
      this.stats.maxReserved = Math.max(this.stats.maxReserved, this.reserved);
      let done = false;
      w.resolve(() => {
        if (done) return;
        done = true;
        this.active--;
        this.perProject.set(w.project, (this.perProject.get(w.project) ?? 1) - 1);
        this.reserved -= w.size;
        if (!w.foreground && this.limits.bytesPerSecond > 0) {
          // Pace background bulk: the next background start waits until these bytes "fit" the rate.
          this.nextAllowedAt = Math.max(this.nextAllowedAt, this.now()) + (w.size / this.limits.bytesPerSecond) * 1000;
        }
        this.pump();
      });
    }
  }
}
