# Tasks

## 1. Project ID allocation and legacy compatibility

- [x] 1.1 Add a server-side prefix validator and 80-bit base32 suffix allocator, separating it from the legacy join validator; verify default prefixes, one-character prefixes, normalization, 31/48-character boundaries, invalid input and suffix-looking caller input with focused unit cases.
- [x] 1.2 Replace plain-slug creation with five bounded allocation attempts and a parameterized single-statement project/owner CTE compatible with Neon HTTP and PGlite; verify atomic success, forced slug conflicts, retry exhaustion, owner-insert failure rollback and unrelated database failure handling in server tests.
- [x] 1.3 Route owner ID changes through the same allocation policy and preserve no-op/unrelated legacy updates; verify new suffixed rename results, old-ID lookup failure after rename, owner authorization, and unchanged internal IDs/memberships.
- [x] 1.4 Update server test helpers and existing account/project/peer fixtures to join using returned slugs, and explicitly seed unsuffixed legacy projects; verify same-prefix concurrent creation, legacy joins/listing, legacy-name reuse, passwords, permissions and tickets in the affected suites.
- [x] 1.5 Exercise atomic creation through the existing Docker Neon-compatible HTTP stack; verify duplicate-prefix creation succeeds distinctly and project/membership writes are atomic on the production driver path, then document the naming API semantics and legacy compatibility in docs/protocol.md and docs/permissions.md.

## 2. Creation, sharing and local project flows

- [x] 2.1 Update Projects normal/template/import setup and folder creation, plus LocalProjectActions publication, to request a readable prefix and consume the returned full share ID; verify every new shared project gets a suffix and local-only UUID projects retain their names and data in browser and desktop tests.
- [x] 2.2 Update ProjectSettings, project-admin state and ShareDialog to use authoritative returned slugs after creation/rename; verify copy/join shows the complete new ID and a rename does not break internal routes, cached contents or refreshed folder markers.
- [x] 2.3 Extend the relevant Playwright, local-publish and folder-binding coverage for same-name creation, template/import creation, local publication and legacy marked folders; verify files/history survive publication and legacy co-authors can still join.
- [x] 2.4 Update README, docs/import.md and docs/folders.md with prefix input, automatic suffixes and copying the full ID; verify documented steps match normal creation, folder creation, import and local publication screens.

## 3. Reliable remembered sessions

- [x] 3.1 Make bearer persistence awaitable with serialized native credential writes and explicit save/read/delete results; verify delayed writes, save failure, retry and login-followed-by-logout races with mocked credential-store integration tests.
- [x] 3.2 Scope session credentials and cached users to canonical server origins, including the desktop development proxy target; verify switching A to B never sends A's token or restores A's cached account on B, and returning to A restores its own valid session.
- [x] 3.3 Integrate persistence results into login/register and startup UX without discarding successful current-run authentication; verify a successful save restores before account routing, locked-store reads allow retry/local mode, and save failure visibly explains that login was not remembered.
- [x] 3.4 Implement durable sign-out suppression and authoritative expired/revoked-session cleanup while preserving credentials during network failure; verify sign-out/restart even after deletion failure, remote revocation, offline cached access and local-mode no-network behavior.
- [x] 3.5 Implement legacy credential/cache attribution and migration rules without sending unknown tokens to selected servers; verify attributable migration, one-time sign-in for unattributed state, stable native service/device keys and retained scoped credentials after upgrades.
- [x] 3.6 Add a real desktop close/relaunch sign-in regression using the existing desktop WebDriver/keychain harness, plus a persistent-browser-cookie reopen regression; verify restore and sign-out on supported desktop platforms and report unavailable native keychains explicitly rather than counting skipped persistence as passed.
- [x] 3.7 Update docs/accounts.md and README to explain remembered login, the existing inactivity lifetime, recoverable credential-store errors and one-time legacy reauthentication; verify the guidance matches the delivered UI and no documentation suggests saving passwords.

## 4. HiveTeX icon

- [x] 4.1 Create the canonical connected honeycomb H SVG from design.md and its simplified small-size rendition; deliver actual-size previews at 16/24/32/128 pixels on light/dark backgrounds and visually verify silhouette, contrast and legibility.
- [x] 4.2 Derive Logo.svelte, favicon.svg, desktop app-icon.png and platform icon assets from the canonical geometry using the installed Tauri icon tool; verify logo consumers show the same mark and ICO/ICNS/PNG assets contain the new artwork.
- [x] 4.3 Update Tauri bundle icon configuration; verify generated platform assets and accessible icon-only web navigation, and record the source and regeneration command in developer documentation. Clean installed-app icon inspection is recorded below as an approved release follow-up.

## 5. Stable-release Vercel production delivery

- [x] 5.1 Extract a reusable production deployment workflow with explicit source SHA/trigger/release inputs and existing Vercel settings; verify syntax and permissions with actionlint or equivalent, and verify callers do not hold the shared deploy-production concurrency lock.
- [x] 5.2 Add trusted release-source resolution and exact-SHA successful-CI gating, including bounded waiting; verify annotated/lightweight tags, changed tags, missing/failed CI, prerelease flags/suffixes, and a branch advancing after tagging using fixture-driven source-selection tests.
- [x] 5.3 Add a post-publication reusable-workflow call to Release, manual publication handling and a release-tag recovery input while retaining master/manual entry points; verify fixtures for successful automated publication, installer retry without publication, publication failure, manual release, draft and prerelease, with no reliance on a token-generated release event.
- [x] 5.4 Add deployment source metadata and stale/duplicate guards within the shared concurrency slot, including a second eligibility check before promotion; verify identical deployments, deployed newer descendants, older stable versions, divergent/unknown provenance and delayed master/release runs with mocked GitHub/Vercel responses.
- [x] 5.5 Stage the production-environment build without domain assignment, capture its unique deployment URL, verify READY/health, then promote and verify production alias identity and health; verify build/migration/upload failures, bounded retries and the old-healthy-endpoint case with a controlled nonproduction harness.
- [x] 5.6 Emit source/tag/URL and terminal success/failure/skip summaries with recoverable manual instructions; verify a failed deploy leaves installers published and a retry can target the same tag/SHA without rebuilding them.
- [x] 5.7 Update README and docs/deployment.md with both master and release triggers, required settings, stale-release behavior, provenance bootstrap and retry commands; verify examples against workflow inputs and preserve Vercel Git-deploy disablement.

## 6. Cross-area validation

- [x] 6.1 Run the existing full project checks and affected Rust/desktop integration checks after the changes, without modifying Turborepo commands; verify builds, lint/type checks, tests, bundle constraints and cross-area create/share/reopen behavior pass, recording environment limitations explicitly.
- [x] 6.3 If implementation is pushed, identify triggered workflows and monitor CI/desktop/deployment runs to terminal states, fetch failing logs and fix regressions before reporting completion; report the final observed workflow outcomes.

## Approved release follow-up

The user approved the following deferrals on 2026-10-13. They are unverified release checks, not completed implementation verification:

- Inspect clean-install/window/taskbar or dock/installer icons on Windows, macOS and Linux (the deferred installer portion of original task 4.3); record each observed platform and do not count unavailable hosts as passed.
- Verify a clean upgrade from an older installed version preserves valid scoped sessions, existing unsuffixed projects, folder locations and content while showing the new icon and assigning suffixes to newly created/published projects (original task 6.2); record results with the release review.

## Workflow follow-up

- On the next authorized stable release, verify its published tag/SHA and the production deployment outcome or explicit already-newer skip; do not create a release solely to finish planning.
- Archive this change with the archive workflow after implementation and review are complete.
