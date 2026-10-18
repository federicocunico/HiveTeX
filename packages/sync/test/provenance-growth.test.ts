import { afterEach, expect, it } from 'vitest';

/**
 * Spec peer-sync "Bounded provenance growth": 1,000 single-character edits in a 100 KB file synchronized with one
 * co-author. Store and network growth must follow the typed content, not the document size.
 *
 * HIVETEX_SYNC_SRC points the test at another checkout's `packages/sync/src` (absolute path), to show that the first
 * apply of audit-sync-data-safety (a full preimage per operation) fails it. Default: this checkout.
 */
const base = process.env.HIVETEX_SYNC_SRC ? `file:///${process.env.HIVETEX_SYNC_SRC.replace(/\\/g, '/').replace(/^\/+/, '')}` : '../src';
const { Net, converged, waitFor } = await import(/* @vite-ignore */ `${base}/testkit.ts`) as typeof import('../src/testkit.js');
const { loopbackPair } = await import(/* @vite-ignore */ `${base}/transport.ts`) as typeof import('../src/transport.js');
const { ChangeLog } = await import(/* @vite-ignore */ `${base}/changelog.ts`) as typeof import('../src/changelog.js');

type Store = { docs: Map<string, Uint8Array[]>; meta: Map<string, unknown>; changes: Map<string, unknown> };
const valueBytes = (v: unknown): number => ArrayBuffer.isView(v) ? v.byteLength : new TextEncoder().encode(JSON.stringify(v) ?? '').length;
function storeBytes(s: Store) {
  let n = 0;
  for (const updates of s.docs.values()) for (const u of updates) n += u.byteLength;
  for (const [k, v] of s.meta) n += k.length + valueBytes(v);
  for (const c of s.changes.values()) n += valueBytes(c);
  return n;
}

/** Per-keystroke threshold after the first measurement (docs/runtime.md): 3 KB, independent of the document size. */
const PER_KEY = 3 * 1024;
/**
 * Continuous typing forms a few Changes groups, each holding at most a preimage and before/after texts: a fixed number
 * of document copies in total, never one per keystroke.
 */
const DOC_COPIES = 8;

let net: InstanceType<typeof Net> | undefined;
afterEach(() => net?.destroy());

async function measure(docSize: number, keys: number) {
  net = await Net.create();
  const a = await net.add('Alice', 'owner'), b = await net.add('Bob', 'editor');
  const logs = [a, b].map((n) => new ChangeLog({ model: n.model, store: n.store, idleMs: 60_000 }));
  for (const l of logs) l.start();
  const body = 'lorem ipsum\n'.repeat(Math.ceil(docSize / 12)).slice(0, docSize);
  const id = await a.model.createTextNow('main.tex', body);
  const [ta, tb] = loopbackPair();
  let sent = 0;
  for (const t of [ta, tb]) { const send = t.send.bind(t); t.send = (ch, data) => { sent += data.byteLength; return send(ch, data); }; }
  await Promise.all([a.mesh.addTransport(ta), b.mesh.addTransport(tb)]);
  await converged([a, b], id, 10_000);
  await a.model.flush(); await b.model.flush();
  await waitFor(() => a.mesh.historyStatus.complete && b.mesh.historyStatus.complete, 10_000);
  await new Promise((r) => setTimeout(r, 300));
  const before = [storeBytes(a.store as unknown as Store), storeBytes(b.store as unknown as Store)], sentBefore = sent;
  const text = await a.model.openText(id);
  for (let n = 0; n < keys; n++) text.insert(Math.floor(text.length / 2), 'x');
  await waitFor(async () => (await b.model.openText(id)).length === docSize + keys, 60_000);
  for (const l of logs) await l.flush();
  await a.model.flush(); await b.model.flush();
  await new Promise((r) => setTimeout(r, 300));
  for (const l of logs) l.stop();
  const added = [storeBytes(a.store as unknown as Store) - before[0]!, storeBytes(b.store as unknown as Store) - before[1]!];
  const groups = Math.max(...await Promise.all([a, b].map(async (n) => (await n.store.listChangeSets()).length)));
  return { added, sent: sent - sentBefore, groups };
}

it('keeps store and network growth for 1,000 keystrokes in a 100 KB file within the per-keystroke and per-group bound', async () => {
  const keys = 1000, size = 100 * 1024;
  const m = await measure(size, keys);
  console.info(`provenance growth: store +${m.added.map((n) => `${(n / 1024).toFixed(0)} KB`).join(' / +')}, sent ${(m.sent / 1024).toFixed(0)} KB, ${m.groups} groups`);
  for (const added of m.added) expect(added).toBeLessThan(keys * PER_KEY + DOC_COPIES * size);
  expect(m.sent).toBeLessThan(keys * PER_KEY);
  // The same typing in a four times larger document costs the same on the wire.
  net?.destroy();
  const large = await measure(4 * size, keys);
  expect(large.sent).toBeLessThan(m.sent * 1.25 + 16 * 1024);
}, 300_000);
