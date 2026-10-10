# Design

## Context

Observed on the real project `hivetex` (Vercel CLI 63):

- Neon and Upstash (`upstash/upstash-kv`) are installed. Their variables exist for Production and Preview, are marked
  sensitive, and `vercel env pull` returns 11-character placeholders for them.
- Missing variables: `TICKET_*`, `GMAIL_*`.
- CLI features available non-interactively:
  - `vercel link --yes --project <name>`;
  - `vercel integration add <slug> -m k=v -e <env>`. First-time terms may need an interactive confirmation.
  - `vercel env add NAME <env> --value V --yes [--force]`;
  - `vercel env ls <env>`;
  - `vercel deploy --prod --yes`.
- The GitHub CLI has `gh secret list|set` and `gh variable set`.

## Goals / Non-Goals

**Goals:** a single re-runnable command; no secrets in tracked files or output; works unattended given a local file.

**Non-Goals:**
- Creating the Vercel, GitHub or Google accounts.
- Logging in (the script starts `vercel login` / `gh auth login` when needed; they are interactive by nature).
- Custom domains.
- Tagging a release (that stays `make release`).

## Decisions

### D1. `scripts/setup.mjs`, Node built-ins only
Steps run in order, each idempotent, each printing `[n/9] title … ok|skipped|done`.

1. **Tools and logins.**
   - `gh auth status`, or run `gh auth login`.
   - `npx vercel@latest whoami`, or run `vercel login`.
2. **Link.** Skipped if `.vercel/project.json` exists. Otherwise `vercel link --yes --project ${VERCEL_PROJECT:-hivetex}`.
3. **Storage.** `vercel integration list` decides. If Neon is missing: `vercel integration add neon -m region=iad1`. If
   Upstash Redis is missing: `vercel integration add upstash/upstash-kv -m primaryRegion=iad1`. Both connect to all
   environments.
4. **Server settings.** `vercel env ls production` / `preview` gives the existing names. Missing values are added to
   both environments:
   - **generated:** `TICKET_SIGNING_JWK`, `TICKET_PUBLIC_JWKS`, `TICKET_KID`. `ROTATE=1` replaces them with `--force`.
   - **asked:** `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `BOOTSTRAP_ADMIN`.
   - **optional:** `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN`. An empty answer skips them.
   - Values passed explicitly through `.env.setup` or the environment overwrite (`--force`): the maintainer asked for
     them.
5. **Deploy.** `vercel deploy --prod --yes`. Migrations run in the build (D2). The production URL is read from the
   command output.
6. **Health.** `GET <url>/api/health` must return 200 within 60 s, with retries.
7. **Updater key.** Skipped if `gh secret list` has `TAURI_SIGNING_PRIVATE_KEY`. Otherwise it is set from
   `~/.tauri/p2platex.key`; if that file is missing, the step explains how to generate a key and continues.
8. **Server URL variable.** `gh variable set P2PLATEX_API_BASE --body <url>`.
9. **Summary.** The URL, "register `<BOOTSTRAP_ADMIN>` to become admin", and the next step `make release VERSION=…
   CONFIRM=1`.

**Inputs.** Precedence: process environment, then `.env.setup` (`KEY=VALUE` lines), then an interactive prompt (TTY
only; hidden for passwords). Without a TTY, a missing required value stops with the list of variables to set.

**Secrecy.** Values go to `vercel env add` via `--value` with `shell: false`, so they are not interpreted by a shell,
and the script never echoes them. `.env.setup` is covered by the existing `.env*` ignore rule.

**`--only=secrets`.** Runs steps 1, 4 (ticket keys only) and 7. `make secrets` uses it, replacing the old print-only
script; `gen-secrets.mjs` stays as the key generator.

### D2. Migrations in the Vercel build
`vercel.json` `buildCommand`:

```
npx pnpm@10 --filter @p2platex/server migrate && npx pnpm@10 --filter @p2platex/web build
```

The build has the real sensitive values. Preview deployments share the database with production in this setup, so
migrations must stay additive (drizzle forward-only, as today). Documented.

### D3. `BOOTSTRAP_ADMIN`
In the register and login handlers: when `env.BOOTSTRAP_ADMIN` equals the user's lower-cased username and no user has
`is_admin`, a single `UPDATE users SET is_admin = true WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM users WHERE
is_admin)` sets it. The condition is atomic, so two concurrent sign-ins cannot create two admins. The response reflects
the new flag.

### D4. Origin fallback
`appOrigin = APP_ORIGIN ?? (VERCEL_ENV === 'production' && VERCEL_PROJECT_PRODUCTION_URL ? https://… : VERCEL_URL ?
https://… : http://localhost:1420)`. Vercel exposes these system variables by default.

### D5. `make env-pull`
`vercel env pull .env.local --environment=production`. It is still useful for non-sensitive values. The README notes that
sensitive values come back masked. `migrate-prod` and `seed-admin` stay for self-hosted setups with readable
credentials.

## Risks / Trade-offs

- **The CLI's output format can change.** The script parses `vercel deploy` (last `https://` line) and
  `integration list` (product names). It fails loudly with the command to run by hand.
- **Marketplace terms on first install** may require an interactive confirmation or the browser. The script surfaces
  the CLI's prompt, or stops with the dashboard link.
- **Migrating on preview builds touches the shared database.** That is acceptable for additive migrations and a test
  release; separate databases per environment are a later concern.
