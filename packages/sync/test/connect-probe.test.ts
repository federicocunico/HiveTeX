import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRtcNetwork } from '../src/testing.js';
import { TestAuthority } from '../src/testkit.js';
import { type Dev, type FakeWs, Relay, makeDev, managerFor } from './connect-helpers.js';

const PID = 'proj-probe';
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

/** `lo` (lower id) offers. */
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

function start(auth: TestAuthority, lo: Dev, hi: Dev, rtc: FakeRtcNetwork, relay: Relay, o = {}) {
  const a = managerFor(lo, auth, PID, rtc, { wsFactory: relay.attach(lo, [] as FakeWs[]), clientInfo: 'test a', ...o });
  const b = managerFor(hi, auth, PID, rtc, { wsFactory: relay.attach(hi, [] as FakeWs[]), clientInfo: 'test z', ...o });
  cleanup.push(() => {
    a.mgr.stop();
    b.mgr.stop();
  });
  a.mgr.start();
  b.mgr.start();
  return { a: a.mgr, b: b.mgr };
}

describe('connection test (probePeer)', () => {
  it('connected pair: signaling round trip with the other side\'s own report, confirmed by the service', async () => {
    const { auth, lo, hi } = await pair();
    const { a } = start(auth, lo, hi, new FakeRtcNetwork(), new Relay({ acks: true }));
    await vi.waitFor(() => expect(lo.mesh.peers.length).toBe(1), { timeout: 3000 });
    const r = await a.probePeer('z-device');
    expect(r.attempt.outcome).toBe('connected');
    expect(r.remote).toMatchObject({ client: 'test z', knowsYou: true, role: 'answerer', connected: true });
    expect(r.signaling.replyMs).not.toBeNull();
    expect(r.verdict).toMatch(/^Connected/);
    expect(r.trace.map((e) => e.ev)).toEqual(expect.arrayContaining(['probe.start', 'sig.send', 'sig.recv', 'probe.end']));
  });

  it('desktop: the native stack lines written during the test are in its result and in this device\'s diagnostics', async () => {
    const { auth, lo, hi } = await pair();
    const log: Array<{ seq: number; line: string }> = [{ seq: 1, line: 'INFO webrtc_ice: before the test' }];
    const nativeLog = async (since: number) => log.filter((l) => l.seq > since);
    const { a } = start(auth, lo, hi, new FakeRtcNetwork(), new Relay({ acks: true }), { nativeLog });
    await vi.waitFor(() => expect(lo.mesh.peers.length).toBe(1), { timeout: 3000 });
    // what the stack had logged before is read first (a failure or an earlier test), so the test shows only its own lines
    await a.probePeer('z-device');
    log.push({ seq: 2, line: 'WARN webrtc_ice: pair <ip> <-> <ip> failed' });
    const r = await a.probePeer('z-device');
    expect(r.nativeLog).toEqual(['WARN webrtc_ice: pair <ip> <-> <ip> failed']);
    expect(a.selfDiagnostics().nativeLog).toEqual(['INFO webrtc_ice: before the test', 'WARN webrtc_ice: pair <ip> <-> <ip> failed']);
  });

  it('on-demand signaling that is closed: the test opens it, learns who is online and connects', async () => {
    const { auth, lo, hi } = await pair();
    const rtc = new FakeRtcNetwork();
    const relay = new Relay({ acks: true });
    const b = managerFor(hi, auth, PID, rtc, { wsFactory: relay.attach(hi, [] as FakeWs[]), clientInfo: 'test z' });
    const a = managerFor(lo, auth, PID, rtc, {
      wsFactory: relay.attach(lo, [] as FakeWs[]), clientInfo: 'test a',
      zeroIdle: true, doorbell: { ring: async () => false }, introductionWindowMs: 100, introductionMinMs: 10, idleCloseMs: 5,
    });
    cleanup.push(() => {
      a.mgr.stop();
      b.mgr.stop();
    });
    b.mgr.start();
    a.mgr.start();
    a.mgr.setDoorbellAvailable(false);
    expect(a.mgr.socketOpen).toBe(false);
    const r = await a.mgr.probePeer('z-device');
    expect(r.steps[0]?.detail).toMatch(/opened for this test/);
    expect(r.known).toBe(true);
    expect(r.verdict).toMatch(/^Connected/);
  });

  it('both sockets closed (zero idle, linked): the test rings, the co-author comes to the service and answers (field report 2026-10-14)', async () => {
    const { auth, lo, hi } = await pair();
    const rtc = new FakeRtcNetwork();
    const relay = new Relay({ acks: true });
    const mgrs: Array<ReturnType<typeof managerFor>> = [];
    const bell = (self: string) => ({ ring: async () => { for (const m of mgrs) if (m !== mgrs[self === 'a' ? 0 : 1]) m.mgr.answerRing(); return true; } });
    const opts = { zeroIdle: true, introductionWindowMs: 3000, introductionMinMs: 200, idleCloseMs: 5, answerJitterMs: 0 };
    mgrs.push(managerFor(lo, auth, PID, rtc, { wsFactory: relay.attach(lo, [] as FakeWs[]), clientInfo: 'test a', doorbell: bell('a'), ...opts }));
    mgrs.push(managerFor(hi, auth, PID, rtc, { wsFactory: relay.attach(hi, [] as FakeWs[]), clientInfo: 'test z', doorbell: bell('z'), ...opts }));
    const [a, b] = mgrs as [ReturnType<typeof managerFor>, ReturnType<typeof managerFor>];
    cleanup.push(() => {
      a.mgr.stop();
      b.mgr.stop();
    });
    for (const m of mgrs) {
      m.mgr.start();
      m.mgr.setDoorbellAvailable(true);
    }
    await vi.waitFor(() => expect(lo.mesh.peers.length).toBe(1), { timeout: 5000 });
    await vi.waitFor(() => expect(a.mgr.socketOpen || b.mgr.socketOpen).toBe(false), { timeout: 8000 });
    const r = await a.mgr.probePeer('z-device');
    expect(r.onServer).toBe(true);
    expect(r.remote).toMatchObject({ client: 'test z', knowsYou: true });
  });

  it('from the answering side: the probe makes the offering side retry at once, and the test reports the new connection', async () => {
    const { auth, lo, hi } = await pair();
    const rtc = new FakeRtcNetwork();
    rtc.stallNext = 1; // the first attempt never completes
    const { b } = start(auth, lo, hi, rtc, new Relay({ acks: true }), { linkTimeoutMs: 60_000, maxBackoffMs: 60_000 });
    await vi.waitFor(() => expect(b.candidates()[0]?.dev).toBe('a-device'), { timeout: 3000 });
    const r = await b.probePeer('a-device', { attemptTimeoutMs: 5000 });
    expect(r.role).toBe('answerer');
    expect(r.remote?.role).toBe('offerer');
    expect(r.signaling.delivery).toMatchObject({ via: 'server', accepted: true, targetOnline: true, delivered: true });
    expect(r.attempt.outcome).toBe('connected');
  });

  it('relay-only variant: the test\'s attempt asks the stack for relay candidates only, on the side that runs it', async () => {
    const { auth, lo, hi } = await pair();
    const rtc = new FakeRtcNetwork();
    rtc.stallNext = 1; // no link yet when the test starts
    const policies: Array<string | undefined> = [];
    const factory = (ice: unknown[], opts?: { policy?: 'all' | 'relay' }) => {
      policies.push(opts?.policy);
      return rtc.factory(ice, opts);
    };
    const { a } = start(auth, lo, hi, rtc, new Relay({ acks: true }), { linkTimeoutMs: 60_000, maxBackoffMs: 60_000, rtcFactory: factory });
    await vi.waitFor(() => expect(a.candidates()[0]?.attempts ?? 0).toBe(0), { timeout: 3000 });
    await vi.waitFor(() => expect(policies.length).toBeGreaterThan(0), { timeout: 3000 });
    const before = policies.length;
    const r = await a.probePeer('z-device', { relayOnly: true, attemptTimeoutMs: 5000 });
    expect(policies.slice(before)).toContain('relay');
    expect(r.trace.some((e) => e.ev === 'link.policy' && e.data?.policy === 'relay')).toBe(true);
    expect(r.attempt.outcome).toBe('connected');
    expect(r.steps.find((s) => s.label === 'Application relay')).toMatchObject({ ok: null, detail: 'not offered by the signaling service' });
    // the restriction belonged to that test only
    expect((a as unknown as { attemptPolicy: Map<string, string> }).attemptPolicy.size).toBe(0);
  });

  it('with TURN configured, every other attempt after failed checks is relay-only; without TURN never', async () => {
    for (const turn of [true, false]) {
      const { auth, lo, hi } = await pair();
      const rtc = new FakeRtcNetwork();
      rtc.stallNext = 1_000_000; // checks never succeed
      const policies: Array<string | undefined> = [];
      const factory = (ice: unknown[], opts?: { policy?: 'all' | 'relay' }) => {
        policies.push(opts?.policy);
        return rtc.factory(ice, opts);
      };
      const ice = turn ? [{ urls: 'turn:turn.example:3478', username: 'u', credential: 'c' }] : [{ urls: 'stun:stun.example:3478' }];
      const { a } = start(auth, lo, hi, rtc, new Relay({ acks: true }), { linkTimeoutMs: 150, maxBackoffMs: 100, rtcFactory: factory, getIceServers: async () => ice });
      await vi.waitFor(() => expect(policies.length).toBeGreaterThanOrEqual(8), { timeout: 8000 });
      a.stop();
      const offerer = policies.filter((_, i) => i % 2 === 0).slice(0, 4); // a and b alternate creating their links
      if (turn) expect(policies).toContain('relay');
      else expect(policies).not.toContain('relay');
      expect(offerer.length).toBeGreaterThan(0);
    }
  });

  it('a failing connection: names the stage, keeps the other side\'s view and the step-by-step trace', async () => {
    const { auth, lo, hi } = await pair();
    const rtc = new FakeRtcNetwork();
    rtc.stallNext = 10;
    const { a } = start(auth, lo, hi, rtc, new Relay({ acks: true }), { linkTimeoutMs: 300, maxBackoffMs: 60_000 });
    await vi.waitFor(() => expect(a.candidates()[0]?.attempts ?? 0).toBeGreaterThan(0), { timeout: 3000 });
    const r = await a.probePeer('z-device', { attemptTimeoutMs: 3000 });
    expect(r.attempt.outcome).toBe('failed');
    expect(r.attempt.cause).toBe('checks-failed');
    expect(r.remote?.knowsYou).toBe(true);
    expect(r.verdict).toMatch(/none worked/);
    expect(r.steps.map((s) => s.label)).toEqual(expect.arrayContaining(['Accepted by the service', 'Delivered to the other device', 'Answer from the other device', 'Connection']));
    expect(r.trace.some((e) => e.ev === 'link.timeout')).toBe(true);
  });

  it('the receipt may arrive before the acknowledgement (as from the real service): both are reported', async () => {
    const { auth, lo, hi } = await pair();
    const { a } = start(auth, lo, hi, new FakeRtcNetwork(), new Relay({ acks: true, deliveredFirst: true }));
    await vi.waitFor(() => expect(lo.mesh.peers.length).toBe(1), { timeout: 3000 });
    const r = await a.probePeer('z-device');
    expect(r.signaling.delivery).toMatchObject({ via: 'server', accepted: true, targetOnline: true, delivered: true });
    expect(r.steps.find((s) => s.label === 'Delivered to the other device')?.ok).toBe(true);
  });

  it('the service accepts but never delivers: the test says so instead of blaming the network', async () => {
    const { auth, lo, hi } = await pair();
    const { a } = start(auth, lo, hi, new FakeRtcNetwork(), new Relay({ acks: true, undelivered: new Set(['z-device']) }), { linkTimeoutMs: 300, maxBackoffMs: 60_000 });
    await vi.waitFor(() => expect(a.candidates()[0]?.dev).toBe('z-device'), { timeout: 3000 });
    const r = await a.probePeer('z-device', { replyTimeoutMs: 800, attemptTimeoutMs: 1500 });
    expect(r.signaling.delivery).toMatchObject({ accepted: true, targetOnline: true, delivered: false });
    expect(r.remote).toBeNull();
    expect(r.verdict).toMatch(/did not deliver it/);
    expect(r.trace.some((e) => e.ev === 'sig.not-delivered' || e.ev === 'sig.server-ack')).toBe(true);
  });

  it('an older co-author app that does not answer probes, behind a service without acknowledgements', async () => {
    const { auth, lo, hi } = await pair();
    const { a, b } = start(auth, lo, hi, new FakeRtcNetwork(), new Relay(), { linkTimeoutMs: 300, maxBackoffMs: 60_000 });
    (b as unknown as { answerProbe: () => Promise<void> }).answerProbe = async () => {};
    await vi.waitFor(() => expect(lo.mesh.peers.length).toBe(1), { timeout: 3000 });
    lo.mesh.peers[0]?.conn.close();
    await vi.waitFor(() => expect(lo.mesh.peers.length).toBe(0), { timeout: 3000 });
    const r = await a.probePeer('z-device', { replyTimeoutMs: 500, attemptTimeoutMs: 3000 });
    expect(r.signaling.delivery?.accepted).toBeNull();
    expect(r.remote).toBeNull();
    expect(r.steps.find((s) => s.label === 'Accepted by the service')?.detail).toMatch(/no acknowledgement/);
  });

  it('an unknown device: nothing to test, said plainly', async () => {
    const { auth, lo, hi } = await pair();
    const { a } = start(auth, lo, hi, new FakeRtcNetwork(), new Relay());
    const r = await a.probePeer('nobody');
    expect(r.known).toBe(false);
    expect(r.verdict).toMatch(/does not see that co-author online/);
  });

  it('self diagnostics and the kept trace describe this device', async () => {
    const { auth, lo, hi } = await pair();
    const { a } = start(auth, lo, hi, new FakeRtcNetwork(), new Relay());
    await vi.waitFor(() => expect(lo.mesh.peers.length).toBe(1), { timeout: 3000 });
    expect(a.selfDiagnostics()).toMatchObject({ dev: 'a-device', client: 'test a', socketOpen: true, meshPeers: 1, knownDevices: 1 });
    const evs = a.trace().map((e) => e.ev);
    expect(evs).toEqual(expect.arrayContaining(['manager.start', 'socket.opening', 'server.ready', 'device.learned', 'attempt.start', 'mesh.auth-ok']));
  });
});
