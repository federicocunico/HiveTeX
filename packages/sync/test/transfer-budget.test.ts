import { afterEach, describe, expect, it } from 'vitest';
import { BlobManager } from '../src/blobs.js';
import { sha256Hex } from '../src/model.js';
import { SyncTracker } from '../src/sync-status.js';
import { Net } from '../src/testkit.js';
import { TransferDeferred, TransferScheduler } from '../src/transfer-budget.js';

/** 8.6: device-wide background transfer budgets. */
const MiB = 1024 * 1024;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('transfer scheduler (8.6)', () => {
  it('serves projects round robin within the global and per-project limits, so none starves', async () => {
    const s = new TransferScheduler({ bytesPerSecond: 0 });
    const order: string[] = [];
    const run = async (p: string) => {
      const release = await s.acquire(p, 1);
      order.push(p);
      await tick(10);
      release();
    };
    // A big project queues five transfers before two small ones ask for one each.
    const jobs = [...Array.from({ length: 5 }, () => run('big')), run('small1'), run('small2')];
    await Promise.all(jobs);
    expect(s.stats.maxActive).toBeLessThanOrEqual(2);
    // The small projects are served right after big's first transfer, not after all five.
    expect(order.indexOf('small1')).toBeLessThan(3);
    expect(order.indexOf('small2')).toBeLessThan(3);
    expect(order.filter((p) => p === 'big')).toHaveLength(5);
  });

  it('gives foreground transfers the next slot and does not limit them per project', async () => {
    const s = new TransferScheduler({ bytesPerSecond: 0, global: 1 });
    const hold = await s.acquire('bg', 1);
    const order: string[] = [];
    const bg = s.acquire('bg2', 1).then((r) => { order.push('background'); r(); });
    const fg = s.acquire('open', 1, true).then((r) => { order.push('foreground'); r(); });
    await tick();
    hold();
    await Promise.all([bg, fg]);
    expect(order).toEqual(['foreground', 'background']);
  });

  it('keeps reserved receive bytes within the budget (one oversized transfer may run alone)', async () => {
    const s = new TransferScheduler({ bytesPerSecond: 0, global: 4, perProject: 4, receiveBytes: 10 * MiB });
    const sizes = [6, 6, 3, 12, 2].map((m) => m * MiB);
    await Promise.all(sizes.map(async (size, i) => {
      const r = await s.acquire(`p${i}`, size);
      await tick(10);
      r();
    }));
    expect(s.stats.maxReserved).toBeLessThanOrEqual(12 * MiB);
    expect(s.stats.started).toBe(5);
  });

  it('defers when the retained budget or the disk reserve would be exceeded, and recovers when space returns', async () => {
    let free = 200 * MiB;
    let retained = 0;
    const s = new TransferScheduler({ bytesPerSecond: 0, retainedBudget: 1000 * MiB, reserveBytes: 128 * MiB }, { freeBytes: async () => free, retainedBytes: async () => retained });
    await expect(s.acquire('p', 100 * MiB)).rejects.toMatchObject({ reason: 'storage-full' });
    retained = 990 * MiB;
    free = 10_000 * MiB;
    await expect(s.acquire('p', 20 * MiB)).rejects.toMatchObject({ reason: 'storage-budget' });
    retained = 0;
    const release = await s.acquire('p', 20 * MiB);
    release();
    // A foreground (open project) transfer is never deferred by background budgets.
    free = 0;
    (await s.acquire('p', 20 * MiB, true))();
  });

  it('paces background bytes to the configured rate', async () => {
    const s = new TransferScheduler({ bytesPerSecond: 10 * MiB });
    (await s.acquire('p', 2 * MiB))();
    const t = Date.now();
    (await s.acquire('q', 1))();
    expect(Date.now() - t).toBeGreaterThanOrEqual(150); // 2 MiB at 10 MiB/s
  });
});

describe('tracker under the transfer budget (8.6)', () => {
  let net: Net;
  const trackers: SyncTracker[] = [];
  afterEach(() => { for (const t of trackers.splice(0)) t.stop(); net?.destroy(); });

  it('a disk-full device shows the binary as deferred, keeps what it has, and fetches it once space returns', async () => {
    net = await Net.create();
    const author = await net.add('author', 'owner');
    const seed = await net.add('seed', 'editor');
    await author.model.createTextNow('main.tex', 'text');
    const png = new Uint8Array(50_000).map((_, i) => i % 7);
    const hash = await new BlobManager(author.mesh, author.store).add(png);
    author.model.createBinary('fig.png', hash, png.length);
    const keep = new TextEncoder().encode('already stored, never evicted');
    await seed.store.putBlob(await sha256Hex(keep), keep);
    let free = 0;
    const scheduler = new TransferScheduler({ bytesPerSecond: 0 }, { freeBytes: async () => free, retainedBytes: async () => 0 });
    const tracker = new SyncTracker({ mesh: seed.mesh, model: seed.model, store: seed.store, blobs: new BlobManager(seed.mesh, seed.store), connecting: () => 0, offline: () => false, throttleMs: 5, retryBaseMs: 100, retryMaxMs: 200, transfers: { scheduler, project: 'p', foreground: () => false } });
    trackers.push(tracker);
    tracker.start();
    await net.link(author, seed);
    const deferred = async () => (await tracker.refresh()).files.find((f) => f.kind === 'binary')?.deferred;
    for (let i = 0; i < 200 && (await deferred()) !== 'storage-full'; i++) await tick(20);
    expect(await deferred()).toBe('storage-full');
    expect(tracker.snapshot.stage).not.toBe('synced');
    expect(await seed.store.getBlob(await sha256Hex(keep))).toBeDefined();
    free = 10_000 * MiB;
    for (let i = 0; i < 300 && tracker.snapshot.stage !== 'synced'; i++) await tick(20);
    expect(tracker.snapshot.stage).toBe('synced');
    expect(await deferred()).toBeUndefined();
    expect(scheduler.stats.deferred).toBeGreaterThan(0);
    expect(TransferDeferred).toBeDefined();
  }, 30_000);
});
