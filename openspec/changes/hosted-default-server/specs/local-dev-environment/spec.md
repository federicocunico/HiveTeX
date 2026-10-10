# Spec Delta

## ADDED Requirements

### Requirement: Developing against the hosted server
`make dev` SHALL start the desktop app with hot reload, connected to the hosted server (`https://hivetex.vercel.app`)
without requiring a local API, database or credentials. A `SERVER` parameter SHALL select another deployment, and
`make dev-local` SHALL run the all-local mode (local API with an embedded database, plus the UI). Development SHALL NOT
require weakening the hosted server's origin checks: requests from the development UI SHALL reach the server as
same-origin requests.

#### Scenario: Default development session
- **WHEN** a contributor runs `make dev`
- **THEN** the desktop app opens with hot reload, signs in against `hivetex.vercel.app`, and lists that account's
  projects

#### Scenario: Another deployment
- **WHEN** a contributor runs `make dev SERVER=https://staging.example.org`
- **THEN** the development app talks to that server instead

#### Scenario: Everything local
- **WHEN** a contributor runs `make dev-local`
- **THEN** a local API with an embedded database and the UI start, as `make dev` did before
