# Release 0.10.0 preflight

The 2026-10-24 release preflight found two high-severity transitive dependency advisories in the required `pnpm audit --audit-level=high` gate:

- [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c): jsdom's Undici was updated from 8.11.2 to 8.12.3 in the lockfile. Its Node requirement remains `>=22.19.0`, compatible with the local/pinned 22.22.0 authoring lanes and the Node 22 CI/build lanes.
- [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5): Vercel CLI config pins Zod 4.1.11, including in its current 0.3.3 release. A narrowly scoped `@vercel/cli-config>zod` override selects patched Zod 4.6.7 within the same major version. The published Zod package declares no Node engine restriction.

The exact audit command passes after these changes, with four moderate advisories below the configured threshold. No audit gate or severity threshold was relaxed.

Release source checks passed locally: all 27 Turbo build/lint/test tasks (7m25s), deployment/advisory policy tests (17/17), and history plus staged-diff Gitleaks scans. After installing the final lockfile with `pnpm install --frozen-lockfile`, the affected frontend suites passed 30/30, the production Vercel functions import passed, and the exact audit gate passed again. Svelte checking reports zero errors and 12 existing warnings; initial JavaScript is 191.0 KiB gzip against the 250 KiB budget. The staged diff passes whitespace checks.

## First hosted run and startup correction

Commit `0190d1c`'s [CI run](https://github.com/federicocunico/HiveTeX/actions/runs/40090414205) passed all 27 build/lint/unit tasks, frontend types/budget and audit. Its four required browser lanes timed out at 300 seconds while waiting for Vite; no test started. The advisory browser lane reported the same startup failure.

A detached checkout with no generated distribution and a separate empty TEMP cache prepared all resources directly in **42.5 seconds**, producing the same `tl2019-5eed4a4ac9c250ecc67f2f74` identity. This does not establish a mirror outage or download latency as the cause. The observed failure is in implicit Vite startup; its precise internal cause remains unproven.

CI now runs explicit distribution preparation before builds/browser startup, with a separate ten-minute acquisition budget. Its cache contains only original archives and formats, keyed by the lockfile; the normal generator checks their SHA-256 before reuse. Generated output is not cached. Preparation and Vite use the same checkout, default Node temporary directory and distribution identity. The web-server timeout and required test retry settings are unchanged.

After direct preparation and a frozen install in the detached checkout, `CI=true` editor geometry acceptance passed **3/3** in 23.4 seconds. Debug startup records show Vite ready in 2.284 seconds and its HTTP readiness check succeeding in under three seconds.

## Hosted WebView2 debugging correction

The first [Desktop run](https://github.com/federicocunico/HiveTeX/actions/runs/40090414130) passed Rust, lifecycle, native/helper/package recovery and real browser WASM checks. Native authoring then failed waiting for its CDP endpoint, while native telemetry showed one visible main window and one tray. All lifecycle CDP shutdowns had also fallen back to forced termination; their process/window assertions passed, but this is not graceful-shutdown evidence.

Native authoring now uses a uniquely named copy of the isolated test executable and a fresh temporary WebView profile. On GitHub runners it also sets the supported per-executable WebView2 debug policy, following the existing Sandbox harness. The UUID-named registry value is deleted in `finally`, and no policy targets the product executable. Standard-user local runs retain the environment mechanism, since policy writes require administrator access. The endpoint timeout remains 30 seconds. Launch diagnostics record selected flags, policy use, child command lines and cleanup result. Lifecycle JSON now records each `quit`/`killed` outcome explicitly.

The focused local `CI=true` native authoring journey passed in **35.0 seconds**, including actual automatic native compilation, long-CRLF geometry and graceful `quit`, using the existing isolated 0.9.1 acceptance binary. This validates the harness and environment path locally; the hosted policy path must be validated by the next Desktop run. The exact reason that the first hosted runtime did not expose its environment-requested endpoint remains unproven.
