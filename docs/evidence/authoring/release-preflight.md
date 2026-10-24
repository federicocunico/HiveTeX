# Release 0.10.0 preflight

The 2026-10-24 release preflight found two high-severity transitive dependency advisories in the required `pnpm audit --audit-level=high` gate:

- [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c): jsdom's Undici was updated from 8.11.2 to 8.12.3 in the lockfile. Its Node requirement remains `>=22.19.0`, compatible with the local/pinned 22.22.0 authoring lanes and the Node 22 CI/build lanes.
- [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5): Vercel CLI config pins Zod 4.1.11, including in its current 0.3.3 release. A narrowly scoped `@vercel/cli-config>zod` override selects patched Zod 4.6.7 within the same major version. The published Zod package declares no Node engine restriction.

The exact audit command passes after these changes, with four moderate advisories below the configured threshold. No audit gate or severity threshold was relaxed.

Release source checks passed locally: all 27 Turbo build/lint/test tasks (7m25s), deployment/advisory policy tests (17/17), and history plus staged-diff Gitleaks scans. After installing the final lockfile with `pnpm install --frozen-lockfile`, the affected frontend suites passed 30/30, the production Vercel functions import passed, and the exact audit gate passed again. Svelte checking reports zero errors and 12 existing warnings; initial JavaScript is 191.0 KiB gzip against the 250 KiB budget. The staged diff passes whitespace checks.
