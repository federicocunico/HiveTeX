# local-dev-environment Specification

## Purpose

Gives contributors one documented command surface to install, run, test and deploy every component, and a containerized local stack that exercises the same control-plane code path used in production.

## Requirements

### Requirement: Make command surface
The repository root SHALL provide a Makefile whose default target prints every available target with a one-line description. Targets SHALL cover install, dev servers, build, lint, unit tests, end-to-end tests, desktop dev/test, the Docker stack, and Vercel deploys.

#### Scenario: Discover commands
- **WHEN** a developer runs `make` with no arguments
- **THEN** a list of targets with descriptions is printed and nothing else runs

#### Scenario: Full local verification
- **WHEN** a developer runs `make check`
- **THEN** build, lint, type-check, unit tests and end-to-end tests run in sequence and the command fails if any of them fails

### Requirement: Cross-platform recipes
Make targets SHALL work with GNU Make on Linux, macOS and Windows (Git Bash), and SHALL fail with an actionable message when a required tool (pnpm, Docker, Rust, Vercel CLI) is missing.

#### Scenario: Missing Docker
- **WHEN** a developer without Docker runs `make up`
- **THEN** the command stops with a message saying Docker is required and how to install it

### Requirement: Containerized local stack
`make up` SHALL start, via Docker Compose, a Postgres database, a Redis store, local emulators exposing the Neon HTTP and Upstash REST interfaces, an SMTP catcher with a web inbox, the control-plane API and the web app, all reachable on localhost with documented ports.

#### Scenario: Stack starts
- **WHEN** a developer runs `make up` on a clean checkout
- **THEN** the web app answers on its documented port, `GET /api/health` returns 200, and the mail inbox UI is reachable

#### Scenario: Stop and reset
- **WHEN** a developer runs `make down` and then `make reset`
- **THEN** containers stop, and after reset the database and Redis volumes are empty

### Requirement: Production code path parity
The API container SHALL run the same dependency wiring used on Vercel (Neon HTTP driver, Upstash REST client, SMTP mailer, signaling backend) pointed at the local emulators, and SHALL apply database migrations on start.

#### Scenario: Register through the real path
- **WHEN** a developer registers an account in the web app served by `make up`
- **THEN** the account row is in the local Postgres, rate-limit keys are in the local Redis, and the verification email appears in the SMTP catcher inbox

### Requirement: Emulator overrides are opt-in
Server configuration for local emulators SHALL be controlled only by explicit environment variables, and production behavior SHALL be unchanged when they are unset.

#### Scenario: Production without overrides
- **WHEN** the API runs on Vercel without the emulator variables
- **THEN** it connects to Neon, Upstash and Gmail exactly as before

### Requirement: Optional components
The stack SHALL offer opt-in profiles for a TURN relay and a self-hosted TeX Live file server for the in-browser compiler, off by default.

#### Scenario: TeX Live profile
- **WHEN** a developer runs `make up PROFILES=texlive`
- **THEN** the web app's in-browser compiler fetches packages from the local file server instead of the public one

### Requirement: End-to-end tests against the stack
`make test-stack` SHALL run the end-to-end suite against the containerized stack, in addition to `make e2e`, which uses the lightweight embedded-database dev server.

#### Scenario: E2E on stack
- **WHEN** a developer runs `make test-stack`
- **THEN** the stack is started if not running, the e2e suite runs against it, and the exit code reflects the test result

### Requirement: Vercel deploy targets
The Makefile SHALL provide targets to pull environment variables, deploy a preview, deploy to production, run migrations against the linked database and seed an admin. Production deploy SHALL require explicit confirmation and SHALL run checks first.

#### Scenario: Preview deploy
- **WHEN** a developer with a linked Vercel project runs `make deploy-preview`
- **THEN** a preview deployment is created and its URL printed

#### Scenario: Production confirmation
- **WHEN** a developer runs `make deploy-prod` without `CONFIRM=1`
- **THEN** the command asks for confirmation (or exits non-interactively with instructions) and does not deploy

#### Scenario: Not linked
- **WHEN** a developer runs a deploy target in a checkout not linked to a Vercel project
- **THEN** the command stops and explains how to run `vercel link`

### Requirement: No secrets in the repository
Local stack credentials SHALL be non-secret development defaults kept in a committed example file, and real deployment secrets SHALL only come from Vercel environment variables or untracked local env files.

#### Scenario: Fresh clone
- **WHEN** a developer clones the repository and runs `make up`
- **THEN** the stack starts without creating or requiring any real third-party credential
