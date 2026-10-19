import { afterEach, describe, expect, it } from 'vitest';
import { jsonBytes } from '../src/frames.js';
import { waitFor } from './helpers.js';
import { type Node, Net, converged, text } from './net.js';

let net: Net;
afterEach(() => net?.destroy());

const EPOCH = 0x20;
const keysOf = (n: Node) => (n.mesh as unknown as { o: { keys: never } }).o.keys;
const mint = (n: Node, role: 'owner' | 'editor' | 'viewer', ep: number, o: { pid?: string; iat?: number } = {}) =>
  net.auth.mint(
    { pid: o.pid ?? 'proj1', uid: `u-${n.name}`, uname: n.name, dev: n.dev, keys: keysOf(n), role, ep },
    o.iat === undefined ? {} : { iat: o.iat },
  );
const settle = () => new Promise((r) => setTimeout(r, 80));

describe('authoritative membership epochs (F05)', () => {
  it('a viewer announcing an invented epoch neither advances policy nor evicts members nor storms refreshes', async () => {
    net = await Net.create();
    const clock = { t: Date.now() };
    net.auth.now = () => new Date(clock.t);
    const meshOpts = { epochGraceMs: 60_000, policyIntervalMs: 1_000_000 };
    const [owner, vic] = [await net.add('owen', 'owner', { meshOpts }), await net.add('vic', 'viewer', { meshOpts })];
    await net.link(owner, vic);
    let refreshes = 0;
    owner.mesh.onEpochAdvance(() => refreshes++);

    for (let i = 0; i < 5; i++) vic.mesh.broadcast(EPOCH, jsonBytes({ epoch: 1_000_000_000 + i }));
    await settle();
    await expect.poll(async () => owner.mesh.epoch, { timeout: 15_000 }).toBe(1);
    expect(refreshes).toBeLessThanOrEqual(1);

    clock.t += 120_000;
    owner.mesh.enforcePolicy();
    vic.mesh.enforcePolicy();
    await settle();
    await expect.poll(async () => owner.mesh.peers, { timeout: 15_000 }).toHaveLength(1);
    expect(vic.mesh.peers).toHaveLength(1);
  });

  it('rejects wrong-project, expired and unsigned evidence relayed in EPOCH frames', async () => {
    net = await Net.create();
    const [owner, vic] = [await net.add('owen', 'owner'), await net.add('vic', 'viewer')];
    await net.link(owner, vic);
    const now = Math.floor(Date.now() / 1000);
    const evidence = [
      await mint(vic, 'viewer', 7, { pid: 'other-project' }),
      await mint(vic, 'viewer', 7, { iat: now - 5000 }),
      'not.a.ticket',
    ];
    for (const ticket of evidence) vic.mesh.broadcast(EPOCH, jsonBytes({ epoch: 7, ticket }));
    await settle();
    await expect.poll(async () => owner.mesh.epoch, { timeout: 15_000 }).toBe(1);
  });

  it('advances to the epoch of a valid same-project ticket, not to the number claimed beside it', async () => {
    net = await Net.create();
    const [owner, vic] = [await net.add('owen', 'owner'), await net.add('vic', 'viewer')];
    await net.link(owner, vic);
    vic.mesh.broadcast(EPOCH, jsonBytes({ epoch: 100, ticket: await mint(vic, 'viewer', 3) }));
    await waitFor(() => owner.mesh.epoch === 3);
    await settle();
    await expect.poll(async () => owner.mesh.epoch, { timeout: 15_000 }).toBe(3);
  });

  it('the local refresh path advances our own epoch and relays verified evidence to every peer', async () => {
    net = await Net.create();
    const [owner, ed, vic] = [await net.add('owen', 'owner'), await net.add('edd', 'editor'), await net.add('vic', 'viewer')];
    await net.link(owner, ed);
    await net.link(owner, vic);
    await owner.mesh.refreshOwnTicket(await mint(owner, 'owner', 2));
    expect(owner.mesh.epoch).toBe(2);
    await waitFor(() => ed.mesh.epoch === 2 && vic.mesh.epoch === 2);
  });

  it('a refreshed ticket for another project or an expired one does not advance the local epoch', async () => {
    net = await Net.create();
    const [owner, ed] = [await net.add('owen', 'owner'), await net.add('edd', 'editor')];
    await net.link(owner, ed);
    await owner.mesh.refreshOwnTicket(await mint(owner, 'owner', 5, { pid: 'other-project' }));
    await owner.mesh.refreshOwnTicket(await mint(owner, 'owner', 5, { iat: Math.floor(Date.now() / 1000) - 5000 }));
    await settle();
    await expect.poll(async () => owner.mesh.epoch, { timeout: 15_000 }).toBe(1);
    expect(ed.mesh.epoch).toBe(1);
  });
});

describe('current authorization for delayed work (F18)', () => {
  it('does not apply or forward an editor update whose sender was demoted while its document load waited', async () => {
    net = await Net.create();
    const clock = { t: Date.now() };
    net.auth.now = () => new Date(clock.t);
    const [owner, dee, vic] = [await net.add('owen', 'owner'), await net.add('dee', 'editor'), await net.add('vic', 'viewer')];
    await net.link(owner, dee);
    await net.link(owner, vic);
    const id = await dee.model.createTextNow('main.tex', 'base');
    await converged([owner, dee, vic], id);
    // the owner's document load is deferred (slow storage)
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const getDoc = owner.model.getDoc.bind(owner.model);
    owner.model.getDoc = async (docId: string) => {
      await gate;
      return getDoc(docId);
    };
    (await dee.model.openText(id)).insert(4, ' evil');
    await settle(); // the update reached the owner and waits for the load
    clock.t += 5_000;
    net.auth.epoch = 2;
    await dee.mesh.refreshOwnTicket(await mint(dee, 'viewer', 2, { iat: Math.floor(clock.t / 1000) }));
    await waitFor(() => owner.mesh.peers.find((p) => p.claims.uname === 'dee')?.claims.role === 'viewer');
    release();
    await settle();
    await expect.poll(async () => await text(owner, id), { timeout: 15_000 }).toBe('base');
    expect(await text(vic, id)).toBe('base');
  });

  it('refuses a reconnect that presents an older editor ticket after a newer viewer ticket was seen', async () => {
    net = await Net.create();
    const clock = { t: Date.now() };
    net.auth.now = () => new Date(clock.t);
    const meshOpts = { epochGraceMs: 60_000, policyIntervalMs: 1_000_000 };
    const owner = await net.add('owen', 'owner', { meshOpts });
    const dee = await net.add('dee', 'editor', { meshOpts });
    await net.link(owner, dee);
    net.auth.epoch = 2;
    clock.t += 5_000;
    await dee.mesh.refreshOwnTicket(await mint(dee, 'viewer', 2, { iat: Math.floor(clock.t / 1000) }));
    await waitFor(() => owner.mesh.peers[0]?.claims.role === 'viewer');

    net.isolate(dee);
    await waitFor(() => owner.mesh.peers.length === 0);
    // dee's mesh still presents its original editor ticket (epoch 1), within the stale-epoch grace period
    await expect(net.link(owner, dee)).rejects.toThrow();
    await waitFor(() => owner.mesh.rejected.length > 0);
    expect(owner.mesh.peers.find((p) => p.claims.role === 'editor')).toBeUndefined();
  });
});

describe('typing across an epoch bump', () => {
  // CI full-flow: the owner demotes someone else while an unaffected editor types. The editor's next keystrokes are
  // still signed with its previous-epoch ticket until its own refresh lands; none of them may be lost.
  it("an unaffected editor's keystrokes signed before its refresh still reach everyone", async () => {
    net = await Net.create();
    const held: { ticket?: string; node?: Node } = {};
    const owner = await net.add('owen', 'owner');
    const ed = await net.add('edd', 'editor', { meshOpts: { getTicket: () => held.ticket ?? held.node?.ticket ?? '' } });
    held.node = ed;
    const vic = await net.add('vic', 'editor');
    await net.link(owner, ed);
    await net.link(owner, vic);
    await net.link(ed, vic);
    const id = await owner.model.createTextNow('main.tex', 'owner line');
    await converged([owner, ed, vic], id);
    const typed = async (s: string) => { const t = await ed.model.openText(id); t.insert(t.length, s); };

    await typed(' B-f');
    await waitFor(async () => (await text(owner, id)).endsWith(' B-f') && (await text(vic, id)).endsWith(' B-f'));
    // vic is demoted: the owner learns the new epoch first and relays the evidence
    await owner.mesh.refreshOwnTicket(await mint(owner, 'owner', 2));
    await waitFor(() => ed.mesh.epoch === 2 && vic.mesh.epoch === 2);
    await typed('rom'); // still signed with edd's epoch-1 editor ticket
    await settle();
    held.ticket = await mint(ed, 'editor', 2);
    await ed.mesh.refreshOwnTicket(held.ticket);
    await typed('-editor');

    for (const n of [owner, vic]) await expect.poll(async () => await text(n, id), { timeout: 5_000 }).toBe('owner line B-from-editor');
  });

  it('keystrokes the demoted member signed with the old editor ticket are held, then refused once its viewer ticket shows', async () => {
    net = await Net.create();
    const owner = await net.add('owen', 'owner');
    const dee = await net.add('dee', 'editor');
    await net.link(owner, dee);
    const id = await owner.model.createTextNow('main.tex', 'base');
    await converged([owner, dee], id);
    await owner.mesh.refreshOwnTicket(await mint(owner, 'owner', 2)); // dee was demoted
    await waitFor(() => dee.mesh.epoch === 2);
    (await dee.model.openText(id)).insert(4, ' evil'); // signed with dee's epoch-1 editor ticket
    await settle();
    await dee.mesh.refreshOwnTicket(await mint(dee, 'viewer', 2, { iat: Math.floor(Date.now() / 1000) + 1 }));
    await waitFor(() => owner.mesh.peers[0]?.claims.role === 'viewer');
    await settle();
    expect(await text(owner, id)).toBe('base');
  });
});

describe('privileged application messages (3.3)', () => {
  it('drops editor-only topics from a peer that is a viewer when the message arrives', async () => {
    net = await Net.create();
    const [owner, dee] = [await net.add('owen', 'owner'), await net.add('dee', 'editor')];
    await net.link(owner, dee);
    const seen: string[] = [];
    (owner.mesh as unknown as { onApp: (t: string, h: (f: unknown, b: unknown) => void, o?: object) => void }).onApp(
      'priv',
      (_f, b) => seen.push(String(b)),
      { editorOnly: true },
    );
    dee.mesh.broadcastApp('priv', 'while-editor');
    await waitFor(() => seen.length === 1);
    net.auth.epoch = 2;
    await dee.mesh.refreshOwnTicket(await mint(dee, 'viewer', 2, { iat: Math.floor(Date.now() / 1000) + 1 }));
    await waitFor(() => owner.mesh.peers[0]?.claims.role === 'viewer');
    dee.mesh.broadcastApp('priv', 'while-viewer');
    await settle();
    await expect.poll(async () => seen, { timeout: 15_000 }).toEqual(['while-editor']);
  });
});
