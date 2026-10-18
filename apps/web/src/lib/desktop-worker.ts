import { WorkerRenderer, encodeValue, decodeValue, storeScope } from "@hivetex/sync";
import type { ProjectInfo } from "./session.svelte.js";
import { sessionOrigin } from "./api.js";

export async function openDesktopWorker(
  project: ProjectInfo,
  account: string,
  createdHere: boolean,
) {
  const [{ invoke }, { listen }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/event"),
  ]);
  const listeners = new Map<string, Set<(data: any) => void>>();
  // The worker generation this editor is attached to; a `ready` from a later one means the worker restarted.
  let generation = 0;
  let restarted: ((gen: number) => void) | null = null;
  const off = await listen<{ event: string; data: unknown; gen?: number }>("worker://event", (event) => {
    const frame = event.payload;
    if (frame.event === "ready" && typeof frame.gen === "number") restarted?.(frame.gen);
    if (typeof frame.data === "string")
      for (const cb of listeners.get(frame.event) ?? []) cb(decodeValue(frame.data));
  });
  const renderer = new WorkerRenderer({
    request: async <T>(method: string, params: unknown) => {
      try {
        return decodeValue(
          await invoke<string>("worker_request", { method, params: encodeValue(params) }),
        ) as T;
      } catch (e) {
        throw e instanceof Error ? e : new Error(String(e));
      }
    },
    on: (event, cb) => {
      const set = listeners.get(event) ?? new Set();
      set.add(cb);
      listeners.set(event, set);
      return () => {
        set.delete(cb);
      };
    },
  });
  const server = sessionOrigin();
  const isLocal = project.id.startsWith("local-");
  const scope = isLocal
    ? "local-" + project.id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)
    : await storeScope(server, account, project.id);
  try {
    await renderer.open({
      server,
      account,
      project: project.id,
      scope,
      isLocal,
      role: project.role,
      createdHere,
    });
    generation = (await invoke<{ generation: number }>("worker_diagnostics")).generation;
  } catch (e) {
    off();
    throw e;
  }
  // Reattach after a restart; a failure (the new worker still starting) is retried with a growing delay.
  restarted = (gen) => {
    if (gen <= generation) return;
    generation = gen;
    const attempt = (n: number) =>
      void renderer.reattach().catch(() => {
        if (n < 6 && generation === gen) setTimeout(() => attempt(n + 1), 500 * 2 ** n);
      });
    attempt(0);
  };
  return {
    renderer,
    close: async () => {
      restarted = null;
      await renderer.close();
      off();
    },
  };
}
