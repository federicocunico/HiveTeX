# p2platex

Free, decentralized, peer-to-peer collaborative LaTeX editor. Sources live only on co-authors' devices
(synced as CRDTs over WebRTC); the best connected machine compiles the PDF for everyone.
A tiny Vercel "control plane" handles accounts, project lookup, permissions and connection bootstrap only.

## Architecture
- `apps/web` – Svelte 5 + Vite SPA (also the Tauri frontend)
- `apps/desktop` – Tauri 2 shell (native compile, folder mirror, keychain)
- `api/` – Hono on Vercel Functions (Neon Postgres + Upstash Redis)
- `packages/*` – protocol, crypto, sync, compile, github, ui

See `openspec/changes/bootstrap-p2p-latex-platform/` for specs, design and tasks.

## Development
Requires Node 22, pnpm 10, Rust (for desktop). `pnpm install && pnpm turbo build lint test`.

## Hosting note
Vercel Hobby is for **non-commercial** use only.

## License
AGPL-3.0-or-later. If you run a modified public deployment you must offer its source to users
(the web app links to this repository).
