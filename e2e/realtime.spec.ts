import { type Page, expect, test } from "@playwright/test";
import { addFile, createProject, joinProject, newUser, uniq } from "./helpers.js";

/**
 * Real-time collaboration at group scale over real WebRTC (spec peer-sync › Real-time propagation at group scale):
 * seven browser users in one project. Latency is measured from the writer's edit to the moment the text appears in
 * each other user's editor DOM (all pages share the machine clock).
 */

type P2P = {
  session: {
    model: {
      find(p: string): { id: string } | undefined;
      openText(
        id: string,
      ): Promise<{ insert(i: number, s: string): void; length: number; toString(): string }>;
      createBinary(path: string, hash: string, size: number): unknown;
    };
    blobs: { add(bytes: Uint8Array): Promise<string>; has(hash: string): Promise<boolean> };
    peers: Array<{ route: string; limited?: unknown }>;
  };
};

const pct = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[
    Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))
  ] as number;
// The healthy profile fits the shipped 1,200 envelopes/10 s socket guard, including ACKs and six recipients.
// REALTIME_ASSET_BYTES=2097152 exercises the quota-limited burst separately; it is not the latency acceptance profile.
const ASSET_BYTES = Number(process.env.REALTIME_ASSET_BYTES ?? 256 * 1024);

/** Records when each `#k#` marker first appears in this page's editor. */
async function watchMarkers(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __seen: Record<string, number> };
    w.__seen = {};
    const el = document.querySelector(".cm-content") as HTMLElement;
    const scan = () => {
      for (const m of el.textContent?.match(/#\d+#/g) ?? [])
        if (!(m in w.__seen)) w.__seen[m] = performance.timeOrigin + performance.now();
    };
    new MutationObserver(scan).observe(el, { childList: true, subtree: true, characterData: true });
    scan();
  });
}

const docText = (page: Page) =>
  page.evaluate(async () => {
    const s = (window as unknown as { __p2p: P2P }).__p2p.session;
    return (await s.model.openText(s.model.find("main.tex")!.id)).toString();
  });

for (const route of ["direct", "relay"] as const) {
  test(`seven users over ${route}: typing during background hydration stays responsive and converges`, async ({
    browser,
  }, testInfo) => {
    test.skip(
      route === "relay" && process.env.APPLICATION_RELAY !== "1",
      "needs APPLICATION_RELAY=1 and sufficient relay budget",
    );
    test.setTimeout(300_000);
    const N = 7;
    let slug = uniq("rt-");
    const ctxs = await Promise.all(Array.from({ length: N }, () => browser.newContext()));
    for (const ctx of ctxs)
      await ctx.addInitScript((relayOnly) => {
        const Original = window.RTCPeerConnection;
        const pcs: RTCPeerConnection[] = [];
        (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = pcs;
        window.RTCPeerConnection = class extends Original {
          constructor(cfg?: RTCConfiguration) {
            super(relayOnly ? { ...cfg, iceServers: [], iceTransportPolicy: "relay" } : cfg);
            pcs.push(this);
          }
        } as typeof RTCPeerConnection;
      }, route === "relay");
    try {
      const users = [];
      for (let i = 0; i < N; i++) users.push(await newUser(ctxs[i]!, `rt${i}`));
      const [owner, ...others] = users as [(typeof users)[number], ...typeof users];

      slug = await createProject(owner.page, slug);
      await owner.page.getByTestId("settings-btn").click();
      await owner.page.getByLabel("Default role").selectOption("editor");
      await owner.page.getByRole("button", { name: "Save", exact: true }).first().click();
      await expect(
        owner.page.getByTestId("settings-dialog").getByText("Saved", { exact: true }),
      ).toBeVisible();
      await owner.page.getByRole("button", { name: "Close" }).click();
      await addFile(owner.page, "main.tex");
      for (const u of others) {
        await u.page.goto("/#/");
        await joinProject(u.page, slug);
      }
      for (const u of users) {
        await expect(u.page.getByTestId("peer-count")).toContainText(`${N - 1} co-authors`, {
          timeout: 120_000,
        });
        await u.page.getByRole("treeitem", { name: "main.tex" }).click();
        await expect(u.page.locator(".cm-content")).toBeVisible();
      }

      // ---- latency: one writer, everyone else measures arrival in their editor ----
      const writer = others[0]!;
      const receivers = users.filter((u) => u !== writer);
      for (const r of receivers) await watchMarkers(r.page);
      const sent: Record<string, number> = {};
      const assets: string[] = [];
      let hydrationOverlaps = 0;
      for (let k = 0; k < 30; k++) {
        // These files are never opened in an editor. The sync tracker hydrates them while text keeps flowing.
        // A fresh incompressible asset every five keystrokes keeps exercising the shared transport queues.
        if (k % 5 === 0) {
          const hash = await owner.page.evaluate(
            async ({ batch, size }) => {
              const s = (window as unknown as { __p2p: P2P }).__p2p.session;
              const bytes = new Uint8Array(size);
              for (let offset = 0; offset < bytes.length; offset += 65_536)
                crypto.getRandomValues(bytes.subarray(offset, offset + 65_536));
              const hash = await s.blobs.add(bytes);
              s.model.createBinary(`background-${batch}.png`, hash, bytes.length);
              return hash;
            },
            { batch: k / 5, size: ASSET_BYTES },
          );
          assets.push(hash);
          hydrationOverlaps += await writer.page.evaluate(
            async (h) =>
              Number(!(await (window as unknown as { __p2p: P2P }).__p2p.session.blobs.has(h))),
            hash,
          );
        }
        const marker = `#${k}#`;
        sent[marker] = await writer.page.evaluate(async (m) => {
          const s = (window as unknown as { __p2p: P2P }).__p2p.session;
          const t = await s.model.openText(s.model.find("main.tex")!.id);
          const at = performance.timeOrigin + performance.now();
          t.insert(t.length, m);
          return at;
        }, marker);
        await writer.page.waitForTimeout(100); // typing rhythm
      }
      await expect
        .poll(
          async () =>
            (
              await Promise.all(
                receivers.map((r) =>
                  r.page.evaluate(
                    () => Object.keys((window as unknown as { __seen: object }).__seen).length,
                  ),
                ),
              )
            ).every((n) => n === 30),
          { timeout: 30_000 },
        )
        .toBe(true);
      const lat: number[] = [];
      for (const r of receivers) {
        const seen = await r.page.evaluate(
          () => (window as unknown as { __seen: Record<string, number> }).__seen,
        );
        for (const [m, t] of Object.entries(sent)) lat.push((seen[m] as number) - t);
      }
      const p50 = pct(lat, 50);
      const p95 = pct(lat, 95);
      console.log(
        `[realtime] ${N} users over ${route} with background hydration: keystroke-to-screen p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${Math.max(...lat).toFixed(1)}ms (${lat.length} samples)`,
      );
      await testInfo.attach(`latency-${route}.json`, {
        body: JSON.stringify({
          route,
          profile: ASSET_BYTES <= 256 * 1024 ? "healthy-network" : "burst",
          peers: N,
          assetBytes: assets.length * ASSET_BYTES,
          hydrationOverlaps,
          p50,
          p95,
          samples: lat,
        }),
        contentType: "application/json",
      });
      expect(hydrationOverlaps).toBeGreaterThan(0);
      expect(p95).toBeLessThan(250);
      for (const u of users) {
        await expect
          .poll(
            () =>
              u.page.evaluate(async (hashes) => {
                const s = (window as unknown as { __p2p: P2P }).__p2p.session;
                return (await Promise.all(hashes.map((h) => s.blobs.has(h)))).every(Boolean);
              }, assets),
            { timeout: 120_000 },
          )
          .toBe(true);
        const routes = await u.page.evaluate(() =>
          (window as unknown as { __p2p: P2P }).__p2p.session.peers.map((p) => p.route),
        );
        expect(routes).toHaveLength(N - 1);
        expect(new Set(routes)).toEqual(new Set([route]));
        if (route === "relay")
          expect(
            await u.page.evaluate(
              () =>
                (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.filter(
                  (pc) => pc.connectionState === "connected",
                ).length,
            ),
          ).toBe(0);
      }

      // ---- everyone types at once ----
      const t0 = Date.now();
      await Promise.all(
        users.map((u, i) =>
          u.page.evaluate(async (who) => {
            const s = (window as unknown as { __p2p: P2P }).__p2p.session;
            const t = await s.model.openText(s.model.find("main.tex")!.id);
            for (let k = 0; k < 10; k++) {
              t.insert(k % 2 ? t.length : 0, `<${who}.${k}>`);
              await new Promise((r) => setTimeout(r, 20));
            }
          }, i),
        ),
      );
      await expect
        .poll(async () => new Set(await Promise.all(users.map((u) => docText(u.page)))).size, {
          timeout: 30_000,
        })
        .toBe(1);
      console.log(`[realtime] ${N} users x 10 concurrent edits converged in ${Date.now() - t0}ms`);
      const final = await docText(owner.page);
      for (let i = 0; i < N; i++)
        for (let k = 0; k < 10; k++) expect(final).toContain(`<${i}.${k}>`);
    } finally {
      const diagnostics = await Promise.all(
        ctxs.map(async (ctx) => {
          const page = ctx.pages()[0];
          return page
            ?.evaluate(() => {
              const s = (window as unknown as { __p2p?: P2P }).__p2p?.session;
              return s
                ? { peers: s.peers, sync: (s as unknown as { syncStatus: unknown }).syncStatus }
                : null;
            })
            .catch(() => null);
        }),
      );
      await testInfo.attach(`sync-${route}.json`, {
        body: JSON.stringify(diagnostics),
        contentType: "application/json",
      });
      await Promise.all(ctxs.map((c) => c.close()));
    }
  });
}
