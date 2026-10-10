import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { Mesh } from '../src/mesh.js';
import { RtcLink } from '../src/rtc.js';
import { type BridgeEvent, tauriRtcFactory } from '../src/tauri-rtc.js';
import type { PeerTransport } from '../src/transport.js';
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
