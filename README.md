# HiveTeX

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

1. **Install the tools.** Node 22 with pnpm (`corepack enable`), Git, GNU Make and the [GitHub CLI](https://cli.github.com).
   Then install dependencies with `make install`.

2. **Get a Gmail App Password.** Create one at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
   (2-step verification is required). The server uses it to send verification and password-reset emails.

3. **Run the setup.** It logs you in to GitHub and Vercel if needed, links the Vercel project, adds Neon (Postgres) and
   Upstash (Redis), stores all server secrets, deploys (the database tables are created during the build), checks
   `/api/health` and configures GitHub for desktop releases. It asks for your Gmail address, the App Password and the
   username that becomes admin. For TURN it asks for optional Cloudflare keys; leave them empty to skip.

   ```bash
   make setup              # preview first with: make setup DRY_RUN=1
   ```

   To run it without questions, put the answers in a `.env.setup` file (git-ignored; the keys are listed at the end of
   `.env.example`). Re-running is safe: existing secrets are kept, and the app is redeployed. Testers on different
   networks connect more reliably with a free [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/)
   key (`CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN`).

4. **Become admin.** Open the URL printed at the end, and register the username you gave as admin. It becomes the
   platform admin automatically (only while no admin exists).

5. **Tag the release.** The version must match the sources (`make version VERSION=0.1.1` changes it everywhere; commit
   the result). Then:

   ```bash
   make release VERSION=0.1.1 CONFIRM=1   # pushes tag v0.1.1
   ```

   After about 30 minutes, a **draft** release has the Windows, macOS and Linux installers, already pointing at your
   server. Check it, then press *Publish*. Installed apps get later releases from *Account → Check for updates*.

6. **Invite testers.** Send them the web link, or the release page for the desktop app. First launch:
    - **Windows:** SmartScreen shows "Windows protected your PC": click *More info* → *Run anyway*.
    - **macOS:** open the `.dmg` and drag the app to Applications. If macOS blocks it, open *System Settings → Privacy &
      Security* and click *Open Anyway*.
    - **Linux:** run `chmod +x HiveTeX_*.AppImage` and start it, or install the `.deb`. Device keys need a keychain
      (GNOME Keyring or KWallet), which standard desktops have.
    - **Desktop, any OS:** the sign-in screen shows the server. Use *Change* if it isn't your deployment.

    To test: one person creates a project (*New project*) and shares its ID and password. The others use *Join a
    project*. Type together, compile, and try *Open folder…* with a git clone and an AI tool (see
    [docs/folders.md](docs/folders.md)).

Other commands: `make secrets` stores only the signing keys (`ROTATE=1` replaces the ticket keys). Run
`npx vercel@latest logs <your-app>.vercel.app` for server errors. Manual setup, key rotation, the free-tier budget and
self-hosting with Docker are in [docs/deployment.md](docs/deployment.md).

## Development
Requires Node 22, pnpm 10, Rust (desktop only), Docker (local stack only) and GNU Make. On Windows, run `make` from
Git Bash; install it with `scoop install make` or `choco install make`. Every target is a thin wrapper, and the plain
command is shown on the right.

| Make | Plain command | What it does |
|---|---|---|
| `make` | | list all targets |
| `make install` | `pnpm install` | install dependencies |
| `make dev` | `pnpm turbo run dev --filter=@hivetex/server --filter=@hivetex/web` | API on :3000 (embedded Postgres, console mailer) + web on :1420 |
| `make test` | `pnpm turbo run test` | unit + integration tests of every package |
| `make e2e` | `pnpm exec playwright test` | end-to-end tests (starts a local API with an embedded database) |
| `make check` | build, lint, svelte-check, tests, bundle budget, e2e | what CI runs |
| `make up` / `make down` / `make reset` | `docker compose up -d --build --wait` … | full local stack with the production code path ([docs/local-stack.md](docs/local-stack.md)) |
| `make test-stack` | | e2e suite against the Docker stack |
| `make desktop-dev` / `make desktop-test` | `pnpm --filter @hivetex/desktop tauri dev` / `cargo test --lib` | desktop app (desktop tests compile real LaTeX if a TeX distribution is installed) |
| `make desktop-e2e` | `node apps/desktop/e2e/run.mjs` | desktop UI tests over WebDriver (`tauri-driver`; see [docs/folders.md](docs/folders.md#desktop-ui-tests)) |
| `make deploy-preview` / `make deploy-prod CONFIRM=1` | `npx vercel deploy [--prod]` | deploy to Vercel ([docs/deployment.md](docs/deployment.md)) |

## Hosting note
Vercel Hobby is for **non-commercial** use only.

## License
AGPL-3.0-or-later. If you run a modified public deployment you must offer its source to users
(the web app links to this repository).
