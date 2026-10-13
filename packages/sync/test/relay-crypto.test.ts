import { RelayHandshake, type RelayHandshakeOptions, type RelayFrameContext, toB64u } from '@hivetex/crypto';
import { describe, expect, it, vi } from 'vitest';
import { TestAuthority, identity } from './helpers.js';

async function fixture() {
  const authority = await TestAuthority.create();
  const [alice, bob] = [await identity('alice', 'owner'), await identity('bob', 'editor')];
  let now = Date.now();
  const mint = (id: typeof alice) => authority.mint({ pid: 'project', ...id });
  const [ticketA, ticketB] = await Promise.all([mint(alice), mint(bob)]);
  const a: RelayHandshakeOptions = { projectId: 'project', peerDeviceId: bob.dev, ticket: ticketA, keys: alice.keys, trusted: authority.trusted, role: 'initiator', now: () => now };
  const b: RelayHandshakeOptions = { projectId: 'project', peerDeviceId: alice.dev, ticket: ticketB, keys: bob.keys, trusted: authority.trusted, role: 'responder', now: () => now };
  const pair = async () => Promise.all([RelayHandshake.create(a), RelayHandshake.create(b)]);
  return { a, b, pair, authority, alice, bob, advance: (ms: number) => { now += ms; } };
}
async function sessions(f: Awaited<ReturnType<typeof fixture>>) {
  const [a, b] = await f.pair();
  const [ap, bp] = await Promise.all([a.acceptHello(b.hello), b.acceptHello(a.hello)]);
  const [ac, bc] = await Promise.all([a.acceptProof(bp), b.acceptProof(ap)]);
  return Promise.all([a.acceptConfirmation(bc), b.acceptConfirmation(ac)]);
}
const ctx: RelayFrameContext = { kind: 'data', channel: 'sync', message: 0, fragment: 0, fragments: 1 };

describe('authenticated ephemeral relay handshake', () => {
  it('confirms both directional keys and exchanges ciphertext with matching transcript bindings', async () => {
    const f = await fixture(), [a, b] = await sessions(f);
    expect(a.binding.transcriptHash).toBe(b.binding.transcriptHash);
    expect(a.binding.localRole).not.toBe(b.binding.localRole);
    const text = new TextEncoder().encode('private project update');
    const ab = await a.seal(ctx, text), ba = await b.seal(ctx, text);
    expect(ab.ciphertext).not.toBe(ba.ciphertext);
    expect((await b.open(ab)).plaintext).toEqual(text);
    expect((await a.open(ba)).plaintext).toEqual(text);
    a.close(); b.close();
  });

  it.each(['ephemeral', 'challenge', 'generation', 'role', 'ticket'] as const)('rejects substituted %s', async (field) => {
    const f = await fixture(), [a, b] = await f.pair(), [other] = await f.pair();
    const hello = { ...b.hello };
    if (field === 'ephemeral') hello.ephemeral = other.hello.ephemeral;
    if (field === 'challenge') hello.challenge = other.hello.challenge;
    if (field === 'generation') hello.generation = other.hello.generation;
    if (field === 'role') hello.role = 'initiator';
    if (field === 'ticket') hello.ticket = a.hello.ticket;
    if (field === 'role' || field === 'ticket') await expect(a.acceptHello(hello)).rejects.toThrow();
    else {
      await a.acceptHello(hello);
      const bp = await b.acceptHello(a.hello);
      await expect(a.acceptProof(bp)).rejects.toThrow('possession');
    }
    a.close(); b.close(); other.close();
  });

  it('rejects reflected proof and confirmation', async () => {
    const f = await fixture(), [a, b] = await f.pair();
    const ap = await a.acceptHello(b.hello); await b.acceptHello(a.hello);
    await expect(a.acceptProof(ap)).rejects.toThrow('possession');
    b.close();
    const [c, d] = await f.pair();
    const cp = await c.acceptHello(d.hello), dp = await d.acceptHello(c.hello);
    const cc = await c.acceptProof(dp); await d.acceptProof(cp);
    await expect(c.acceptConfirmation(cc)).rejects.toThrow('confirmation');
    d.close();
  });

  it('requires proof before key confirmation', async () => {
    const f = await fixture(), [a, b] = await f.pair();
    await a.acceptHello(b.hello);
    await expect(a.acceptConfirmation('A'.repeat(43))).rejects.toThrow('unexpected');
    await expect(a.acceptProof('A'.repeat(86))).rejects.toThrow('closed');
    b.close();
  });

  it('rejects a copied ticket with another signing key', async () => {
    const f = await fixture();
    await expect(RelayHandshake.create({ ...f.a, keys: f.b.keys })).rejects.toThrow('identity');
  });

  it('rejects another project, device, or expired ticket', async () => {
    const f = await fixture();
    await expect(RelayHandshake.create({ ...f.a, projectId: 'other' })).rejects.toThrow('identity');
    const a = await RelayHandshake.create({ ...f.a, peerDeviceId: 'other-device' }), b = await RelayHandshake.create(f.b);
    await expect(a.acceptHello(b.hello)).rejects.toThrow('peer or project');
    b.close(); f.advance(1_000_000);
    await expect(RelayHandshake.create(f.a)).rejects.toThrow('ticket verification');
  });

  it.each(['', 'A', toB64u(new Uint8Array(32))])('rejects malformed or low-order X25519 input', async (ephemeral) => {
    const f = await fixture(), [a, b] = await f.pair();
    await expect(a.acceptHello({ ...b.hello, ephemeral })).rejects.toThrow();
    await expect(a.acceptHello(b.hello)).rejects.toThrow('closed'); b.close();
  });

  it('cannot finish after close or handshake deadline', async () => {
    const f = await fixture(), [a, b] = await f.pair();
    f.advance(10_001);
    await expect(a.acceptHello(b.hello)).rejects.toThrow('expired'); b.close();
  });

  it('reconnects with fresh ephemeral keys and rejects a previous generation proof', async () => {
    const f = await fixture(), [a, b] = await f.pair(), [c, d] = await f.pair();
    expect(a.hello.ephemeral).not.toBe(c.hello.ephemeral);
    const old = await b.acceptHello(a.hello);
    await c.acceptHello(d.hello);
    await expect(c.acceptProof(old)).rejects.toThrow('possession');
    a.close(); b.close(); d.close();
  });
});

describe('relay frame encryption and replay bounds', () => {
  it('accepts reordered fragments once, and recognizes authenticated identical retries', async () => {
    const [a, b] = await sessions(await fixture());
    const frames = await Promise.all([0, 1, 2].map(n => a.seal({ ...ctx, message: n }, new Uint8Array([n]))));
    for (const n of [2, 0, 1]) expect((await b.open(frames[n]!)).plaintext).toEqual(new Uint8Array([n]));
    const repeated = await Promise.all([b.open(frames[0]!), b.open(frames[0]!)]);
    for (const result of repeated) { expect(result.duplicate).toBe(true); expect(result.plaintext.length).toBe(0); }
    a.close(); b.close();
  });

  it.each(['channel', 'kind', 'message', 'fragment', 'counter', 'session', 'ciphertext'] as const)('rejects changed authenticated %s', async field => {
    const [a, b] = await sessions(await fixture());
    const original = await a.seal({ ...ctx, fragments: 2 }, new Uint8Array([1]));
    const frame = { ...original };
    if (field === 'channel') frame.channel = 'bulk';
    if (field === 'kind') frame.kind = 'ack';
    if (field === 'message') frame.message++;
    if (field === 'fragment') frame.fragment++;
    if (field === 'counter') frame.counter++;
    if (field === 'session') frame.session = 'X'.repeat(43);
    if (field === 'ciphertext') frame.ciphertext = (frame.ciphertext[0] === 'A' ? 'B' : 'A') + frame.ciphertext.slice(1);
    await expect(b.open(frame)).rejects.toThrow();
    expect((await b.open(original)).duplicate).toBe(false);
    a.close(); b.close();
  });

  it('rejects own-direction ciphertext and old-session traffic', async () => {
    const f = await fixture(), [a, b] = await sessions(f), [c, d] = await sessions(f);
    const frame = await a.seal(ctx, new Uint8Array([1]));
    await expect(a.open(frame)).rejects.toThrow();
    await expect(d.open(frame)).rejects.toThrow();
    for (const s of [a, b, c, d]) s.close();
  });

  it('bounds the replay window and refuses a counter exhausted session', async () => {
    const [a, b] = await sessions(await fixture());
    const first = await a.seal(ctx, new Uint8Array([1]));
    await b.open(first);
    // Exercise the boundary without encrypting billions of frames.
    (a as unknown as { counter: number }).counter = 1024;
    await b.open(await a.seal(ctx, new Uint8Array([2])));
    await expect(b.open(first)).rejects.toThrow('stale');
    (a as unknown as { counter: number }).counter = 0xffff_ffff;
    await expect(a.seal(ctx, new Uint8Array())).rejects.toThrow('exhausted');
    await expect(a.seal(ctx, new Uint8Array())).rejects.toThrow('closed'); b.close();
  });

  it('bounds frame sizes, and destroys closed or expired session access', async () => {
    const f = await fixture(), [a, b] = await sessions(f);
    await expect(a.seal(ctx, new Uint8Array(16385))).rejects.toThrow('too large');
    const frame = await a.seal(ctx, new Uint8Array(16384));
    f.advance(1_000_000);
    await expect(b.open(frame)).rejects.toThrow('expired');
    a.close(); await expect(a.seal(ctx, new Uint8Array())).rejects.toThrow('closed');
  });
});


describe('relay crypto cancellation and admission', () => {
  it('expires an abandoned handshake timer and refuses delayed completion', async () => {
    const f = await fixture();
    vi.useFakeTimers();
    try {
      const [a, b] = await f.pair();
      await vi.advanceTimersByTimeAsync(10_001);
      await expect(a.acceptHello(b.hello)).rejects.toThrow('closed');
      a.close(); b.close();
    } finally { vi.useRealTimers(); }
  });
  it('bounds concurrent decryption admissions before allocating unbounded work', async () => {
    const [a, b] = await sessions(await fixture());
    const frame = await a.seal(ctx, new Uint8Array([1]));
    const pending = Array.from({ length: 257 }, () => b.open(frame));
    const results = await Promise.allSettled(pending);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(256);
    expect(results[256]).toMatchObject({ status: 'rejected' });
    a.close(); b.close();
  });
  it('rejects crypto work queued before close', async () => {
    const [a, b] = await sessions(await fixture());
    const frame = await a.seal(ctx, new Uint8Array([1]));
    const pending = b.open(frame); b.close();
    await expect(pending).rejects.toThrow('closed'); a.close();
  });
});
