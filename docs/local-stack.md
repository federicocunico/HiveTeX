# Local stack (Docker Compose)

`make up` runs the whole control plane on your machine with the **same code path as production**: the API uses the
Neon HTTP driver, the Upstash REST client and an SMTP mailer, just as on Vercel. They point at local emulators
instead of the real services. Use it to catch bugs that the lightweight dev server (`make dev`, embedded PGlite +
in-memory signaling) cannot show. Examples are HTTP-driver quirks, pub/sub timing and email delivery.

No real credential is needed. The defaults in `docker/.env.stack` are development values and are **not secrets**.

## Requirements

- Docker with Compose v2. On Windows and macOS that is Docker Desktop; on Windows enable the WSL 2 backend.
- GNU Make (see the README) or the `docker compose` commands below.

## Commands

| Make | Equivalent | What it does |
|---|---|---|
| `make up` | `docker compose up -d --build --wait` | builds and starts everything, waits until healthy |
| `make up PROFILES=turn,texlive` | `docker compose --profile turn --profile texlive up -d --build --wait` | also starts the optional services |
| `make ps` / `make logs` | `docker compose ps` / `docker compose logs -f` | status / follow logs (`make logs S=api` for one service) |
| `make down` | `docker compose down` | stops containers and keeps the data |
| `make reset` | `docker compose down -v` | stops and **deletes** the database and Redis volumes |
| `make migrate-local` | `pnpm --filter @hivetex/server migrate` with the stack env | re-applies migrations from the host (the API also runs them at start) |
| `make test-stack` | see the Makefile | starts the stack with rate limits off and runs the Playwright suite against it |

## Services and ports

| Service | URL / port | Purpose |
|---|---|---|
| `web` | http://localhost:8080 | production build of the web app (nginx). It has the same security headers as `vercel.json` (no HSTS on http) and proxies `/api` and the `/api/signal` WebSocket |
| `api` | http://localhost:3001/api/health | control plane: `server/src/docker.ts` uses the production wiring from `server/src/production.ts` |
| `mailpit` | http://localhost:8025 (SMTP 1025) | catches every email (verification, password reset) |
| `postgres` | localhost:5432 (`postgres`/`postgres`, db `main`) | database |
| `neon-proxy` | localhost:4444 | Neon HTTP API in front of `postgres` (`NEON_HTTP_ENDPOINT`) |
| `redis` | localhost:6379 | rate limits, KV, presence, pub/sub |
| `upstash` | localhost:8079 (token `dev-stack-token`) | Upstash REST API: `srh` handles commands, and `docker/upstash-shim.mjs` adds pub/sub streaming |
| `turn` (profile `turn`) | 3478 udp/tcp, user `dev` / `dev-stack-turn` | coturn NAT relay for testing WebRTC across networks |
| `texlive` (profile `texlive`) | http://localhost:8081 | serves a TeX Live tree for the in-browser compiler |

Host ports can be changed with environment variables: `WEB_PORT`, `API_PORT`, `PG_PORT`, `REDIS_PORT`,
`UPSTASH_PORT`, `NEON_PROXY_PORT`, `MAILPIT_UI_PORT`, `MAILPIT_SMTP_PORT` and `TEXLIVE_PORT`. The API is published on
3001, not 3000, so it never collides with `make dev` / `make e2e`. Playwright would silently reuse anything already
listening on :3000.

## How the overrides work

The server reads these variables. All of them are unset on Vercel, where behavior is unchanged:

- `NEON_HTTP_ENDPOINT`: sends the Neon HTTP driver to the local proxy.
- `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_FROM`: an explicit SMTP server instead of Gmail.
- `HIVETEX_DEV_STACK=1`: generates an ephemeral ticket signing key when `TICKET_SIGNING_JWK` is empty. Tickets
  stop verifying after an API restart, so reload the browser if peers stop connecting.
- `E2E_NO_LIMITS=1`, set by `make test-stack`: disables rate limiting, because the e2e suite registers many accounts
  from one IP. A plain `make up` keeps the real limits, so you can test them.

## Optional: TeX Live file server

The in-browser compiler downloads TeX packages on demand, from the public SwiftLaTeX server by default. To use your
own server:

1. Put a TeX Live tree in the SwiftLaTeX layout (`pdftex/<n>/…`, `xetex/<n>/…`) in `docker/texlive/`, or set
   `TEXLIVE_DIR=/path/to/tree`. It is large, so it is not part of the repository.
2. Start the stack with
   `make up PROFILES=texlive VITE_TEXLIVE_URL=http://localhost:8081/ CSP_CONNECT_EXTRA=http://localhost:8081`.
   The web image is rebuilt with that URL, and the CSP allows it.

Users can also set the server per device in *Account → TeX package server*.

## Troubleshooting

- **Port already in use**: change the host port with the variables above, for example `WEB_PORT=8090 make up`.
- **Peers don't connect after an API restart**: the ephemeral ticket key changed. Reload the browser tabs.
- **Windows: slow builds or file watching**: keep the repository on an NTFS drive (not a network share) and give Docker
  Desktop at least 4 GB of RAM. `make up` does not bind-mount sources, except the small Upstash shim.
- **Everything is slower than `make dev`**: expected. Every query is an HTTP round trip through the Neon proxy, as in
  production.
- **Start from scratch**: run `make reset && make up`.
