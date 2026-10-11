import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { Mesh } from '../src/mesh.js';
import { RtcLink } from '../src/rtc.js';
import { type BridgeEvent, tauriRtcFactory } from '../src/tauri-rtc.js';
import { DataChannelTransport, type PeerTransport } from '../src/transport.js';
import { Net } from '../src/testkit.js';

const base = fileURLToPath(new URL('../../../apps/desktop/src-tauri/target/debug/examples/rtc_cli', import.meta.url));
const bin = existsSync(`${base}.exe`) ? `${base}.exe` : existsSync(base) ? base : null;

let child: ChildProcessWithoutNullStreams | null = null;
let rid = 0;
const waiting = new Map<number, { ok: (v: unknown) => void; err: (e: Error) => void }>();
const listeners = new Map<string, Set<(p: BridgeEvent) => void>>();
let buf = '';

function start() {
  child = spawn(bin as string, []);
  child.stdout.on('data', (d) => {
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
}

const invoke = <T>(cmd: string, args?: Record<string, unknown>) =>
  new Promise<T>((ok, err) => {
    const id = ++rid;
    waiting.set(id, { ok: ok as (v: unknown) => void, err });
    child?.stdin.write(`${JSON.stringify({ rid: id, cmd, args })}\n`);
  });

const listen = async (event: string, cb: (p: BridgeEvent) => void) => {
  const set = listeners.get(event) ?? new Set();
  set.add(cb);
  listeners.set(event, set);
  return () => void set.delete(cb);
};

afterAll(() => child?.kill());

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
