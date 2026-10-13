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

- **Production deploys follow successful CI and stable releases.** Master push CI uses Deploy as before. Automated
  Release publication calls the shared production workflow directly; manual stable publication uses Deploy’s
  `release: published` entry point. Drafts and prereleases do not deploy. Releases resolve their actual tag commit
  (including annotated tags), require trusted push CI for that exact SHA and never substitute the master tip.
- **One production job controls ordering.** It skips duplicate verified commits, superseded master commits, older stable
  versions and releases whose commit is an ancestor of newer production. Divergent or unknown provenance fails clearly.
  When an older deployment has no source metadata, establish its source from the existing deployment/build records and
  set `HIVETEX_PRODUCTION_BASELINE_ID` (that exact Vercel deployment ID) and `HIVETEX_PRODUCTION_BASELINE_SHA`
  (its full verified Git commit). This baseline cannot apply to a different deployment. New deploys write their own
  `hivetexSha`, `hivetexTag` when applicable and trigger metadata.
- **A deploy is checked before promotion.** The workflow uploads sources with production settings and `--skip-domain`,
  waits for the unique deployment to be READY, checks its health, rechecks release/CI/ordering and promotes it. It then
  verifies that the stable production alias points at the new deployment ID and checks its health. A healthy old
  endpoint cannot make a failed release deploy look green. Migrations still run during the build and must remain
  compatible with the currently serving version.
- **Settings and recovery.** Reuse `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`; `make setup` configures
  them. `HIVETEX_API_BASE` names the stable production domain. If unique deployment URLs require authentication, set
  the repository’s `VERCEL_AUTOMATION_BYPASS_SECRET` from that Vercel project’s automation bypass setting; checks send
  it in a header and protection stays enabled. The run summary reports source, tag, deployment URL and terminal state.
  Upload/promotion failures have bounded retries and a deployment budget. A deploy failure keeps published installers.
  Retry without republishing them: `gh workflow run deploy.yml -f release_tag=v1.2.3`. For a checked branch commit, use
  `gh workflow run deploy.yml`. Vercel’s own Git deploys remain disabled in `vercel.json`.

GitHub suppresses follow-on release events from its built-in token, so the direct reusable call is required for
automated publication ([trigger behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)).
The checks use Vercel’s [deployment lookup](https://vercel.com/docs/rest-api/deployments/get-a-deployment-by-id-or-url),
[alias lookup](https://vercel.com/docs/rest-api/aliases/get-an-alias) and optional
[automation bypass header](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation).

The Make targets need no global Vercel CLI (they use `npx vercel@latest`). `make up` runs the same server code locally
against emulators ([local-stack.md](local-stack.md)).

## 4. Free-tier budget (design D9)

Edits generate **no** control-plane traffic. For ~100 active users × 60 h/month and ~30 active projects: ≈ 60–70 k function
invocations (limit 1 M), ≈ 150–250 k Redis commands, a few queries per call on Postgres. Watch Vercel *Usage*, Upstash and Neon
dashboards during the first weeks.

## 5. Desktop

- **Releases are built and published on GitHub.** Pushing tag `vX.Y.Z` (`make release VERSION=X.Y.Z CONFIRM=1`) runs
  the *Desktop* workflow's `build` job. It fills a draft release with Windows (exe, msi), macOS (universal dmg, ad-hoc
  signed) and Linux (AppImage, deb, rpm) installers, plus the signed `latest.json` used by *Account → Check for
  updates*. When the three builds succeed, the *Release* workflow checks that every file is there, adds download links
  and first-launch notes, and publishes it (about 30 minutes after the push). A tag like `v0.3.0-beta.1` is published
  as a pre-release, which installed apps don't update to.
- **A release cannot be blocked by a flaky test or a mirror outage:**
  - `make release` tags only a commit that is on GitHub and whose *CI* and *Desktop* runs passed (`FORCE=1` skips
    the check);
  - the tag's `build` jobs make only the installers, without waiting for the tests, and retry package downloads;
  - if a build still fails, the *Release* workflow re-runs the failed jobs automatically (3 attempts in all) and
    publishes as soon as all three succeed.
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
