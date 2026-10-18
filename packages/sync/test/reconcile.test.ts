import { MsgType, fileDocId } from '@hivetex/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { packDoc } from '../src/frames.js';
import { ProjectModel } from '../src/model.js';
import { loopbackPair } from '../src/transport.js';
import { Gate } from './gate.js';
import { waitFor } from './helpers.js';
import { type Node, Net } from './net.js';

let net: Net;
afterEach(() => net?.destroy());

const FAST = { flushMs: 1 };

/** Links two nodes; the returned gates withhold each side's outgoing frames on demand. */
async function linkGated(a: Node, b: Node) {
  const [ta, tb] = loopbackPair();
  const [ga, gb] = [new Gate(ta), new Gate(tb)];
  await Promise.all([a.mesh.addTransport(ga), b.mesh.addTransport(gb)]);
  return { ga, gb };
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe('document reconciliation (5.2)', () => {
  it('confirms a remote empty file, which then counts as complete and stays so after reopening', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    const id = a.model.createText('empty.tex');
    await net.link(a, b);
    await waitFor(() => b.model.list().length === 1);
    expect(b.model.availability(fileDocId(id))).toBe('unknown');
    const r = await b.mesh.reconcile(fileDocId(id));
    expect(r).toMatchObject({ outcome: 'confirmed', source: a.dev });
    expect(b.model.availability(fileDocId(id))).toBe('complete');
    expect(b.mesh.reconciled(fileDocId(id))).toBe(true);
    await b.model.flush();
    const again = new ProjectModel(b.store, FAST);
    await again.init();
    expect(again.availability(fileDocId(id))).toBe('complete');
  });

  it('reports a document nobody can confirm as unavailable, not as empty', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    a.model.putEntry('ghost', { path: 'ghost.tex', kind: 'text' });
    await net.link(a, b);
    await waitFor(() => b.model.list().length === 1);
    expect(await b.mesh.reconcile(fileDocId('ghost'))).toMatchObject({ outcome: 'unavailable' });
    expect(await b.mesh.reconcile('f:never-heard-of')).toMatchObject({ outcome: 'unavailable' });
    expect(b.model.availability(fileDocId('ghost'))).not.toBe('complete');
  });

  it('does not take a partial peer for a source of complete state', async () => {
    net = await Net.create();
    const [a, c, b] = [await net.add('alice', 'owner'), await net.add('carol', 'editor'), await net.add('bob', 'editor')];
    const id = await a.model.createTextNow('main.tex', 'body');
    await net.link(a, c);
    await waitFor(() => c.model.list().length === 1);
    await c.mesh.openDoc(fileDocId(id)); // carol holds a copy that nobody confirmed
    await waitFor(async () => (await c.model.openText(id)).toString() === 'body');
    await net.link(c, b);
    await waitFor(() => b.model.list().length === 1);
    expect(await b.mesh.reconcile(fileDocId(id))).toMatchObject({ outcome: 'unavailable' });
    expect(b.model.availability(fileDocId(id))).not.toBe('complete');
  });

  it('times out, cancels and settles on disconnection without claiming success', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    const id = await a.model.createTextNow('main.tex', 'body');
    const { ga } = await linkGated(a, b);
    await waitFor(() => b.model.list().length === 1);
    ga.closed = true;
    expect(await b.mesh.reconcile(fileDocId(id), { timeoutMs: 40 })).toMatchObject({ outcome: 'timeout' });
    const ctl = new AbortController();
    const pending = b.mesh.reconcile(fileDocId(id), { signal: ctl.signal, timeoutMs: 5000 });
    await settle(10);
    ctl.abort();
    expect(await pending).toMatchObject({ outcome: 'cancelled' });
    const gone = b.mesh.reconcile(fileDocId(id), { timeoutMs: 5000 });
    await settle(10);
    net.isolate(b);
    expect(await gone).toMatchObject({ outcome: 'disconnected' });
    expect(b.model.availability(fileDocId(id))).not.toBe('complete');
    expect(await b.mesh.reconcile(fileDocId(id))).toMatchObject({ outcome: 'unavailable', reason: 'no-peer' });
  });

  it('ignores a delayed reply of an earlier round while the current round is still waiting', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    const id = await a.model.createTextNow('main.tex', 'body');
    const { ga } = await linkGated(a, b);
    await waitFor(() => b.model.list().length === 1);
    ga.closed = true;
    expect(await b.mesh.reconcile(fileDocId(id), { timeoutMs: 40 })).toMatchObject({ outcome: 'timeout' });
    await waitFor(() => ga.held.length > 0);
    await settle(20);
    const old = ga.take(); // alice's answers to round 1
    const round2 = b.mesh.reconcile(fileDocId(id), { timeoutMs: 5000 });
    let done = false;
    void round2.then(() => (done = true));
    await waitFor(() => ga.held.length > 0);
    await settle(20);
    await ga.deliver(old); // the old reply arrives while round 2 waits for its own
    await settle(40);
    expect(done).toBe(false);
    expect(b.model.availability(fileDocId(id))).not.toBe('complete');
    await ga.release();
    expect(await round2).toMatchObject({ outcome: 'confirmed' });
    expect(b.model.availability(fileDocId(id))).toBe('complete');
  });

  it.each([
    ['receipt-capable', true],
    ['legacy', false],
  ])('never completes a round from an unrelated incremental update (%s peer)', async (_n, receipts) => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner', { meshOpts: { receipts } }), await net.add('bob', 'editor')];
    const id = await a.model.createTextNow('main.tex', 'body');
    const { ga } = await linkGated(a, b);
    await waitFor(() => b.model.list().length === 1);
    ga.closed = true;
    const round = b.mesh.reconcile(fileDocId(id), { timeoutMs: 150 });
    await settle(30);
    // alice keeps editing: a live update reaches bob although her answer to the request does not
    const doc = await a.model.getDoc(fileDocId(id));
    doc.getText('t').insert(0, 'more ');
    ga.bypass = true;
    await a.mesh.peers[0]?.conn.send(MsgType.UPDATE, packDoc(fileDocId(id), Y.encodeStateAsUpdate(doc)));
    ga.bypass = false;
    expect(await round).toMatchObject({ outcome: 'timeout' });
    expect((await b.model.openText(id)).toString()).toContain('more');
    expect(b.model.availability(fileDocId(id))).toBe('partial');
  });

  it('keeps legacy STEP1/STEP2 peers working, one outstanding exchange per document and connection', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner', { meshOpts: { receipts: false } }), await net.add('bob', 'editor')];
    const id = await a.model.createTextNow('main.tex', 'body');
    const empty = a.model.createText('empty.tex');
    const { ga, gb } = await linkGated(a, b);
    await waitFor(() => b.model.list().length === 2);
    await settle(80);
    // a legacy peer's STEP2 completes the exchange (an empty one included)
    expect(await b.mesh.reconcile(fileDocId(empty))).toMatchObject({ outcome: 'confirmed' });
    expect(b.model.availability(fileDocId(empty))).toBe('complete');

    ga.closed = true;
    const sent = gb.sentTypes.get(MsgType.STEP1) ?? 0;
    const [r1, r2] = await Promise.all([
      b.mesh.reconcile(fileDocId(id), { timeoutMs: 60 }),
      b.mesh.reconcile(fileDocId(id), { timeoutMs: 60 }),
    ]);
    expect([r1.outcome, r2.outcome]).toEqual(['timeout', 'timeout']);
    expect((gb.sentTypes.get(MsgType.STEP1) ?? 0) - sent).toBe(1); // history traffic cannot answer a reconciliation
    // the first exchange's answer finally arrives: it answers an abandoned request, not a later one
    await ga.release();
    await settle(60);
    expect(b.model.availability(fileDocId(id))).not.toBe('complete');
    expect(await b.mesh.reconcile(fileDocId(id), { timeoutMs: 2000 })).toMatchObject({ outcome: 'confirmed' });
    expect(b.model.availability(fileDocId(id))).toBe('complete');
  });

  it('lets a legacy requester complete against a receipt-capable peer', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor', { meshOpts: { receipts: false } })];
    const id = await a.model.createTextNow('main.tex', 'body');
    await net.link(a, b);
    await waitFor(() => b.model.list().length === 1);
    expect(await b.mesh.reconcile(fileDocId(id))).toMatchObject({ outcome: 'confirmed' });
    expect((await b.model.openText(id)).toString()).toBe('body');
  });

  it('never uses a viewer as a source of document state', async () => {
    net = await Net.create();
    const [a, v, b] = [await net.add('alice', 'owner'), await net.add('vera', 'viewer'), await net.add('bob', 'editor')];
    const id = await a.model.createTextNow('main.tex', 'body');
    await net.link(a, v);
    await waitFor(() => v.model.list().length === 1);
    expect(await v.mesh.reconcile(fileDocId(id))).toMatchObject({ outcome: 'confirmed' }); // a viewer may receive
    await net.link(v, b);
    // vera holds the complete file, but a viewer's state is never applied, so it cannot be a source
    expect(await b.mesh.reconcile(fileDocId(id))).toMatchObject({ outcome: 'unavailable', reason: 'no-peer' });
    expect(b.model.availability(fileDocId(id))).not.toBe('complete');
  });
});
