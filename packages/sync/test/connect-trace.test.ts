import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRtcNetwork, TraceLog } from '../src/testing.js';
import { TestAuthority } from '../src/testkit.js';
import { type FakeWs, Relay, deferred, flush, makeDev, managerFor } from './connect-helpers.js';
import { traceLog } from './trace.js';

const PID = 'proj-trace';
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

/** `lo` has the lower device id, so it is the one that offers. */
async function pair() {
  const auth = await TestAuthority.create();
  const lo = await makeDev(auth, PID, 'a-device');
  const hi = await makeDev(auth, PID, 'z-device');
  cleanup.push(() => {
    lo.mesh.destroy();
    hi.mesh.destroy();
  });
  return { auth, lo, hi };
}

/** Whether `want` occurs in `have` in this order (other events may lie between). */
const inOrder = (have: string[], want: string[]) => {
  let i = 0;
  for (const h of have) if (h === want[i]) i++;
  return i === want.length;
};

const SECRET = 'relay-secret-credential-xyz';
const servers = [{ urls: 'turn:relay.example.org:3478', username: 'user-xyz', credential: SECRET }];

function start(lo: Awaited<ReturnType<typeof pair>>['lo'], hi: Awaited<ReturnType<typeof pair>>['hi'], auth: TestAuthority, rtc: FakeRtcNetwork, o = {}, loLog = traceLog(), hiLog = traceLog()) {
  const relay = new Relay();
  const sa: FakeWs[] = [];
  const sb: FakeWs[] = [];
  const a = managerFor(lo, auth, PID, rtc, { wsFactory: relay.attach(lo, sa), getIceServers: async () => ({ iceServers: servers, relay: { available: true, reason: 'ok' } }), trace: loLog.sink, ...o });
  const b = managerFor(hi, auth, PID, rtc, { wsFactory: relay.attach(hi, sb), getIceServers: async () => ({ iceServers: servers, relay: { available: true, reason: 'ok' } }), trace: hiLog.sink, ...o });
  cleanup.push(() => {
    a.mgr.stop();
    b.mgr.stop();
  });
  a.mgr.start();
  b.mgr.start();
  return { a, b, loLog, hiLog };
}

describe('connection trace', () => {
  it('records every step of a successful connection, in order, from both sides', async () => {
    const { auth, lo, hi } = await pair();
    const { a, loLog } = start(lo, hi, auth, new FakeRtcNetwork());
    await vi.waitFor(() => expect(lo.mesh.peers.length).toBe(1), { timeout: 3000 });
    expect(a.mgr.candidates()).toHaveLength(0);
    expect(inOrder(loLog.names('a-device'), ['attempt.start', 'ice.request', 'ice.ok', 'link.created', 'link.offer.sent', 'sig.send', 'sig.recv', 'link.answer.received', 'link.channels.open', 'link.up'])).toBe(true);
    expect(inOrder(loLog.names('z-device'), ['sig.recv', 'link.created', 'link.offer.received', 'link.answer.sent', 'link.up'])).toBe(true);
    expect(loLog.of('ice.ok', 'a-device')[0]?.data).toMatchObject({ servers: 1, relay: 'available:ok' });
    expect(loLog.of('sig.send', 'a-device').every((e) => e.dev === 'z-device')).toBe(true);
  });

  it('a failed connection shows the steps taken and the cause where it stopped', async () => {
    const { auth, lo, hi } = await pair();
    const rtc = new FakeRtcNetwork();
    rtc.stallNext = 1;
    const { loLog } = start(lo, hi, auth, rtc, { linkTimeoutMs: 150, maxBackoffMs: 5000 });
    await vi.waitFor(() => expect(loLog.of('link.timeout', 'a-device')).toHaveLength(1), { timeout: 3000 });
    expect(inOrder(loLog.names('a-device'), ['attempt.start', 'link.created', 'link.offer.sent', 'link.answer.received', 'link.timeout', 'retry.scheduled'])).toBe(true);
    expect(loLog.of('link.timeout', 'a-device')[0]?.data).toEqual({ cause: 'checks-failed' });
    expect(loLog.of('retry.scheduled', 'a-device')[0]?.data).toMatchObject({ attempt: 1 });
  });

  it('a candidate that arrives before the answering link exists shows up as held, then applied', async () => {
    const { auth, lo, hi } = await pair();
    const rtc = new FakeRtcNetwork();
    const relay = new Relay();
    const slow = deferred<unknown[]>();
    const hiLog = traceLog();
    const a = managerFor(lo, auth, PID, rtc, { wsFactory: relay.attach(lo, []) });
    const b = managerFor(hi, auth, PID, rtc, { wsFactory: relay.attach(hi, []), getIceServers: () => slow.promise, trace: hiLog.sink });
    cleanup.push(() => {
      a.mgr.stop();
      b.mgr.stop();
    });
    a.mgr.start();
    b.mgr.start();
    await vi.waitFor(() => expect(hiLog.of('sig.held', 'z-device').length).toBeGreaterThan(0), { timeout: 3000 });
    expect(hiLog.of('link.created', 'z-device')).toHaveLength(0);
    slow.resolve([]);
    await vi.waitFor(() => expect(hiLog.of('sig.applied-held', 'z-device')).toHaveLength(1), { timeout: 3000 });
    expect(inOrder(hiLog.names('z-device'), ['sig.held', 'link.created', 'sig.applied-held'])).toBe(true);
  });

  it('never records credentials, keys or addresses', async () => {
    const { auth, lo, hi } = await pair();
    const { loLog } = start(lo, hi, auth, new FakeRtcNetwork());
    await vi.waitFor(() => expect(lo.mesh.peers.length).toBe(1), { timeout: 3000 });
    const text = JSON.stringify(loLog.events) + loLog.format();
    for (const forbidden of [SECRET, 'user-xyz', 'relay.example.org', 'devX', 'ticket']) expect(text).not.toContain(forbidden);
  });

  it('a broken trace sink never affects connecting', async () => {
    const { auth, lo, hi } = await pair();
    start(lo, hi, auth, new FakeRtcNetwork(), { trace: () => { throw new Error('sink down'); } });
    await vi.waitFor(() => expect(lo.mesh.peers.length).toBe(1), { timeout: 3000 });
  });

  it('formats the merged trace with participants and relative times', async () => {
    const log = new TraceLog();
    log.sink({ t: 1, self: 'a-device', ev: 'sig.send', dev: 'z-device', data: { k: 'offer', via: 'server' } });
    log.sink({ t: 2, self: 'z-device', ev: 'ice.request' });
    const out = log.format();
    expect(out).toContain('a-device -> z-device');
    expect(out).toContain('sig.send k=offer via=server');
    expect(out.split('\n')).toHaveLength(3);
  });
});
