import { RelayHandshake, type RelaySession, type StoredDeviceKeys } from '@hivetex/crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChannelName, PeerTransport } from '../src/transport.js';
import { Net, type Node, converged, text } from './net.js';
import { waitFor } from './helpers.js';

// An ordered test wire around real encrypted sessions, deliberately without server delivery/retry logic.
class CipherWire implements PeerTransport {
  peer!: CipherWire;
  closed = false;
  private message = 0;
  private listener: (c: ChannelName, d: Uint8Array) => void = () => {};
  private onClosed: () => void = () => {};
  private sends = Promise.resolve();
  constructor(private session: RelaySession) {}
  get authenticationBinding() { return this.session.binding; }
  send(channel: ChannelName, data: Uint8Array) {
    const run = this.sends.then(async () => {
      if (this.closed) throw new Error('closed');
      const env = await this.session.seal({ kind: 'data', channel, message: this.message++, fragment: 0, fragments: 1 }, data);
      const received = await this.peer.session.open(env);
      if (!this.closed && !this.peer.closed && !received.duplicate) this.peer.listener(channel, received.plaintext);
    });
    this.sends = run.catch(() => {});
    return run;
  }
  onMessage(cb: typeof this.listener) { this.listener = cb; }
  onClose(cb: () => void) { this.onClosed = cb; }
  close() {
    if (this.closed) return;
    this.closed = true; this.session.close(); this.onClosed(); this.peer.close();
  }
}
const keys = (n: Node) => (n.mesh as unknown as { o: { keys: StoredDeviceKeys } }).o.keys;
let net: Net;
afterEach(() => net?.destroy());
async function link(a: Node, b: Node) {
  const options = { projectId: net.pid, trusted: net.auth.trusted, now: () => net.auth.now().getTime() };
  const ha = await RelayHandshake.create({ ...options, keys: keys(a), ticket: a.ticket, peerDeviceId: b.dev, role: 'initiator' });
  const hb = await RelayHandshake.create({ ...options, keys: keys(b), ticket: b.ticket, peerDeviceId: a.dev, role: 'responder' });
  const [pa, pb] = await Promise.all([ha.acceptHello(hb.hello), hb.acceptHello(ha.hello)]);
  const [ca, cb] = await Promise.all([ha.acceptProof(pb), hb.acceptProof(pa)]);
  const wa = new CipherWire(await ha.acceptConfirmation(cb)), wb = new CipherWire(await hb.acceptConfirmation(ca));
  wa.peer = wb; wb.peer = wa;
  return Promise.all([a.mesh.addTransport(wa), b.mesh.addTransport(wb)]);
}
const mint = (n: Node, role: 'owner' | 'editor' | 'viewer', ep: number) => net.auth.mint({ pid: net.pid, uid: 'u-' + n.name, uname: n.name, dev: n.dev, keys: keys(n), role, ep });

describe('relay membership enforcement through the existing mesh', () => {
  it('retains viewer restrictions over encrypted sessions', async () => {
    net = await Net.create();
    const owner = await net.add('owner', 'owner'), viewer = await net.add('viewer', 'viewer');
    await link(owner, viewer);
    const id = await owner.model.createTextNow('main.tex', 'base');
    await converged([owner, viewer], id);
    (await viewer.model.openText(id)).insert(4, '-forbidden');
    await new Promise(r => setTimeout(r, 100));
    expect(await text(owner, id)).toBe('base');
  });

  it('does not apply an update delayed past demotion, or accept the old editor ticket on reconnect', async () => {
    net = await Net.create();
    let now = Date.now(); net.auth.now = () => new Date(now);
    const owner = await net.add('owner', 'owner'), editor = await net.add('editor', 'editor');
    await link(owner, editor);
    const id = await editor.model.createTextNow('main.tex', 'base');
    await converged([owner, editor], id);
    let release!: () => void, entered = false;
    const gate = new Promise<void>(r => { release = r; });
    const getDoc = owner.model.getDoc.bind(owner.model);
    owner.model.getDoc = async doc => { entered = true; await gate; return getDoc(doc); };
    (await editor.model.openText(id)).insert(4, '-delayed');
    await waitFor(() => entered);
    now += 5000;
    await editor.mesh.refreshOwnTicket(await mint(editor, 'viewer', 2));
    await waitFor(() => owner.mesh.peers[0]?.claims.role === 'viewer');
    release(); await new Promise(r => setTimeout(r, 100));
    expect(await text(owner, id)).toBe('base');
    net.isolate(editor);
    await expect(link(owner, editor)).rejects.toThrow('stale device ticket');
  });

  it('rejects stale membership after a removed member exceeds the existing epoch grace', async () => {
    net = await Net.create();
    let now = Date.now(); net.auth.now = () => new Date(now);
    const owner = await net.add('owner', 'owner', { meshOpts: { epochGraceMs: 100, policyIntervalMs: 1_000_000 } });
    const editor = await net.add('editor', 'editor');
    await link(owner, editor);
    await owner.mesh.refreshOwnTicket(await mint(owner, 'owner', 2));
    await waitFor(() => owner.mesh.epoch === 2);
    now += 200; owner.mesh.enforcePolicy();
    await waitFor(() => owner.mesh.peers.length === 0);
    await expect(link(owner, editor)).rejects.toThrow('stale membership epoch');
  });
});
