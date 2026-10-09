# Design

## Context

Motivation and measured numbers: `proposal.md`. Requirements: delta specs in this change.

- `mesh.ts:onLocalDocUpdate` sends every local update to peers interested in the doc. For updates received from a peer
  (`origin` = that connection) it returns early unless `conns.size >= relayThreshold` (default 6), and then forwards
  to every other interested peer. `ConnectionManager` connects every pair of devices (full mesh), falling back to
  relays through peers only when a direct link fails (NAT). Yjs drops already-integrated updates, so relays stop after
  one hop, but in a full mesh of N they cost (N-1)² frames per edit.
- Scratch measurement (in-process transport with immediate delivery, Windows, Node 22):

  | peers | keystroke p95 | frames / keystroke | 20 edits × all peers converge |
  |---|---|---|---|
  | 2 | 0.6 ms | 1 | 12 ms |
  | 6 | 0.4 ms | 5 | 16 ms |
  | 8 | 1.3 ms | 49 | 33 ms |
  | 10 | 0.9 ms | 81 | 36 ms |
  | 12 | 1.0 ms | 121 | 62 ms |

  The repository's loopback test transport delivers with `setTimeout(0)`, which Windows clamps to ~15.6 ms; benchmarks
  must not use it for timing.
- No CORS middleware: `OPTIONS /api/*` from `http://tauri.localhost` returns 404 without `Access-Control-*` headers
  (verified against the local server). The desktop client sends `X-Requested-With` and `Authorization`, which
  require a preflight.
- `tex.rs:detect` returns `flavor: "tectonic", supports: ["xelatex"]` when no other engine exists, but `compile`
  looks up an executable named after the engine (`xelatex`) and fails.
- `/auth/register` awaits `sendVerifyEmail` after inserting the user. There is no "resend verification" endpoint.
- `docker/nginx.conf.template` uses `$proxy_add_x_forwarded_for`, appending to a client-supplied header whose first
  entry the API trusts.

## Goals / Non-Goals

**Goals:** N-1 frames per edit in a full mesh while keeping delivery in partial meshes; automated, repeatable
latency/scale measurements (unit-level for logic, browser-level for real WebRTC); desktop usable in production.

**Non-Goals:** a gossip overlay for meshes of 50+ devices (WebRTC full mesh is fine up to ~12–15); measuring across
the public internet in CI (documented manual procedure instead); bundling Tectonic in the installer.

## Decisions

### D1. Neighbor-aware relaying
Each mesh broadcasts `APP 'nbrs' {devices: string[]}` (its directly connected device ids) on every peer join/leave,
debounced 100 ms, and stores the latest set per peer. On an update received from peer S, it forwards to peer X (that
is interested in the doc) only if X is not known to be a neighbor of S. Since neighbor sets of honest peers are
complete in a full mesh, nothing is forwarded; when A–B is missing, C forwards A's updates to B. Unknown neighbor
set (old client, or before the first `nbrs` arrives) → forward (safe default, old behavior). The `relayThreshold`
option is removed. Relays never loop: Yjs emits no update for already-integrated content, so a forwarded copy
produces no further event.
Alternatives: dedupe by update hash (still sends the duplicates once), spanning-tree routing (more state and failure
cases for no gain at this size).

### D2. Measuring
- **Unit level (`packages/sync/test/scale.test.ts`)**: an immediate-delivery transport (`setImmediate`, real framing
  and compression) in place of the loopback. Asserts for N ∈ {2, 6, 8, 12}: frames per keystroke == N-1 (full mesh),
  p95 propagation < 50 ms, concurrent typing by all converges with every insertion, partial mesh (one missing pair and
  a chain) delivers everything, and a late joiner catches up.
- **Benchmark (`pnpm --filter @p2platex/sync bench`, `make bench`)**: same harness, prints a table (p50/p95/max,
  frames/edit, convergence) for N = 2…16; used to fill `docs/performance.md`. Not part of CI timing assertions.
- **Browser level (`e2e/realtime.spec.ts`)**: 7 browser contexts (owner + 6 joined as editors) over real WebRTC on
  localhost. One page types 30 characters with 100 ms pauses; every page records when each marker appears
  (`MutationObserver` on the editor, timestamps from the shared machine clock via `performance.timeOrigin + now()`).
  Asserts p95 < 250 ms (the spec) and logs p50/p95/max. Then all 7 type 10 tokens concurrently and every page must
  converge to the same text containing all 70 tokens.

### D3. CORS for desktop origins
Hono `cors()` on `/api/*` with `origin` = the configured desktop origins (`tauri://localhost`,
`http://tauri.localhost`, `https://tauri.localhost`) plus `EXTRA_ORIGINS`; `credentials: false` (desktop uses bearer
tokens; web is same-origin and unaffected); allowed headers `Content-Type, Authorization, X-Requested-With`; methods
`GET, POST, PATCH, DELETE`; `maxAge` 600. Other origins get no CORS headers. The CSRF guard is unchanged (it already
accepts these origins). The WebSocket relay is not subject to CORS.

### D4. Tectonic is not advertised (revised during apply)
The original plan was to run `tectonic -X compile --untrusted`. While applying, `security-hardening` replaced
engine-level read restrictions with a post-run check of the recorder file (`.fls`). Tectonic writes no recorder file,
and its I/O layer reads absolute paths straight from the filesystem, so its reads cannot be verified. Running it would
reopen the file-disclosure hole. So `detect()` no longer reports Tectonic: a Tectonic-only device advertises no engine,
is never elected, and the app shows the existing "install TeX Live, MiKTeX or MacTeX" note. That still removes the bug
(a device that wins the election and then fails every build). Supporting Tectonic again needs a way to observe its
file access (for example an OS sandbox): left for a future change.

### D5. Registration email in the background
`sendVerifyEmail` runs via `deps.background` (Vercel `waitUntil`), with errors logged. New
`POST /auth/resend-verification` (signed in, unverified, rate-limited 3/hour) and a button on the Account page.

### D6. Stack nginx
`proxy_set_header X-Forwarded-For $remote_addr;` (the stack has a single proxy hop).

## Risks / Trade-offs

- [Browser e2e with 7 WebRTC peers is heavy on 2-vCPU CI runners] → generous budget (spec threshold 250 ms is far
  above localhost latency); the test runs with CI retries like other P2P tests; numbers are logged for trend checks.
- [Stale neighbor sets during churn could skip a needed relay] → on any peer leave the mesh rebroadcasts `nbrs`, and
  Yjs state-vector sync on (re)connection repairs anything missed.
- [Tectonic downloads its bundle on first use] → documented; offline machines should install a TeX distribution.

## Migration Plan

Ship together. Old clients ignore `nbrs`; new clients relay for peers whose neighbor sets are unknown.
