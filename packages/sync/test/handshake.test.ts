import { MsgType } from '@hivetex/protocol';
import { describe, expect, it } from 'vitest';
import { PeerConnection } from '../src/connection.js';
import { jsonBytes } from '../src/frames.js';
import { loopbackPair } from '../src/transport.js';
import { TestAuthority, identity, tick } from './helpers.js';

async function connect(
  auth: TestAuthority,
  a: Awaited<ReturnType<typeof identity>>,
  b: Awaited<ReturnType<typeof identity>>,
  o: { pidA?: string; pidB?: string; transport?: ReturnType<typeof loopbackPair> } = {},
) {
  const [ta, tb] = o.transport ?? loopbackPair();
  const mk = async (id: typeof a, t: typeof ta, pid: string) =>
    new PeerConnection({
      transport: t,
      projectId: 'proj1',
      keys: id.keys,
      trusted: auth.trusted,
      getTicket: () => '',
      handshakeTimeoutMs: 500,
      ...{ _ticketPid: pid },
    });
  // Build connections with real tickets (getTicket must be sync, so mint first).
  const tickA = await auth.mint({ pid: o.pidA ?? 'proj1', uid: a.uid, uname: a.uname, dev: a.dev, keys: a.keys, role: a.role });
  const tickB = await auth.mint({ pid: o.pidB ?? 'proj1', uid: b.uid, uname: b.uname, dev: b.dev, keys: b.keys, role: b.role });
  const ca = new PeerConnection({ transport: ta, projectId: 'proj1', keys: a.keys, trusted: auth.trusted, getTicket: () => tickA, handshakeTimeoutMs: 500 });
  const cb = new PeerConnection({ transport: tb, projectId: 'proj1', keys: b.keys, trusted: auth.trusted, getTicket: () => tickB, handshakeTimeoutMs: 500 });
  void mk;
  return { ca, cb };
}

describe('peer authentication handshake (6.2)', () => {
  it('authenticates two valid peers and exposes verified claims', async () => {
    const auth = await TestAuthority.create();
    const [a, b] = [await identity('alice', 'owner'), await identity('bob', 'editor')];
    const { ca, cb } = await connect(auth, a, b);
    const [claimsOfB, claimsOfA] = await Promise.all([ca.ready, cb.ready]);
    expect(claimsOfB).toMatchObject({ uname: 'bob', role: 'editor', pid: 'proj1' });
    expect(claimsOfA).toMatchObject({ uname: 'alice', role: 'owner' });
  });

  it('closes when the peer presents a ticket for another project', async () => {
    const auth = await TestAuthority.create();
    const [a, b] = [await identity('alice', 'owner'), await identity('mallory', 'owner')];
    const { ca, cb } = await connect(auth, a, b, { pidB: 'other-project' });
    await expect(ca.ready).rejects.toThrow();
    await expect(cb.ready).rejects.toThrow();
    expect(ca.closed).toBe(true);
  });

  it('rejects a swapped DTLS fingerprint (signaling-server MITM)', async () => {
    const auth = await TestAuthority.create();
    const [a, b] = [await identity('alice', 'owner'), await identity('bob', 'editor')];
    // A believes B's fingerprint is 'EVIL'; the signatures cannot match on both sides.
    const t = loopbackPair({ seenByA: 'EVIL:EVIL' });
    const { ca, cb } = await connect(auth, a, b, { transport: t });
    await expect(ca.ready).rejects.toThrow(/key-possession|closed|timeout/);
    await expect(cb.ready).rejects.toThrow();
  });

  it('rejects a peer that does not hold the key named in its ticket', async () => {
    const auth = await TestAuthority.create();
    const [a, b, thief] = [await identity('alice', 'owner'), await identity('bob', 'editor'), await identity('thief', 'editor')];
    // thief replays bob's ticket but signs with its own key
    const [ta, tb] = loopbackPair();
    const tickA = await auth.mint({ pid: 'proj1', uid: a.uid, uname: a.uname, dev: a.dev, keys: a.keys, role: a.role });
    const bobTicket = await auth.mint({ pid: 'proj1', uid: b.uid, uname: b.uname, dev: b.dev, keys: b.keys, role: b.role });
    const ca = new PeerConnection({ transport: ta, projectId: 'proj1', keys: a.keys, trusted: auth.trusted, getTicket: () => tickA, handshakeTimeoutMs: 500 });
    const cb = new PeerConnection({ transport: tb, projectId: 'proj1', keys: thief.keys, trusted: auth.trusted, getTicket: () => bobTicket, handshakeTimeoutMs: 500 });
    await expect(ca.ready).rejects.toThrow(/key-possession|closed/);
    void cb;
  });

  it('rejects expired tickets', async () => {
    const auth = await TestAuthority.create();
    const [a, b] = [await identity('alice', 'owner'), await identity('bob', 'editor')];
    const [ta, tb] = loopbackPair();
    const old = Math.floor(Date.now() / 1000) - 3600;
    const tickA = await auth.mint({ pid: 'proj1', uid: a.uid, uname: a.uname, dev: a.dev, keys: a.keys, role: a.role });
    const tickB = await auth.mint({ pid: 'proj1', uid: b.uid, uname: b.uname, dev: b.dev, keys: b.keys, role: b.role }, { iat: old });
    const ca = new PeerConnection({ transport: ta, projectId: 'proj1', keys: a.keys, trusted: auth.trusted, getTicket: () => tickA, handshakeTimeoutMs: 500 });
    new PeerConnection({ transport: tb, projectId: 'proj1', keys: b.keys, trusted: auth.trusted, getTicket: () => tickB, handshakeTimeoutMs: 500 });
    await expect(ca.ready).rejects.toThrow();
  });

  it('refuses application frames before authentication', async () => {
    const auth = await TestAuthority.create();
    const a = await identity('alice', 'owner');
    const [ta, tb] = loopbackPair();
    const tickA = await auth.mint({ pid: 'proj1', uid: a.uid, uname: a.uname, dev: a.dev, keys: a.keys, role: a.role });
    const ca = new PeerConnection({ transport: ta, projectId: 'proj1', keys: a.keys, trusted: auth.trusted, getTicket: () => tickA, handshakeTimeoutMs: 500 });
    await tb.send('sync', new Uint8Array([MsgType.UPDATE, 0, 0]));
    await expect(ca.ready).rejects.toThrow();
    await tick(5);
    void jsonBytes;
  });

  it('drops frames a viewer is not allowed to send (role filter)', async () => {
    const auth = await TestAuthority.create();
    const [a, v] = [await identity('alice', 'editor'), await identity('vic', 'viewer')];
    const { ca, cb } = await connect(auth, a, v);
    await Promise.all([ca.ready, cb.ready]);
    const got: number[] = [];
    ca.onFrame((_c, type) => got.push(type));
    await cb.send(MsgType.UPDATE, new Uint8Array([0, 0]));
    await cb.send(MsgType.STEP2, new Uint8Array([0, 0]));
    await cb.send(MsgType.BLOB_HAVE, jsonBytes({ hashes: [] }));
    await cb.send(MsgType.STEP1, new Uint8Array([0, 0]));
    await tick(30);
    expect(got).toEqual([MsgType.STEP1]);
    expect(ca.droppedFromViewer).toBe(3);
  });
});
