# Spec Delta

## MODIFIED Requirements

### Requirement: Documented setup for a test deployment
The repository SHALL provide one command (`make setup`) that performs the first deployment of a test release
end to end, and SHALL be safe to re-run. It SHALL:
- check the required tools and logins;
- link the hosting project and provision the database and Redis services when missing;
- store the server secrets and settings;
- deploy;
- verify the deployment answers its health check;
- configure the GitHub secret and variable used by desktop releases.

It SHALL ask only for values that cannot be generated (mail account and app password, the first admin's username,
optional TURN credentials). It SHALL accept these from the environment or from a git-ignored local file, so it can run
without prompts. Secrets SHALL never be written to tracked files or printed. The README SHALL describe this command,
the manual steps as a fallback, tagging a release, and installing and testing on each platform.

#### Scenario: Following the guide
- **WHEN** a maintainer with the listed accounts follows the README (`make setup`, then `make release`)
- **THEN** they end with a deployed web app, a draft release with installers, and testers who can register and open a
  shared project

#### Scenario: First setup
- **WHEN** a maintainer logged in to Vercel and GitHub runs `make setup` and answers the prompts
- **THEN** the web app is deployed with its database schema, `/api/health` answers, and the repository has the updater
  key secret and the server URL variable

#### Scenario: Re-running setup
- **WHEN** `make setup` runs again on an already configured project
- **THEN** existing secrets (ticket keys, mail password) are kept, unless rotation is explicitly requested, and the run
  ends with a fresh deployment

#### Scenario: Unattended run
- **WHEN** all non-generated values are present in the environment or the local setup file
- **THEN** `make setup` completes without asking anything

#### Scenario: Generating secrets
- **WHEN** the maintainer runs `make secrets`
- **THEN** missing ticket-signing keys are generated and stored for production and preview, existing ones are kept
  unless `ROTATE=1`, the updater key is stored as a GitHub secret, and no secret value is printed

## ADDED Requirements

### Requirement: Schema migrations during deployment
Each deployment of the control plane SHALL apply pending database migrations before the new version serves requests,
using the deployment's own database credentials. A failed migration SHALL fail the deployment.

#### Scenario: New migration
- **WHEN** a commit adds a migration and is deployed
- **THEN** the deployment applies it during the build, and the build fails if the migration fails

### Requirement: First administrator bootstrap
When the server setting `BOOTSTRAP_ADMIN` names a username and no platform admin exists, the account with that
username SHALL become a platform admin when it registers or signs in. Once any admin exists, the setting SHALL have no
effect.

#### Scenario: Designated user registers first
- **WHEN** `BOOTSTRAP_ADMIN=alice` and no admin exists, and alice registers
- **THEN** alice is a platform admin

#### Scenario: An admin already exists
- **WHEN** an admin exists and the user named by `BOOTSTRAP_ADMIN` signs in
- **THEN** that user's role is unchanged

### Requirement: Public origin from the hosting platform
When `APP_ORIGIN` is not set, a production deployment SHALL use the hosting platform's stable production domain as its
public origin (for links in emails and cookie security), not the address of the individual deployment.

#### Scenario: No APP_ORIGIN on a production deployment
- **WHEN** the server runs in production on the hosting platform without `APP_ORIGIN`
- **THEN** reset and verification links use `https://<production domain>`
