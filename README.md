# p2platex

Free, decentralized, peer-to-peer collaborative LaTeX editor. Sources live only on co-authors' devices
(synced as CRDTs over WebRTC); the best connected machine compiles the PDF for everyone.
A tiny Vercel "control plane" handles accounts, project lookup, permissions and connection bootstrap only.

## Architecture
- `apps/web` – Svelte 5 + Vite SPA (also the Tauri frontend)
- `apps/desktop` – Tauri 2 shell (native compile, folder mirror, keychain)
- `server/` – control plane (Hono, Drizzle, Neon Postgres, Upstash Redis); `api/index.ts` is its Vercel Functions entry
- `packages/*` – protocol, crypto, sync, compile, github, ui

See `openspec/changes/bootstrap-p2p-latex-platform/` for specs, design and tasks.

## Documentation

- [Importing Overleaf / arXiv / folders](docs/import.md) · [Deployment (free tier)](docs/deployment.md) · [Accounts & admin](docs/accounts.md) · [Permissions](docs/permissions.md)
- [Wire protocol](docs/protocol.md) · [Compilation](docs/compilation.md) · [GitHub backup](docs/github-backup.md)
- [Local AI tools (Claude Code, Codex, Cursor)](docs/local-ai-tools.md) · [Security review](docs/security.md) · [Local stack (Docker)](docs/local-stack.md)
- Specs, design and tasks: `openspec/changes/`

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
| `make deploy-preview` / `make deploy-prod CONFIRM=1` | `npx vercel deploy [--prod]` | deploy to Vercel ([docs/deployment.md](docs/deployment.md)) |

## Hosting note
Vercel Hobby is for **non-commercial** use only.

## License
AGPL-3.0-or-later. If you run a modified public deployment you must offer its source to users
(the web app links to this repository).
