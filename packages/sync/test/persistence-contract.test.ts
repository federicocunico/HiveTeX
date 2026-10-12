import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { NATIVE_CHUNK, NativePersistence, decodeValue, encodeValue, storeScope } from '../src/native-persistence.js';
import { fakeNative, sha } from './native-fake.js';
import { IndexedDbPersistence, MemoryPersistence, type Persistence } from '../src/persistence.js';

/**
 * 5.1: one contract for every Persistence. The native store's SQLite semantics are tested in Rust (store.rs); here a
 * stand-in for the Tauri commands checks the adapter's encoding, chunking and error paths against the same contract.
 */

let dbn = 0;
const makers: Array<[string, () => Promise<{ p: Persistence; failNext?: () => void }>]> = [
  ['memory', async () => ({ p: new MemoryPersistence() })],
  ['indexeddb', async () => ({ p: await IndexedDbPersistence.open(`contract-${dbn++}`, new IDBFactory()) })],
  ['native', async () => { const f = fakeNative(); return { p: await NativePersistence.open(f.invoke, 'a'.repeat(64)), failNext: f.failNext }; }],
];

for (const [name, make] of makers) {
  describe(`persistence contract: ${name}`, () => {
    it('stores document updates in order, compacts one document and lists documents', async () => {
      const { p } = await make();
      await p.append('a', [new Uint8Array([1]), new Uint8Array([2])]);
      await p.append('b', [new Uint8Array([9])]);
      await p.append('a', [new Uint8Array([3])]);
      expect((await p.load('a')).map((u) => [...u])).toEqual([[1], [2], [3]]);
      await p.compact('a', new Uint8Array([7, 7]));
      expect((await p.load('a')).map((u) => [...u])).toEqual([[7, 7]]);
      expect((await p.load('b')).map((u) => [...u])).toEqual([[9]]);
      expect((await p.listDocs()).sort()).toEqual(['a', 'b']);
      expect(await p.load('missing')).toEqual([]);
    });

    it('applies a transaction of documents and metadata together, binary values included', async () => {
      const { p } = await make();
      const journal = { pending: [new Uint8Array([5, 6])], at: 3, nested: { bytes: new Uint8Array([1]) } };
      await p.transact([{ op: 'append', docId: 'd', updates: [new Uint8Array([1])] }, { op: 'meta', key: 'journal', value: journal }]);
      const got = (await p.getMeta('journal')) as typeof journal;
      expect([...got.pending[0] as Uint8Array]).toEqual([5, 6]);
      expect([...got.nested.bytes]).toEqual([1]);
      expect(got.at).toBe(3);
      await p.transact([{ op: 'meta', key: 'journal', value: undefined }]);
      expect(await p.getMeta('journal')).toBeUndefined();
      await p.setMeta('k', { ok: true });
      expect(await p.getMeta('k')).toEqual({ ok: true });
    });

    it('stores blobs, snapshots and change sets with their ordering and retention', async () => {
      const { p } = await make();
      const blob = new TextEncoder().encode('figure');
      await p.putBlob(sha(blob), blob);
      expect([...((await p.getBlob(sha(blob))) as Uint8Array)]).toEqual([...blob]);
      expect(await p.getBlob('0'.repeat(64))).toBeUndefined();
      expect(await p.listBlobs()).toEqual([sha(blob)]);
      await p.putSnapshot({ id: 's2', at: 2, files: [] });
      await p.putSnapshot({ id: 's1', at: 1, files: [{ path: 'a.tex', kind: 'text', text: 'x' }] });
      expect((await p.listSnapshots()).map((s) => s.id)).toEqual(['s1', 's2']);
      const now = 1_000_000_000_000;
      for (let i = 0; i < 503; i++) await p.putChangeSet({ id: `c${i}`, source: { kind: 'editor', name: 'me' }, startedAt: 0, endedAt: now - 30 * 24 * 3600_000 - i, files: [] });
      expect((await p.listChangeSets())[0]?.id).toBe('c0');
      expect(await p.pruneChangeSets(now)).toBe(3);
      expect(await p.listChangeSets()).toHaveLength(500);
    });
  });
}

describe('native adapter specifics (5.1)', () => {
  it('stages large blobs in bounded chunks, reads them back in chunks and rejects a wrong hash', async () => {
    const f = fakeNative();
    const p = await NativePersistence.open(f.invoke, 'b'.repeat(64));
    const big = new Uint8Array(NATIVE_CHUNK * 2 + 123).map((_, i) => i % 251);
    await p.putBlob(sha(big), big);
    expect(f.calls.filter((c) => c === 'store_stage_chunk')).toHaveLength(3);
    expect(f.calls).toContain('store_stage_commit');
    const back = (await p.getBlob(sha(big))) as Uint8Array;
    expect(back.length).toBe(big.length);
    expect(sha(back)).toBe(sha(big));
    expect(f.calls.filter((c) => c === 'store_read_blob')).toHaveLength(3);
    await expect(p.putBlob('f'.repeat(64), big)).rejects.toThrow();
    expect(f.calls.at(-1)).toBe('store_stage_abort');
    expect(await p.listBlobs()).toEqual([sha(big)]);
  });

  it('a failed transaction leaves the previous state; one writer per scope; closed stores refuse calls', async () => {
    const f = fakeNative();
    const p = await NativePersistence.open(f.invoke, 'c'.repeat(64));
    await p.append('d', [new Uint8Array([1])]);
    f.failNext();
    await expect(p.transact([{ op: 'compact', docId: 'd', state: new Uint8Array([2]) }, { op: 'meta', key: 'm', value: 1 }])).rejects.toThrow('disk full');
    expect((await p.load('d')).map((u) => [...u])).toEqual([[1]]);
    expect(await p.getMeta('m')).toBeUndefined();
    await expect(NativePersistence.open(f.invoke, 'c'.repeat(64))).rejects.toThrow('already open');
    p.close();
    await expect(p.load('d')).rejects.toThrow('closed');
  });

  it('scopes stores by canonical server, account and project; the value codec round-trips bytes', async () => {
    const s1 = await storeScope('https://HiveTeX.app/', 'ann', 'p1');
    expect(s1).toMatch(/^[0-9a-f]{64}$/);
    expect(await storeScope('https://hivetex.app', 'ann', 'p1')).toBe(s1);
    expect(await storeScope('https://hivetex.app', 'bob', 'p1')).not.toBe(s1);
    expect(await storeScope('https://other.app', 'ann', 'p1')).not.toBe(s1);
    const v = decodeValue(encodeValue({ a: [new Uint8Array([0, 255])], s: 'x', n: null })) as { a: Uint8Array[]; s: string; n: null };
    expect([...(v.a[0] as Uint8Array)]).toEqual([0, 255]);
    expect(v.s).toBe('x');
    expect(v.n).toBeNull();
  });
});
