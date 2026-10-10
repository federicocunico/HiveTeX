# Design

## Context

- **Server address (`apps/web/src/lib/api.ts`).** `apiBase()` returns the stored `serverUrl`, else
  `import.meta.env.VITE_API_BASE`, else `''`, which means the page's own origin. On the desktop, `''` means
  `tauri://localhost` in a release build and `http://localhost:1420` under `tauri dev`. The release workflow sets
  `VITE_API_BASE` from a repository variable; local and fork builds have no server.
- **Dev setup.**
  - `vite.config.ts` proxies `/api` (with WebSocket) to `http://localhost:3000`.
  - `make dev` runs the local API and the web app; `make desktop-dev` runs `tauri dev` (devUrl `localhost:1420`).
- **Server origin checks.**
  - CORS allows `APP_ORIGIN` plus the desktop origins (`tauri://localhost`, `http(s)://tauri.localhost`).
  - `csrfGuard` requires `x-requested-with` and rejects foreign `Origin` headers.
  - `http://localhost:1420` is deliberately not allowed in production.
- **Compilation (`session.svelte.ts`, `packages/compile`).**
  - Engine: native TeX (desktop), else the in-browser engine (web), else none.
  - The election uses a capability record. "Compile for others" (`compileForOthers`) is an opt-out that makes the
    device ineligible.
  - *Compile here* compiles locally on demand.

## Goals / Non-Goals

**Goals:**
- Desktop builds work out of the box against hivetex.vercel.app, with a visible override and a reset.
- `make dev` gives a working desktop UI against the hosted server with no local backend.
- An explicit, per-device compiler preference.

**Non-Goals:**
- Inno Setup. The Tauri NSIS installer stays.
- Changing server-side CORS for development.
- Per-project compiler preferences.
- Compiling on a peer chosen by the user. The election still picks the leader.

## Decisions

### D1. Resolving the server
Precedence:
1. a stored user choice (`hivetex.serverUrl`);
2. otherwise, in development (`import.meta.env.DEV`): `''`, which goes through the dev proxy;
3. otherwise the build default: `VITE_API_BASE`, falling back to `DEFAULT_SERVER = 'https://hivetex.vercel.app'`
   (desktop only);
4. on the web, always `''`.

Other details:
- `ServerChoice` and Account show the effective server and offer *Use the default server*, which clears the stored
  choice and reloads.
- The release workflow keeps passing `HIVETEX_API_BASE` as an optional override. The constant is the shipped default,
  so a missing variable no longer yields a server-less build.

### D2. Dev proxy instead of CORS changes
`vite.config.ts` gets the proxy target from `HIVETEX_SERVER` (default `https://hivetex.vercel.app`; `make dev-local` sets
`http://localhost:3000`):

```ts
proxy: { '/api': { target, ws: true, changeOrigin: true, secure: true,
  configure: (p) => p.on('proxyReq', (req) => req.setHeader('origin', target)) } }
```

The browser (or webview) sees same-origin `/api`, and the server sees its own origin, so the CSRF and CORS checks pass
without being relaxed. The desktop uses bearer tokens, so no cookie domain problems arise; for the web UI on localhost,
host-only cookies work.

Make targets:
- `make dev`: `HIVETEX_SERVER=$(SERVER) pnpm --filter @hivetex/desktop tauri dev`, with `SERVER` defaulting to the
  hosted URL.
- `make dev-local`: the previous `turbo dev` of server and web, plus `HIVETEX_SERVER=http://localhost:3000`.
- `make desktop-dev` becomes an alias of `make dev`.

### D3. Compiler preference
`hivetex.compileMode` ∈ `auto | peers | local`, stored per device (localStorage), and set from Settings → Compiler
(Account page) or the workspace status bar.

| Mode | Engine loaded | Eligible as leader | Auto-compile after edits | Visible PDF |
|---|---|---|---|---|
| `auto` | yes | yes, unless "compile for others" is off | when leader | leader's |
| `peers` | no (skips native detection and the wasm download) | no | no | leader's |
| `local` | yes | no | yes, local debounce (same settle delay as the leader) | own; remote results ignored |

- Switching modes updates the capability record (eligibility) immediately, so the election reacts without a reload.
  Switching into `local` or `auto` loads the engine lazily.
- *Compile here* stays available in `auto` and `local`, and is hidden in `peers`.
- **Status bar** shows "Compiled by ⟨device/user⟩ · Compiler: Automatic ▾".
  - In `peers` with no eligible leader: "No peer can compile right now. Switch to *Automatic* (needs TeX) or ask a
    co-author with the desktop app."
  - First run on the desktop without TeX in `auto`: "No LaTeX installed: peers will compile for you", with a link to
    *Use peers* / install instructions.

### D4. Test strategy
- **Unit:** server resolution precedence (stored > dev > build default > constant); compile-mode effects on the
  capability record (eligibility) and on the local auto-compile.
- **E2E (web, fake engine):**
  - three members: when the leader switches to *Use peers*, another takes over;
  - a *Use peers* member never compiles;
  - *This device only* shows its own result while the others keep theirs.
- **`make dev`:** a smoke check that the Vite proxy forwards `/api/health` to the configured target (script test against
  a local HTTP target), plus a manual check against hivetex.vercel.app.

## Risks / Trade-offs

- **The hosted server is the default target for contributors' dev sessions,** so local experiments create real accounts
  on it. The README says to use `make dev-local` or a staging deployment for destructive testing.
- **Proxying WebSockets through Vite to Vercel** relies on Vite's `http-proxy` `wss` support, which is standard. The
  smoke test covers the HTTP path; signaling is checked manually once.
- **`local` mode duplicates compiles** (each such device compiles its own). It is a deliberate choice of that user and
  does not affect others.
