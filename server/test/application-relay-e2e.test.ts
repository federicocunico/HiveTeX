import { generateDeviceKeys } from "@hivetex/crypto";
import { MsgType } from "@hivetex/protocol";
import {
  BlobManager,
  ConnectionManager,
  type ManagerOptions,
  Mesh,
  MemoryPersistence,
  ProjectModel,
  SyncTracker,
  type WebSocketLike,
} from "@hivetex/sync";
import { FakePc, FakeRtcNetwork, inProcessSocket } from "@hivetex/sync/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schema } from "../src/db/client.js";
import type { Deps } from "../src/deps.js";
import { createApplicationRelayRouter, type RelayDebit } from "../src/signal/application-relay.js";
import { MemorySignalBackend, createSignalSession } from "../src/signal/hub.js";
import { Client, type TestEnv, makeEnv, register } from "./helpers.js";
import { traceLog } from "./trace.js";

/**
 * Phase-1 acceptance on the current clients (3.1-3.5, 3.7): real ConnectionManager/Mesh/BlobManager, the real signal hub
 * and relay router, WebRTC made unusable (every attempt stalls) and no TURN.
 */
let env: TestEnv;
let backend: MemorySignalBackend;
let rtc: FakeRtcNetwork;
let debit: RelayDebit;
let deps: Deps;
const cleanup: Array<() => void> = [];

beforeEach(async () => {
  env = await makeEnv();
  backend = new MemorySignalBackend({ recordMessages: true });
  rtc = new FakeRtcNetwork();
  rtc.stallNext = 1_000_000; // no direct path at all
  debit = "ok";
  deps = {
    ...env.deps,
    applicationRelay: createApplicationRelayRouter({
      namespace: "e2e",
      backend,
      deps: env.deps,
      admission: { acquire: async () => ({ debit: async () => debit, close: () => {} }) },
    }),
  };
});
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(10);
  }
  throw new Error("waitFor timed out");
}

interface Dev {
  name: string;
  model: ProjectModel;
  mesh: Mesh;
  mgr: ConnectionManager;
  blobs: BlobManager;
  store: MemoryPersistence;
  dev: string;
  sockets: WebSocketLike[];
  /** A fresh ticket from the control plane, shared with the peers as the app does. */
  refreshTicket: () => Promise<void>;
}
async function makeDevice(
  client: Client,
  pid: string,
  name: string,
  extra: Partial<ManagerOptions> = {},
  serverDeps: () => Deps = () => deps,
): Promise<Dev> {
  const keys = await generateDeviceKeys();
  const dev = (
    await client.post("/devices", { ed25519Pub: keys.edPub, x25519Pub: keys.xPub, label: name })
  ).json.deviceId as string;
  const mint = async () => (await client.post(`/projects/${pid}/ticket`, { deviceId: dev })).json.ticket as string;
  let ticket = await mint();
  const store = new MemoryPersistence();
  const model = new ProjectModel(store, { flushMs: 5 });
  await model.init();
  const tk = (await new Client(env).get("/keys")).json.keys;
  const mesh = new Mesh({
    projectId: pid,
    model,
    keys,
    trusted: tk,
    getTicket: () => ticket,
    now: env.deps.now,
  });
  const blobs = new BlobManager(mesh, store);
  const sockets: WebSocketLike[] = [];
  const mgr = new ConnectionManager({
    mesh,
    projectId: pid,
    keys,
    trusted: tk,
    getTicket: () => ticket,
    signalUrl: "ws://test/api/signal",
    wsFactory: () => {
      const ws = inProcessSocket((sock) => createSignalSession(sock, serverDeps(), backend));
      sockets.push(ws);
      return ws;
    },
    rtcFactory: rtc.factory,
    getIceServers: async () => [],
    now: env.deps.now,
    idleCloseMs: 50,
    trace: traceLog().sink,
    linkTimeoutMs: 300,
    maxBackoffMs: 300,
    relayAfterMs: 200,
    directRetryMs: 300,
    directProbationMs: 300,
    relayTransport: { rtoMs: 200 },
    ...extra,
  });
  cleanup.push(() => {
    mgr.stop();
    mesh.destroy();
  });
  const refreshTicket = async () => {
    ticket = await mint();
    await mesh.refreshOwnTicket(ticket);
  };
  return { name, model, mesh, mgr, blobs, store, dev, sockets, refreshTicket };
}

async function project(slug: string, names = ["olga", "bob"]) {
  const owner = await register(env, names[0] as string);
  const created = (await owner.post("/projects", { slug, password: "project-secret-1" })).json.project;
  const pid = created.id as string;
  const bob = await register(env, names[1] as string);
  await bob.post("/projects/join", { slug: created.slug, password: "project-secret-1" });
  const uid = (await env.db.select().from(schema.users)).find((u) => u.username === names[1])?.id;
  await owner.patch(`/projects/${pid}/members/${uid}`, { role: "editor" });
  return { owner, bob, pid, slug: created.slug as string };
}
const relayFrames = () => backend.log.filter((m) => m.includes('"app-relay"')).length;

describe("application relay between current clients (3.x)", () => {
  it('reintroduces a socket after a peer leave removed its relay just before the duration cutoff (13.7)', async () => {
    const { owner, bob, pid } = await project('relay-staggered-cutoff');
    const options = { doorbell: { ring: async () => true }, introductionWindowMs: 3000, introductionMinMs: 50,
      idleCloseMs: 3000, directRetryMs: 60_000, relayAfterMs: 20 };
    const a = await makeDevice(owner, pid, 'a', options), b = await makeDevice(bob, pid, 'b', options);
    for (const d of [a, b]) { d.mgr.setDoorbellAvailable(true); d.mgr.start(); }
    await waitFor(() => a.mesh.peers.length === 1 && b.mesh.peers.length === 1);
    const id = await a.model.createTextNow('cutoff.tex', 'before');
    await waitFor(() => b.model.files.has(id)); await b.mesh.openDoc(`f:${id}`);
    await waitFor(async () => (await b.model.openText(id)).toString() === 'before');
    await sleep(3500); // the original introduction window is over, but relay sockets are still needed
    const before = b.sockets.length;
    const presence = await backend.getPresence(pid);
    await backend.publish(`sig:${pid}`, JSON.stringify({ t: 'leave', dev: a.dev, sid: presence[a.dev]?.split('|')[0] }));
    await waitFor(() => b.mesh.peers.length === 0);
    // The platform closes B's socket before its deliberate idle-close timer, after A's leave removed the relay map.
    b.sockets.at(-1)!.close();
    await waitFor(() => b.sockets.length > before && a.mesh.peers.length === 1 && b.mesh.peers.length === 1, 15_000);
    (await a.model.openText(id)).insert(6, ' after');
    await waitFor(async () => (await b.model.openText(id)).toString() === 'before after');
  }, 30_000);

  it("12 relay peers converge under simultaneous typing and send an edit once per connection (13.3)", async () => {
    const { owner, bob, pid } = await project("relay-scale-12");
    const nodes = await Promise.all(
      Array.from({ length: 12 }, (_, i) => makeDevice(i % 2 ? bob : owner, pid, `p${i}`, { directRetryMs: 60_000, linkTimeoutMs: 20_000, relayTransport: { rtoMs: 1500 } })),
    );
    for (const d of nodes) d.mgr.start();
    await waitFor(() => nodes.every((d) => d.mesh.peers.length === 11), 30_000);
    for (const d of nodes)
      expect(Object.values(d.mgr.routes()).every((r) => r.route === "relay")).toBe(true);
    const id = await nodes[0]!.model.createTextNow("scale.tex", "start");
    for (const d of nodes) {
      await waitFor(() => d.model.files.has(id), 30_000);
      await d.mesh.openDoc(`f:${id}`);
    }
    const texts = await Promise.all(nodes.map((d) => d.model.openText(id)));
    await waitFor(() => texts.every((t) => t.toString() === "start"));
    await Promise.all(
      nodes.slice(1).map(async (d) =>
        expect((await d.mesh.reconcile(`f:${id}`, { timeoutMs: 10_000 })).outcome).toBe(
          "confirmed",
        ),
      ),
    );
    expect((await nodes[0]!.mesh.reconcile(`f:${id}`, { timeoutMs: 10_000 })).outcome).toBe("confirmed");
    await sleep(300); // let neighbour lists settle before measuring duplicate forwarding
    let frames = 0;
    const restore: Array<() => void> = [];
    for (const d of nodes)
      for (const peer of d.mesh.peers) {
        const original = peer.conn.send.bind(peer.conn);
        peer.conn.send = async (...args: Parameters<typeof original>) => {
          if (args[0] === MsgType.UPDATE) frames++;
          return original(...args);
        };
        restore.push(() => {
          peer.conn.send = original;
        });
      }
    const started = performance.now();
    texts[0]!.insert(texts[0]!.length, " once");
    await waitFor(() => texts.every((t) => t.toString() === "start once"));
    await sleep(100);
    expect(frames).toBe(11);
    for (const r of restore) r();
    await Promise.all(
      texts.map(async (t, i) => {
        for (let k = 0; k < 20; k++) {
          t.insert(0, `<${i}.${k}>`);
          await sleep(5);
        }
      }),
    );
    await waitFor(() => new Set(texts.map((t) => t.toString())).size === 1, 20_000);
    const final = texts[0]!.toString();
    for (let i = 0; i < 12; i++)
      for (let k = 0; k < 20; k++) expect(final).toContain(`<${i}.${k}>`);
    console.log(
      `[relay scale] 12 peers, ${frames} frames for one edit; 240 concurrent edits converged in ${(performance.now() - started).toFixed(0)} ms`,
    );
  }, 90_000);

  it("syncs through the relay within 5 s without WebRTC or TURN, independently of attempt timeouts, as ciphertext", async () => {
    const { owner, bob, pid } = await project("relay-e2e-1");
    // Default relay start (at once) and the default 30 s WebRTC attempt, which never completes here.
    const defaults = { relayAfterMs: 0, linkTimeoutMs: 30_000, directProbationMs: 8000 };
    const a = await makeDevice(owner, pid, "a", defaults);
    const b = await makeDevice(bob, pid, "b", defaults);
    const started = Date.now();
    a.mgr.start();
    b.mgr.start();
    await waitFor(() => a.mesh.peers.length === 1 && b.mesh.peers.length === 1, 6000);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(Object.values(a.mgr.routes())).toEqual([{ route: "relay", limited: null }]);

    const SECRET = "RELAY-SECRET-PARAGRAPH-9917";
    const id = await a.model.createTextNow("relay-chapter.tex", `\\section{${SECRET}}`);
    const bytes = new TextEncoder().encode(`PNGDATA-${SECRET}`.repeat(4000)); // ~100 kB, several relay fragments
    const hash = await a.blobs.add(bytes);
    a.model.createBinary("figures/relay.png", hash, bytes.length);
    await waitFor(() => b.model.files.has(id));
    await b.mesh.openDoc(`f:${id}`);
    await waitFor(async () => (await b.model.openText(id)).toString().includes(SECRET));
    expect(new TextDecoder().decode(await b.blobs.fetch(hash, 10_000))).toContain(SECRET);
    expect(relayFrames()).toBeGreaterThan(0);
    for (const needle of [SECRET, "relay-chapter", "relay.png", "PNGDATA", "section"])
      expect(backend.log.join("\n")).not.toContain(needle);
  }, 30_000);

  it("recovers from the 300 s socket rotation with a fresh relay session and keeps offline work", async () => {
    const { owner, bob, pid } = await project("relay-e2e-2");
    const a = await makeDevice(owner, pid, "a");
    const b = await makeDevice(bob, pid, "b");
    a.mgr.start();
    b.mgr.start();
    await waitFor(() => a.mesh.peers.length === 1 && b.mesh.peers.length === 1);
    const id = await a.model.createTextNow("rot.tex", "start");
    await waitFor(() => b.model.files.has(id));
    await b.mesh.openDoc(`f:${id}`);
    await waitFor(async () => (await b.model.openText(id)).toString() === "start");
    const firstSession = (a.mesh.peers[0]?.conn.transport as unknown as { sessionId: string })
      .sessionId;
    // The platform ends both sockets (function duration); edits continue meanwhile.
    for (const d of [a, b]) d.sockets.at(-1)?.close();
    (await a.model.openText(id)).insert(5, " during-rotation");
    await waitFor(
      () => a.mesh.peers.length === 1 && b.mesh.peers.length === 1 && a.sockets.length > 1,
      10_000,
    );
    const secondSession = (a.mesh.peers[0]?.conn.transport as unknown as { sessionId: string })
      .sessionId;
    expect(secondSession).not.toBe(firstSession);
    await waitFor(
      async () => (await b.model.openText(id)).toString() === "start during-rotation",
      10_000,
    );
  }, 30_000);

  it("retries after a relay subscription failure and completes a binary interrupted by an instance replacement", async () => {
    const { owner, bob, pid } = await project("relay-e2e-7");
    // The first relay attachments fail like an Upstash subscription that never confirms (hub closes with 1011).
    let failures = 2;
    const flaky = (): Deps => ({
      ...deps,
      applicationRelay: {
        attach: async (ctx) => {
          if (failures-- > 0) throw new Error("subscription readiness timed out");
          return (deps.applicationRelay as NonNullable<Deps["applicationRelay"]>).attach(ctx);
        },
      },
    });
    const slow = { relayTransport: { rtoMs: 200, windowBytes: 32 * 1024 } };
    const a = await makeDevice(owner, pid, "a", slow, flaky);
    const b = await makeDevice(bob, pid, "b", slow, flaky);
    a.mgr.start();
    b.mgr.start();
    await waitFor(() => a.mesh.peers.length === 1 && b.mesh.peers.length === 1, 15_000);
    expect(failures).toBeLessThan(0);
    const bytes = new TextEncoder().encode("BINARY-".repeat(60_000)); // ~420 kB: needs many credit windows
    const hash = await a.blobs.add(bytes);
    a.model.createBinary("big.bin", hash, bytes.length);
    const fetched = b.blobs.fetch(hash, 25_000);
    let done = false;
    void fetched.then(() => {
      done = true;
    });
    await sleep(30);
    expect(done).toBe(false);
    for (const d of [a, b]) d.sockets.at(-1)?.close(); // the instance goes away mid-transfer
    expect((await fetched).length).toBe(bytes.length);
  }, 40_000);

  it("hands over to a direct link when one becomes available, without losing concurrent edits", async () => {
    const { owner, bob, pid } = await project("relay-e2e-3");
    const a = await makeDevice(owner, pid, "a");
    const b = await makeDevice(bob, pid, "b");
    a.mgr.start();
    b.mgr.start();
    await waitFor(() => a.mesh.peers.length === 1 && b.mesh.peers.length === 1);
    expect(Object.values(a.mgr.routes())[0]?.route).toBe("relay");
    // The relay route needs the signaling socket on both sides, also on the device that is not the gatekeeper.
    expect(a.mgr.socketOpen && b.mgr.socketOpen).toBe(true);
    const id = await a.model.createTextNow("handover.tex", "");
    await waitFor(() => b.model.files.has(id));
    await b.mesh.openDoc(`f:${id}`);
    const [ta, tb] = [await a.model.openText(id), await b.model.openText(id)];
    rtc.stallNext = 0; // a direct path appears
    for (let n = 0; n < 40; n++) {
      ta.insert(ta.length, `a${n} `);
      tb.insert(0, `b${n} `);
      await sleep(15);
    }
    await waitFor(
      () =>
        Object.values(a.mgr.routes())[0]?.route === "direct" &&
        Object.values(b.mgr.routes())[0]?.route === "direct",
      10_000,
    );
    expect(a.mesh.peers.length).toBe(1); // one active owner per peer
    await waitFor(
      () =>
        ta.toString() === tb.toString() && ta.toString().split(" ").filter(Boolean).length === 80,
      10_000,
    );
    // Direct route: the device that is not the gatekeeper (higher id) releases its socket (zero idle once linked directly).
    const notGatekeeper = a.dev > b.dev ? a : b;
    await waitFor(() => !notGatekeeper.mgr.socketOpen, 3000);
  }, 30_000);

  it("hands over during simultaneous edits and an asset transfer with one owner, unchanged authorization and nothing lost (13.8)", async () => {
    const { owner, bob, pid } = await project("relay-e2e-8");
    const slow = { relayTransport: { rtoMs: 200, windowBytes: 32 * 1024 } };
    const a = await makeDevice(owner, pid, "a", slow);
    const b = await makeDevice(bob, pid, "b", slow);
    a.mgr.start();
    b.mgr.start();
    await waitFor(() => a.mesh.peers.length === 1 && b.mesh.peers.length === 1);
    expect(Object.values(a.mgr.routes())[0]?.route).toBe("relay");
    const before = { a: a.mesh.peers[0]?.claims, b: b.mesh.peers[0]?.claims };
    const id = await a.model.createTextNow("cutover.tex", "");
    await waitFor(() => b.model.files.has(id));
    await b.mesh.openDoc(`f:${id}`);
    const [ta, tb] = [await a.model.openText(id), await b.model.openText(id)];
    // A large asset starts over the relay; the direct path appears while it and the typing are in flight.
    const bytes = new TextEncoder().encode("ASSET-".repeat(70_000));
    const hash = await a.blobs.add(bytes);
    a.model.createBinary("fig.bin", hash, bytes.length);
    const fetched = b.blobs.fetch(hash, 30_000);
    await sleep(30);
    rtc.stallNext = 0;
    for (let n = 0; n < 40; n++) {
      ta.insert(ta.length, `a${n} `);
      tb.insert(0, `b${n} `);
      await sleep(15);
    }
    await waitFor(
      () =>
        Object.values(a.mgr.routes())[0]?.route === "direct" &&
        Object.values(b.mgr.routes())[0]?.route === "direct",
      15_000,
    );
    expect((await fetched).length).toBe(bytes.length);
    expect(await b.store.getBlob(hash)).toBeDefined();
    await waitFor(
      () =>
        ta.toString() === tb.toString() && ta.toString().split(" ").filter(Boolean).length === 80,
      10_000,
    );
    // One current connection generation per peer, authenticated as the same members with the same roles.
    expect(a.mesh.peers.length).toBe(1);
    expect(b.mesh.peers.length).toBe(1);
    expect(a.mesh.peers[0]?.claims).toEqual(before.a);
    expect(b.mesh.peers[0]?.claims).toEqual(before.b);
  }, 40_000);

  it("keeps edits pending with a relay-limited state while the budget is exhausted, then delivers them", async () => {
    const { owner, bob, pid } = await project("relay-e2e-4");
    const a = await makeDevice(owner, pid, "a");
    const b = await makeDevice(bob, pid, "b");
    a.mgr.start();
    b.mgr.start();
    await waitFor(() => a.mesh.peers.length === 1 && b.mesh.peers.length === 1);
    const id = await a.model.createTextNow("quota.tex", "base");
    await waitFor(() => b.model.files.has(id));
    await b.mesh.openDoc(`f:${id}`);
    await waitFor(async () => (await b.model.openText(id)).toString() === "base");
    debit = "limited";
    (await a.model.openText(id)).insert(4, " while-limited");
    await waitFor(() => Object.values(a.mgr.routes())[0]?.limited === "relay_limited");
    await sleep(300);
    await expect.poll(async () => (await b.model.openText(id)).toString(), { timeout: 15_000 }).toBe("base");
    expect((await a.model.openText(id)).toString()).toBe("base while-limited"); // local work intact
    // Server acceptance or a fragment ACK is not reconciliation: a round towards the limited peer does not complete.
    expect((await a.mesh.reconcile(`f:${id}`, { timeoutMs: 500 })).outcome).not.toBe("confirmed");
    debit = "ok";
    await waitFor(
      async () => (await b.model.openText(id)).toString() === "base while-limited",
      70_000,
    );
  }, 90_000);

  it.each(["limited", "unavailable"] as const)(
    "relay accounting %s never pauses direct traffic to other peers (13.9)",
    async (failure) => {
      const { owner, bob, pid, slug } = await project("relay-e2e-9");
      const carl = await register(env, "carl");
      await carl.post("/projects/join", { slug, password: "project-secret-1" });
      const carlId = (await env.db.select().from(schema.users)).find(
        (u) => u.username === "carl",
      )?.id;
      await owner.patch(`/projects/${pid}/members/${carlId}`, { role: "editor" });
      rtc.stallNext = 0; // a and c reach each other directly
      const behindNat = new FakeRtcNetwork();
      behindNat.stallNext = 1_000_000; // b has no direct path to anyone: relay only
      const a = await makeDevice(owner, pid, "a");
      const b = await makeDevice(bob, pid, "b", { rtcFactory: behindNat.factory });
      const c = await makeDevice(carl, pid, "c");
      for (const d of [a, b, c]) d.mgr.start();
      await waitFor(
        () => a.mesh.peers.length === 2 && b.mesh.peers.length >= 1 && c.mesh.peers.length >= 1,
        15_000,
      );
      const route = (to: Dev) => a.mgr.routes()[to.dev]?.route;
      await waitFor(() => route(b) === "relay" && route(c) === "direct", 10_000);
      const id = await a.model.createTextNow("budget.tex", "base");
      for (const d of [b, c]) {
        await waitFor(() => d.model.files.has(id));
        await d.mesh.openDoc(`f:${id}`);
        await waitFor(async () => (await d.model.openText(id)).toString() === "base");
      }
      debit = failure; // the deployment budget is exhausted or accounting cannot issue new credit
      for (let n = 0; n < 20; n++)
        (await a.model.openText(id)).insert(Infinity as unknown as number, ` d${n}`);
      // The direct co-author keeps receiving in real time; only the relay-only peer waits.
      await waitFor(async () => (await c.model.openText(id)).toString().includes("d19"), 5000);
      await waitFor(
        () =>
          a.mgr.routes()[b.dev]?.limited ===
          (failure === "limited" ? "relay_limited" : "relay_accounting_unavailable"),
      );
      expect((await b.model.openText(id)).toString()).toBe("base");
      expect(a.mgr.routes()[c.dev]?.limited ?? null).toBeNull();
      debit = "ok";
      await waitFor(async () => (await b.model.openText(id)).toString().includes("d19"), 70_000);
    },
    120_000,
  );

  it("reports text reconciled with an image pending as incomplete over the relay", async () => {
    const { owner, bob, pid } = await project("relay-e2e-8");
    const a = await makeDevice(owner, pid, "a");
    const b = await makeDevice(bob, pid, "b");
    const tracker = new SyncTracker({
      mesh: b.mesh,
      model: b.model,
      store: b.store,
      blobs: b.blobs,
      connecting: () => 0,
      offline: () => false,
      fetchTimeoutMs: 500,
      retryBaseMs: 200,
    });
    cleanup.push(() => tracker.stop());
    tracker.start();
    await a.model.createTextNow("main.tex", "all text is here");
    // The image is listed but its bytes are not available from any source (e.g. deferred by the relay budget).
    a.model.createBinary("figures/pending.png", "f".repeat(64), 1234);
    a.mgr.start();
    b.mgr.start();
    await waitFor(() => a.mesh.peers.length === 1 && b.mesh.peers.length === 1);
    expect(Object.values(b.mgr.routes())[0]?.route).toBe("relay");
    await waitFor(async () => {
      const s = await tracker.refresh();
      return s.files.some((f) => f.kind === "text" && f.have && f.reconciled);
    }, 10_000);
    await sleep(1500);
    const s = await tracker.refresh();
    expect(s.files.find((f) => f.kind === "binary")?.have).toBe(false);
    expect(s.stage).not.toBe("synced");
    expect(s.lastSyncAt).toBeNull();
  }, 30_000);

  it("starts the relay at once even with TURN configured: relay first, WebRTC in the background", async () => {
    const { owner, bob, pid } = await project("relay-e2e-9");
    const turn = {
      getIceServers: async () => [
        { urls: "turn:turn.example:3478", username: "u", credential: "c" },
      ],
      linkTimeoutMs: 20_000,
      relayAfterMs: 0,
    };
    const a = await makeDevice(owner, pid, "a", turn);
    const b = await makeDevice(bob, pid, "b", turn);
    a.mgr.start();
    b.mgr.start();
    // The TURN attempt is still running (20 s): the relay does not wait for it.
    await waitFor(() => a.mesh.peers.length === 1 && b.mesh.peers.length === 1, 3000);
    expect(Object.values(a.mgr.routes())[0]?.route).toBe("relay");
    expect(a.mgr.candidates()[0]?.linking ?? true).toBe(true);
  }, 30_000);

  it("the connection test measures a round trip through the application relay when it is the route", async () => {
    const { owner, bob, pid } = await project("relay-e2e-12");
    const a = await makeDevice(owner, pid, "a");
    const b = await makeDevice(bob, pid, "b");
    a.mgr.start();
    b.mgr.start();
    await waitFor(() => Object.values(a.mgr.routes())[0]?.route === "relay" && Object.values(b.mgr.routes())[0]?.route === "relay");
    const r = await a.mgr.probePeer(b.dev, { attemptTimeoutMs: 1500 });
    const step = r.steps.find((s) => s.label === "Application relay");
    expect(step?.ok).toBe(true);
    expect(step?.detail).toMatch(/went to the other device and back through the HiveTeX server in \d+ ms/);
    expect(r.verdict).toMatch(/^Connected through the application relay/);
  }, 30_000);

  it("a direct link that drops during its probation never becomes the route; edits keep flowing through the relay", async () => {
    const { owner, bob, pid } = await project("relay-e2e-10");
    const pcs: FakePc[] = [];
    const watched = (ice: unknown[]) => {
      const pc = rtc.factory(ice);
      pcs.push(pc as FakePc);
      return pc;
    };
    const opts = { rtcFactory: watched, directProbationMs: 1500 };
    const a = await makeDevice(owner, pid, "a", opts);
    const b = await makeDevice(bob, pid, "b", opts);
    a.mgr.start();
    b.mgr.start();
    await waitFor(() => Object.values(a.mgr.routes())[0]?.route === "relay" && Object.values(b.mgr.routes())[0]?.route === "relay");
    rtc.stallNext = 0; // a direct path appears ...
    await waitFor(() => pcs.some((pc) => pc.connectionState === "connected"), 6000);
    rtc.stallNext = 1_000_000; // ... and is gone again for every later attempt
    for (const pc of pcs.filter((p) => p.connectionState === "connected")) pc.cut(); // dies seconds after connecting, as in the lab
    await sleep(2500); // past the probation
    expect(Object.values(a.mgr.routes())[0]?.route).toBe("relay");
    expect(Object.values(b.mgr.routes())[0]?.route).toBe("relay");
    const id = await a.model.createTextNow("probation.tex", "still through the relay");
    await waitFor(() => b.model.files.has(id));
    await b.mesh.openDoc(`f:${id}`);
    await waitFor(async () => (await b.model.openText(id)).toString() === "still through the relay");
  }, 30_000);

  it("a ticket refreshed through the relay during probation does not fail the handover (sandbox run 2026-10-14)", async () => {
    // One device had the relay as its route, the other was still finishing the relay handshake when the direct link came
    // up. The second handed the link to its mesh at once, its greeting carrying the ticket of that moment; it then
    // refreshed its ticket over the relay, and when the first ended its probation that greeting was older than the
    // ticket already seen: "stale device ticket", the link dropped, and the retries left the pair without a route.
    const { owner, bob, pid } = await project("relay-e2e-12");
    // The first direct attempt starts with the relay, as in the field, and connects only once the gate opens.
    rtc.stallNext = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const pcs: FakePc[] = [];
    const watched = (ice: unknown[]) => {
      const pc = rtc.factory(ice) as FakePc;
      const setRemote = pc.setRemoteDescription.bind(pc);
      pc.setRemoteDescription = async (d) => { await gate; return setRemote(d); };
      pcs.push(pc);
      return pc;
    };
    const opts = { rtcFactory: watched, directProbationMs: 3000, linkTimeoutMs: 20_000 };
    const fast = await makeDevice(owner, pid, "a", opts);
    const slow = await makeDevice(bob, pid, "b", opts);
    // On the relay connection, the slow device gets the other's greeting but not yet its proof: the other device has
    // authenticated the relay connection (its route), this one has not.
    let holding = true;
    const held: Array<() => void> = [];
    const addTransport = slow.mesh.addTransport.bind(slow.mesh);
    slow.mesh.addTransport = (t) => {
      if (holding && t.authenticationBinding.kind === "relay") {
        const onMessage = t.onMessage.bind(t);
        let n = 0;
        t.onMessage = (cb) => onMessage((c, d) => (holding && ++n > 1 ? held.push(() => cb(c, d)) : cb(c, d)));
      }
      return addTransport(t);
    };
    fast.mgr.start();
    slow.mgr.start();
    const route = (d: Dev) => Object.values(d.mgr.routes())[0]?.route;
    await waitFor(() => route(fast) === "relay", 10_000);
    expect(route(slow)).toBeUndefined();
    open(); // the direct path connects while the slow device still authenticates the relay
    await waitFor(() => pcs.filter((pc) => pc.connectionState === "connected").length >= 2, 10_000);
    holding = false;
    for (const deliver of held.splice(0)) deliver();
    await waitFor(() => route(slow) === "relay", 5000);
    env.advance(2000); // a later issue time (seconds; the test clock stands still)
    await slow.refreshTicket(); // shared over the relay while the direct link is on probation
    await waitFor(() => route(fast) === "direct" && route(slow) === "direct", 15_000);
    expect([...fast.mesh.rejected, ...slow.mesh.rejected]).not.toContain("stale device ticket");
  }, 40_000);

  for (const notices of ["lower", "higher"] as const) {
    it(`hands back to the relay within 4 s when only the ${notices} id sees the direct route go silent, sockets closed (sandbox run 2026-10-14)`, async () => {
      // A TURN route died after four minutes and only one side noticed. Both sockets were closed (zero idle): the other
      // device stayed off the server until it declared the link lost (10 s), so the relay could not start; and a device
      // whose direct link still looked fine refused the relay.
      const { owner, bob, pid } = await project(`relay-e2e-13-${notices}`);
      rtc.stallNext = 0;
      const devices: Dev[] = [];
      const pcs = new Map<string, FakePc[]>();
      const make = async (client: Client, name: string) => {
        const mine: FakePc[] = [];
        pcs.set(name, mine);
        const d = await makeDevice(client, pid, name, {
          rtcFactory: (ice) => {
            const pc = rtc.factory(ice) as FakePc;
            mine.push(pc);
            return pc;
          },
          zeroIdle: true,
          doorbell: { ring: async () => { for (const o of devices) if (o.name !== name) o.mgr.answerRing(); return true; } },
          answerJitterMs: 0,
          introductionMinMs: 2000, // an answer to a ring stays at least this long (8 s by default)
          introductionWindowMs: 3000,
        });
        devices.push(d);
        return d;
      };
      const a = await make(owner, "a");
      const b = await make(bob, "b");
      a.mgr.start();
      b.mgr.start();
      a.mgr.setDoorbellAvailable(true); // the push subscription is up, as the app reports it
      b.mgr.setDoorbellAvailable(true);
      const route = (d: Dev) => Object.values(d.mgr.routes())[0]?.route;
      await waitFor(() => route(a) === "direct" && route(b) === "direct", 10_000);
      await waitFor(() => !a.mgr.socketOpen && !b.mgr.socketOpen, 10_000);
      const id = await a.model.createTextNow("one-way.tex", "");
      await waitFor(() => b.model.files.has(id));
      await b.mesh.openDoc(`f:${id}`);
      const [ta, tb] = [await a.model.openText(id), await b.model.openText(id)];
      rtc.stallNext = 1_000_000; // no new direct path
      const [low, high] = a.dev < b.dev ? [a, b] : [b, a];
      const noticing = notices === "lower" ? low : high;
      const other = noticing === a ? b : a;
      const live = (pcs.get(noticing.name) ?? []).filter((pc) => pc.connectionState === "connected");
      expect(live.length).toBe(1);
      const dropped = Date.now();
      live[0]?.cut({ onlyHere: true });
      expect(route(other)).toBe("direct"); // the other side still sees nothing wrong
      (other === a ? ta : tb).insert(0, "after the one-way drop ");
      await waitFor(() => (noticing === a ? ta : tb).toString().includes("after the one-way drop"), 8000);
      expect(Date.now() - dropped).toBeLessThan(4000);
      await waitFor(() => route(a) === "relay" && route(b) === "relay", 3000);
    }, 40_000);
  }

  it("hands back to the relay within 2 s when the direct route goes silent", async () => {
    const { owner, bob, pid } = await project("relay-e2e-11");
    rtc.stallNext = 0;
    const pcs: FakePc[] = [];
    const watched = (ice: unknown[]) => {
      const pc = rtc.factory(ice);
      pcs.push(pc as FakePc);
      return pc;
    };
    const a = await makeDevice(owner, pid, "a", { rtcFactory: watched });
    const b = await makeDevice(bob, pid, "b", { rtcFactory: watched });
    a.mgr.start();
    b.mgr.start();
    await waitFor(() => Object.values(a.mgr.routes())[0]?.route === "direct" && Object.values(b.mgr.routes())[0]?.route === "direct", 10_000);
    const id = await a.model.createTextNow("handback.tex", "");
    await waitFor(() => b.model.files.has(id));
    await b.mesh.openDoc(`f:${id}`);
    const tb = await b.model.openText(id);
    rtc.stallNext = 1_000_000; // no new direct path
    const dropped = Date.now();
    for (const pc of pcs.filter((p) => p.connectionState === "connected")) pc.cut(); // the path stops answering on both sides
    (await a.model.openText(id)).insert(0, "after the drop");
    await waitFor(() => tb.toString().includes("after the drop"), 4000);
    expect(Date.now() - dropped).toBeLessThan(2000);
    expect(Object.values(a.mgr.routes())[0]?.route).toBe("relay");
  }, 30_000);

  it("older peers and servers keep WebRTC only: no relay messages without negotiation", async () => {
    const { owner, bob, pid } = await project("relay-e2e-5");
    rtc.stallNext = 0;
    const old = await makeDevice(owner, pid, "a", { applicationRelay: false });
    const cur = await makeDevice(bob, pid, "b");
    old.mgr.start();
    cur.mgr.start();
    await waitFor(() => old.mesh.peers.length === 1 && cur.mesh.peers.length === 1);
    expect(Object.values(cur.mgr.routes())[0]?.route).toBe("direct");
    // A server without the relay role: capable clients behave like today.
    const plain = await project("relay-e2e-6", ["pat", "quinn"]);
    rtc.stallNext = 1_000_000;
    const x = await makeDevice(plain.owner, plain.pid, "x", {}, () => env.deps);
    const y = await makeDevice(plain.bob, plain.pid, "y", {}, () => env.deps);
    x.mgr.start();
    y.mgr.start();
    await sleep(1500);
    expect(x.mesh.peers.length + y.mesh.peers.length).toBe(0);
    expect(relayFrames()).toBe(0);
    expect(x.mgr.candidates().length + y.mgr.candidates().length).toBeGreaterThan(0);
  }, 30_000);
});
