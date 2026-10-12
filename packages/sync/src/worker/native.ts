import type { StoredDeviceKeys } from "@hivetex/crypto";
import type { TicketClaims, TrustedKey } from "@hivetex/protocol";
import { NativeIngressJournal } from "../ingress.js";
import { NativePersistence, storeScope, type StoreInvoke } from "../native-persistence.js";
import { ProjectRuntime, type TicketAnswer } from "../runtime.js";
import { tauriRtcFactory, type BridgeEvent } from "../tauri-rtc.js";
import type { RpcEndpoint } from "../worker-ipc.js";
import type { ProjectOpen, WorkerProject } from "./projects.js";
import type { SharedPushChannels } from '../shared-push.js';

const bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/** The production worker adapters. Secrets are read from the OS keychain; never synthesized on failure. */
export function nativeProjects(
  rpc: RpcEndpoint,
  push?: SharedPushChannels,
  transfers?: { scheduler: import('../transfer-budget.js').TransferScheduler; foreground: (p: ProjectOpen) => boolean },
) {
  return async (p: ProjectOpen): Promise<WorkerProject> => {
    if (!p.account || !p.project || !p.scope) throw new Error("invalid project identity");
    const url = new URL(p.server);
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))
    )
      throw new Error("invalid server");
    const expected = p.isLocal
      ? "local-" + p.project.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)
      : await storeScope(url.origin, p.account, p.project);
    if (expected !== p.scope) throw new Error("wrong store scope");
    const native: StoreInvoke = (cmd, args = {}) =>
      rpc.request("native.call", { cmd, args, project: p.project });
    const deviceKey = 'device:' + await storeScope(url.origin, p.account, 'identity');
    let raw = await native<string | null>("secret_get", { key: deviceKey }).catch(() => {
      throw Object.assign(new Error('Device credentials required or OS keychain locked'), { code: 'auth_required' });
    });
    if (!raw)
      throw Object.assign(new Error("Device credentials required"), { code: "auth_required" });
    const saved = JSON.parse(raw) as {
      edSeed: string;
      xSeed: string;
      edPub: string;
      xPub: string;
      deviceId: string | null;
    };
    const keys: StoredDeviceKeys = {
      kind: "noble",
      edSeed: bytes(saved.edSeed),
      xSeed: bytes(saved.xSeed),
      edPub: saved.edPub,
      xPub: saved.xPub,
    };
    let token = p.isLocal
      ? null
      : await native<string | null>("secret_get", { key: "session-token" });
    if (!p.isLocal && !token)
      throw Object.assign(new Error("Sign in to resume synchronization"), {
        code: "auth_required",
      });
    let storeId = 0;
    let closed = false;
    const network = new AbortController();
    const store = await NativePersistence.open(async (cmd, args) => {
      const answer = await native<any>(cmd, args);
      if (cmd === "store_open") storeId = answer;
      return answer;
    }, p.scope);
    const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      if (p.isLocal || closed) throw new Error("networking stopped");
      const response = await fetch(url.origin + "/api" + path, {
        method,
        signal: network.signal,
        headers: {
          "X-Requested-With": "hivetex",
          Authorization: "Bearer " + token,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = (await response.json()) as { error?: { message?: string } };
      if (closed) throw new Error('networking stopped');
      if (!response.ok)
        throw Object.assign(new Error(result.error?.message ?? "Request failed"), {
          status: response.status,
        });
      return result as T;
    };
    const trusted = ((await store.getMeta("worker.trusted")) as TrustedKey[] | undefined) ?? [];
    const runtime: ProjectRuntime = new ProjectRuntime({
      projectId: p.project,
      zeroIdle: true,
      isLocal: p.isLocal,
      role: p.role,
      createdHere: p.createdHere,
      store,
      keys,
      deviceId: saved.deviceId,
      trusted,
      canWrite: () => runtime.role !== "viewer" && !runtime.revoked,
      ...(transfers ? { transfers: { scheduler: transfers.scheduler, foreground: () => transfers.foreground(p) } } : {}),
      adapters: {
        ...(push ? { pushChannel: push.channel } : {}),
        registerDevice: async () => {
          const r = await request<{ deviceId: string }>("POST", "/devices", {
            ed25519Pub: keys.edPub,
            x25519Pub: keys.xPub,
            label: "HiveTeX desktop",
          });
          saved.deviceId = r.deviceId;
          if (closed) throw new Error('networking stopped');
          await native("secret_set", { key: deviceKey, value: JSON.stringify(saved) });
          return r.deviceId;
        },
        loadTrusted: async () => (await request<{ keys: TrustedKey[] }>("GET", "/keys")).keys,
        saveTrusted: (keys) => {
          void store.setMeta("worker.trusted", keys);
        },
        fetchTicket: (dev) =>
          request<TicketAnswer>("POST", "/projects/" + p.project + "/ticket", { deviceId: dev }),
        ring: (dev) => request("POST", "/projects/" + p.project + "/ring", { deviceId: dev }),
        iceServers: () => request("POST", "/turn", { projectId: p.project }),
        signalUrl: url.origin.replace(/^http/, "ws") + "/api/signal",
        wsFactory: (u) => new WebSocket(u) as any,
        rtcFactory: () =>
          tauriRtcFactory(native, async (event, cb) =>
            rpc.on("rtc", (wire) => {
              const e = (
                wire as { payload: { project: string; name: string; payload: BridgeEvent } }
              ).payload;
              if (e.project === p.project && e.name === event) cb(e.payload);
            }),
          ),
      },
    });
    try {
      await runtime.open();
    } catch (e) {
      store.close();
      throw e;
    }
    return {
      runtime,
      store,
      journal: new NativeIngressJournal(native, storeId),
      registerAttachment: (attachment) =>
        native("attachment_register", { id: storeId, attachment }),
      unregisterAttachment: (attachment) =>
        native("attachment_unregister", { id: storeId, attachment }),
      close: async () => {
        closed = true; network.abort(); token = null; raw = null;
        saved.edSeed = ''; saved.xSeed = '';
        await runtime.close();
        await runtime.changelog.flush();
        await runtime.model.destroy();
        await native("store_close", { id: storeId });
        if (keys.kind === "noble") {
          keys.edSeed.fill(0);
          keys.xSeed.fill(0);
        }
      },
    };
  };
}
