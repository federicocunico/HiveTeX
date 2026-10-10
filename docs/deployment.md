# Deploying the control plane (free)

The short version is the README section **Release v0.1 and test with others**; this page has the details.

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

`make secrets` (`node scripts/gen-secrets.mjs`) prints a fresh key pair plus the `vercel env add` and `gh secret set`
commands. The one-liner below does the same by hand:

```bash
# ticket signing key (Ed25519) – generate once
node -e "const {generateKeyPairSync}=require('crypto');const k=generateKeyPairSync('ed25519');
const priv=k.privateKey.export({format:'jwk'}),pub=k.publicKey.export({format:'jwk'});
console.log('TICKET_SIGNING_JWK='+JSON.stringify(priv));
console.log('TICKET_PUBLIC_JWKS='+JSON.stringify([{kid:'k1',jwk:{...pub,alg:'EdDSA',use:'sig',kid:'k1'}}]));"
```

Set `TICKET_SIGNING_JWK`, `TICKET_PUBLIC_JWKS`, `TICKET_KID=k1`, `APP_ORIGIN=https://<your-domain>` (see `.env.example`).
Rotate by adding a second key to `TICKET_PUBLIC_JWKS`, switching `TICKET_KID`, and removing the old public key after 15 minutes.

## 3. First deploy

```bash
npx vercel@latest link                # once per checkout (creates .vercel/project.json)
make env-pull                         # vercel env pull .env.local
make migrate-prod                     # applies drizzle migrations to Neon using .env.local
make deploy-preview                   # vercel deploy  -> prints the preview URL
make seed-admin ADMIN=<username>      # after registering that account
make deploy-prod CONFIRM=1            # runs `make check`, then vercel deploy --prod
```

The Make targets need no global Vercel CLI (they use `npx vercel@latest`). Without Make, run the commands in the
comments directly. Before deploying, `make up` lets you try the same server code locally against emulators
([local-stack.md](local-stack.md)).

## 4. Free-tier budget (design D9)

Edits generate **no** control-plane traffic. For ~100 active users × 60 h/month and ~30 active projects: ≈ 60–70 k function
invocations (limit 1 M), ≈ 150–250 k Redis commands, a few queries per call on Postgres. Watch Vercel *Usage*, Upstash and Neon
dashboards during the first weeks.

## 5. Desktop

- **Releases are built on GitHub.** Pushing tag `vX.Y.Z` (`make release VERSION=X.Y.Z CONFIRM=1`) runs the *Desktop*
  workflow's `build` job. It makes a draft release with Windows (exe, msi), macOS (universal dmg, ad-hoc signed) and
  Linux (AppImage, deb) installers, plus the signed `latest.json` used by *Account → Check for updates*.
- **Secret and variable.** The job needs the `TAURI_SIGNING_PRIVATE_KEY` repository secret, and refuses a tag whose
  version differs from `tauri.conf.json` (fix it with `make version VERSION=X.Y.Z`). The variable
  `P2PLATEX_API_BASE` sets the server the installers use by default.
- **Dry run.** *Actions → Desktop → Run workflow* builds the same installers as workflow artifacts, without a release
  and without needing the key.
- **Local builds.** `make desktop-build` builds installers on the current machine (needs Rust).
- **Choosing a server.** Testers can change the server on the sign-in screen, or later in *Account*.
- **Optional paid signing.** Set the `APPLE_*` secrets (Developer ID + notarization) to replace ad-hoc signing on
  macOS. Windows Authenticode signing is not wired yet, so SmartScreen asks once.
