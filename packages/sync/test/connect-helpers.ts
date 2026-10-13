import { type StoredDeviceKeys, generateDeviceKeys } from '@hivetex/crypto';
import { ConnectionManager, type ManagerOptions, type WebSocketLike } from '../src/connect.js';
import { Mesh } from '../src/mesh.js';
import { ProjectModel } from '../src/model.js';
import { MemoryPersistence } from '../src/persistence.js';
import { FakeRtcNetwork } from '../src/testing.js';
import { TestAuthority } from '../src/testkit.js';
import { traceLog } from './trace.js';

/** A scripted signaling socket: the test decides what the relay "says" and sees everything the client sends. */
export class FakeWs implements WebSocketLike {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onSend: ((m: Record<string, unknown>) => void) | null = null;
  send(d: string) {
    const m = JSON.parse(d) as Record<string, unknown>;
    this.sent.push(m);
    this.onSend?.(m);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  say(o: unknown) {
    this.onmessage?.({ data: JSON.stringify(o) });
  }
}

/** Lets pending promises and (real) crypto work settle. */
export const flush = async (ms = 40) => {
  await new Promise((r) => setTimeout(r, ms));
};
/** Like `flush` for tests that fake the timers. */
export const flushMicro = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

export interface Dev {
  dev: string;
  keys: StoredDeviceKeys;
  ticket: string;
  mesh: Mesh;
  model: ProjectModel;
}

export async function makeDev(auth: TestAuthority, pid: string, dev: string, ttlSec = 900): Promise<Dev> {
  const keys = await generateDeviceKeys();
  const ticket = await auth.mint({ pid, uid: `u-${dev}`, uname: dev, dev, keys, role: 'editor' }, { ttlSec });
  const model = new ProjectModel(new MemoryPersistence(), { flushMs: 5 });
  await model.init();
  const mesh = new Mesh({ projectId: pid, model, keys, trusted: auth.trusted, getTicket: () => ticket, now: auth.now });
  return { dev, keys, ticket, mesh, model };
}

export function managerFor(
  d: Dev,
  auth: TestAuthority,
  pid: string,
  rtc: FakeRtcNetwork,
  o: Partial<ManagerOptions> & { sockets?: FakeWs[] } = {},
) {
  const { sockets = [], ...rest } = o;
  const factories = { calls: 0, ice: [] as unknown[][] };
  const mgr = new ConnectionManager({
    mesh: d.mesh,
    projectId: pid,
    keys: d.keys,
    trusted: auth.trusted,
    getTicket: () => d.ticket,
    signalUrl: 'ws://test',
    wsFactory: () => {
      const ws = new FakeWs();
      sockets.push(ws);
      queueMicrotask(() => ws.open());
      return ws;
    },
    rtcFactory: (ice) => {
      factories.calls++;
      factories.ice.push(ice);
      return rtc.factory(ice);
    },
    getIceServers: async () => [],
    now: auth.now,
    idleCloseMs: 50,
    trace: traceLog().sink,
    ...rest,
  });
  return { mgr, factories, sockets };
}

/** Minimal relay between FakeWs sockets of several managers: delivers `sig` envelopes and presence. */
export class Relay {
  private socks = new Map<string, FakeWs>();
  private tickets = new Map<string, string>();
  /** A `wsFactory` for `dev` that registers its sockets here. */
  attach(dev: Dev, sockets: FakeWs[]) {
    return (): FakeWs => {
      const ws = new FakeWs();
      sockets.push(ws);
      ws.onSend = (m) => {
        if (m.t === 'sig') {
          const to = this.socks.get(String(m.to));
          to?.say({ t: 'sig', from: dev.dev, fromTicket: dev.ticket, env: m.env });
        }
      };
      queueMicrotask(() => {
        ws.open();
        this.socks.set(dev.dev, ws);
        this.tickets.set(dev.dev, dev.ticket);
        ws.say({ t: 'ready', tickets: [...this.tickets].filter(([d]) => d !== dev.dev).map(([, t]) => t) });
        for (const [d, s] of this.socks) if (d !== dev.dev) s.say({ t: 'join', ticket: dev.ticket, sid: `sid-${dev.dev}` });
      });
      return ws;
    };
  }
}

export const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
