# Writing tests that pass on CI as well as locally

CI runs `pnpm turbo build lint test`: every package's tests at the same time, on a 2-4 vCPU runner. Real-time work
there (crypto, meshes, worker processes, compression) takes several times longer than on a developer machine.
In October 2026 an audit of repeated CI failures found that almost all of them came from a handful of patterns.
None of them was an application bug.

## What failed, and the rule that prevents it

| Cause | Example | Rule |
| --- | --- | --- |
| Fixed wait, then a positive assertion | `await tick(100); expect(seen).toEqual([0, 1, 2])` after a compressed send | Wait for the condition, not for a time: `await expect.poll(() => seen).toEqual(…)` (or the file's `until`/`waitFor` helper). Keep fixed waits only to check that something does **not** happen. |
| Asynchronous work behind an event | doorbell rings are verified (JWS) asynchronously, so the test asserted before verification ended | Give the component a way to say it is done (`Doorbell.settled()`, `SeedCatalog.settled()`) and await it. |
| Too short per-test limits | the vitest default of 5 s for tests that start real worker processes or stage tens of MB | `vitest.config.ts` (sync, compile) and `apps/web/vite.config.ts` use 30 s and two workers per package under `CI`; the server already used 60 s for PGlite. A real hang still fails. |
| Two writers on one store | a "reopen" helper started a second `ProjectModel` mid-test, whose delayed persistence rewrote old text | Read stored state passively (`stored()` reads `store.load`), or close the second model first. One writer per store, as in the product. |
| A transient state reported as a failure | the catalog showed "wake-up service unreachable" while the push stream was still connecting | Distinct states for "not yet" and "failed"; the test polls for the settled state. |
| Missing CI setup that a developer machine has | desktop e2e had no bundled Node resources (`prepare-worker.mjs`), and no Playwright browser for the desktop/browser tests; the router-matrix job had no pnpm for `setup-node` | Test harnesses prepare what they need themselves (`apps/desktop/e2e/run.mjs` runs `prepare-worker.mjs`), and every workflow job installs its tools explicitly. |
| Latency thresholds tighter than the contract | in-process p95 < 50 ms in `scale.test.ts` | Assert the specified contract (≤ 250 ms on a healthy network), not a lucky local number. |
| Fixtures sharing ids across instances | two `FakeRtcNetwork`s numbered their connections `pc1, pc2, …` independently | Ids in fakes are process-wide. |
| False positives in secret scanning | upstream CI config in vendored sources, a fake ticket in a redaction test | Allowlist paths/patterns in `.gitleaks.toml` with a reason. Removing a file later does not help, because the scan covers history. |

## Checking before you push

- `node scripts/audit-tests.mjs` lists fixed-wait-then-positive-assertion sites. Each remaining one is deliberate,
  for example an exact count that must stay put (a poll would pass early) or a call with side effects (a poll would
  repeat it).
- To reproduce CI contention locally, set `CI=1` (two workers per package) and run `pnpm turbo test --force` while
  other busy processes occupy most cores. Run it several times: one green run proves little about a timing bug.
