import { TestAuthority, identity, waitFor } from "@hivetex/sync/testkit";
import { afterEach, describe, expect, it } from "vitest";
import {
  createApplicationRelayRouter,
  relayChannel,
  type RelayAdmission,
  type RelayDebit,
} from "../src/signal/application-relay.js";
import { MemorySignalBackend } from "../src/signal/hub.js";
import { verifyTicket } from "@hivetex/crypto";
import type { Config } from "../src/config.js";

const closes: Array<() => void> = [];
afterEach(() => {
  for (const close of closes.splice(0)) close();
});
async function fixture() {
  const auth = await TestAuthority.create();
  const backend = new MemorySignalBackend({ recordMessages: true });
  let allowed: RelayDebit = "ok",
    charged = 0;
  const admission: RelayAdmission = {
    acquire: async () => ({
      debit: async (bytes) => {
        charged += bytes;
        return allowed;
      },
      close: () => {},
    }),
  };
  const deps = { now: () => new Date(), config: { ticketPublicJwks: auth.trusted } as Config };
  const router = createApplicationRelayRouter({ namespace: "test", backend, admission, deps });
  const node = async (name: string, project = "project") => {
    const id = await identity(name, "editor");
    const ticket = await auth.mint({ ...id, pid: project });
    const claims = await verifyTicket(ticket, auth.trusted);
    const sid = "r1_" + name.padEnd(16, "_").slice(0, 16);
    await backend.setPresence(project, id.dev, sid + "|" + ticket, 90);
    const inbox: Array<Record<string, unknown>> = [];
    let active = true;
    const session = await router.attach({
      claims,
      sid,
      active: () => active,
      send: (m) => {
        inbox.push(m as Record<string, unknown>);
      },
    });
    closes.push(() => {
      active = false;
      session.close();
    });
    return {
      ...id,
      ticket,
      claims,
      sid,
      inbox,
      session,
      stop: () => {
        active = false;
        session.close();
      },
    };
  };
  return {
    backend,
    node,
    setAllowed: (v: RelayDebit) => {
      allowed = v;
    },
    charged: () => charged,
  };
}

describe("recipient-scoped application relay", () => {
  it("keeps the subscription usable after bounded receive overflow so endpoints can retry", async () => {
    const f = await fixture(),
      a = await f.node("alice"),
      b = await f.node("bob");
    let release!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const getPresence = f.backend.getPresence.bind(f.backend);
    f.backend.getPresence = async (...args) => {
      await blocked;
      return getPresence(...args);
    };
    const channel = relayChannel("test", "project", b.dev, b.sid);
    const message = {
      t: "app-relay",
      to: b.dev,
      sid: b.sid,
      from: a.dev,
      fromSid: a.sid,
      env: "YWJj",
    };
    for (let n = 0; n < 300; n++) await f.backend.publish(channel, JSON.stringify(message));
    await waitFor(() => b.inbox.some((m) => m.code === "relay_inbound_dropped"));
    // 44 overflowing publishes, one informational notice without a retry delay (not a forwarding limit)
    expect(b.inbox.filter((m) => m.code === "relay_inbound_dropped")).toEqual([{ t: "relay-error", code: "relay_inbound_dropped" }]);
    expect(b.inbox.some((m) => m.code === "relay_backpressure")).toBe(false);
    release();
    await waitFor(() => b.inbox.filter((m) => m.t === "app-relay").length === 256);
    f.backend.getPresence = getPresence;
    await a.session.forward({ t: "app-relay", to: b.dev, sid: b.sid, env: "cmV0cnk" });
    await waitFor(() => b.inbox.some((m) => m.env === "cmV0cnk"));
  });

  it("forwards only to the current same-project session, with server-derived sender identity", async () => {
    const f = await fixture(),
      a = await f.node("alice"),
      b = await f.node("bob"),
      other = await f.node("other");
    const published: string[] = [];
    const publish = f.backend.publish.bind(f.backend);
    f.backend.publish = async (channel, payload) => {
      published.push(channel);
      await publish(channel, payload);
    };
    await a.session.forward({ t: "app-relay", to: b.dev, sid: b.sid, env: "YWJj" });
    await waitFor(() => b.inbox.length === 1);
    expect(b.inbox[0]).toMatchObject({ from: a.dev, fromSid: a.sid, env: "YWJj" });
    expect(other.inbox).toHaveLength(0);
    expect(published).toEqual([relayChannel("test", "project", b.dev, b.sid)]);
    expect(f.charged()).toBeGreaterThan(4);
  });

  it("rejects unknown, wrong-project and obsolete recipient sessions", async () => {
    const f = await fixture(),
      a = await f.node("alice"),
      b = await f.node("bob", "different");
    await a.session.forward({ t: "app-relay", to: "unknown", sid: b.sid, env: "YWJj" });
    await a.session.forward({ t: "app-relay", to: b.dev, sid: b.sid, env: "YWJj" });
    const c = await f.node("carol");
    await a.session.forward({ t: "app-relay", to: c.dev, sid: "r1_wrong___________", env: "YWJj" });
    expect(f.backend.log).toHaveLength(0);
    expect(f.charged()).toBe(0);
    expect(a.inbox.every((m) => m.t === "relay-error")).toBe(true);
  });

  it("does not forward from a socket replaced by another instance", async () => {
    const f = await fixture(),
      a = await f.node("alice"),
      b = await f.node("bob");
    await f.backend.setPresence("project", a.dev, "r1_new_____________|" + a.ticket, 90);
    await a.session.forward({ t: "app-relay", to: b.dev, sid: b.sid, env: "YWJj" });
    expect(f.backend.log).toHaveLength(0);
    expect(a.inbox[0]).toMatchObject({ code: "relay_session_replaced" });
  });

  it("drops already-published ciphertext after the recipient session is replaced", async () => {
    const f = await fixture(),
      a = await f.node("alice"),
      b = await f.node("bob");
    await f.backend.setPresence("project", b.dev, "r1_new_____________|" + b.ticket, 90);
    await f.backend.publish(
      relayChannel("test", "project", b.dev, b.sid),
      JSON.stringify({
        t: "app-relay",
        to: b.dev,
        sid: b.sid,
        from: a.dev,
        fromSid: a.sid,
        env: "YWJj",
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(b.inbox).toHaveLength(0);
  });

  it("fails closed when credit or accounting is unavailable", async () => {
    const f = await fixture(),
      a = await f.node("alice"),
      b = await f.node("bob");
    f.setAllowed("limited");
    await a.session.forward({ t: "app-relay", to: b.dev, sid: b.sid, env: "YWJj" });
    expect(f.backend.log).toHaveLength(0);
    expect(a.inbox[0]).toMatchObject({ code: "relay_limited" });
    f.setAllowed("unavailable");
    await a.session.forward({ t: "app-relay", to: b.dev, sid: b.sid, env: "YWJj" });
    expect(f.backend.log).toHaveLength(0);
    expect(a.inbox[1]).toMatchObject({
      code: "relay_accounting_unavailable",
      retryAfterMs: 30_000,
    });
    a.stop();
    await a.session.forward({ t: "app-relay", to: b.dev, sid: b.sid, env: "YWJj" });
    expect(f.backend.log).toHaveLength(0);
  });
});
