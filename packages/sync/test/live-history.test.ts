import { afterEach, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Net, TestAuthority, converged, identity, waitFor } from '../src/testkit.js';
import { MemoryPersistence } from '../src/persistence.js';
import { signOperation, storeAuthoredOperation } from '../src/authorship.js';

let net: Net | undefined;
afterEach(() => net?.destroy());

/** Times one edit from `from` until `to` shows it; a failure prints the trace of what each side holds. */
async function propagation(from: Awaited<ReturnType<Net['add']>>, to: Awaited<ReturnType<Net['add']>>, id: string, mark: string, ms = 1_000) {
  const started = Date.now();
  (await from.model.openText(id)).insert(0, mark);
  await waitFor(async () => (await to.model.openText(id)).toString().startsWith(mark), ms).catch(async (e) => {
    console.error('TRACE', JSON.stringify({ mark, from: (await from.model.openText(id)).toString().slice(0, 80), to: (await to.model.openText(id)).toString().slice(0, 80), save: from.model.saveState, history: from.mesh.historyStatus }));
    throw e;
  });
  return Date.now() - started;
}

it('keeps live edits flowing while provenance storage fails continuously, with a persistent warning', async () => {
  class FailingAuthority extends MemoryPersistence {
    override async setMeta(key: string, value: unknown) {
      if (key.startsWith('authored')) throw new Error('authored records unavailable');
      return super.setMeta(key, value);
    }
  }
  net = await Net.create();
  const a = await net.add('Alice', 'owner', { store: new FailingAuthority() }), b = await net.add('Bob', 'editor');
  const id = await a.model.createTextNow('main.tex', 'base');
  await net.link(a, b); await converged([a, b], id);
  for (let n = 0; n < 10; n++) expect(await propagation(a, b, id, `${n}.`)).toBeLessThan(1_000);
  await waitFor(() => a.model.saveState.docs.includes('history:authorship'));
  // The document itself is durable: flush does not wait for, or fail on, the provenance retry.
  await a.model.flush();
  expect(a.model.saveState.failing).toBe(true);
  expect(await propagation(a, b, id, 'after-flush.')).toBeLessThan(1_000);
});

it('keeps Alice <-> Bob edits within normal time while Carol bootstraps a large retained history', async () => {
  net = await Net.create();
  const a = await net.add('Alice', 'owner'), b = await net.add('Bob', 'editor');
  const id = await a.model.createTextNow('main.tex', 'base');
  const big = await a.model.createTextNow('big.tex', '');
  const body = await a.model.openText(big);
  for (let n = 0; n < 24; n++) body.insert(0, `${n}`.padEnd(300 * 1024, '.'));
  await a.model.flush();
  await net.link(a, b); await converged([a, b], id);
  await waitFor(() => b.mesh.historyStatus.complete, 30_000);
  const c = await net.add('Carol', 'editor');
  // A slow link to Carol: retained history to her takes seconds.
  await net.link(a, c, { latencyMs: 30 });
  await c.mesh.openDoc(`f:${id}`);
  const times: number[] = [];
  for (let n = 0; n < 6; n++) {
    times.push(await propagation(a, b, id, `a${n}.`));
    times.push(await propagation(b, a, id, `b${n}.`));
  }
  expect(c.mesh.historyStatus.complete).toBe(false); // still bootstrapping while the edits above went through
  expect(Math.max(...times)).toBeLessThan(500);
  await waitFor(() => c.mesh.historyStatus.complete, 60_000);
}, 90_000);

it('skips a history record signed by an untrusted key and one never answered; paging continues and settles as incomplete', async () => {
  net = await Net.create();
  const b = await net.add('Bob', 'owner');
  const id = await b.model.createTextNow('main.tex', 'base');
  for (let n = 0; n < 40; n++) (await b.model.openText(id)).insert(0, '.');
  await b.model.flush();
  // A record signed under another authority, and a descriptor whose content is gone (Bob cannot answer it).
  const stranger = await identity('Mallory', 'editor'), other = await TestAuthority.create();
  const ticket = await other.mint({ pid: net.pid, uid: stranger.uid, uname: stranger.uname, dev: stranger.dev, keys: stranger.keys, role: 'editor' });
  const doc = new Y.Doc(); doc.getText('t').insert(0, 'forged');
  const forged = await signOperation({ pid: net.pid, docId: `f:${id}`, update: Y.encodeStateAsUpdate(doc), ticket, source: 'editor' }, stranger.keys);
  await storeAuthoredOperation(b.store, forged);
  await b.store.setMeta('authored:00000000-dead-0000-0000-000000000000', { v: 1, chunks: 1 });
  const total = (await b.store.listMetaKeys!('authored:')).filter((k) => k.startsWith('authored:')).length;
  const c = await net.add('Carol', 'editor', { meshOpts: { historyWantTimeoutMs: 300 } });
  await net.link(b, c);
  await waitFor(() => c.mesh.historyStatus.incomplete, 15_000).catch((e) => { console.error('TRACE', JSON.stringify(c.mesh.historyStatus)); throw e; });
  expect(c.mesh.historyStatus).toMatchObject({ complete: false, incomplete: true, skipped: 2, pending: 0 });
  const reasons = c.mesh.historySkipped.map((s) => s.reason);
  expect(reasons.some((r) => r.startsWith('verification failed'))).toBe(true);
  expect(reasons).toContain('no answer');
  expect(c.mesh.historySkipped.every((s) => s.device === b.dev)).toBe(true);
  const received = (await c.store.listMetaKeys!('authored:')).filter((k) => k.startsWith('authored:')).length;
  expect(received).toBe(total - 2);
});
