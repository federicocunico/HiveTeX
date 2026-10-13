import { afterEach, describe, expect, it, vi } from 'vitest';
import { attemptCause } from '../src/connect.js';
import { FakePc, FakeRtcNetwork } from '../src/testing.js';
import { TestAuthority } from '../src/testkit.js';
import { type FakeWs, Relay, deferred, flush, flushMicro, makeDev, managerFor } from './connect-helpers.js';

const PID = 'proj-life';
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
  vi.useRealTimers();
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

const pcsOf = (rtc: FakeRtcNetwork) =>
  (rtc as unknown as { pcs: Map<string, { onconnectionstatechange: (() => void) | null; connectionState: string }> }).pcs;

describe('connection lifecycle ownership (F10)', () => {
  it('desktop zero-idle policy keeps a failed push channel socketless and bounds an explicit Sync now introduction', async () => {
    const { auth, lo } = await pair();
    const { mgr, sockets } = managerFor(lo, auth, PID, new FakeRtcNetwork(), {
      zeroIdle: true, doorbell: { ring: async () => false },
      introductionWindowMs: 100, introductionMinMs: 10, idleCloseMs: 5,
    });
    cleanup.push(() => mgr.stop());
    mgr.start(); mgr.setDoorbellAvailable(false);
    await flush(30); expect(sockets).toHaveLength(0);
    mgr.reconnectNow(); await flush(30); expect(sockets).toHaveLength(1);
    await vi.waitFor(() => expect(mgr.socketOpen).toBe(false), { timeout: 1000 });
    await flush(30); expect(sockets).toHaveLength(1);
  });
  it('duplicate announcements while configuration loads share one attempt', async () => {
    const { auth, lo, hi } = await pair();
    const ice = deferred<unknown[]>();
    const { mgr, factories, sockets } = managerFor(lo, auth, PID, new FakeRtcNetwork(), { getIceServers: () => ice.promise });
    cleanup.push(() => mgr.stop());
    mgr.start();
    await flush();
    const ws = sockets[0] as FakeWs;
    ws.say({ t: 'ready', tickets: [hi.ticket] });
    ws.say({ t: 'join', ticket: hi.ticket, sid: 's1' });
    await flush();
    ice.resolve([]);
    await flush();
    expect(factories.calls).toBe(1);
  });

  it('candidates sent while the answering side still loads its configuration are applied, not dropped', async () => {
    const { auth, lo, hi } = await pair();
    const rtc = new FakeRtcNetwork();
    const relay = new Relay();
    const sa: FakeWs[] = [];
    const sb: FakeWs[] = [];
    const slow = deferred<unknown[]>();
    const a = managerFor(lo, auth, PID, rtc, { wsFactory: relay.attach(lo, sa) });
    const b = managerFor(hi, auth, PID, rtc, { wsFactory: relay.attach(hi, sb), getIceServers: () => slow.promise });
    cleanup.push(() => {
      a.mgr.stop();
      b.mgr.stop();
    });
    const applied: string[] = [];
    const real = FakePc.prototype.addIceCandidate;
    FakePc.prototype.addIceCandidate = async function (this: FakePc, c?: unknown) {
      if (this.remoteDescription?.type === 'offer') applied.push(String((c as { candidate: string }).candidate));
      return real.call(this);
    } as typeof real;
    cleanup.push(() => {
      FakePc.prototype.addIceCandidate = real;
    });
    a.mgr.start();
    b.mgr.start();
    await flush(200); // the offer and the offerer's candidates reach the answerer before its configuration
    expect(applied).toEqual([]);
    slow.resolve([]);
    await vi.waitFor(() => expect(applied.length).toBeGreaterThan(0), { timeout: 2000 });
  });

  it('names the stage a failed attempt stopped at', async () => {
    const empty = { state: 'new', offerReceived: false, offerSent: false, answerReceived: false, localCandidates: [], remoteCandidates: [] };
    expect(attemptCause({ ...empty, offerSent: true }, true)).toBe('no-setup-reply');
    expect(attemptCause({ ...empty, offerSent: true, answerReceived: true }, true)).toBe('no-candidates');
    expect(attemptCause({ ...empty, offerReceived: true }, false)).toBe('no-candidates');
    expect(attemptCause({ ...empty, answerReceived: true, remoteCandidates: ['host'] }, true)).toBe('checks-failed');
  });

  it('a timed-out attempt whose offer was never answered reports no setup reply', async () => {
    const { auth, lo, hi } = await pair();
    const { mgr, sockets } = managerFor(lo, auth, PID, new FakeRtcNetwork(), { linkTimeoutMs: 80, maxBackoffMs: 5000 });
    cleanup.push(() => mgr.stop());
    mgr.start();
    await flush();
    const ws = sockets[0] as FakeWs;
    ws.say({ t: 'ready', tickets: [hi.ticket] });
    ws.say({ t: 'join', ticket: hi.ticket, sid: 's1' });
    await vi.waitFor(() => expect(mgr.candidates()[0]?.cause).toBe('no-setup-reply'), { timeout: 3000 });
    const c = mgr.candidates()[0];
    expect(c?.lastError).toBe('connection attempt timed out');
    expect(c?.link?.offerSent).toBe(true);
  });

  it('a pair that exchanged candidates but never connected reports failed checks', async () => {
    const { auth, lo, hi } = await pair();
    const rtc = new FakeRtcNetwork();
    rtc.stallNext = 1;
    const relay = new Relay();
    const sa: FakeWs[] = [];
    const sb: FakeWs[] = [];
    const a = managerFor(lo, auth, PID, rtc, { linkTimeoutMs: 150, maxBackoffMs: 5000, wsFactory: relay.attach(lo, sa) });
    const b = managerFor(hi, auth, PID, rtc, { linkTimeoutMs: 150, maxBackoffMs: 5000, wsFactory: relay.attach(hi, sb) });
    cleanup.push(() => {
      a.mgr.stop();
      b.mgr.stop();
    });
    a.mgr.start();
    b.mgr.start();
    await vi.waitFor(() => expect(a.mgr.candidates()[0]?.cause).toBe('checks-failed'), { timeout: 3000 });
  });

  it('stop before configuration resolves creates no transport and sends no signaling', async () => {
    const { auth, lo, hi } = await pair();
    const ice = deferred<unknown[]>();
    const { mgr, factories, sockets } = managerFor(lo, auth, PID, new FakeRtcNetwork(), { getIceServers: () => ice.promise });
    cleanup.push(() => mgr.stop());
    mgr.start();
    await flush();
    const ws = sockets[0] as FakeWs;
    ws.say({ t: 'join', ticket: hi.ticket, sid: 's1' });
    await flush();
    mgr.stop();
    const sentBefore = ws.sent.length;
    ice.resolve([]);
    await flush();
    expect(factories.calls).toBe(0);
    expect(ws.sent.length).toBe(sentBefore);
  });

  it('keeps the attempt slot through authentication and retries after a failed authentication', async () => {
    const { auth, lo, hi } = await pair();
    const rtc = new FakeRtcNetwork();
    const relay = new Relay();
    const sa: FakeWs[] = [];
    const sb: FakeWs[] = [];
    const a = managerFor(lo, auth, PID, rtc, { maxBackoffMs: 50, linkTimeoutMs: 500, wsFactory: relay.attach(lo, sa) });
    const b = managerFor(hi, auth, PID, rtc, { maxBackoffMs: 50, linkTimeoutMs: 500, wsFactory: relay.attach(hi, sb) });
    cleanup.push(() => {
      a.mgr.stop();
      b.mgr.stop();
    });
    const failing = deferred<never>();
    const real = lo.mesh.addTransport.bind(lo.mesh);
    let first = true;
    lo.mesh.addTransport = ((t) => {
      if (first) {
        first = false;
        return failing.promise;
      }
      return real(t);
    }) as typeof lo.mesh.addTransport;
    a.mgr.start();
    b.mgr.start();
    await vi.waitFor(() => expect(first).toBe(false), { timeout: 3000 });
    const callsDuringAuth = a.factories.calls;
    // the same device is announced again while its first connection is still authenticating
    sa[0]?.say({ t: 'join', ticket: hi.ticket, sid: 's2' });
    await flush();
    expect(a.factories.calls).toBe(callsDuringAuth);
    failing.reject(new Error('authentication failed'));
    await vi.waitFor(() => expect(lo.mesh.peers.length).toBe(1), { timeout: 4000 });
    expect(a.factories.calls).toBe(callsDuringAuth + 1);
  });

  it('stop releases every mesh handler, so repeated pause/resume does not accumulate them', async () => {
    const { auth, lo } = await pair();
    const counts = () => {
      const m = lo.mesh as unknown as { joinCbs: Set<unknown>; leaveCbs: Set<unknown>; appHandlers: Map<string, Set<unknown>> };
      return [m.joinCbs.size, m.leaveCbs.size, ...['pex', 'rtc'].map((t) => m.appHandlers.get(t)?.size ?? 0)];
    };
    const base = counts();
    const rtc = new FakeRtcNetwork();
    for (let i = 0; i < 3; i++) {
      const { mgr } = managerFor(lo, auth, PID, rtc);
      mgr.start();
      await flush(5);
      mgr.stop();
    }
    expect(counts()).toEqual(base);
  });

  it('stop leaves no pending timer behind, including retry and link-deadline timers', async () => {
    const { auth, lo, hi } = await pair();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const rtc = new FakeRtcNetwork();
    const { mgr, sockets } = managerFor(lo, auth, PID, rtc);
    mgr.start();
    await flushMicro();
    const ws = sockets[0] as FakeWs;
    ws.say({ t: 'join', ticket: hi.ticket, sid: 's1' });
    // Bounded by real time (Date is not faked): ticket verification is real crypto, slower on a loaded runner.
    for (const end = Date.now() + 15_000; pcsOf(rtc).size === 0 && Date.now() < end; ) await flushMicro(1);
    // the attempt fails: a retry timer is pending
    const pcs = pcsOf(rtc);
    const pc = [...pcs.values()][0];
    expect(pc).toBeDefined();
    if (pc) {
      pc.connectionState = 'failed';
      pc.onconnectionstatechange?.();
    }
    await flushMicro();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    mgr.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores messages of an obsolete socket', async () => {
    const { auth, lo, hi } = await pair();
    const { mgr, factories, sockets } = managerFor(lo, auth, PID, new FakeRtcNetwork());
    cleanup.push(() => mgr.stop());
    mgr.start();
    await flush();
    const old = sockets[0] as FakeWs;
    mgr.stop();
    mgr.start();
    await flush();
    expect(sockets.length).toBe(2);
    old.say({ t: 'join', ticket: hi.ticket, sid: 'old' });
    await flush();
    expect(factories.calls).toBe(0);
  });
});

describe('signaling heartbeat and session ids (F08)', () => {
  const pings = (ws: FakeWs) => ws.sent.filter((m) => m.t === 'ping').length;

  it('pings the relay while the socket is open and authenticated, and stops with the manager', async () => {
    const { auth, lo } = await pair();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { mgr, sockets } = managerFor(lo, auth, PID, new FakeRtcNetwork(), { heartbeatMs: 30_000 });
    mgr.start();
    await flushMicro();
    const ws = sockets[0] as FakeWs;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(pings(ws)).toBe(0); // nothing before the relay accepted us (an early ping would close the socket)
    ws.say({ t: 'ready', tickets: [] });
    await flushMicro();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pings(ws)).toBe(1);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(pings(ws)).toBe(4);
    mgr.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(pings(ws)).toBe(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a replaced socket neither keeps pinging nor keeps the new socket from pinging', async () => {
    const { auth, lo } = await pair();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { mgr, sockets } = managerFor(lo, auth, PID, new FakeRtcNetwork(), { heartbeatMs: 30_000, reconnectAfterMs: 100_000 });
    cleanup.push(() => mgr.stop());
    mgr.start();
    await flushMicro();
    const first = sockets[0] as FakeWs;
    first.say({ t: 'ready', tickets: [] });
    await vi.advanceTimersByTimeAsync(101_000); // rotation closes the first socket, a retry opens the second
    await flushMicro();
    const second = sockets[1] as FakeWs;
    expect(second).toBeDefined();
    const before = pings(first);
    second.say({ t: 'ready', tickets: [] });
    await vi.advanceTimersByTimeAsync(65_000);
    expect(pings(first)).toBe(before);
    expect(pings(second)).toBe(2);
  });

  it('uses the session ids of ready: the leave of an older session is not a departure', async () => {
    const { auth, lo, hi } = await pair();
    const { mgr, sockets } = managerFor(lo, auth, PID, new FakeRtcNetwork(), { getIceServers: () => new Promise(() => {}) });
    cleanup.push(() => mgr.stop());
    mgr.start();
    await flush();
    const ws = sockets[0] as FakeWs;
    ws.say({ t: 'ready', tickets: [hi.ticket], sessions: { [hi.dev]: 'new' } });
    await flush();
    expect(mgr.candidates().find((c) => c.dev === hi.dev)?.onRelay).toBe(true);
    ws.say({ t: 'leave', dev: hi.dev, sid: 'old' });
    await flush();
    expect(mgr.candidates().find((c) => c.dev === hi.dev)?.onRelay).toBe(true);
    ws.say({ t: 'leave', dev: hi.dev, sid: 'new' });
    await flush();
    expect(mgr.candidates().find((c) => c.dev === hi.dev)).toBeUndefined();
  });
});

describe('relay credentials (F09)', () => {
  const HOUR = 3_600_000;
  /** A fake clock shared by tickets and the manager; tickets last long enough to outlive the credentials. */
  async function clocked() {
    const auth = await TestAuthority.create();
    const clock = { ms: Date.now() };
    auth.now = () => new Date(clock.ms);
    const lo = await makeDev(auth, PID, 'a-device', 86_400);
    const hi = await makeDev(auth, PID, 'z-device', 86_400);
    cleanup.push(() => {
      lo.mesh.destroy();
      hi.mesh.destroy();
    });
    return { auth, clock, lo, hi };
  }
  /** Credentials service: `script` decides each call (a config, an error, or never). */
  function service(clock: { ms: number }, script: (n: number) => 'ok' | 'hang' | Error | { status: number; retryAfterMs?: number }) {
    const calls = { n: 0 };
    const get = () => {
      const n = ++calls.n;
      const r = script(n);
      if (r === 'hang') return new Promise<never>(() => {});
      if (r === 'ok') return Promise.resolve({ iceServers: [{ urls: `turn:relay${n}`, username: 'u', credential: 'p' }], expiresAt: clock.ms + HOUR });
      return Promise.reject(Object.assign(new Error('credentials unavailable'), r));
    };
    return { calls, get };
  }
  const urls = (ice: unknown[]) => ice.map((s) => (s as { urls: string }).urls);

  async function started(o: Parameters<typeof managerFor>[4] & { random?: () => number }, withClock?: Awaited<ReturnType<typeof clocked>>) {
    const t = withClock ?? (await clocked());
    const m = managerFor(t.lo, t.auth, PID, new FakeRtcNetwork(), { ...o, random: () => 0.5 });
    cleanup.push(() => m.mgr.stop());
    m.mgr.start();
    await flush();
    (m.sockets[0] as FakeWs).say({ t: 'join', ticket: t.hi.ticket, sid: 's1' });
    return { ...t, ...m };
  }

  it('refreshes credentials once they expired and reuses them before that', async () => {
    const t = await clocked();
    const svc = service(t.clock, () => 'ok');
    const s = await started({ getIceServers: svc.get }, t);
    await vi.waitFor(() => expect(s.factories.calls).toBe(1));
    expect(urls(s.factories.ice[0] ?? [])).toEqual(['turn:relay1']);
    t.clock.ms += HOUR / 2;
    s.mgr.reconnectNow();
    await vi.waitFor(() => expect(s.factories.calls).toBe(2));
    expect(svc.calls.n).toBe(1); // still valid: cached
    t.clock.ms += HOUR; // beyond the expiry the server reported
    s.mgr.reconnectNow();
    await vi.waitFor(() => expect(s.factories.calls).toBe(3));
    expect(svc.calls.n).toBe(2);
    expect(urls(s.factories.ice[2] ?? [])).toEqual(['turn:relay2']);
  });

  it('a failed first acquisition is retried, not cached, and does not block the attempt', async () => {
    const t = await clocked();
    const svc = service(t.clock, (n) => (n === 1 ? new Error('offline') : 'ok'));
    const s = await started({ getIceServers: svc.get }, t);
    await vi.waitFor(() => expect(s.factories.calls).toBe(1)); // went ahead without relay credentials
    expect(s.factories.ice[0]).toEqual([]);
    s.mgr.reconnectNow(); // inside the backoff after the failure: no new request
    await vi.waitFor(() => expect(s.factories.calls).toBe(2));
    expect(svc.calls.n).toBe(1);
    t.clock.ms += 5_000;
    s.mgr.reconnectNow();
    await vi.waitFor(() => expect(s.factories.calls).toBe(3));
    expect(svc.calls.n).toBe(2);
    expect(urls(s.factories.ice[2] ?? [])).toEqual(['turn:relay2']);
  });

  it('a hanging acquisition is bounded, and later attempts ask again', async () => {
    const t = await clocked();
    const svc = service(t.clock, (n) => (n === 1 ? 'hang' : 'ok'));
    const s = await started({ getIceServers: svc.get, iceTimeoutMs: 60 }, t);
    await vi.waitFor(() => expect(s.factories.calls).toBe(1), { timeout: 2000 }); // the link did not wait forever
    t.clock.ms += 5_000;
    s.mgr.reconnectNow();
    await vi.waitFor(() => expect(s.factories.calls).toBe(2));
    expect(svc.calls.n).toBe(2);
    expect(urls(s.factories.ice[1] ?? [])).toEqual(['turn:relay2']);
  });

  it('shares one acquisition between concurrent attempts towards different peers', async () => {
    const t = await clocked();
    const hi2 = await makeDev(t.auth, PID, 'y-device', 86_400);
    cleanup.push(() => hi2.mesh.destroy());
    const gate = deferred<{ iceServers: unknown[]; expiresAt: number }>();
    let calls = 0;
    const { mgr, factories, sockets } = managerFor(t.lo, t.auth, PID, new FakeRtcNetwork(), {
      getIceServers: () => {
        calls++;
        return gate.promise;
      },
    });
    cleanup.push(() => mgr.stop());
    mgr.start();
    await flush();
    const ws = sockets[0] as FakeWs;
    ws.say({ t: 'ready', tickets: [t.hi.ticket, hi2.ticket] });
    await flush();
    gate.resolve({ iceServers: [{ urls: 'turn:shared' }], expiresAt: t.clock.ms + HOUR });
    await vi.waitFor(() => expect(factories.calls).toBe(2));
    expect(calls).toBe(1);
  });

  it('honours a rate limit: no new request before the advised delay', async () => {
    const t = await clocked();
    const svc = service(t.clock, (n) => (n === 1 ? { status: 429, retryAfterMs: 120_000 } : 'ok'));
    const s = await started({ getIceServers: svc.get }, t);
    await vi.waitFor(() => expect(s.factories.calls).toBe(1));
    t.clock.ms += 60_000;
    s.mgr.reconnectNow();
    await vi.waitFor(() => expect(s.factories.calls).toBe(2));
    expect(svc.calls.n).toBe(1);
    t.clock.ms += 61_000;
    s.mgr.reconnectNow();
    await vi.waitFor(() => expect(s.factories.calls).toBe(3));
    expect(svc.calls.n).toBe(2);
  });
});


describe('peer-to-peer data path', () => {
  it('keeps edits off the signaling server after direct connectivity, including a signaling outage', async () => {
    const { auth, lo, hi } = await pair();
    const rtc = new FakeRtcNetwork(), relay = new Relay();
    const sa: FakeWs[] = [], sb: FakeWs[] = [];
    const a = managerFor(lo, auth, PID, rtc, { wsFactory: relay.attach(lo, sa), heartbeatMs: 60_000 });
    const b = managerFor(hi, auth, PID, rtc, { wsFactory: relay.attach(hi, sb), heartbeatMs: 60_000 });
    cleanup.push(() => { a.mgr.stop(); b.mgr.stop(); });
    a.mgr.start(); b.mgr.start();
    await vi.waitFor(() => expect(lo.mesh.peers.length).toBe(1));
    await vi.waitFor(() => expect(hi.mesh.peers.length).toBe(1));
    await flush(100);
    // Once introductions settle, the non-gatekeeper leaves signaling entirely.
    expect(a.mgr.socketOpen).toBe(true);
    expect(b.mgr.socketOpen).toBe(false);
    const before = [...sa, ...sb].map(ws => ws.sent.length);
    const file = await lo.model.createTextNow('p2p.tex', 'peer content');
    await vi.waitFor(() => expect(hi.model.files.has(file)).toBe(true));
    await hi.mesh.openDoc('f:' + file);
    await vi.waitFor(async () => expect((await hi.model.openText(file)).toString()).toBe('peer content'));
    for (let n = 0; n < 10; n++) (await lo.model.openText(file)).insert(0, String(n));
    await vi.waitFor(async () => expect((await hi.model.openText(file)).toString()).toBe('9876543210peer content'));
    expect([...sa, ...sb].map(ws => ws.sent.length)).toEqual(before);
    sa[0]?.close();
    expect(a.mgr.socketOpen).toBe(false);
    (await hi.model.openText(file)).insert(0, 'offline-server:');
    await vi.waitFor(async () => expect((await lo.model.openText(file)).toString()).toBe('offline-server:9876543210peer content'));
    expect(a.mgr.socketOpen).toBe(false);
    expect(lo.mesh.peers.length).toBe(1);
  });
});
