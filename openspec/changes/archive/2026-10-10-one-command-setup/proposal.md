# Proposal

## Why

The v0.1 guide still takes ten manual steps, and `make secrets` only prints commands. Trying the guide against the real
Vercel project (`hivetex`) showed that three of those steps cannot work as written:

- The Marketplace integrations set `DATABASE_URL` and `KV_*` for Production and Preview only, so `make env-pull`
  (Development) gets no database URL.
- These variables are *sensitive*: `vercel env pull` returns placeholders instead of their values, so migrations and
  `make seed-admin` cannot run from the maintainer's machine at all.
- Without `APP_ORIGIN`, the server falls back to the per-deployment URL, so emails would link to a single deployment
  instead of the production domain.

The maintainer wants one command that sets everything up.

## What Changes

- **`make setup`** does the whole first deployment, safe to re-run:
  - checks the tools and logins (`gh`, Vercel);
  - links the project;
  - provisions Neon and Upstash if missing;
  - stores the server secrets and settings in Vercel, skipping existing values unless asked to rotate;
  - deploys to production;
  - checks `/api/health`;
  - stores the updater key secret and the server URL variable in GitHub.

  It asks only for what cannot be generated (Gmail account and App Password, the admin username, optional TURN keys).
  It also reads them from a git-ignored `.env.setup` file or the environment, so it can run unattended.
- **`make secrets`** runs the secret steps instead of printing them: ticket keys to Vercel (kept if present;
  `ROTATE=1` replaces them) and the updater key to GitHub.
- **Migrations run in the Vercel build**, which has access to the sensitive database URL. Every deploy brings the schema
  up to date.
- **First admin without database access.** When `BOOTSTRAP_ADMIN` names a username and the platform has no admin yet,
  that user becomes admin on registration or sign-in.
- **The server derives its public origin** from Vercel's production domain when `APP_ORIGIN` is not set.
- The README guide shrinks to `make setup`, then `make release`, with the manual steps kept as a fallback.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `release-distribution`: the documented setup becomes an automated, re-runnable command, with database migrations
  during deployment and a first-admin bootstrap.

## Impact

- `scripts/setup.mjs` (new), `scripts/gen-secrets.mjs`, `Makefile` (`setup`, `secrets`, and `env-pull` using the
  production environment).
- `vercel.json` build command: migrations before the web build.
- `server/src/config.ts` (origin fallback), `server/src/accounts/routes.ts` (admin bootstrap), with tests.
- `README.md`, `docs/deployment.md`, `.env.example`.
- Touches the maintainer's Vercel project and GitHub repository settings only when the maintainer runs the command.
