# Tasks

## 1. Server

- [x] 1.1 Origin fallback to `VERCEL_PROJECT_PRODUCTION_URL` on production deployments; verify config unit tests (APP_ORIGIN wins, production domain, preview deployment URL, local default)
- [x] 1.2 `BOOTSTRAP_ADMIN` on register and login, atomic (only when no admin exists); verify server tests (promoted when first, unchanged when an admin exists, other usernames unaffected)
- [x] 1.3 Migrations in the Vercel build command; verify `vercel.json` parses and `pnpm --filter @p2platex/server migrate` fails clearly without `DATABASE_URL`

## 2. Setup command

- [x] 2.1 `scripts/setup.mjs` with the steps of design D1, inputs from env / `.env.setup` / prompts, `--only=secrets`, `ROTATE=1`; verify on the real `hivetex` project: dry run detects storage as present and lists the missing settings; `make secrets` stores the ticket keys (values checked to arrive intact) and a re-run keeps them
- [x] 2.2 `make setup`, `make secrets` (runs instead of printing), `env-pull` from production; `.env.example` lists the setup inputs; verify a second `make setup` keeps existing keys and needs no input
- [x] 2.3 First real `make setup` on `hivetex` with the maintainer's Gmail App Password: deploy succeeds (migrations in the build), `/api/health` is 200, the admin bootstrap works on registration

## 3. Docs

- [x] 3.1 README guide: install tools, `make setup`, `make release`, testers' first launch; manual steps moved to `docs/deployment.md` with the sensitive-value note; verify the commands named exist
- [x] 3.2 `make check`, CI green
