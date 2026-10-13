import { MsgType } from '@hivetex/protocol';
import { describe, expect, it } from 'vitest';
import { PeerConnection, peerAuthenticationTranscript } from '../src/connection.js';
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
    await expect.poll(async () => got, { timeout: 15_000 }).toEqual([MsgType.STEP1]);
    expect(ca.droppedFromViewer).toBe(3);
  });
});

describe('inbound queue budget (F12)', () => {
  it('closes an authenticated connection whose peer sends a frame above the inbound budget', async () => {
    const auth = await TestAuthority.create();
    const [a, b] = [await identity('alice', 'owner'), await identity('bob', 'editor')];
    const [ta, tb] = loopbackPair();
    const mint = (id: typeof a) => auth.mint({ pid: 'proj1', uid: id.uid, uname: id.uname, dev: id.dev, keys: id.keys, role: id.role });
    const [tickA, tickB] = [await mint(a), await mint(b)];
    const ca = new PeerConnection({ transport: ta, projectId: 'proj1', keys: a.keys, trusted: auth.trusted, getTicket: () => tickA, maxInboundBytes: 4000 });
    const cb = new PeerConnection({ transport: tb, projectId: 'proj1', keys: b.keys, trusted: auth.trusted, getTicket: () => tickB });
    await Promise.all([ca.ready, cb.ready]);
    const junk = new Uint8Array(5000);
    junk[0] = MsgType.AWARENESS;
    await tb.send('sync', junk);
    await tick(30);
    await expect.poll(async () => ca.closed, { timeout: 15_000 }).toBe(true);
  });
});

describe('outbound frame ordering (F12)', () => {
  it('keeps send order when a compressed frame is followed by small uncompressed ones', async () => {
    const auth = await TestAuthority.create();
    const [a, b] = [await identity('alice', 'owner'), await identity('bob', 'editor')];
    const { ca, cb } = await connect(auth, a, b);
    await Promise.all([ca.ready, cb.ready]);
    const seen: number[] = [];
    cb.onFrame((_c, _t, payload) => seen.push((JSON.parse(new TextDecoder().decode(payload)) as { n: number }).n));
    const big = jsonBytes({ n: 0, pad: 'compressible '.repeat(40_000) });
    await Promise.all([
      ca.send(MsgType.APP, big),
      ca.send(MsgType.APP, jsonBytes({ n: 1 })),
      ca.send(MsgType.APP, jsonBytes({ n: 2 })),
    ]);
    await tick(100);
    await expect.poll(async () => seen.slice(0, 3), { timeout: 15_000 }).toEqual([0, 1, 2]);
  });
});


describe('transport authentication binding', () => {
  it('preserves the exact legacy DTLS signed bytes in both directions', () => {
    const binding = { kind: 'dtls' as const, localFingerprint: 'AA:AA', remoteFingerprint: 'BB:BB' };
    const decode = (b: Uint8Array) => new TextDecoder().decode(b);
    expect(decode(peerAuthenticationTranscript(binding, 'proj1', 'a', 'b'))).toBe('hivetex/v1\0proj1\0AA:AA\0BB:BB\0a\0b');
    expect(decode(peerAuthenticationTranscript(binding, 'proj1', 'b', 'a', true))).toBe('hivetex/v1\0proj1\0BB:BB\0AA:AA\0b\0a');
  });

  it('authenticates an explicit DTLS adapter with a legacy adapter', async () => {
    const auth = await TestAuthority.create();
    const t = loopbackPair();
    Object.defineProperty(t[0], 'authenticationBinding', { value: {
      kind: 'dtls', localFingerprint: t[0].localFingerprint, remoteFingerprint: t[0].remoteFingerprint,
    } });
    const { ca, cb } = await connect(auth, await identity('a', 'owner'), await identity('b', 'editor'), { transport: t });
    await Promise.all([ca.ready, cb.ready]);
    ca.close();
    cb.close();
  });

  it.each(['matching', 'changed transcript', 'reflected role', 'dtls downgrade'])(
    'handles relay binding: %s', async (mode) => {
      const auth = await TestAuthority.create();
      const t = loopbackPair();
      Object.defineProperty(t[0], 'authenticationBinding', { value: { kind: 'relay', transcriptHash: 'A'.repeat(43), localRole: 'initiator' } });
      if (mode !== 'dtls downgrade') Object.defineProperty(t[1], 'authenticationBinding', { value: {
        kind: 'relay', transcriptHash: (mode === 'changed transcript' ? 'B' : 'A').repeat(43),
        localRole: mode === 'reflected role' ? 'initiator' : 'responder',
      } });
      const { ca, cb } = await connect(auth, await identity('a', 'owner'), await identity('b', 'editor'), { transport: t });
      if (mode === 'matching') await Promise.all([ca.ready, cb.ready]);
      else {
        await expect(ca.ready).rejects.toThrow();
        await expect(cb.ready).rejects.toThrow();
      }
      ca.close();
      cb.close();
    },
  );

  it('rejects an invalid explicit binding instead of falling back to DTLS', async () => {
    const auth = await TestAuthority.create();
    const t = loopbackPair();
    Object.defineProperty(t[0], 'authenticationBinding', { value: { kind: 'relay', transcriptHash: '', localRole: 'initiator' } });
    await expect(connect(auth, await identity('a', 'owner'), await identity('b', 'editor'), { transport: t })).rejects.toThrow('invalid transport authentication binding');
  });
});
