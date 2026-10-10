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
- **Choosing a server.** Desktop builds use their default server until the user picks another on the sign-in screen or
  in *Account* (for an on-premise deployment, say). *Use the default server* switches back.
- **Optional paid signing.** Set the `APPLE_*` secrets (Developer ID + notarization) to replace ad-hoc signing on
  macOS. Windows Authenticode signing is not wired yet, so SmartScreen asks once.
