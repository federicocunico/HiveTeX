import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { Mesh } from '../src/mesh.js';
import { RtcLink, selectedPath } from '../src/rtc.js';
import { type BridgeEvent, tauriRtcFactory } from '../src/tauri-rtc.js';
import { DataChannelTransport, type PeerTransport } from '../src/transport.js';
import { Net } from '../src/testkit.js';

const base = fileURLToPath(new URL('../../../apps/desktop/src-tauri/target/debug/examples/rtc_cli', import.meta.url));
const bin = existsSync(`${base}.exe`) ? `${base}.exe` : existsSync(base) ? base : null;

/** One rtc_cli process: the real Rust bridge over stdin/stdout. */
function bridgeProcess() {
  const proc: ChildProcessWithoutNullStreams = spawn(bin as string, []);
  let rid = 0;
  let buf = '';
  const waiting = new Map<number, { ok: (v: unknown) => void; err: (e: Error) => void }>();
  const listeners = new Map<string, Set<(p: BridgeEvent) => void>>();
  proc.stdout.on('data', (d) => {
    buf += String(d);
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line) as { rid?: number; result?: unknown; error?: string; event?: string; payload?: BridgeEvent };
      if (m.event) for (const l of listeners.get(m.event) ?? []) l(m.payload as BridgeEvent);
      else if (m.rid !== undefined) {
        const w = waiting.get(m.rid);
        waiting.delete(m.rid);
        if (m.error) w?.err(new Error(m.error));
        else w?.ok(m.result);
      }
    }
  });
  const invoke = <T,>(cmd: string, args?: Record<string, unknown>) =>
    new Promise<T>((ok, err) => {
      const id = ++rid;
      waiting.set(id, { ok: ok as (v: unknown) => void, err });
      proc.stdin.write(`${JSON.stringify({ rid: id, cmd, args })}\n`);
    });
  const listen = async (event: string, cb: (p: BridgeEvent) => void) => {
    const set = listeners.get(event) ?? new Set();
    set.add(cb);
    listeners.set(event, set);
    return () => void set.delete(cb);
  };
  processes.push(proc);
  return { invoke, listen };
}
const processes: ChildProcessWithoutNullStreams[] = [];
let shared: ReturnType<typeof bridgeProcess> | null = null;
function start() {
  shared ??= bridgeProcess();
}
const invoke = <T,>(cmd: string, args?: Record<string, unknown>) => (shared as ReturnType<typeof bridgeProcess>).invoke<T>(cmd, args);
const listen = (event: string, cb: (p: BridgeEvent) => void) => (shared as ReturnType<typeof bridgeProcess>).listen(event, cb);

afterAll(() => { for (const p of processes) p.kill(); });

describe.skipIf(!bin)('Rust WebRTC fallback transport (9.2)', () => {
  it('carries the full authenticated mesh handshake and CRDT sync over the Rust bridge', async () => {
    start();
    const factory = tauriRtcFactory(invoke, listen);
    const net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];

    // Link A (initiator) <-> B (answerer), each side with its own bridge peer, signaling relayed in-process.
    const links: { a?: RtcLink; b?: RtcLink } = {};
    const transports: { a?: PeerTransport; b?: PeerTransport } = {};
    const ready = new Promise<void>((resolve) => {
      const check = () => transports.a && transports.b && resolve();
      links.a = new RtcLink({
        factory,
        iceServers: [],
        initiator: true,
        send: (s) => void links.b?.handle(s),
        onTransport: (t) => ((transports.a = t), check()),
        onFail: (w) => console.log('A failed', w),
      });
      links.b = new RtcLink({
        factory,
        iceServers: [],
        initiator: false,
        send: (s) => void links.a?.handle(s),
        onTransport: (t) => ((transports.b = t), check()),
        onFail: (w) => console.log('B failed', w),
      });
    });
    await links.a?.start();
    await Promise.race([ready, new Promise((_, rej) => setTimeout(() => rej(new Error('bridge link timed out')), 30_000))]);

    // Real fingerprints came out of the Rust-generated SDP.
    expect(transports.a?.localFingerprint).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/i);
    expect(transports.a?.localFingerprint).toBe(transports.b?.remoteFingerprint);

    const [pa, pb] = await Promise.all([
      (a.mesh as Mesh).addTransport(transports.a as PeerTransport),
      (b.mesh as Mesh).addTransport(transports.b as PeerTransport),
    ]);
    expect(pa.claims.uname).toBe('bob');
    expect(pb.claims.uname).toBe('alice');

    const id = await a.model.createTextNow('main.tex', 'over the rust bridge');
    await b.mesh.openDoc(`f:${id}`);
    const end = Date.now() + 10_000;
    while (Date.now() < end && (await b.model.openText(id)).toString() !== 'over the rust bridge') await new Promise((r) => setTimeout(r, 25));
    expect((await b.model.openText(id)).toString()).toBe('over the rust bridge');

    // large payload to exercise fragmentation + back-pressure across IPC
    const big = 'x'.repeat(300_000);
    (await a.model.openText(id)).insert(0, big);
    const end2 = Date.now() + 15_000;
    while (Date.now() < end2 && (await b.model.openText(id)).length < big.length) await new Promise((r) => setTimeout(r, 50));
    expect((await b.model.openText(id)).length).toBe(big.length + 'over the rust bridge'.length);
    net.destroy();
  }, 90_000);
});

/** Links two bridge peers; `muxed` asks the native side for the shared UDP listener (what the worker uses). */
async function bridgeLink(muxed: boolean) {
  // Each side is its own native process, as two devices are: a muxed listener is per process.
  const side = () => {
    const p = bridgeProcess();
    const inv = (<T,>(cmd: string, args?: Record<string, unknown>) => p.invoke<T>(cmd, cmd === 'rtc_create' ? { ...args, muxed } : args)) as typeof invoke;
    return tauriRtcFactory(inv, p.listen);
  };
  const [fa, fb] = [side(), side()];
  const peers: ReturnType<typeof fa>[] = [];
  const keep = (f: typeof fa) => (ice: unknown[]) => { const p = f(ice); peers.push(p); return p; };
  const links: { a?: RtcLink; b?: RtcLink } = {};
  const transports: { a?: PeerTransport; b?: PeerTransport } = {};
  const ready = new Promise<void>((resolve) => {
    const check = () => transports.a && transports.b && resolve();
    links.a = new RtcLink({ factory: keep(fa), iceServers: [], initiator: true, send: (s) => void links.b?.handle(s), onTransport: (t) => ((transports.a = t), check()), onFail: () => {} });
    links.b = new RtcLink({ factory: keep(fb), iceServers: [], initiator: false, send: (s) => void links.a?.handle(s), onTransport: (t) => ((transports.b = t), check()), onFail: () => {} });
  });
  await links.a?.start();
  await Promise.race([ready, new Promise((_, rej) => setTimeout(() => rej(new Error('bridge link timed out')), 30_000))]);
  return { a: transports.a as PeerTransport, b: transports.b as PeerTransport, peers };
}

describe.skipIf(!bin)('native RTC parity on the shared muxed listener (9.1)', () => {
  it('keeps per-channel ordering under backpressure, reports the selected pair, and settles on cancellation', async () => {
    const { a, b, peers } = await bridgeLink(true);
    const got: Record<string, number[]> = { sync: [], bulk: [] };
    b.onMessage((ch, d) => got[ch]?.push(new DataView(d.buffer, d.byteOffset).getUint32(0)));
    // 400 small ordered messages on sync interleaved with 40 x 64 KiB on bulk: well past the high-water mark.
    const sends: Promise<void>[] = [];
    for (let i = 0; i < 400; i++) {
      const m = new Uint8Array(32); new DataView(m.buffer).setUint32(0, i); sends.push(a.send('sync', m));
      if (i % 10 === 0) { const big = new Uint8Array(64 * 1024); new DataView(big.buffer).setUint32(0, i / 10); sends.push(a.send('bulk', big)); }
    }
    await Promise.all(sends);
    const end = Date.now() + 20_000;
    while (Date.now() < end && (got.sync!.length < 400 || got.bulk!.length < 40)) await new Promise((r) => setTimeout(r, 25));
    expect(got.sync).toEqual(Array.from({ length: 400 }, (_, i) => i));
    expect(got.bulk).toEqual(Array.from({ length: 40 }, (_, i) => i));
    // Selected candidate pair statistics come from the native stack: a direct (host) path on this machine.
    expect(await selectedPath(peers[0]!)).toBe('direct');
    // Cancellation: closing mid-transfer settles every pending send and the peer sees the close.
    let closedB = false; b.onClose(() => { closedB = true; });
    const pending = Array.from({ length: 50 }, () => a.send('bulk', new Uint8Array(256 * 1024)));
    a.close();
    const settled = await Promise.race([Promise.allSettled(pending), new Promise<'hung'>((r) => setTimeout(() => r('hung'), 5_000))]);
    expect(settled).not.toBe('hung');
    const end2 = Date.now() + 15_000;
    while (Date.now() < end2 && !closedB) await new Promise((r) => setTimeout(r, 50));
    expect(closedB).toBe(true);
  }, 90_000);
});

/** Scripted bridge: `rtc_send` behavior is controlled per test, everything else succeeds. */
function scriptedBridge(sendImpl: (n: number) => Promise<number>) {
  let events: ((e: BridgeEvent) => void) | null = null;
  const calls: string[] = [];
  let sends = 0;
  const fakeInvoke = (async (cmd: string, args?: Record<string, unknown>) => {
    calls.push(cmd);
    if (cmd === 'rtc_send') return sendImpl(++sends);
    void args;
    return undefined;
  }) as Parameters<typeof tauriRtcFactory>[0];
  const fakeListen: Parameters<typeof tauriRtcFactory>[1] = async (_event, cb) => {
    events = cb;
    return () => {};
  };
  const peer = tauriRtcFactory(fakeInvoke, fakeListen)([]);
  const sync = peer.createDataChannel('sync');
  const bulk = peer.createDataChannel('bulk');
  const transport = new DataChannelTransport(sync, bulk, 'a', 'b');
  return {
    peer,
    sync,
    transport,
    calls,
    sends: () => sends,
    emit: (e: BridgeEvent) => events?.(e),
    open: async () => {
      await new Promise((r) => setTimeout(r, 5));
      events?.({ kind: 'open', label: 'sync' });
      events?.({ kind: 'open', label: 'bulk' });
    },
  };
}

const settle = <T>(ps: Promise<T>[], ms = 300) =>
  Promise.race([Promise.allSettled(ps), new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms))]);

describe('native RTC send failures and cancellation (F11)', () => {
  it('closes the owning transport when an IPC send fails, instead of reporting delivery', async () => {
    const b = scriptedBridge(async () => {
      throw new Error('ipc broke');
    });
    await b.open();
    let closed = 0;
    b.transport.onClose(() => closed++);
    await b.transport.send('sync', new Uint8Array(10)); // accepted: it is queued, not yet delivered
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(1);
    await expect(b.transport.send('sync', new Uint8Array(10))).rejects.toThrow();
  });

  it('does not send later queued messages after an IPC failure (no gap in a fragment stream)', async () => {
    const b = scriptedBridge(async (n) => {
      if (n === 1) throw new Error('ipc broke');
      return 0;
    });
    await b.open();
    const first = b.transport.send('sync', new Uint8Array(10));
    const rest = [b.transport.send('sync', new Uint8Array(10)), b.transport.send('sync', new Uint8Array(10))];
    await settle([first, ...rest]);
    await new Promise((r) => setTimeout(r, 20));
    expect(b.sends()).toBe(1);
    for (const p of rest) p.catch(() => {});
  });

  it('settles sends waiting on a hung IPC when the peer is closed', async () => {
    const b = scriptedBridge(() => new Promise<number>(() => {}));
    await b.open();
    // The first message is above the high-water mark, so the next send waits for a drain that never comes.
    const sends = [b.transport.send('sync', new Uint8Array(2 * 1024 * 1024)), b.transport.send('sync', new Uint8Array(10))];
    await new Promise((r) => setTimeout(r, 20));
    b.peer.close();
    const res = await settle(sends);
    expect(res).not.toBe('hung');
    expect((res as PromiseSettledResult<void>[]).some((r) => r.status === 'rejected')).toBe(true);
    await expect(b.transport.send('sync', new Uint8Array(1))).rejects.toThrow();
  });

  it('settles sends waiting on a hung IPC when the transport is closed locally', async () => {
    const b = scriptedBridge(() => new Promise<number>(() => {}));
    await b.open();
    const sends = [b.transport.send('bulk', new Uint8Array(2 * 1024 * 1024)), b.transport.send('bulk', new Uint8Array(10))];
    await new Promise((r) => setTimeout(r, 20));
    b.transport.close();
    const res = await settle(sends);
    expect(res).not.toBe('hung');
  });

  it('settles pending sends when Rust reports the channel closed', async () => {
    const b = scriptedBridge(() => new Promise<number>(() => {}));
    await b.open();
    const sends = [b.transport.send('sync', new Uint8Array(2 * 1024 * 1024)), b.transport.send('sync', new Uint8Array(10))];
    await new Promise((r) => setTimeout(r, 20));
    b.emit({ kind: 'close', label: 'sync' });
    expect(await settle(sends)).not.toBe('hung');
  });
});
