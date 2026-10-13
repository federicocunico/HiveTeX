# Design

## Context

See proposal.md for motivation and the four delta specs for behavior.

- The current logo, favicon and native icon source depict a single hexagon with a backslash. Logo.svelte is reused by the public, account and app headers, while the favicon and native SVG duplicate the artwork. Tauri's bundle lists ICO and PNG despite an existing ICNS asset.
- main.ts already awaits initBearer before mounting the app. api.ts reads one unscoped session-token credential; setBearer starts an unawaited write/delete and swallows failures. auth.svelte.ts caches one unscoped user. This identifies failure paths, not a reproduced root cause for every reported repeated login. The native keyring already selects Windows Credential Manager, macOS Keychain or Linux Secret Service. The server already implements persistent web cookies and 30-day session inactivity with revocation.
- projects.id is a random immutable database identity; projects.slug is the globally unique human share ID. Create and rename currently accept a caller-selected plain slug. Local-only projects use local-UUID identities. Shared creation occurs in Projects (including folder creation and new import setup) and LocalProjectActions; ImportDialog imports into an already-created session; join, markers, peer tickets and cached data distinguish slug from internal id.
- CI runs on pushes, including tags. Deploy responds to successful master CI and manual dispatch, checks out the run SHA, skips superseded master commits, uploads sources to Vercel and checks only the stable health URL. Release publishes drafts with github.token after Desktop builds; it does not deploy Vercel. Vercel Git deployment is disabled.

## Goals / Non-Goals

**Goals:** reuse current storage and identity primitives; make side effects awaitable and observable; centralize share-ID assignment and production deployment; preserve deployed data and legacy references.

**Non-Goals:** no new auth provider, refresh-token protocol, password vault, display-name database column, internal-ID migration, alias service, or change to release installer gating. Do not change Turborepo tasks or configuration for this work.

## Decisions

### 1. A connected honeycomb H, built as vector artwork

Use a bold H assembled from seven joined hexagonal modules: two vertical groups of three cells and one bridging center cell. Merge touching modules into a clean silhouette. Amber stems represent the hive; the warm ivory center bridge represents co-authors connecting. A diagonal negative-space cut in the bridge evokes a LaTeX backslash at larger sizes. There are no letters, gradients, shadows or tiny node dots inside the mark.

Design on a 1024-square canvas: graphite #16181D tile, 192-unit corner radius, artwork inside a 160-unit inset; amber #EBA724 and ivory #FFF4D6. At 16–24 pixels remove the diagonal cut and inner seams, keeping the same H silhouette. On a light UI use the transparent mark with a darker amber rendition; desktop icons retain the graphite tile. Keep the existing HiveTeX wordmark outside the icon.

Maintain source.svg as the canonical geometric artwork and derive favicon, Logo renditions, app-icon.png and native formats from it. Use the installed Tauri icon tooling and include the appropriate ICNS/ICO/PNG assets in bundle configuration. Visually inspect actual-size previews on light/dark backgrounds during implementation. Clean installer/window/taskbar or dock inspection on Windows, macOS and Linux is an approved release follow-up, with unavailable platforms recorded as unverified.

Alternative: a bitmap mascot would add style but lose small-size legibility and introduce separate artwork maintenance. The vector H extends HiveTeX's existing geometric branding and expresses peer collaboration.

### 2. Awaited, server-scoped session persistence

Refactor bearer updates into asynchronous operations that callers await. Login/register success applies the live token immediately and waits for credential storage before claiming it is remembered. A storage failure returns a distinct persistence result so the UI can show that sign-in succeeded for this run, explain it was not remembered, and retry without resubmitting a password.

Serialize credential mutations so a delayed login write cannot resurrect a session after logout. Use a canonical effective API origin to scope native credentials and cached user identities. Resolve the real proxy target for desktop development rather than using the empty apiBase as a global key. Changing servers changes the in-memory bearer before any request and uses only that origin's saved state. Keep native service app.hivetex.desktop so device keys and existing installation identity remain stable.

Startup awaits the scoped credential read before loadMe. Distinguish absent credentials from locked/unavailable storage. Retry reads without deleting unread tokens; allow local mode or manual sign-in. Only an authoritative unauthorized response clears a saved session; transient network/server failures do not turn into revocation. Preserve the existing local-mode network guard and offline cached-user behavior using origin-scoped cache entries.

On sign-out clear memory immediately, mark that origin's session as signed out in non-secret local state, and await deletion. The sign-out marker prevents restoration if deletion fails; keep it until a subsequent explicit successful login saves a new session. Report deletion errors and offer retry. No token or password goes in that marker, localStorage, logs or ordinary files.

Legacy migration: the present single key has no issuing-origin metadata. Do not test an unattributed token against an arbitrary server. If attribution is established by trustworthy local metadata, migrate it only to that origin; otherwise require a one-time sign-in and retire the unattributed token/cache. Existing correctly scoped credentials survive future upgrades. Explain this one-time compatibility limit in accounts documentation.

Alternative: extending session lifetime or saving passwords would not fix lost credential writes, hidden keychain errors or cross-server leakage. Retain the current session protocol and security lifetime. Browser cookie persistence remains unchanged and gets a reopen regression check.

### 3. Random suffixed share IDs at the server boundary

Keep projects.id, every foreign key, IndexedDB key, membership ticket and local UUID unchanged. Change only the assignment of projects.slug. This intentionally supersedes the existing project-access rules allowing arbitrary custom IDs and rejecting repeated names.

Use ten cryptographically random bytes encoded with the existing lowercase base32 alphabet (a-z, 2-7): a 16-character suffix with 80 bits of entropy. This is random uniqueness, not a deterministic hash of the name. A unique database constraint is the final collision guarantee; randomness minimizes retries.

Creation's existing slug field becomes a prefix input. Trim and lowercase, validate 1–48 ASCII a-z/0-9/hyphen characters, collapse repeated hyphens and trim edge hyphens, reject an empty normalized prefix, and retain at most 31 characters so prefix + hyphen + suffix fits the existing 48-character limit. With the field omitted, use project. The new UI limits prefixes to 31 and explains automatic suffix assignment; older callers with longer valid inputs get a documented truncated prefix. Do not strip a suffix-looking tail supplied by a caller: it is still input and the server always generates its own final suffix.

Attempt up to five candidates. Production uses Drizzle Neon HTTP, while tests use PGlite; do not depend on interactive transaction callbacks. Use one parameterized PostgreSQL statement with data-modifying CTEs: insert the project with ON CONFLICT (slug) DO NOTHING RETURNING, insert the owner membership only from the returned row, and return the created project joined to that membership. One statement makes both writes atomic on both backends. Normalize the execute-result shape at the database boundary and verify through the Neon-compatible Docker path as well as PGlite. A collision retries with fresh randomness; unrelated database errors propagate through normal error handling. Compute the password hash once per request. On exhaustion return a retryable generation error, never overwrite or leave a partially owned project.

Rename uses the same assignment helper with fresh randomness, preserves immutable id and members, and returns the final share ID. Treat absent slug or a submitted value identical to the current slug as a no-op; unrelated settings must not alter legacy IDs. Keep the existing broad validator for joining and legacy lookup, separate from prefix validation. No schema-wide format check or bulk migration can reject legacy rows.

Projects (including folder/import setup) and LocalProjectActions label input Project name (prefix) and show/copy the returned full ID for sharing. Settings and share flows use the authoritative returned slug after rename. Refresh folder markers through the existing project metadata path; never reconstruct a share ID from user input. Existing local-only names stay human-readable until publication, when the server returns a suffixed share ID.

Alternative: making the suffix in the UI can be bypassed by API callers and old clients. Using the name's hash maps identical names to identical IDs. A new display-name column is unnecessary for the requested naming convention.

### 4. One production deployment job, multiple reliable entry points

Extract deployment into a reusable workflow with workflow_call inputs for trigger kind, immutable source SHA, and optional release tag/id. Call it directly from a job that depends on successful publication in Release. Export validated tag/SHA/publication outputs from the publish job; retrying installer builds must not set those outputs as deploy-ready. Add release: published handling for human publication, and a tag input for manual recovery. Preserve master-CI and current manual deploy entry points as wrappers.

The direct reusable call makes automated publication reliable without a new personal token: release events generated with GITHUB_TOKEN do not trigger another run. Job-level reusable calls support explicit inputs and secrets. See [GitHub event triggering](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow) and [reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows).

Validate tags as stable version tags and query the actual published release, rejecting drafts/prereleases, including stable-looking tags marked prerelease. Resolve the full immutable commit by peeling annotated or lightweight tags; do not use release.target_commitish or the default-branch workflow SHA as the deployed source. Verify the tag still resolves to the recorded SHA on every retry. Require a successful trusted push CI run from this repository and CI workflow for the exact SHA; wait at most 15 minutes for an applicable active run and fail clearly if none succeeds. Retain master latest-tip checking for master-triggered deployment only.

Put the shared deploy job in concurrency group deploy-production with cancel-in-progress false. Do not also hold the same group in a caller; that would deadlock a reusable call. After taking the slot and again before promotion, compare candidate SHA/tag with current production deployment metadata and published stable versions. Skip identical verified deployments, ancestors of a newer deployed commit, and older stable versions. Fail with a clear manual recovery path if deployed source is unknown or ancestry is divergent, rather than guessing. Add non-secret hivetex source SHA/tag/trigger metadata to every new deployment; use existing provider commit metadata to bootstrap the first comparison where trustworthy. Existing successful master deploys remain allowed, subject to the same stale-source guard.

Upload checked-out sources as production-environment staged deployments using --prod --skip-domain and bounded retries, retaining the existing Vercel build/migration command. Capture the unique URL from stdout separately from logs, wait for that deployment's READY state, and check its health before promoting it. Then promote, confirm the stable production domain points to that deployment ID through Vercel inspection/API data, and check the stable health endpoint. This prevents an old healthy deployment from satisfying the new release check. Vercel documents [staging and deployment metadata](https://vercel.com/docs/cli/deploy), [inspection and bounded waiting](https://vercel.com/docs/cli/inspect), and [promotion](https://vercel.com/docs/cli/promote).

Reuse VERCEL_TOKEN and org/project variables. CI metadata needs actions:read; release publication retains its current contents/actions write permissions only where needed. No credentials go into tracked files or output. Emit release tag, source SHA, deployment ID/URL and success/failure/skip summary, including a manual retry command. A failed deploy does not remove published installers.

Alternative: adding only release:published misses automated publications. Checking out master on publication can deploy a different version. A separate duplicated deploy script risks inconsistent credentials, gates and retry behavior.

## Risks / Trade-offs

- Existing clients may assume the requested slug is the final ID → keep the request field, return actual IDs, update first-party callers/tests and document older-client limitations; reads and joins remain compatible.
- Random suffixes are probabilistic → database uniqueness plus targeted bounded retries guarantees no two registered projects share the same ID.
- Longer IDs reduce visual simplicity → input stays a short readable prefix and copy/share actions expose the complete canonical ID.
- Unattributed old session tokens cannot be safely scoped → one-time sign-in where attribution is unavailable, followed by durable origin-scoped storage; never send an unknown token to a selected server.
- A credential store may be unavailable on Linux/headless hosts → current-run sessions and local mode remain usable with visible retry; real supported-platform persistence checks must not silently skip and count as passed.
- Master can deploy while desktop builds run → shared serialization and current-deployment checks skip a release already superseded in production, with an explicit summary.
- A staged build still runs migrations on the shared production database → migrations must remain backward-compatible with the serving version; a failed migration fails deployment and requires normal database recovery.
- Deployment protection may restrict the unique deployment health URL → use the project's supported authenticated check mechanism; do not disable protection to make tests pass.
- OS icon caches can lag → verify bundled assets during implementation and a clean-install/launcher view on each desktop platform during the approved release follow-up; development-window checks do not count as installer verification.

## Migration Plan

1. Implement server allocation and single-statement atomic uniqueness with dual legacy/new lookup compatibility. Seed old IDs in compatibility tests; no data backfill is needed.
2. Ship UI changes that consume returned IDs and durable scoped session storage. Keep device keys and app identifier stable; migrate attributable credentials and explain one-time reauthentication for unknown origins.
3. Generate all icon renditions and ensure platform bundle configuration uses them.
4. Merge reusable deployment and trigger changes to the default branch before the next release. Record the existing production source using trustworthy deployment metadata; unknown provenance requires an explicit manual bootstrap, not a silent downgrade.
5. Validate locally and exercise the release handoff in a controlled deployment, then confirm an actual authorized stable release updates or correctly reports already-current production. If implementation pushes trigger CI, monitor every run to terminal status and fix failures before completion.
6. Application rollback keeps minted slugs because they satisfy the old broad format and no internal identities moved. Credential schema rollback may require sign-in once but must not export tokens to plaintext. Production rollback is an explicit maintainer action to a known deployment; do not automate downgrades or undo migrations blindly.

## Approved Release Verification Scope

The user approved deferring clean installer icon inspection across Windows/macOS/Linux and an actual upgrade from an older installed version on 2026-10-13. Before the next release is accepted, inspect launcher/window/taskbar or dock/installer artwork and verify preservation of valid scoped sessions, legacy project IDs, folder locations and content; newly created/published projects must receive suffixes. Record observed results and unavailable hosts explicitly. The implementation review records completed local evidence separately, without claiming these installer checks passed.
