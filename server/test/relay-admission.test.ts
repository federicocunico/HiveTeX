import { sign, toB64u } from '@hivetex/crypto';
import { signalAuthMessage } from '@hivetex/protocol';
import { TestAuthority, identity } from '@hivetex/sync/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import type { Deps } from '../src/deps.js';
import { createSignalSession, MemorySignalBackend } from '../src/signal/hub.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function fixture(forward: () => Promise<void> = async () => {}) {
  const auth = await TestAuthority.create(), id = await identity('a', 'editor');
  const ticket = await auth.mint({ ...id, pid: 'p' });
  let buffered = 0, closed = 0, sendApplication: (m: unknown) => void = () => {};
  const inbox: Array<Record<string, unknown>> = [];
  const deps = { now: () => new Date(), config: { ticketPublicJwks: auth.trusted }, applicationRelay: {
    attach: async (context: { send: (m: unknown) => void }) => { sendApplication = context.send; return { forward, close: () => {} }; },
  } } as unknown as Deps;
  const session = createSignalSession({ get bufferedAmount() { return buffered; }, send: raw => { inbox.push(JSON.parse(raw)); }, close: code => { closed = code ?? 1000; } }, deps, new MemorySignalBackend());
  cleanups.push(session.onClose);
  const nonce = inbox[0]!.nonce as string;
  const proof = await sign(id.keys, new TextEncoder().encode(signalAuthMessage('p', id.dev, nonce)));
  await session.onMessage(JSON.stringify({ t: 'auth', ticket, sig: toB64u(proof), capabilities: ['application-relay-v1'] }));
  const frame = JSON.stringify({ t: 'app-relay', to: 'peer', sid: 'r1_1234567890123456', env: 'AA' });
  return { session, frame, inbox, buffered: (n: number) => { buffered = n; }, closed: () => closed, deliver: (m: unknown) => sendApplication(m) };
}

describe('application relay admission and reserved signaling', () => {
  it('bounds pending forwarding work without blocking signaling', async () => {
    let release!: () => void, admitted = 0;
    const gate = new Promise<void>(r => { release = r; });
    const f = await fixture(async () => { admitted++; await gate; });
    const pending = Array.from({ length: 100 }, () => f.session.onMessage(f.frame));
    expect(admitted).toBe(64);
    await f.session.onMessage(JSON.stringify({ t: 'ping' }));
    expect(f.inbox.some(m => m.t === 'pong')).toBe(true);
    expect(f.inbox.filter(m => m.code === 'relay_backpressure')).toHaveLength(1);
    release(); await Promise.all(pending);
    expect(f.closed()).toBe(0);
  });

  it('rate-limits relay bursts separately from the signaling allowance', async () => {
    let admitted = 0;
    const f = await fixture(async () => { admitted++; });
    for (let n = 0; n < 1250; n++) await f.session.onMessage(f.frame);
    expect(admitted).toBe(1200);
    await f.session.onMessage(JSON.stringify({ t: 'ping' }));
    expect(f.inbox.some(m => m.t === 'pong')).toBe(true);
    expect(f.closed()).toBe(0);
  });

  it('reserves socket buffer capacity for control and closes a persistently slow socket', async () => {
    const f = await fixture();
    f.buffered(256 * 1024);
    f.deliver({ t: 'app-relay', env: 'AA' });
    expect(f.inbox.some(m => m.t === 'app-relay')).toBe(false);
    await f.session.onMessage(JSON.stringify({ t: 'ping' }));
    expect(f.inbox.some(m => m.t === 'pong')).toBe(true);
    f.buffered(320 * 1024);
    await f.session.onMessage(JSON.stringify({ t: 'ping' }));
    expect(f.closed()).toBe(1013);
  });

  it('enforces the encoded byte ceiling even with multibyte JSON', async () => {
    const f = await fixture();
    await f.session.onMessage(JSON.stringify({ t: 'ping', extra: String.fromCharCode(0x00e9).repeat(32768) }));
    expect(f.closed()).toBe(1009);
  });
});
