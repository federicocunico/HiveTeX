# p2platex

Free, decentralized, peer-to-peer collaborative LaTeX editor. Sources live only on co-authors' devices
(synced as CRDTs over WebRTC); the best connected machine compiles the PDF for everyone.
A tiny Vercel "control plane" handles accounts, project lookup, permissions and connection bootstrap only.

## Architecture
- `apps/web` – Svelte 5 + Vite SPA (also the Tauri frontend)
- `apps/desktop` – Tauri 2 shell (native compile, folder mirror, keychain)
- `server/` – control plane (Hono, Drizzle, Neon Postgres, Upstash Redis); `api/index.ts` is its Vercel Functions entry
- `packages/*` – protocol, crypto, sync, compile, github, ui

See `openspec/specs/` for the behavior specs and `openspec/changes/archive/` for the original designs and tasks.

## Documentation

- [Real-time performance](docs/performance.md) · [Importing Overleaf / arXiv / folders](docs/import.md) · [Deployment (free tier)](docs/deployment.md) · [Accounts & admin](docs/accounts.md) · [Permissions](docs/permissions.md)
- [Wire protocol](docs/protocol.md) · [Compilation](docs/compilation.md) · [GitHub backup](docs/github-backup.md)
- [Projects in folders (open a clone, Changes view)](docs/folders.md) · [Local AI tools (Claude Code, Codex, Cursor)](docs/local-ai-tools.md) · [Security review](docs/security.md) · [Local stack (Docker)](docs/local-stack.md)
- Specs: `openspec/specs/` · history (proposals, designs, tasks): `openspec/changes/archive/`

## Release v0.1 and test with others

You need accounts on GitHub, [Vercel](https://vercel.com) (Hobby), and a Gmail address used only to send email. Everything
here is free; Vercel Hobby is for non-commercial use. Run the commands from the repository root (Git Bash on Windows).

1. **Install the tools.** Node 22 with pnpm (`corepack enable`), Git, GNU Make, and the GitHub CLI logged in
   (`gh auth login`). Then install dependencies with `make install`.

2. **Create the Vercel project.** Run `npx vercel@latest link` and create a new project. Vercel reads `vercel.json`, so
   keep the defaults. New projects use Fluid Compute, which the WebSocket signaling needs.

3. **Add the database and Redis.** In the Vercel dashboard, go to *Storage*, add **Neon** (Postgres) and **Upstash**
   (Redis), and connect both to the project. They set `DATABASE_URL` and `KV_REST_API_URL` / `KV_REST_API_TOKEN` for you.

4. **Generate and store the server secrets.** `make secrets` prints a fresh ticket-signing key pair and the exact
   `vercel env add` commands. Run them. Nothing is written to disk.

   ```bash
   make secrets
   ```

5. **Set the app URL and email.** Create a Gmail [App Password](https://myaccount.google.com/apppasswords) (it needs
   2-step verification), then set:

   ```bash
   for env in production preview; do
     printf %s 'https://<your-app>.vercel.app' | npx vercel@latest env add APP_ORIGIN $env
     printf %s 'you.p2platex@gmail.com' | npx vercel@latest env add GMAIL_USER $env
     printf %s '<16-char app password>'   | npx vercel@latest env add GMAIL_APP_PASSWORD $env
   done
   ```

6. **Recommended: TURN for testers on different networks.** Without a relay, people behind strict NATs or corporate
   firewalls may not connect. Create a free [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/)
   key and add `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN` the same way.

7. **Deploy and create the tables.**

   ```bash
   make env-pull         # writes .env.local (git-ignored)
   make migrate-prod     # creates the tables in Neon
   make deploy-prod CONFIRM=1
   ```

   Open `https://<your-app>.vercel.app` and register your account. Then make yourself admin with
   `make seed-admin ADMIN=<your-username>`.

8. **Configure desktop releases on GitHub.** The updater key signs automatic updates. The variable makes the installers
   use your server by default.

   ```bash
   gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/p2platex.key   # make secrets prints this line for you
   gh variable set P2PLATEX_API_BASE --body https://<your-app>.vercel.app
   ```

   No key yet? See the end of `make secrets`. Optional: a dry run that only builds is under GitHub → *Actions* →
   *Desktop* → *Run workflow*; the installers appear as artifacts of the run.

9. **Tag the release.** The version must match the sources (`make version VERSION=0.1.0` changes it everywhere; commit
   the result). Then:

   ```bash
   make release VERSION=0.1.0 CONFIRM=1   # pushes tag v0.1.0
   ```

   After about 30 minutes, a **draft** release "p2platex v0.1.0" has the Windows, macOS and Linux installers. Check it,
   then press *Publish*. Installed apps get later releases from *Account → Check for updates* (signed with your key).

10. **Invite testers.** Send them the web link, or the release page for the desktop app. First launch:
    - **Windows:** SmartScreen shows "Windows protected your PC": click *More info* → *Run anyway*.
    - **macOS:** open the `.dmg` and drag the app to Applications. If macOS blocks it, open *System Settings → Privacy &
      Security* and click *Open Anyway*.
    - **Linux:** run `chmod +x p2platex_*.AppImage` and start it, or install the `.deb`. Device keys need a keychain
      (GNOME Keyring or KWallet), which standard desktops have.
    - **Desktop, any OS:** the sign-in screen shows the server. Use *Change* if it isn't your deployment.

    To test: one person creates a project (*New project*) and shares its ID and password. The others use *Join a
    project*. Type together, compile, and try *Open folder…* with a git clone and an AI tool (see
    [docs/folders.md](docs/folders.md)).

Trouble? Run `npx vercel@latest logs <your-app>.vercel.app` for server errors. [docs/deployment.md](docs/deployment.md)
has the details: key rotation, the free-tier budget, and self-hosting with Docker instead of Vercel.

## Development
Requires Node 22, pnpm 10, Rust (desktop only), Docker (local stack only) and GNU Make. On Windows, run `make` from
Git Bash; install it with `scoop install make` or `choco install make`. Every target is a thin wrapper, and the plain
command is shown on the right.

| Make | Plain command | What it does |
|---|---|---|
| `make` | | list all targets |
| `make install` | `pnpm install` | install dependencies |
| `make dev` | `pnpm turbo run dev --filter=@p2platex/server --filter=@p2platex/web` | API on :3000 (embedded Postgres, console mailer) + web on :1420 |
| `make test` | `pnpm turbo run test` | unit + integration tests of every package |
| `make e2e` | `pnpm exec playwright test` | end-to-end tests (starts a local API with an embedded database) |
| `make check` | build, lint, svelte-check, tests, bundle budget, e2e | what CI runs |
| `make up` / `make down` / `make reset` | `docker compose up -d --build --wait` … | full local stack with the production code path ([docs/local-stack.md](docs/local-stack.md)) |
| `make test-stack` | | e2e suite against the Docker stack |
| `make desktop-dev` / `make desktop-test` | `pnpm --filter @p2platex/desktop tauri dev` / `cargo test --lib` | desktop app (desktop tests compile real LaTeX if a TeX distribution is installed) |
| `make desktop-e2e` | `node apps/desktop/e2e/run.mjs` | desktop UI tests over WebDriver (`tauri-driver`; see [docs/folders.md](docs/folders.md#desktop-ui-tests)) |
| `make deploy-preview` / `make deploy-prod CONFIRM=1` | `npx vercel deploy [--prod]` | deploy to Vercel ([docs/deployment.md](docs/deployment.md)) |

## Hosting note
Vercel Hobby is for **non-commercial** use only.

## License
AGPL-3.0-or-later. If you run a modified public deployment you must offer its source to users
(the web app links to this repository).
