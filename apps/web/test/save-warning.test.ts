import { MemoryPersistence, ProjectModel } from '@hivetex/sync';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { exportRecoveryZip } from '../src/lib/recovery-export.js';
import { saveWarning, syncLabel } from '../src/lib/sync-view.js';

/** Storage that refuses every write, like a full or revoked IndexedDB. */
class BrokenStore extends MemoryPersistence {
  broken = true;
  override async append(docId: string, updates: Uint8Array[]) {
    if (this.broken) throw new Error('QuotaExceededError');
    return super.append(docId, updates);
  }
}

const wait = (cond: () => boolean, ms = 3000) =>
  new Promise<void>((resolve, reject) => {
    const end = Date.now() + ms;
    const t = setInterval(() => {
      if (cond()) (clearInterval(t), resolve());
      else if (Date.now() > end) (clearInterval(t), reject(new Error('timeout')));
    }, 5);
  });

describe('local save failures reach the workspace', () => {
  it('stays visible while storage fails, exports the retained work, and clears only after it is stored', async () => {
    const store = new BrokenStore();
    const model = new ProjectModel(store, { flushMs: 1, retryMs: 5, maxRetryMs: 20 });
    await model.init();
    let failing = false;
    model.onSaveState((s) => {
      failing = s.failing;
    });
    const id = await model.createTextNow('main.tex', 'unsaved thesis');
    await wait(() => failing);
    expect(saveWarning(failing)).toContain('Not saved on this device');
    // the status line does not claim the edits are saved
    expect(syncLabel(null, 0, failing)).not.toContain('Saved on this device');
    expect(syncLabel({ stage: 'alone', peers: 0, connecting: 0, rootSynced: true, total: 1, received: 1, percent: 100, files: [], lastSyncAt: null, stalled: false }, 0, failing)).toContain('not saved');

    // still failing after a retry or two: the warning has not cleared
    await new Promise((r) => setTimeout(r, 60));
    expect(failing).toBe(true);
    expect(store.docs.get(`f:${id}`)).toBeUndefined();

    const out = await exportRecoveryZip(model, async () => {
      throw new Error('no blob');
    });
    expect(out.missing).toEqual([]);
    expect(new TextDecoder().decode(unzipSync(out.zip)['main.tex'])).toBe('unsaved thesis');

    // storage recovers: the warning clears only once the retained edit is committed
    store.broken = false;
    await wait(() => !failing);
    expect(store.docs.get(`f:${id}`)?.length).toBeGreaterThan(0);
    expect(saveWarning(failing)).toBeNull();
  });

  it('lists files that cannot be read instead of failing the export', async () => {
    const store = new MemoryPersistence();
    const model = new ProjectModel(store, { flushMs: 1 });
    await model.init();
    await model.createTextNow('a.tex', 'ok');
    model.createBinary('img.png', 'deadbeef', 3);
    const out = await exportRecoveryZip(model, async () => {
      throw new Error('not on this device');
    });
    expect(out.missing).toEqual(['img.png']);
    const files = unzipSync(out.zip);
    expect(Object.keys(files).sort()).toEqual(['RECOVERY-MISSING.txt', 'a.tex']);
  });
});
