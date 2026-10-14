import { generateDeviceKeys } from "@hivetex/crypto";
import { ConnectionManager, Mesh, MemoryPersistence, ProjectModel } from "@hivetex/sync";
import { FakeRtcNetwork, inProcessSocket } from "@hivetex/sync/testing";
import { describe, expect, it } from "vitest";
import { schema } from "../src/db/client.js";
import { createApplicationRelayRouter } from "../src/signal/application-relay.js";
import { MemorySignalBackend, createSignalSession } from "../src/signal/hub.js";
import { Client, makeEnv, register } from "./helpers.js";

/**
 * Long application-relay session (RELAY_SOAK_S=300 to run): two current clients, WebRTC unusable, edits from both sides
 * every 500 ms. Every edit must arrive within 10 s and the event loop must stay responsive (no step blocked over 1 s).
 */
const SOAK_S = Number(process.env.RELAY_SOAK_S ?? 0);

describe.skipIf(!SOAK_S)("application relay soak", () => {
  it(`stays responsive and delivers every edit for ${SOAK_S} s`, async () => {
    const env = await makeEnv();
    const backend = new MemorySignalBackend();
    const rtc = new FakeRtcNetwork();
    rtc.stallNext = 1_000_000;
    const deps = {
      ...env.deps,
      applicationRelay: createApplicationRelayRouter({ namespace: "soak", backend, deps: env.deps, admission: { acquire: async () => ({ debit: async () => "ok" as const, close: () => {} }) } }),
    };
    const owner = await register(env, "olga");
    const created = (await owner.post("/projects", { slug: "soak", password: "project-secret-1" })).json.project;
    const pid = created.id as string;
    const bob = await register(env, "bob");
    await bob.post("/projects/join", { slug: created.slug, password: "project-secret-1" });
    const uid = (await env.db.select().from(schema.users)).find((u) => u.username === "bob")?.id;
    await owner.patch(`/projects/${pid}/members/${uid}`, { role: "editor" });
    const tk = (await new Client(env).get("/keys")).json.keys;
    const device = async (client: Client, name: string) => {
      const keys = await generateDeviceKeys();
      const dev = (await client.post("/devices", { ed25519Pub: keys.edPub, x25519Pub: keys.xPub, label: name })).json.deviceId as string;
      const ticket = (await client.post(`/projects/${pid}/ticket`, { deviceId: dev })).json.ticket as string;
      const model = new ProjectModel(new MemoryPersistence(), { flushMs: 5 });
      await model.init();
      const mesh = new Mesh({ projectId: pid, model, keys, trusted: tk, getTicket: () => ticket, now: env.deps.now });
      const events: string[] = [];
      const mgr = new ConnectionManager({
        mesh, projectId: pid, keys, trusted: tk, getTicket: () => ticket, signalUrl: "ws://test/api/signal",
        wsFactory: () => inProcessSocket((sock) => createSignalSession(sock, deps, backend)),
        rtcFactory: rtc.factory, getIceServers: async () => [], now: env.deps.now,
        trace: (e) => { if (/socket\.(silent|closed)|relay\.|probation|degraded/.test(e.ev)) events.push(`${Date.now()} ${e.ev} ${JSON.stringify(e.data ?? {})}`); },
      });
      mgr.start();
      return { model, mesh, mgr, events, dev };
    };
    const a = await device(owner, "a");
    const b = await device(bob, "b");
    try {
      const end0 = Date.now() + 15_000;
      while (Date.now() < end0 && !(a.mesh.peers.length && b.mesh.peers.length)) await new Promise((r) => setTimeout(r, 50));
      expect(Object.values(a.mgr.routes())[0]?.route).toBe("relay");
      const id = await a.model.createTextNow("soak.tex", "");
      while (!b.model.files.has(id)) await new Promise((r) => setTimeout(r, 20));
      await b.mesh.openDoc(`f:${id}`);
      const [ta, tb] = [await a.model.openText(id), await b.model.openText(id)];
      // the event loop: a 100 ms tick that records its worst lateness
      let worstLag = 0;
      let last = Date.now();
      const tick = setInterval(() => { const now = Date.now(); worstLag = Math.max(worstLag, now - last - 100); last = now; }, 100);
      const late: string[] = [];
      const end = Date.now() + SOAK_S * 1000;
      for (let n = 0; Date.now() < end; n++) {
        const [from, to] = n % 2 ? [tb, ta] : [ta, tb];
        const marker = ` m${n}`;
        from.insert(from.length, marker);
        const t = Date.now();
        while (!to.toString().includes(marker) && Date.now() - t < 10_000) await new Promise((r) => setTimeout(r, 20));
        if (!to.toString().includes(marker)) late.push(`${n} after ${Math.round((Date.now() - t) / 1000)} s; routes ${JSON.stringify(a.mgr.routes())}`);
        await new Promise((r) => setTimeout(r, Math.max(0, 500 - (Date.now() - t))));
      }
      clearInterval(tick);
      console.log(`soak: worst event-loop lag ${worstLag} ms; late ${late.length}; a events:\n${a.events.slice(-15).join("\n")}\nb events:\n${b.events.slice(-15).join("\n")}`);
      expect(late).toEqual([]);
      expect(worstLag).toBeLessThan(1000);
    } finally {
      a.mgr.stop();
      b.mgr.stop();
      a.mesh.destroy();
      b.mesh.destroy();
    }
  }, (SOAK_S + 120) * 1000);
});
