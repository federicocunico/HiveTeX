# Tasks

Apply after `rename-to-hivetex`.

## 1. Default server

- [x] 1.1 Server resolution (D1): `DEFAULT_SERVER`, dev base, precedence; *Use the default server* on the sign-in screen
  and in Account; release workflow variable becomes an optional override; verify unit tests for the precedence (built-in default, build override, user choice, dev proxy, web) and the
  desktop e2e (the sign-in screen shows the build's server)

## 2. Development

- [x] 2.1 Vite proxy target from `HIVETEX_SERVER` with Origin rewrite (D2); `make dev` (desktop, hosted server,
  `SERVER=`), `make dev-local`, `desktop-dev` alias; verify a proxy smoke test against hivetex.vercel.app (health,
  sign-in request passes the origin check, signaling WebSocket) and `make dev` starting the desktop app with the proxy live
- [x] 2.2 README development table and `docs/deployment.md` updated (dev against hosted vs local, caution about real
  accounts); verify the commands named exist

## 3. Compiler preference

- [x] 3.1 `hivetex.compileMode` (auto / peers / local): engine loading, eligibility, local auto-compile, remote results
  ignored in local mode (D3); verify unit tests for each mode's capability and compile behaviour
- [x] 3.2 Settings → Compiler and the status-bar indicator (who compiled, mode switch, "no peer can compile", no-TeX
  hint); verify svelte-check and the e2e scenarios (leader hand-off on switching to peers, peers never compile,
  local-only results)
- [x] 3.3 `docs/compilation.md` describes the three modes; verify `make check`, CI and Desktop green
