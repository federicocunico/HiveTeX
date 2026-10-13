# Deploying the control plane (free)

The short version is `make setup` (README section **Release v0.1 and test with others**); this page has the details
and the manual route.

Everything runs on free tiers; **Vercel Hobby is for non-commercial use**.

## 1. Services

| Need | Service | Notes |
|---|---|---|
| Hosting + API | **Vercel Hobby** (Fluid Compute, Node.js) | one project: static `apps/web/dist` + `/api/*` function |
| Durable data (accounts, projects, memberships) | **Neon Postgres** (Vercel Marketplace) | sets `DATABASE_URL` |
| Rate limits, signaling pub/sub, one-time hand-offs | **Upstash Redis** (Vercel Marketplace) | sets `KV_REST_API_URL`, `KV_REST_API_TOKEN` (the server also accepts `UPSTASH_REDIS_REST_URL` / `_TOKEN`) |
| Recovery email | **Gmail SMTP** with an App Password | `GMAIL_USER`, `GMAIL_APP_PASSWORD` |
| NAT relay (optional) | **Cloudflare Realtime TURN** free tier | `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` |
| Application relay (optional, off by default) | the same Vercel function + Upstash | `APPLICATION_RELAY=1` plus measured headroom, see section 4 |
| GitHub backup (optional) | GitHub App | see `docs/github-backup.md` |

Airtable and Dropbox were evaluated and rejected as primary stores (rate limits, no unique constraints/transactions, not databases).

## 2. Secrets

`make setup` (or only the keys: `make secrets`) generates and stores everything. Existing ticket keys are kept;
`ROTATE=1 make secrets` replaces them (then redeploy). Nobody is signed out, but existing membership tickets stop
verifying until each client fetches a new one, so peers may reconnect briefly.
For a manual setup, `node scripts/gen-secrets.mjs` prints a fresh pair: set `TICKET_SIGNING_JWK`, `TICKET_PUBLIC_JWKS`
and `TICKET_KID=k1` for production and preview (`vercel env add NAME production`, value on stdin).

For a zero-downtime rotation, add the new public key to `TICKET_PUBLIC_JWKS` next to the old one, switch `TICKET_KID`, and
remove the old public key after 15 minutes.

Other settings:
- `GMAIL_USER`, `GMAIL_APP_PASSWORD` (or `SMTP_*`). Required: the server refuses to start without mail.
- `BOOTSTRAP_ADMIN`: the username that becomes the first platform admin when it registers or signs in. It has no effect
  once an admin exists.
- `APP_ORIGIN`: optional on Vercel. Production deployments default to the project's production domain
  (`VERCEL_PROJECT_PRODUCTION_URL`).
- `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN`: optional TURN relay.
- `APPLICATION_RELAY`, `RELAY_*`, `USAGE_LOG`: optional application relay and usage logging (section 4).

## 3. First deploy

`make setup` does all of this; the manual equivalent is:

```bash
npx vercel@latest link                       # once per checkout (creates .vercel/project.json)
npx vercel@latest integration add neon -m region=iad1
npx vercel@latest integration add upstash/upstash-kv -m primaryRegion=iad1
# set the variables from section 2 for production and preview, then:
make deploy-prod CONFIRM=1                   # runs `make check`, then vercel deploy --prod
```

- **Migrations run in the Vercel build** (`vercel.json` `buildCommand` runs `pnpm --filter @hivetex/server migrate`
  first), so every deploy brings the schema up to date, and a failing migration fails the deploy. Preview deployments
  use the same database here, so migrations must stay additive.
- **Sensitive variables cannot be read back.** The Marketplace marks `DATABASE_URL` and the `KV_*` values sensitive, so
  `make env-pull` gets placeholders for them. That is why migrations run inside Vercel. `make migrate-prod` and
  `make seed-admin` only work when you have readable credentials (self-hosting, or a database URL copied from the Neon
  console).

- **Later deploys run in GitHub Actions, after CI passes** (`.github/workflows/deploy.yml`). The workflow uploads the
  newest `master` commit with the Vercel CLI, retries a failed upload (4 attempts), then checks `/api/health`. Vercel's
  own Git deploys are off (`"git": { "deploymentEnabled": false }` in `vercel.json`): a broken commit never goes
  live, and a GitHub rate limit on Vercel's side cannot fail a deploy. It needs the `VERCEL_TOKEN` secret and the
  `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` variables; `make setup` sets them (token from `.env.setup` or a prompt).

The Make targets need no global Vercel CLI (they use `npx vercel@latest`). `make up` runs the same server code locally
against emulators ([local-stack.md](local-stack.md)).

## 4. Free-tier budget, the doorbell and the application relay

Edits between devices with a working direct (or TURN) connection travel peer to peer. What costs the control plane is
**keeping a connection open while waiting**: Vercel bills provisioned memory for as long as any request on an instance
is in flight, an idle WebSocket included (Hobby: 360 GB-h, 1 M invocations a month), and every socket also renews its
presence in Redis every 30 s and reconnects every 300 s (`vercel.json`).

So current clients keep **no connection to the server while idle** (the doorbell, see
[protocol.md](protocol.md#the-doorbell-waking-devices-without-a-server-connection)). A device waits for rings on a free
push service; the server only answers short requests and holds a signaling socket for the seconds an introduction needs.

`pnpm --filter @hivetex/server usage-report` measures the real hub, connection managers, relay router and budget client
and extrapolates to 30 days (latest output: `openspec/changes/archive/2026-10-12-add-desktop-project-seeding/verification.md`). Measured on
2026-10-12:

| Load | Invocations | GB-h (2 GB) | Redis commands |
|---|---:|---:|---:|
| One project kept reachable by an open socket 24/7 (older clients, or the fallback without a push service) | 8,640 | up to 1,440 | ~190 k |
| One idle device with the doorbell, any number of projects | 0 | 0 | 0 |
| One introduction (ring, answer, link, sockets closed) | 3 | 0.009 | ~34 |
| One relayed MiB (data + acknowledgements) | | | ~600 |

The Upstash free tier (500,000 commands/month) is the first limit: about **15,000 introductions a month**, however many
devices are installed. Connected peers also renew their tickets (one request per ~12 minutes each). Watch the Vercel
*Usage*, Upstash and Neon dashboards. With `USAGE_LOG=1` each instance prints one counters-only `[usage]` line per
minute (operation counts and relay byte totals; never content, identities or channel names).

### Doorbell (push service)

| Variable | Meaning | Default |
|---|---|---|
| `DOORBELL_URL` | ntfy-compatible push service the clients subscribe to and ring through | `https://ntfy.sh` |
| `DOORBELL_URL=off` | no doorbell: clients fall back to keeping a socket while a project is open (costly, see above) | |

- **No account, no cost:** ntfy.sh is free and needs no sign-up. Its limits apply to each device and ringer IP, not to
  this server: about 30 open subscriptions and 250 messages a day per IP. A device uses one subscription for all its
  projects and one message per ring. Organizations with many devices behind one address can run their own ntfy
  (`docker run binwiederhier/ntfy serve`) and set `DOORBELL_URL`; add its origin to `connect-src` in `vercel.json`.
- **What ntfy sees:** opaque topic names (an HMAC of project and membership epoch), the time of rings and the IP
  addresses of subscribers and ringers. Ring messages are signed tokens with topic, epoch, expiry and a nonce: no
  project, user or content. They grant nothing; peers still authenticate with tickets and device keys.
- **Limits:** the ring endpoint allows one ring per device and project every 20 s (60 an hour); a device answers at
  most one ring per project every 10 s (120 an hour), so a leaked token cannot keep devices busy.
- The local dev server (`make dev`) serves its own push endpoint at `/__dev/push`: nothing leaves the machine.

Heartbeat renewals of sockets on the same function instance are batched into one Redis call per 10 s window. Whether
sockets share an instance is up to the platform, so size for the spread-out figure.

### Application relay

Peers that cannot connect directly (and have no TURN) can exchange end-to-end encrypted frames through the signaling
WebSocket. It stays **off until the deployment enables it**:

| Variable | Meaning | Default |
|---|---|---|
| `APPLICATION_RELAY=1` | advertise and forward the relay capability | off |
| `RELAY_PROVIDER_COMMANDS` | monthly Redis commands this deployment may spend (plan minus other uses) | required |
| `RELAY_BASELINE_COMMANDS` | measured monthly commands without relay traffic (dashboard or `USAGE_LOG`) | required |
| `RELAY_ENVELOPES`, `RELAY_BYTES` | deployment-wide forwarded envelopes / accounted bytes per window | 100,000 / 1 GiB |
| `RELAY_ACCOUNT_ENVELOPES`, `RELAY_ACCOUNT_BYTES` | per-account share of the window | 25,000 / 256 MiB |
| `RELAY_SESSIONS`, `RELAY_ACCOUNT_SESSIONS`, `RELAY_DEVICE_SESSIONS` | concurrent relay sockets per deployment / account / device | 64 / 8 / 4 |
| `RELAY_SOCKET_SECONDS`, `RELAY_ACCOUNT_SOCKET_SECONDS` | relay socket time per window, deployment / account (each session is charged its lease, up to 300 s, when it starts; an open socket costs provisioned memory) | 180,000 (50 h) / 36,000 (10 h) |
| `RELAY_WINDOW_MS` | rolling accounting window | 30 days |
| `RELAY_NAMESPACE` | budget namespace; defaults to `<VERCEL_ENV>:<APP_ORIGIN>`, so previews never spend production's allowance | |

The server refuses to start when `RELAY_BASELINE_COMMANDS + 5 × RELAY_ENVELOPES` (scaled to a month) exceeds
`RELAY_PROVIDER_COMMANDS`; lower `RELAY_ENVELOPES` until it fits. These are application caps, not provider guarantees.

How the server handles relayed traffic:

- **Ciphertext only, never stored.** Frames are encrypted between the two devices with relay-specific keys
  ([application-relay-security.md](application-relay-security.md)). The server publishes each frame once to the
  recipient session's own Redis Pub/Sub channel and forgets it. Pub/Sub retains nothing; no Redis stream, list, retry
  queue, database row, request-body capture or log line holds a frame (`server/test/relay-retention.test.ts` scans
  Redis and the console after forwarding).
- **What Redis does hold:** the existing presence leases, plus expiring budget counters keyed by hashed account and
  device IDs (sizes and counts only).
- **Fails closed.** When the budget is spent the sender gets `relay_limited`; when Redis accounting cannot be reached,
  `relay_accounting_unavailable`, both with a retry delay. Direct and TURN links are not affected and clients keep
  their edits pending.
- **Credits are charged up front and never refunded,** in small batches that expire within 5 s, so reconnecting,
  switching projects or crashing never yields a fresh allowance.
- The relay cannot bootstrap a project when no member device holding it is online: there is no server copy.

## 5. Desktop

- **Releases are built and published on GitHub.** Pushing tag `vX.Y.Z` (`make release VERSION=X.Y.Z CONFIRM=1`) runs
  the *Desktop* workflow's `build` job. It fills a draft release with the Windows installers (exe, msi) and the signed
  `latest.json` used by *Account → Check for updates*. Installers are Windows-only for now: macOS and Linux are
  tested in CI (Linux) but not built; build them locally with `make desktop-build`. When the build succeeds, the *Release* workflow checks that every file is there, adds download links
  and first-launch notes, and publishes it (about 30 minutes after the push). A tag like `v0.3.0-beta.1` is published
  as a pre-release, which installed apps don't update to.
- **A release cannot be blocked by a flaky test or a mirror outage:**
  - `make release` tags only a commit that is on GitHub and whose *CI* and *Desktop* runs passed (`FORCE=1` skips
    the check);
  - the tag's `build` jobs make only the installers, without waiting for the tests, and retry package downloads;
  - if a build still fails, the *Release* workflow re-runs the failed jobs automatically (3 attempts in all) and
    publishes as soon as the build succeeds.
- **If a build fails,** the release stays a draft and the *Release* run says what's missing. Re-run the failed
  *Desktop* jobs and it publishes on its own. *Actions → Release → Run workflow* (with the tag) publishes a draft by
  hand.
- **Secret and variable.** The job needs the `TAURI_SIGNING_PRIVATE_KEY` repository secret, and refuses a tag whose
  version differs from `tauri.conf.json` (fix it with `make version VERSION=X.Y.Z`). The variable
  `HIVETEX_API_BASE` overrides the default server baked into the installers (`https://hivetex.vercel.app`, built into the app);
  set it for forks or on-premise builds.
- **Dry run.** *Actions → Desktop → Run workflow* builds the same installers as workflow artifacts, without a release
  and without needing the key.
- **Local builds.** `make desktop-build` builds installers on the current machine (needs Rust).
- **Update notice.** On start, the desktop app asks GitHub for the repository's latest published release (never a
  draft or pre-release; the repository comes from `VITE_SOURCE_URL`, default HiveTeX) and shows a *Version X is
  available* badge with a *Download* button to the release page when it is newer. It stays silent offline.
- **Installers replace the old version.** The Windows setup removes an earlier setup-installed or MSI-installed HiveTeX
  (`apps/desktop/src-tauri/windows/hooks.nsh`; a per-machine MSI asks for administrator rights once) and keeps user data.
  The manual *Desktop* run checks this with `scripts/verify-upgrade.ps1`.
- **Choosing a server.** Desktop builds use their default server until the user picks another on the sign-in screen or
  in *Account* (for an on-premise deployment, say). *Use the default server* switches back.
- **Optional paid signing.** Set the `APPLE_*` secrets (Developer ID + notarization) to replace ad-hoc signing on
  macOS. Windows Authenticode signing is not wired yet, so SmartScreen asks once.

### What a desktop release contains for background sync

| Part | How it gets in | Checked by |
| --- | --- | --- |
| Node 22.22.0 runtime (Windows x64, macOS x64 + arm64, Linux x64) and its LICENSE | `apps/desktop/prepare-worker.mjs` (tauri `beforeBuildCommand`) downloads from nodejs.org and refuses a SHA-256 mismatch; writes `resources/node/manifest.json` | the app before every worker start (`WorkerSpec::verify`) |
| Sync worker bundle (`hivetex-worker.mjs`, third-party license comments at the end) | `apps/desktop/worker-build.mjs` (esbuild), writes `resources/worker/manifest.json` with its SHA-256 | the same check: a tampered or half-updated install does not start the worker |
| Patched `webrtc-ice 0.13.0` | `[patch.crates-io]` → `src-tauri/vendor/webrtc-ice` ([PATCHES.md](../apps/desktop/src-tauri/vendor/PATCHES.md)) | CI runs the crate's tests; `transport::tests::lockfile_pins_the_vendored_patched_ice` |
| Native SQLite (`rusqlite =0.37.0`, bundled), tray, single instance, launch at login | Cargo | `cargo test --lib` |

**Packaged startup check.** `hivetex-desktop --self-check` verifies the bundled runtime and worker and starts the
worker. It waits for the handshake and exits 0, or exits 1 with the reason. It opens no window and does not use a
Node installed on the machine. The *Desktop* `build` job runs it with a minimal `PATH` on the built Windows `.exe`. Run it by
hand on a downloaded or locally built package the same way (inside an AppImage, where linuxdeploy rewrites bundled
executables, the runtime is checked by its pinned version instead of its download checksum). If HiveTeX is
already running for the same user, the second launch hands over to it instead, so quit first.

**Manual macOS checks** (for a locally built macOS package; CI does not build macOS for now):
1. Open the `.dmg`, drag HiveTeX to Applications. The first start needs right-click → Open (ad-hoc signature).
2. `"/Applications/HiveTeX.app/Contents/MacOS/hivetex-desktop" --self-check` prints `self-check: sync worker ready`.
3. Close the window: the menu-bar icon stays, and *Open HiveTeX* brings it back. Starting the app again from
   Launchpad opens the same window and starts no second app (Activity Monitor shows one HiveTeX and one `node-…`).
4. Background syncing → *Start HiveTeX when I sign in…* adds a HiveTeX plist under `~/Library/LaunchAgents`, and clearing it
   removes the file. After logging out and in with *Start in the background*, only the menu-bar icon appears.
5. *Quit HiveTeX* from the menu bar: no HiveTeX or `node-…` process remains.

### Rolling back background features

Every switch is independent, and foreground editing keeps working with all of them off.

| To switch off | Do | Effect |
| --- | --- | --- |
| Application relay | `vercel env rm RELAY_PROVIDER_COMMANDS production` (or any `RELAY_*` limit), then redeploy | Clients stop offering the relay. Direct and TURN paths, and stored data, are unchanged. |
| Desktop background seeding | `vercel env add DESKTOP_BACKGROUND production` with value `off`, then redeploy | Each desktop applies it with its next ticket and remembers it across restarts. Seeds stop; open projects keep syncing. Set it back to anything else to re-enable. |
| Router port mapping (UPnP) | `vercel env add DESKTOP_UPNP production` with value `off`, then redeploy | Owned mappings are removed. Ordinary ICE, TURN and the relay are unchanged. |
| Doorbell | `DOORBELL_URL=off` | Dormant seeds are no longer woken. Open clients use the gatekeeper fallback. |
| Native project store (one desktop) | `localStorage['hivetex.nativeStore'] = 'off'` in its developer console | New migrations stop. Already migrated projects stay native, so a stale IndexedDB copy is never reopened ([desktop storage](desktop-storage.md)). |

A **binary downgrade** to a release before the native store does not see edits made since migration. Before
installing an older version, export the projects (or use the verified export back to IndexedDB described in
[desktop storage](desktop-storage.md)).

### Toolchain of the verified build

rustc 1.93.1, cargo 1.93.1, tauri-cli 2.12.1, tauri 2.12.2, Node 22.22.0, pnpm 10.34.6, esbuild 0.25.12. Crates:
- `webrtc 0.13.0` and `webrtc-ice 0.13.0`, the latter vendored and patched;
- `rusqlite 0.37.0`, `netdev 0.38.2`, `quick-xml 0.38.4`, `reqwest 0.13.5`, `tiny_http 0.12.0`;
- `tauri-plugin-single-instance 2.4.4`, `tauri-plugin-autostart 2.5.1`, `tauri-plugin-updater 2.13.2`.
