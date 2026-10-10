# Tasks

Apply after `rename-to-hivetex`.

## 1. Default server

- [ ] 1.1 Server resolution (D1): `DEFAULT_SERVER`, dev base, precedence; *Use the default server* on the sign-in screen
  and in Account; release workflow variable becomes an optional override; verify unit tests for the precedence and the
  desktop e2e (the sign-in screen shows hivetex.vercel.app when no override is set)

## 2. Development

- [ ] 2.1 Vite proxy target from `HIVETEX_SERVER` with Origin rewrite (D2); `make dev` (desktop, hosted server,
  `SERVER=`), `make dev-local`, `desktop-dev` alias; verify a proxy smoke test against a local target and a manual
  `make dev` sign-in against hivetex.vercel.app
- [ ] 2.2 README development table and `docs/deployment.md` updated (dev against hosted vs local, caution about real
  accounts); verify the commands named exist

## 3. Compiler preference

- [ ] 3.1 `hivetex.compileMode` (auto / peers / local): engine loading, eligibility, local auto-compile, remote results
  ignored in local mode (D3); verify unit tests for each mode's capability and compile behaviour
- [ ] 3.2 Settings → Compiler and the status-bar indicator (who compiled, mode switch, "no peer can compile", no-TeX
  hint); verify svelte-check and the e2e scenarios (leader hand-off on switching to peers, peers never compile,
  local-only results)
- [ ] 3.3 `docs/compilation.md` describes the three modes; verify `make check`, CI and Desktop green
